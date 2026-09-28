/* ==========================================================================
   GLSL: ray tracer main pass.  One light path per pixel is followed through
   up to 8 segments (air -> water -> air -> floor reflection ...).  At every
   dielectric interface the reflected part is evaluated against a cheap
   analytic environment and the path continues along the refracted ray, so
   each expensive routine (scene intersection, volume marching, shadowed
   lighting) has a single call site — keeps the D3D/ANGLE shader compact.
   ========================================================================== */
WB_GLSL.trace = `
uniform float uBubble, uDetail, uClarity, uLensR, uFocus;
uniform vec2 uLens, uJit;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;
layout(location = 2) out vec4 oVel;           // object motion (none here: the resolve uses camera motion)

/* One marcher for both directions: from air finds the first point inside the water
   (returns -1 if none before t1); from inside finds the exit (returns t1 if none) and
   integrates the aeration (bubble cloud) along the way. */
float marchSurface(vec3 ro, vec3 rd, float t0, float t1, bool inside, out float aer) {
  aer = 0.0;
  float t = t0 + uCell * (inside ? 0.22 : 0.5 * hash2(gl_FragCoord.xy * 0.73 + uRand * 17.0));
  float last = 0.0;
  for (int i = 0; i < 900 * uL1; i++) {
    vec3 p = ro + rd * t;
    float f = field(p);
    if ((f > uIso) != inside) {
      if (i == 0) return t;
      float a = t - last, b = t;
      for (int k = 0; k < 7 * uL1; k++) { float m = 0.5 * (a + b); if ((field(ro + rd * m) > uIso) != inside) b = m; else a = m; }
      return b;
    }
    float st = uCell * 0.45;
    if (inside) {                                  // bubble cloud: clumpy, sparkly rather than an even haze
      vec2 fa = fieldPA(p);
      float clump = 0.25 + 1.5 * smoothstep(0.35, 0.8, vnoise2(vec2(p.x * 230.0 + p.z * 170.0, p.y * 260.0 - p.z * 90.0)));
      aer += fa.y / max(fa.x, 1e-3) * st * clump;
    }
    else if (f < uIso * 0.02) st = uCell;
    if (t + st > t1) return inside ? t1 : -1.0;
    t += st; last = st;
  }
  return inside ? t : -1.0;
}
vec3 waterNormal(vec3 p) {
  // thin film on the floor: surface tension flattens particle-scale bumps -> wider gradient stencil
  float e = uCell * mix(0.9, 4.0, smoothstep(0.03, 0.006, p.y));
  vec3 g = vec3(0.0);
  for (int k = 0; k < 4 * uL1; k++) {            // tetrahedral stencil
    vec3 o = vec3(((k + 3) >> 1) & 1, (k >> 1) & 1, k & 1) * 2.0 - 1.0;
    g += o * field(p + o * e);
  }
  return dot(g, g) > 1e-12 ? -normalize(g) : vec3(0.0, 1.0, 0.0);
}
// capillary ripples / wrinkles left by the retracting rubber, advected with the bulk
vec3 ripples(vec3 p, vec3 n) {
  vec3 q = p - uFlowOff;
  // fresh wrinkles right behind the tear front, smoothed away by surface tension within tens of ms
  float fresh = 0.0;
  if (uTime < uPeelEnd + 0.05) {
    float ts = uTime - peelT(normalize(q - uC));
    fresh = smoothstep(0.0, 0.0012, ts) * (1.0 - smoothstep(0.01, 0.04, ts));
  }
  float amp = uDetail * (0.08 + 0.9 * fresh) * smoothstep(0.004, 0.03, p.y);
  vec4 a = noised(q * 140.0), b = noised(q * 330.0 + 17.0), c = noised(q * 760.0 + 5.0);
  vec3 g = a.yzw * 0.0308 + b.yzw * 0.0231 + c.yzw * 0.0137;
  g -= n * dot(g, n);
  return normalize(n - amp * g);
}
void rubberAt(vec3 p, out float cov, out float rim) {
  cov = 0.0; rim = 0.0;
  if (uMembrane == 0) return;
  float dt; float sd = memSD(p, dt);
  if (abs(sd) > uBand * 1.6 || dt <= 0.0) return;
  cov = 1.0;
  rim = uTime > uTE ? 1.0 - smoothstep(0.0, uLipW, dt) : 0.0;
}
vec3 memNormal(vec3 p) {
  float e = 4e-4, t; vec3 g = vec3(0.0);
  for (int k = 0; k < 4 * uL1; k++) {
    vec3 o = vec3(((k + 3) >> 1) & 1, (k >> 1) & 1, k & 1) * 2.0 - 1.0;
    g += o * memSD(p + o * e, t);
  }
  return normalize(g);
}
vec3 bubbleLight(vec3 p) {
  vec3 d0 = uL0c - p, d1 = uL1c - p;
  float a0 = 4.0 * length(uL0u) * length(uL0v), a1 = 4.0 * length(uL1u) * length(uL1v);
  float w0 = a0 * max(dot(normalize(cross(uL0u, uL0v)), -normalize(d0)), 0.0) / dot(d0, d0);
  float w1 = a1 * max(dot(normalize(cross(uL1u, uL1v)), -normalize(d1)), 0.0) / dot(d1, d1);
  return (uL0e * w0 + uL1e * w1) * (0.9 / (4.0 * PI)) + vec3(uAmbient) * 0.6;
}

void main() {
  vec2 uv = (gl_FragCoord.xy + uJit) / uRes * 2.0 - 1.0;   // same sub-pixel jitter for every pixel (temporal AA)
  vec3 rd = normalize(uCamF + uCamR * uv.x * uTanHalf * uAspect + uCamU * uv.y * uTanHalf);
  vec3 ro = uCamPos;
  if (uLensR > 0.0) {                              // thin lens: jittered aperture sample, fixed focus plane
    vec3 pf = uCamPos + rd * (uFocus / dot(rd, uCamF));
    ro = uCamPos + uCamR * uLens.x + uCamU * uLens.y;
    rd = normalize(pf - ro);
  }
  vec3 rd0 = rd;
  vec3 col = vec3(0.0), thr = vec3(1.0);
  const vec3 sigA = vec3(0.35, 0.065, 0.02);     // pure water absorption [1/m]
  bool inside = false;
  float firstT = 1e9;
  for (int seg = 0; seg < 8 * uL1; seg++) {
    if (max(thr.r, max(thr.g, thr.b)) < 0.003) break;
    float t0b = 0.0, t1b = 0.0;
    bool inBox = uHasVol == 1 && boxHit(ro, rd, min(uVolMin, uAnMin), max(uVolMin + uVolSize, uAnMax), t0b, t1b);
    Hit h; h.m = 0; h.t = 1e9; h.n = vec3(0.0, 1.0, 0.0);
    vec3 ps = ro; bool surf = false, under = false;
    float tf = 1e9, m0 = 0.0, m1 = 0.0;
    if (inside) {
      // ---- through the water to the next exit, or the floor below
      tf = rd.y < -1e-5 ? -ro.y / rd.y : 1e9;
      m1 = min(inBox ? t1b : 0.0, tf);
    } else {
      // ---- in air: nearest of opaque scene and water surface
      h = traceOpaque(ro, rd, true);
      m0 = max(t0b, 0.0); m1 = min(t1b, h.t);
    }
    float aer = 0.0;
    float ts = (inside || inBox) ? marchSurface(ro, rd, m0, m1, inside, aer) : -1.0;
    if (inside) {
      float tt = min(ts, tf);
      thr *= exp(-sigA * tt);
      float tb = exp(-aer * uBubble);
      col += thr * (1.0 - tb) * bubbleLight(ro + rd * tt * 0.5);
      thr *= tb;
      if (tf <= ts + 1e-5) { h.t = tf; h.m = 1; under = true; }
      else { ps = ro + rd * ts; surf = true; }
    } else {
      if (seg == 0) firstT = ts >= 0.0 ? ts : h.t;
      if (ts >= 0.0) { ps = ro + rd * ts; surf = true; }
    }
    if (surf) {
      // ---- water (or latex-covered water) interface, entering or leaving
      vec3 n = waterNormal(ps), v = -rd;
      float cov, rim; rubberAt(ps, cov, rim);
      if (cov > 0.0) {
        n = memNormal(ps);
        float dtw; memSD(ps, dtw);
        float wr = uTime > uTE ? 1.0 - smoothstep(uLipW, 5.0 * uLipW, dtw) : 0.0;
        vec4 b = noised(ps * vec3(700.0, 1500.0, 700.0)), c = noised(ps * 2600.0 + 3.0);
        vec3 g = b.yzw * 0.5 * wr + c.yzw * (0.2 * wr + 0.02);   // buckling wrinkles near the tear + faint latex texture
        n = normalize(n + (g - n * dot(g, n)) * 0.12);
      } else n = ripples(ps, n);
      float op = mix(uRubberOpacity, 1.0, rim);
      vec3 jit3 = (vec3(hash2(gl_FragCoord.xy + uRand * 2.9 + float(seg)), hash2(gl_FragCoord.yx + uRand * 4.3), hash2(gl_FragCoord.xy * 0.7 + uRand)) - 0.5) * 0.16;
      if (!inside) {
        float ci = dot(v, n);
        if (ci < 0.02) { n = normalize(n - rd * (0.02 - ci)); ci = max(dot(v, n), 0.02); }
        float F = fresnelDiel(ci, cov > 0.0 ? 1.46 : 1.333);
        col += thr * F * envCheap(ps + n * 3e-4, reflect(rd, n), cov <= 0.0);
        if (cov > 0.0) col += thr * directLightNS(ps, n, v, vec3(0.0), 0.09, vec3(0.06));   // glossy-satin latex sheen
        thr *= 1.0 - F;
        if (cov > 0.0) {
          // stretched latex film: glossy clear coat, coloured diffuse body, mostly diffuse translucency
          vec3 tint = mix(uRubberCol, uRubberCol * uRubberCol, rim);
          col += thr * op * (directLightNS(ps, n, v, tint * 0.85, 0.45, vec3(0.0)) + tint * ambientTerm(n));
          col += thr * (1.0 - op) * (1.0 - uClarity) * uRubberCol * bubbleLight(ps) * 1.4;
          thr *= (1.0 - op) * uClarity * uRubberCol;
        }
        rd = refract(rd, n, 1.0 / 1.333); ro = ps - n * 3e-4; inside = true;
        if (cov > 0.0 && uAccum > 0.5) rd = normalize(rd + jit3);
      } else {
        vec3 td = refract(rd, -n, 1.333);
        if (dot(td, td) < 0.5) { rd = reflect(rd, n); ro = ps - n * 3e-4; continue; }   // total internal reflection
        float F = fresnelDiel(max(dot(rd, n), 1e-3), 1.0 / 1.333);
        col += thr * F * 0.5 * bubbleLight(ps);
        thr *= 1.0 - F;
        if (cov > 0.0) {
          // light striking the far side of the balloon glows through the thin red latex
          col += thr * (1.0 - 0.5 * op) * directLightNS(ps, n, rd, uRubberCol * 0.9, 0.5, vec3(0.0));
          col += thr * (op + (1.0 - op) * (1.0 - uClarity)) * uRubberCol * bubbleLight(ps) * 1.1;
          thr *= (1.0 - op) * uClarity * uRubberCol;
          if (uAccum > 0.5) td = normalize(td + jit3);
        }
        rd = td; ro = ps + n * 3e-4; inside = false;
      }
      continue;
    }
    // ---- opaque surfaces (also the floor seen through a puddle)
    if (h.m == 0) { col += thr * studioVoid(rd); break; }
    vec3 p = ro + rd * h.t;
    if (h.m == 6) { col += thr * rectEmit(p, uL0c, uL0u, uL0v, uL0e); break; }
    if (h.m == 7) { col += thr * rectEmit(p, uL1c, uL1u, uL1v, uL1e); break; }
    vec3 v = -rd, n = h.n, alb = vec3(0.0), F0 = vec3(0.04);
    float rough = 0.6, wet = 0.0;
    if (h.m == 1) {
      vec3 nb; alb = concrete(p.xz, rough, nb);
      wet = under ? 1.0 : floorWet(p.xz);
      alb *= mix(1.0, 0.42, wet); rough = mix(rough, 0.07, wet);
      n = normalize(mix(nb, vec3(0.0, 1.0, 0.0), wet));
      if (under) p.y = 1e-3;
    } else if (h.m == 2) { alb = vec3(uBackdrop); rough = 0.9; F0 = vec3(0.02); }
    else if (h.m == 3) { alb = vec3(0.72, 0.70, 0.66); rough = 0.8; F0 = vec3(0.03); }
    else if (h.m == 4) { alb = uRubberCol * 0.75; rough = 0.32; F0 = vec3(0.045); }
    else bulletMat(p, F0, rough);
    col += thr * (directLight(p, n, v, alb, under ? 0.3 : rough, under ? vec3(0.0) : F0) + alb * ambientTerm(n) * (h.m == 1 && !under ? waterAO(p, n) : 1.0));
    if (h.m == 1) col += thr * alb / PI * causticAt(p.xz);
    if (under) { inside = false; break; }
    float fr = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    if (h.m == 1 && wet > 0.02) {
      // thin film on rough concrete: broken, slightly blurred reflections
      vec3 nb2; float r2; concrete(p.xz * 1.7 + 3.1, r2, nb2);
      vec3 nw = normalize(mix(nb2, vec3(0.0, 1.0, 0.0), 0.55) + (uAccum > 0.5 ? (vec3(hash2(gl_FragCoord.xy + uRand * 7.7), 0.0, hash2(gl_FragCoord.yx + uRand * 3.3)) - 0.5) * 0.12 : vec3(0.0)));
      thr *= wet * 0.7 * (0.02 + 0.98 * fr); rd = reflect(rd, nw); ro = p + nw * 1e-3; continue;
    }
    if (h.m == 5) {                                 // metal: glossy reflection, blurred by the jacket's roughness
      vec3 jr = vec3(hash2(gl_FragCoord.xy + uRand * 5.1), hash2(gl_FragCoord.yx + uRand * 8.3), hash2(gl_FragCoord.xy * 1.3 + uRand * 2.2)) - 0.5;
      vec3 nr = normalize(n + jr * rough * 0.9);
      thr *= (F0 + (1.0 - F0) * fr) * 0.85; rd = reflect(rd, nr); if (dot(rd, n) < 0.0) rd = reflect(rd, n);
      ro = p + n * 2e-4; continue;
    }
    if (h.m == 4) col += thr * (0.045 + 0.955 * fr) * 0.5 * envCheap(p + n * 2e-4, reflect(rd, n), false);
    break;
  }
  if (inside) col += thr * bubbleLight(ro) * 0.3;
  col = max(col, vec3(0.0));
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 60.0) col *= 60.0 / lum;               // firefly clamp (brighter than any softbox)
  float zv = min(firstT * dot(rd0, uCamF), uFar * 0.999);
  oColor = vec4(col, 1.0);
  oDepth = vec4(zv, 0.0, 0.0, 1.0);
  oVel = vec4(0.0);
  float ndc = (uFar + uNear) / (uFar - uNear) - 2.0 * uFar * uNear / ((uFar - uNear) * zv);
  gl_FragDepth = clamp(0.5 * ndc + 0.5, 0.0, 1.0);
}
`;
