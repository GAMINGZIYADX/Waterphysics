/* ==========================================================================
   GLSL: density splatting, droplet impostors, mist, post-processing
   ========================================================================== */
WB_GLSL.fsQuadVS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// ---- particle -> 3D density texture, one z-slice per draw (additive)
WB_GLSL.splatVS = `#version 300 es
layout(location = 0) in vec4 aP;
uniform vec3 uVolMin; uniform float uCell; uniform vec2 uGrid; uniform float uSliceZ; uniform float uH;
out vec2 vC; out float vDz2; out float vAer; out float vFl;
void main() {
  // particles lying on the floor are splatted as flattened (pancake) kernels -> thin continuous film
  float fl = aP.w >= 2.0 ? 1.0 : 0.0;
  float hx = uH * (1.0 + 1.6 * fl);
  float dz = aP.z - uSliceZ, k = 1.0 - dz * dz / (hx * hx);
  if (k <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
  vec2 c = (aP.xy - uVolMin.xy) / uCell;
  gl_Position = vec4(c / uGrid * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.0 * hx * sqrt(k) / uCell + 2.0;
  vC = c; vDz2 = dz * dz; vAer = aP.w - 2.0 * fl; vFl = fl;
}`;
WB_GLSL.splatFS = `#version 300 es
precision highp float;
in vec2 vC; in float vDz2; in float vAer; in float vFl;
uniform float uCell, uH;
out vec4 o;
void main() {
  vec2 d = (gl_FragCoord.xy - vC) * uCell;
  float hx = uH * (1.0 + 1.6 * vFl), hy = uH * (1.0 - 0.6 * vFl);   // floor water: wide, flat kernels (smooth film)
  float q = 1.0 - (d.x * d.x + vDz2) / (hx * hx) - d.y * d.y / (hy * hy);
  if (q <= 0.0) discard;
  float w = q * q * q;
  o = vec4(w, w * vAer, 0.0, 0.0);
}`;

