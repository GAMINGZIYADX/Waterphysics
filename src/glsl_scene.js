/* ==========================================================================
   GLSL: scene geometry, water density field, opaque shading
   ========================================================================== */
WB_GLSL.scene = `
uniform sampler3D uVol;       // R: particle density field, G: density * aeration
uniform vec3  uVolMin, uVolSize;
uniform float uCell;          // voxel size [m]
uniform int   uHasVol, uMembrane;
uniform float uIso, uMemSlope, uBand, uBulgeMax;   // uBulgeMax: bound on the blast inflation of the skin [m]
uniform sampler2D uWet;       // time each floor texel first got wet
uniform float uWetHalf;
uniform vec3  uBulletTip, uBulletDir; uniform float uBulletR, uBulletLen; uniform int uBulletOn;
uniform vec3  uKnotPos, uWadPos; uniform float uWadR, uNeckOn, uTopY;
uniform vec3  uFlowOff;       // bulk displacement of the water since release (ripple advection)
uniform float uRipple;
uniform float uAccum;         // 1 while progressively accumulating a still frame
uniform float uRand;          // per-frame random seed
uniform float uShadowFloor;   // light left in a thick water shadow (lower when caustics carry it)
uniform sampler2D uCau; uniform vec2 uCauMin; uniform float uCauSize; uniform float uCauOn;
vec3 causticAt(vec2 xz) {
  if (uCauOn < 0.5) return vec3(0.0);
  vec2 c = (xz - uCauMin) / uCauSize;
  if (any(lessThan(c, vec2(0.0))) || any(greaterThan(c, vec2(1.0)))) return vec3(0.0);
  vec2 e = vec2(1.0 / 1024.0, 0.0);
  return 0.4 * textureLod(uCau, c, 0.0).rgb + 0.15 * (textureLod(uCau, c + e.xy, 0.0).rgb + textureLod(uCau, c - e.xy, 0.0).rgb + textureLod(uCau, c + e.yx, 0.0).rgb + textureLod(uCau, c - e.yx, 0.0).rgb);
}

// ---------------------------------------------------------------- SDF helpers
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-7); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
bool boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
  vec3 inv = 1.0 / rd; vec3 a = (bmin - ro) * inv, b = (bmax - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z); t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

// ---------------------------------------------------------------- water field
float fieldP(vec3 p) { return textureLod(uVol, (p - uVolMin) / uVolSize, 0.0).r; }
vec2 fieldPA(vec3 p) { return textureLod(uVol, (p - uVolMin) / uVolSize, 0.0).rg; }

// ---------------------------------------------------------------- analytic liquid features
// Coherent liquid structures finer than the particle resolution, added to the density
// field so they are ray traced as water: exit plume core, entry splash cone, cavity-collapse
// jets, and the floor lamella with its rising crown.  Distances in metres, > 0 inside.
uniform vec4 uJetA[4];   // origin.xyz, length (0 = inactive)
uniform vec4 uJetB[4];   // unit axis.xyz, base radius
uniform vec4 uJetC[4];   // cone tan (0 = solid jet), sheet thickness, phase, taper exponent
uniform vec4 uImp;       // floor impact: time, speed, centre x, centre z
uniform vec4 uImp2;      // lamella: initial radius, crown height
uniform vec3 uAnMin, uAnMax;
float jetSD(vec3 p, vec4 A, vec4 B, vec4 C) {
  if (A.w <= 0.0) return -1.0;
  vec3 q = p - A.xyz; float s = dot(q, B.xyz);
  if (s < -0.003 || s > A.w) return -1.0;
  vec3 radial = q - B.xyz * s; float rho = length(radial);
  float x = clamp(s / A.w, 0.0, 1.0);
  if (C.x > 0.0) {                                // hollow splash cone
    float rc = B.w + s * C.x;
    float lump = 1.0 + 0.3 * sin(atan(radial.y, radial.z) * 9.0 + C.z) * x;
    return min(C.y * 0.5 * lump - abs(rho - rc), A.w - s);
  }
  float r = B.w * pow(max(1.0 - x, 0.0), C.w);
  float lam = max(7.0 * r, 0.005) * (0.8 + 0.4 * vnoise2(vec2(s * 40.0, C.z * 0.01)));
  r *= 1.0 + 0.3 * x * sin(6.2832 * s / lam - C.z);                  // Rayleigh-Plateau necking toward the tip
  r *= 0.8 + 0.4 * vnoise2(vec2(s * 120.0 + C.z * 0.1, atan(radial.y, radial.z) * 1.3 + C.z));
  return r - rho;
}
float lamellaR(float tt, float ang) {
  float Rs = uImp2.x + 2.4 * uImp.y * 0.075 * (1.0 - exp(-tt / 0.075));
  vec2 dh = vec2(cos(ang), sin(ang));             // irregular fingering, continuous around the rim
  return Rs * (1.0 + 0.2 * (vnoise2(dh * 4.0 + 3.0) - 0.5) + 0.16 * (vnoise2(dh * 11.0 + 7.0) - 0.5) + 0.08 * (vnoise2(dh * 29.0 + 1.0) - 0.5));
}
float lamellaSD(vec3 p) {
  float tt = uTime - uImp.x;
  if (tt <= 0.0 || p.y > 0.09) return -1.0;
  vec2 d = p.xz - uImp.zw; float r = length(d), ang = atan(d.y, d.x);
  float Rf = lamellaR(tt, ang);
  if (r > Rf + 0.04) return -1.0;
  float hs = max(0.0024, 0.007 * exp(-tt / 0.05)) * (1.0 - 0.45 * smoothstep(0.25 * Rf, Rf, r)) * (1.0 - smoothstep(0.09, 0.22, tt));
  float g = r < Rf ? min(hs - p.y, Rf - r) : -1.0;
  vec2 dh = vec2(cos(ang), sin(ang));
  float H = uImp2.y * smoothstep(0.0, 0.012, tt) * exp(-tt / 0.06) * (0.3 + 0.9 * vnoise2(dh * 9.0 + 5.0) * (0.5 + vnoise2(dh * 23.0 + 2.0)));
  float wall = min(0.003 - abs(r - Rf - p.y * 0.9), H - p.y);
  return max(g, wall);
}
float analyticSD(vec3 p) {
  if (any(lessThan(p, uAnMin)) || any(greaterThan(p, uAnMax))) return -1.0;
  float g = lamellaSD(p);
  for (int i = 0; i < 4 * uL1; i++) g = max(g, jetSD(p, uJetA[i], uJetB[i], uJetC[i]));
  return g;
}
// particle field (+ analytic features), clipped/filled by the latex wherever rubber still covers the water
float field(vec3 p) {
  float f = fieldP(p);
  float ga = analyticSD(p);
  if (ga > -0.02) f = max(f, uIso + ga * uMemSlope);
  if (uMembrane == 0) return f;
  vec3 d = p - uC; float l = length(d);
  if (l < uR * 0.72) return f;
  float sd0 = l - uR * shapeR(d.y / l);
  if (sd0 > 2.5 * uBand + uTent + uLipH + uBulgeMax || sd0 < -uBand) return f;
  float dtp; float sd = memSD(p, dtp);
  if (dtp <= 0.0) return f;
  float fm = uIso - sd * uMemSlope;             // continuous across the latex surface
  return sd > 0.0 ? min(f, fm) : max(f, fm);
}

// ---------------------------------------------------------------- opaque geometry
struct Hit { float t; vec3 n; int m; };   // m: 0 miss, 1 floor, 2 backdrop, 3 string, 4 rubber, 5 bullet, 6 key light, 7 rim light
float hitCyc(vec3 ro, vec3 rd, out vec3 n, out int m) {
  float best = 1e9; n = vec3(0.0, 1.0, 0.0); m = 0;
  if (rd.y < 0.0) {
    float t = -ro.y / rd.y; vec3 p = ro + rd * t;
    if (t > 0.0 && p.z >= -ZB + RC && abs(p.x) < 7.0 && p.z < 7.0) { best = t; n = vec3(0.0, 1.0, 0.0); m = 1; }
  }
  if (rd.z < 0.0) {
    float t = (-ZB - ro.z) / rd.z; vec3 p = ro + rd * t;
    if (t > 0.0 && t < best && p.y >= RC && p.y < 5.0 && abs(p.x) < 7.0) { best = t; n = vec3(0.0, 0.0, 1.0); m = 2; }
  }
  vec2 o = vec2(ro.y - RC, ro.z + ZB - RC), d = rd.yz;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - RC * RC, disc = b * b - a * c;
  if (disc > 0.0 && a > 1e-9) {
    float t = (-b + sqrt(disc)) / a; vec3 p = ro + rd * t; vec2 q = vec2(p.y - RC, p.z + ZB - RC);
    if (t > 0.0 && t < best && q.x <= 0.0 && q.y <= 0.0 && abs(p.x) < 7.0) { best = t; n = normalize(vec3(0.0, -q.x, -q.y)); m = 2; }
  }
  return best;
}
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
float sdRubber(vec3 p) {
  // tied neck: rolled lip bead + knot loop around the neck
  vec3 k = p - uKnotPos;
  float d = sdTorus(k.xzy * vec3(1.0, 1.0, 1.0) - vec3(0.0, 0.0, 0.0), vec2(0.0042, 0.0023));
  d = min(d, sdTorus(vec3(k.x, k.y - 0.0055, k.z), vec2(0.0028, 0.0017)));
  d = smin(d, sdEllipsoid(k + vec3(0.0, 0.004, 0.0), vec3(0.0036, 0.0065, 0.0036)), 0.002);
  if (uNeckOn > 0.001) {
    vec3 a = vec3(uC.x, uTopY - 0.006, uC.z), b = uKnotPos - vec3(0.0, 0.003, 0.0);
    d = smin(d, sdCapsule(p, a, b, 0.0036 + 0.0016 * uNeckOn), 0.004);
  }
  if (uWadR > 0.0005) {
    // retracted latex: a limp, crumpled rag of thin flaps hanging from the knot
    vec3 w = p - uWadPos; float k = uWadR / 0.011;
    float c1 = cos(1.9), s1 = sin(1.9), c2 = cos(4.1), s2 = sin(4.1);
    vec3 w1 = vec3(c1 * w.x - s1 * w.z, w.y, s1 * w.x + c1 * w.z), w2 = vec3(c2 * w.x - s2 * w.z, w.y, s2 * w.x + c2 * w.z);
    float f1 = sdEllipsoid(w - vec3(0.004, -0.009, 0.0) * k, vec3(0.008, 0.016, 0.0028) * k);
    float f2 = sdEllipsoid(w1 - vec3(0.003, -0.011, 0.001) * k, vec3(0.007, 0.018, 0.0024) * k);
    float f3 = sdEllipsoid(w2 - vec3(0.002, -0.007, 0.0) * k, vec3(0.009, 0.012, 0.003) * k);
    float r1 = 1.0 - abs(noised(w * 210.0).x * 2.0 - 1.0);
    d = smin(d, (min(f1, min(f2, f3)) - 0.0012 * r1) * 0.7, 0.003);
  }
  return d;
}
// (the bullet is a rasterised mesh drawn after the ray tracer: see glsl_rubber.js)
vec3 sdNormal(vec3 p) {
  vec3 g = vec3(0.0);
  for (int k = 0; k < 4 * uL1; k++) {
    vec3 o = vec3(((k + 3) >> 1) & 1, (k >> 1) & 1, k & 1) * 2.0 - 1.0;
    g += o * sdRubber(p + o * 1e-4);
  }
  return normalize(g);
}
float sphereTrace(vec3 ro, vec3 rd, vec3 cen, float rad, float tmax) {
  vec3 oc = ro - cen; float b = dot(oc, rd), c = dot(oc, oc) - rad * rad, disc = b * b - c;
  if (disc < 0.0) return 1e9;
  float t = max(-b - sqrt(disc), 0.0), t1 = min(-b + sqrt(disc), tmax);
  for (int i = 0; i < 64 * uL1; i++) {
    if (t > t1) break;
    vec3 p = ro + rd * t;
    float d = sdRubber(p);
    if (d < 2e-5 * (1.0 + t)) return t;
    t += max(d, 1e-5);
  }
  return 1e9;
}
Hit traceOpaque(vec3 ro, vec3 rd, bool withLights) {
  Hit h; h.m = 0; h.t = 1e9; h.n = vec3(0.0, 1.0, 0.0);
  vec3 n; int m;
  float t = hitCyc(ro, rd, n, m);
  if (m > 0) { h.t = t; h.n = n; h.m = m; }
  // string: vertical cylinder above the knot
  vec2 o = ro.xz - uKnotPos.xz; vec2 d = rd.xz;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 0.0007 * 0.0007, disc = b * b - a * c;
  if (disc > 0.0 && a > 1e-10) {
    float ts = (-b - sqrt(disc)) / a; float y = ro.y + rd.y * ts;
    if (ts > 0.0 && ts < h.t && y > uKnotPos.y && y < 4.5) { h.t = ts; h.n = normalize(vec3(o + d * ts, 0.0).xzy); h.m = 3; }
  }
  // sphere-traced latex knot / neck
  vec3 cen = 0.5 * (uKnotPos + vec3(uC.x, uTopY, uC.z));
  float ts = sphereTrace(ro, rd, cen, 0.5 * length(uKnotPos - vec3(uC.x, uTopY, uC.z)) + 0.012 + 1.6 * uWadR + length(uWadPos - uKnotPos), h.t);
  if (ts < h.t) { h.t = ts; h.n = sdNormal(ro + rd * ts); h.m = 4; }
  if (withLights) {
    float tl;
    if (hitRect(ro, rd, uL0c, uL0u, uL0v, tl) && tl < h.t) { h.t = tl; h.m = 6; }
    if (hitRect(ro, rd, uL1c, uL1u, uL1v, tl) && tl < h.t) { h.t = tl; h.m = 7; }
  }
  return h;
}

// ---------------------------------------------------------------- shadows
// transmittance of the water + latex along a shadow ray (water refracts light
// away, so a thick blob casts a ~70% shadow; latex tints it)
vec3 waterShadow(vec3 p, vec3 target) {
  vec3 T = vec3(1.0);
  vec3 d = target - p; float L = length(d); d /= L;
  if (uMembrane == 1) {
    vec3 oc = p - uC; float b = dot(oc, d), c = dot(oc, oc) - uR * uR * 1.05, disc = b * b - c;
    if (disc > 0.0 && -b - sqrt(disc) > 0.0) {
      vec3 q = p + d * (-b - sqrt(disc));
      if (peelT(normalize(q - uC)) > uTime) T *= mix(vec3(1.0), uRubberCol * 1.2, 0.75) * (1.0 - 0.45 * uRubberOpacity);
    }
  }
  if (uHasVol == 0) return T;
  float t0, t1;
  if (!boxHit(p, d, uVolMin, uVolMin + uVolSize, t0, t1)) return T;
  t0 = max(t0, 0.0); t1 = min(t1, L);
  float st = uCell * 1.6, len = 0.0, aer = 0.0;
  float jit = hash2(FRAGXY + uRand);
  for (int i = 0; i < 160 * uL1; i++) {
    float t = t0 + (float(i) + jit) * st; if (t > t1) break;
    vec2 fa = fieldPA(p + d * t);
    float w = smoothstep(uIso * 0.7, uIso * 1.3, fa.x);
    len += w * st; aer += w * fa.y / max(fa.x, 1e-3) * st;
  }
  return T * mix(uShadowFloor, 1.0, exp(-len * 40.0)) * exp(-aer * 60.0);
}
float waterAO(vec3 p, vec3 n) {
  if (uHasVol == 0) return 1.0;
  float o = 0.0;
  for (int i = 1; i <= 4; i++) {
    float h = 0.006 * float(i * i);
    vec3 q = p + n * h;
    if (any(lessThan(q, uVolMin)) || any(greaterThan(q, uVolMin + uVolSize))) continue;
    o += clamp(fieldP(q) / (uIso * 3.0), 0.0, 1.0) / float(i);
  }
  return clamp(1.0 - 0.55 * o, 0.0, 1.0);
}
uniform vec2 uLJ;           // playback: one softbox sample point per frame for all pixels (the temporal resolve softens it)
vec3 lightSample(vec3 c, vec3 hu, vec3 hv) {
  if (uAccum < 0.5) return c + hu * uLJ.x * 0.9 + hv * uLJ.y * 0.9;
  vec2 r = vec2(hash2(FRAGXY * 1.37 + uRand * 91.0), hash2(FRAGXY.yx * 2.11 + uRand * 57.0)) * 2.0 - 1.0;
  return c + hu * r.x * 0.9 + hv * r.y * 0.9;
}

// ---------------------------------------------------------------- materials
float floorWet(vec2 xz) {
  vec2 uv = (xz + uWetHalf) / (2.0 * uWetHalf);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  // interpolate per-texel wetness (not wetting times) so edges are smooth, then a noisy soft threshold
  vec2 fr = uv * float(textureSize(uWet, 0).x) - 0.5, i0 = floor(fr); fr -= i0;
  ivec2 mxi = textureSize(uWet, 0) - 1, b0 = clamp(ivec2(i0), ivec2(0), mxi), b1 = clamp(ivec2(i0) + 1, ivec2(0), mxi);
  float dt0 = uTime + (vnoise2(xz * 170.0) - 0.5) * 0.008;
  float w00 = smoothstep(0.0, 0.01, dt0 - texelFetch(uWet, b0, 0).r), w10 = smoothstep(0.0, 0.01, dt0 - texelFetch(uWet, ivec2(b1.x, b0.y), 0).r);
  float w01 = smoothstep(0.0, 0.01, dt0 - texelFetch(uWet, ivec2(b0.x, b1.y), 0).r), w11 = smoothstep(0.0, 0.01, dt0 - texelFetch(uWet, b1, 0).r);
  float wb = mix(mix(w00, w10, fr.x), mix(w01, w11, fr.x), fr.y);
  float edge = 0.3 + 0.4 * vnoise2(xz * 110.0);                 // rounded, lobed wet edge (not a saw-tooth)
  float w = smoothstep(edge - 0.2, edge + 0.2, wb);
  float tt = uTime - uImp.x;
  if (tt > 0.0) { vec2 d = xz - uImp.zw; float Rf = lamellaR(tt, atan(d.y, d.x)); w = max(w, smoothstep(Rf + 0.006, Rf - 0.006, length(d))); }
  return w;
}
vec3 concrete(vec2 xz, out float rough, out vec3 nb) {
  float n1 = vnoise2(xz * 1.7), n2 = vnoise2(xz * 9.0 + 3.1), n3 = vnoise2(xz * 140.0 + 7.7), n4 = vnoise2(xz * 520.0);
  float v = 0.25 * n1 + 0.2 * n2 + 0.3 * n3 + 0.25 * n4;
  vec3 alb = vec3(0.205, 0.2, 0.19) * (0.84 + 0.32 * v);
  alb *= 0.9 + 0.2 * vnoise2(xz * 3.3 + 11.0);                                   // 10-50 cm mottling
  alb *= 1.0 - 0.12 * smoothstep(0.62, 0.8, vnoise2(xz * 6.0 + 4.2));             // old stains
  float jt = abs(fract((xz.x + 0.53) / 1.2) - 0.5) * 1.2;                         // saw-cut control joint every 1.2 m
  alb *= 1.0 - 0.45 * (1.0 - smoothstep(0.0015, 0.004, jt));
  float sp = smoothstep(0.78, 0.86, vnoise2(xz * 1100.0 + 1.3)); alb *= 1.0 - 0.35 * sp;          // dark aggregate
  float fl = smoothstep(0.86, 0.93, vnoise2(xz * 1500.0 + 9.4)); alb *= 1.0 + 0.35 * fl;          // light sand grains
  float pits = smoothstep(0.9, 0.96, vnoise2(xz * 760.0 + 5.1)); alb *= 1.0 - 0.3 * pits;
  rough = 0.55 + 0.15 * n2;
  float e = 1.0 / 1500.0;
  float hx = vnoise2((xz + vec2(e, 0.0)) * 520.0) - n4, hz = vnoise2((xz + vec2(0.0, e)) * 520.0) - n4;
  nb = normalize(vec3(-hx * 0.12, 1.0, -hz * 0.12));
  return alb;
}
vec3 ambientTerm(vec3 n) { return uAmbient * vec3(0.9, 0.95, 1.0) * (0.55 + 0.45 * n.y); }

// direct lighting from both softboxes (diffuse + specular) with water shadows
vec3 directLight(vec3 p, vec3 n, vec3 v, vec3 alb, float rough, vec3 F0) {
  vec3 acc = vec3(0.0);
  for (int li = 0; li < 2 * uL1; li++) {         // both softboxes, one inlined copy
    vec3 c = li == 0 ? uL0c : uL1c, hu = li == 0 ? uL0u : uL1u, hv = li == 0 ? uL0v : uL1v, le = li == 0 ? uL0e : uL1e;
    float e = rectIrr(p, n, c, hu, hv);
    vec3 s = e > 0.0 ? waterShadow(p + n * 1e-3, lightSample(c, hu, hv)) : vec3(1.0);
    acc += (alb / PI * le * e + rectSpec(p, n, v, rough, F0, c, hu, hv, le)) * s;
  }
  return acc;
}
vec3 directLightNS(vec3 p, vec3 n, vec3 v, vec3 alb, float rough, vec3 F0) {
  vec3 acc = vec3(0.0);
  for (int li = 0; li < 2 * uL1; li++) {
    vec3 c = li == 0 ? uL0c : uL1c, hu = li == 0 ? uL0u : uL1u, hv = li == 0 ? uL0v : uL1v, le = li == 0 ? uL0e : uL1e;
    acc += alb / PI * le * rectIrr(p, n, c, hu, hv) + rectSpec(p, n, v, rough, F0, c, hu, hv, le);
  }
  return acc;
}
// cheap environment for reflections: cyclorama + softboxes, no occluders or shadows
vec3 envCheap(vec3 ro, vec3 rd, bool lights) {
  vec3 n; int m; float t = hitCyc(ro, rd, n, m), tl;
  if (lights && hitRect(ro, rd, uL0c, uL0u, uL0v, tl) && tl < t) return rectEmit(ro + rd * tl, uL0c, uL0u, uL0v, uL0e);
  if (lights && hitRect(ro, rd, uL1c, uL1u, uL1v, tl) && tl < t) return rectEmit(ro + rd * tl, uL1c, uL1u, uL1v, uL1e);
  if (m == 0) return studioVoid(rd);
  vec3 p = ro + rd * t;
  vec3 alb = m == 1 ? vec3(0.235, 0.228, 0.215) * (0.78 + 0.44 * vnoise2(p.xz * 11.0)) * mix(1.0, 0.42, floorWet(p.xz)) : vec3(uBackdrop);
  return alb / PI * (uL0e * rectIrr(p, n, uL0c, uL0u, uL0v) + uL1e * rectIrr(p, n, uL1c, uL1u, uL1v)) + alb * ambientTerm(n)
       + (m == 2 ? alb * bgPool(p) : vec3(0.0));
}
`;