// ---- separable binomial smoothing of the density volume (one axis per pass, one z-slice per draw)
WB_GLSL.blurFS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler3D uSrc; uniform ivec3 uAxis; uniform int uZ; uniform ivec3 uDims;
out vec4 o;
vec4 tap(ivec3 p) { return texelFetch(uSrc, clamp(p, ivec3(0), uDims - 1), 0); }
void main() {
  ivec3 p = ivec3(ivec2(gl_FragCoord.xy), uZ);
  o = (tap(p - 2 * uAxis) + tap(p + 2 * uAxis)) * 0.0625 + (tap(p - uAxis) + tap(p + uAxis)) * 0.25 + tap(p) * 0.375;
}`;

// ---- ray-traced droplet impostors (spray drops + detached fluid particles)
// Fast drops and liquid threads are drawn as ellipsoids stretched along their motion
// (same volume), and write a screen-space motion vector for the temporal resolve.
WB_GLSL.dropVS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;   // p0.xyz, t0
layout(location = 2) in vec4 aB;   // v0.xyz, radius
layout(location = 3) in vec4 aC;   // tau, tLand, seed, kind (0 spray: drag trajectory, 1 fluid: straight line around t0)
uniform mat4 uViewProj, uVP0, uPrevVP; uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uTime, uPrevTime, uG, uTanHalf, uStretch; uniform vec2 uRes; uniform vec2 uJit; uniform vec2 uLensShift;
out vec3 vW; out vec3 vCen; out float vRad; out float vCov; out vec3 vAx; out float vEl; flat out vec3 vVel;
vec3 posAt(float t, out bool ok, out vec3 vel) {
  float dt = t - aA.w;
  bool fl = aC.w > 0.5;
  ok = (fl || dt >= 0.0) && t <= aC.y;
  if (fl) { vel = aB.xyz; return aA.xyz + aB.xyz * dt; }
  float tau = aC.x; vec3 vt = vec3(0.0, -uG * tau, 0.0);
  float e = exp(-max(dt, 0.0) / tau);
  vel = vt + (aB.xyz - vt) * e;
  return aA.xyz + vt * dt + (aB.xyz - vt) * tau * (1.0 - e);
}
void main() {
  bool ok, okp; vec3 vel, velp;
  vec3 p = posAt(uTime, ok, vel);
  if (!ok) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float dist = dot(p - uCamPos, uCamF);
  if (dist < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 pp = posAt(uPrevTime, okp, velp);
  float pxm = uRes.y / (2.0 * uTanHalf * dist);
  float r = aB.w, rpx = r * pxm;
  float rr = max(rpx, 0.75) / pxm;           // inflate sub-pixel drops, keep energy via coverage
  vCov = min(1.0, (rpx * rpx) / (0.75 * 0.75));
  float sp = length(vel);
  vEl = aC.w > 0.5 ? clamp(1.0 + sp / 3.5, 1.0, 3.2) : clamp(1.0 + (sp - 6.0) / 30.0, 1.0, 1.6);
  vEl = 1.0 + (vEl - 1.0) * uStretch;           // motion-blur setting: streak length
  vAx = sp > 1e-4 ? vel / sp : vec3(0.0, 1.0, 0.0);
  float bound = rr * pow(vEl, 0.6667);
  vec3 w = p + (uCamR * aCorner.x + uCamU * aCorner.y) * (bound * 1.5 + 1.0 / pxm);
  gl_Position = uViewProj * vec4(w, 1.0);
  gl_Position.xy += (uJit * 2.0 / uRes + uLensShift) * gl_Position.w;
  vW = w; vCen = p; vRad = rr;
  vec4 c0 = uVP0 * vec4(p, 1.0), c1 = uPrevVP * vec4(pp, 1.0);
  vVel = okp && c1.w > 0.0 ? vec3(0.5 * (c0.xy / c0.w - c1.xy / c1.w), 1.0) : vec3(0.0);
}`;
WB_GLSL.dropFS = `
in vec3 vW; in vec3 vCen; in float vRad; in float vCov; in vec3 vAx; in float vEl; flat in vec3 vVel;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVel;
// ray vs. ellipsoid with long axis vAx: (t near, t far, 1 - (miss distance)^2 in the unit-sphere frame)
vec3 hitEll(vec3 ro, vec3 rd, float rL, float rP) {
  vec3 o = ro - vCen; float k = 1.0 / rL - 1.0 / rP;
  vec3 o2 = o / rP + vAx * dot(vAx, o) * k, d2 = rd / rP + vAx * dot(vAx, rd) * k;
  float a = dot(d2, d2), b = dot(o2, d2), c = dot(o2, o2) - 1.0, disc = b * b - a * c;
  if (disc <= 0.0) return vec3(-1.0, -1.0, 0.0);
  float sq = sqrt(disc);
  return vec3((-b - sq) / a, (-b + sq) / a, disc / a);
}
vec3 nEll(vec3 p, float rL, float rP) {
  vec3 x = p - vCen; float s = dot(x, vAx);
  return normalize((x - vAx * s) / (rP * rP) + vAx * s / (rL * rL));
}
// what a drop shows through itself: the lit red latex if the ray meets the still-covered balloon, else the studio
vec3 dropBack(vec3 p, vec3 d) {
  vec3 oc = p - uC; float b = dot(oc, d), c = dot(oc, oc) - uR * uR * 1.1, disc = b * b - c;
  if (uMembrane == 1 && disc > 0.0 && -b - sqrt(disc) > 0.0) {
    vec3 q = p + d * (-b - sqrt(disc)), nq = normalize(q - uC);
    if (peelT(nq) > uTime) return uRubberCol * ((uL0e * rectIrr(q, nq, uL0c, uL0u, uL0v) + uL1e * rectIrr(q, nq, uL1c, uL1u, uL1v)) / PI * 0.85 + ambientTerm(nq));
  }
  return envCheap(p + d * 1e-4, d, true);
}
void main() {
  float rL = vRad * pow(vEl, 0.6667), rP = vRad * pow(vEl, -0.3333);
  vec3 rd = normalize(vW - uCamPos);
  vec3 h = hitEll(uCamPos, rd, rL, rP);
  if (h.x <= 0.0) discard;
  float t = h.x, disc = h.z;
  vec3 p = uCamPos + rd * t, n = nEll(p, rL, rP);
  float F = fresnelDiel(max(-dot(rd, n), 1e-3), 1.333);
  vec3 cR = envCheap(p + n * 1e-4, reflect(rd, n), true);
  vec3 d1 = refract(rd, n, 1.0 / 1.333);
  vec3 h2 = hitEll(p, d1, rL, rP);
  vec3 p2 = p + d1 * max(h2.y, 0.0), n2 = nEll(p2, rL, rP);
  vec3 d2 = refract(d1, -n2, 1.333);
  if (dot(d2, d2) < 0.5) d2 = reflect(d1, -n2);
  float F2 = fresnelDiel(max(dot(d1, n2), 1e-3), 1.0 / 1.333);
  vec3 cT = dropBack(p2, d2) * (1.0 - F2);
  vec3 col = F * cR + (1.0 - F) * cT;
  // slightly broadened specular glints of the two softboxes (drops are never perfectly spherical)
  col += rectSpec(p, n, -rd, 0.08, vec3(0.02), uL0c, uL0u, uL0v, uL0e) + rectSpec(p, n, -rd, 0.08, vec3(0.02), uL1c, uL1u, uL1v, uL1e);
  if (vCov < 0.999) {
    // unresolved drop: area-averaged radiance of a water sphere (mirror-sphere glint average
    // + strongly forward-peaked refraction lobe for lights behind it + attenuated background)
    vec3 g = vec3(0.0);
    vec3 d0 = uL0c - vCen, d1 = uL1c - vCen;
    float o0 = 4.0 * length(uL0u) * length(uL0v) * max(dot(normalize(cross(uL0u, uL0v)), -normalize(d0)), 0.0) / dot(d0, d0);
    float o1 = 4.0 * length(uL1u) * length(uL1v) * max(dot(normalize(cross(uL1u, uL1v)), -normalize(d1)), 0.0) / dot(d1, d1);
    float c0 = dot(normalize(d0), rd), c1 = dot(normalize(d1), rd);
    g += uL0e * o0 * (0.012 + 0.6 * exp(-(1.0 - c0) * 9.0));
    g += uL1e * o1 * (0.012 + 0.6 * exp(-(1.0 - c1) * 9.0));
    col = g + 0.75 * dropBack(vCen + rd * vRad * 2.0, rd);
  }
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 40.0) col *= 40.0 / lum;
  float edge = smoothstep(0.0, 0.12, disc);
  float a = vCov * edge;
  oColor = vec4(col * a, a);
  oVel = vVel.z > 0.5 ? vec4(vVel.xy * a, a, a) : vec4(0.0);
  float zv = t * dot(rd, uCamF);
  float ndc = (uFar + uNear) / (uFar - uNear) - 2.0 * uFar * uNear / ((uFar - uNear) * zv);
  gl_FragDepth = 0.5 * ndc + 0.5;
}`;

// ---- mist puffs: clouds of micron droplets, strongly forward scattering
WB_GLSL.mistVS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;   // p0.xyz, t0
layout(location = 2) in vec4 aB;   // v0.xyz, r0
layout(location = 3) in vec4 aC;   // tau, life, seed, density
uniform mat4 uViewProj; uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uTime, uG, uMist, uAmbient; uniform vec2 uRes; uniform vec2 uJit; uniform vec2 uLensShift;
uniform vec3 uL0c, uL0u, uL0v, uL0e, uL1c, uL1u, uL1v, uL1e;
out vec2 vUV; out vec3 vP; out float vA; out float vR; out float vZ; out vec3 vL;
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
void main() {
  float dt = uTime - aA.w;
  if (dt < 0.0 || dt > aC.y * 1.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float tau = aC.x; vec3 vt = vec3(0.0, -uG * tau, 0.0);
  vec3 p = aA.xyz + vt * dt + (aB.xyz - vt) * tau * (1.0 - exp(-dt / tau));
  p.y = max(p.y, 0.004);
  float r = aB.w + 0.06 * sqrt(dt) + 0.25 * tau * length(aB.xyz) * (1.0 - exp(-dt / tau));
  float a = aC.w * uMist * (aB.w * aB.w) / (r * r) * exp(-dt / aC.y) * smoothstep(0.0, 0.00025, dt);
  // random in-plane rotation for less regular sprites
  float ang = aC.z * 6.2831;
  vec2 cr = vec2(cos(ang) * aCorner.x - sin(ang) * aCorner.y, sin(ang) * aCorner.x + cos(ang) * aCorner.y);
  vec3 w = p + (uCamR * cr.x + uCamU * cr.y) * r * 1.8;
  gl_Position = uViewProj * vec4(w, 1.0);
  gl_Position.xy += (uJit * 2.0 / uRes + uLensShift) * gl_Position.w;
  vUV = aCorner * 1.8; vP = p; vA = a; vR = r; vZ = dot(w - uCamPos, uCamF);
  // single scattering of both softboxes (Henyey-Greenstein, forward peaked): constant across a puff
  vec3 v = normalize(uCamPos - p), d0 = p - uL0c, d1 = p - uL1c;
  float a0 = 4.0 * length(uL0u) * length(uL0v) * max(dot(normalize(cross(uL0u, uL0v)), normalize(d0)), 0.0) / dot(d0, d0);
  float a1 = 4.0 * length(uL1u) * length(uL1v) * max(dot(normalize(cross(uL1u, uL1v)), normalize(d1)), 0.0) / dot(d1, d1);
  vL = uL0e * a0 * hg(dot(normalize(d0), v), 0.72) + uL1e * a1 * hg(dot(normalize(d1), v), 0.72) + vec3(uAmbient) * 0.35;
}`;
WB_GLSL.mistFS = `
uniform sampler2D uDepthTex;
in vec2 vUV; in vec3 vP; in float vA; in float vR; in float vZ; in vec3 vL;
out vec4 oColor;
void main() {
  float d2 = dot(vUV, vUV);
  float n = vnoise2(vUV * 1.7 + vec2(vP.x * 40.0 + vP.z * 31.0, vP.y * 37.0));
  float w = exp(-2.6 * d2) * (0.6 + 0.8 * n);
  float zs = texelFetch(uDepthTex, ivec2(gl_FragCoord.xy), 0).r;
  float soft = clamp((zs - vZ) / max(vR, 0.004), 0.0, 1.0);
  float a = clamp(vA * w * soft, 0.0, 0.95);
  if (a < 1e-4) discard;
  oColor = vec4(vL * a, a);
}`;

// ---- post
/* Temporal anti-aliasing / upsampling resolve, written at display resolution.
   Every frame the camera is jittered by a sub-pixel offset; the jittered samples
   of the (possibly lower-resolution) render are splatted onto the display grid
   with a Gaussian reconstruction filter and blended into a history buffer:
     mode 0: restart from this frame alone
     mode 1: moving image: history reprojected (camera motion from depth, object
             motion vectors for droplets), clipped to this frame's neighbourhood
             colours (variance clipping in YCoCg) and blended ~1:8
     mode 2: frozen image: plain running average of every sample (supersampling)
   rgb = colour, a = accumulated filter weight. */
WB_GLSL.taaFS = `#version 300 es
precision highp float;
uniform sampler2D uCur, uDepth, uVel, uHist;
uniform vec2 uRenderRes, uOutRes, uJit;
uniform int uMode;
uniform mat4 uPrevVP;
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uTanHalf, uAspect, uMaxW;
out vec4 o;
vec3 toYC(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYC(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
vec3 squash(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 unsquash(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3); }
vec4 histCR(vec2 uv) {                          // Catmull-Rom history fetch (5 bilinear taps)
  vec2 ts = vec2(textureSize(uHist, 0)), sp = uv * ts, tp = floor(sp - 0.5) + 0.5, f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t12 = (tp + w2 / w12) / ts, t0 = (tp - 1.0) / ts, t3 = (tp + 2.0) / ts;
  vec4 r = texture(uHist, vec2(t12.x, t0.y)) * (w12.x * w0.y) + texture(uHist, vec2(t0.x, t12.y)) * (w0.x * w12.y)
         + texture(uHist, t12) * (w12.x * w12.y) + texture(uHist, vec2(t3.x, t12.y)) * (w3.x * w12.y)
         + texture(uHist, vec2(t12.x, t3.y)) * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, vec4(0.0));
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 q = p * uRenderRes / uOutRes;             // display pixel centre in render-pixel units
  ivec2 c0 = ivec2(floor(q - uJit)), mx = ivec2(uRenderRes) - 1, tn = c0;
  vec3 sum = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), nearest = vec3(0.0);
  float wsum = 0.0, zmin = 1e9, dn = 1e9;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 t = clamp(c0 + ivec2(i, j), ivec2(0), mx);
    vec3 c = texelFetch(uCur, t, 0).rgb;
    vec2 d = vec2(t) + 0.5 + uJit - q;
    float d2 = dot(d, d), w = exp(-2.3 * d2);
    sum += c * w; wsum += w;
    vec3 y = toYC(squash(c)); m1 += y; m2 += y * y;
    zmin = min(zmin, texelFetch(uDepth, t, 0).r);
    if (d2 < dn) { dn = d2; nearest = c; tn = t; }
  }
  vec3 cur = wsum > 1e-3 ? sum / wsum : nearest;
  if (uMode == 0) { o = vec4(cur, wsum); return; }
  if (uMode == 2) {
    vec4 h = texelFetch(uHist, ivec2(p), 0);
    float W = h.a + wsum;
    o = vec4((h.rgb * h.a + sum) / max(W, 1e-6), W);
    return;
  }
  vec2 uvp;
  vec4 vel = texelFetch(uVel, tn, 0);
  if (vel.b > 0.3) uvp = p / uOutRes - vel.rg / vel.b;            // droplet: its own motion
  else {                                                            // everything else: camera reprojection
    vec2 ndc = p / uOutRes * 2.0 - 1.0;
    vec3 rd = normalize(uCamF + uCamR * ndc.x * uTanHalf * uAspect + uCamU * ndc.y * uTanHalf);
    vec4 pc = uPrevVP * vec4(uCamPos + rd * (zmin / dot(rd, uCamF)), 1.0);
    uvp = pc.w > 0.0 ? pc.xy / pc.w * 0.5 + 0.5 : vec2(-1.0);
  }
  if (any(lessThan(uvp, vec2(0.0))) || any(greaterThan(uvp, vec2(1.0)))) { o = vec4(cur, wsum); return; }
  vec4 h = histCR(uvp);
  vec3 mu = m1 / 9.0, sg = sqrt(max(m2 / 9.0 - mu * mu, 0.0)) * 1.25 + 1e-4;
  vec3 hy = toYC(squash(h.rgb)), dv = hy - mu;
  vec3 u = abs(dv / sg); float um = max(u.x, max(u.y, u.z));
  vec3 hist = um > 1.0 ? unsquash(fromYC(mu + dv / um)) : h.rgb;
  float hw = min(h.a, uMaxW) * (um > 1.0 ? mix(1.0, 0.5, clamp(um - 1.0, 0.0, 1.0)) : 1.0);
  float W = hw + wsum;
  o = vec4((hist * hw + sum) / W, W);
}`;
WB_GLSL.downFS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uFirst;
out vec4 o;
vec3 s(vec2 uv) { vec3 c = texture(uSrc, uv).rgb; return uFirst > 0.5 ? c / (1.0 + max(c.r, max(c.g, c.b)) * 0.25) : c; }
void main() {
  vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
  vec2 t = uTexel;
  vec3 a = s(uv + t * vec2(-2, 2)), b = s(uv + t * vec2(0, 2)), c = s(uv + t * vec2(2, 2));
  vec3 d = s(uv + t * vec2(-2, 0)), e = s(uv), f = s(uv + t * vec2(2, 0));
  vec3 g = s(uv + t * vec2(-2, -2)), h = s(uv + t * vec2(0, -2)), i = s(uv + t * vec2(2, -2));
  vec3 j = s(uv + t * vec2(-1, 1)), k = s(uv + t * vec2(1, 1)), l = s(uv + t * vec2(-1, -1)), m = s(uv + t * vec2(1, -1));
  vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = vec4(r, 1.0);
}`;
WB_GLSL.upFS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRadius;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uSrc, 0) * 2);
  vec2 t = uTexel * uRadius;
  vec3 r = texture(uSrc, uv).rgb * 4.0;
  r += (texture(uSrc, uv + vec2(-t.x, 0)).rgb + texture(uSrc, uv + vec2(t.x, 0)).rgb + texture(uSrc, uv + vec2(0, -t.y)).rgb + texture(uSrc, uv + vec2(0, t.y)).rgb) * 2.0;
  r += texture(uSrc, uv + vec2(-t.x, -t.y)).rgb + texture(uSrc, uv + vec2(t.x, -t.y)).rgb + texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(t.x, t.y)).rgb;
  o = vec4(r / 16.0, 1.0);
}`;
WB_GLSL.finalFS = `#version 300 es
precision highp float;
uniform sampler2D uHDR, uBloom; uniform float uExposure, uBloomAmt, uGrain, uTimeSeed, uVignette;
uniform vec2 uOutRes;
out vec4 o;
vec3 aces(vec3 x) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 oo = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = i * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537, b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(oo * (a / b), 0.0, 1.0);
}
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 uv = gl_FragCoord.xy / uOutRes;
  // subtle lateral chromatic aberration toward the frame edges
  vec2 dc = (uv - 0.5); float ca = 0.0004 * dot(dc, dc) * 4.0;
  vec3 c;
  c.r = texture(uHDR, uv - dc * ca).r; c.g = texture(uHDR, uv).g; c.b = texture(uHDR, uv + dc * ca).b;
  c += texture(uBloom, uv).rgb * uBloomAmt;
  c *= uExposure;
  float vig = 1.0 - uVignette * smoothstep(0.35, 1.05, length(dc * vec2(1.0, 0.85)) * 1.45);
  c *= vig;
  c = aces(c);
  c = pow(c, vec3(1.0 / 2.2));
  float g = h12(gl_FragCoord.xy + uTimeSeed * 173.0) + h12(gl_FragCoord.yx * 1.3 + uTimeSeed * 71.0) - 1.0;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c += g * uGrain * (0.35 + 0.65 * (1.0 - lum)) * 0.06;
  o = vec4(c, 1.0);
}`;
