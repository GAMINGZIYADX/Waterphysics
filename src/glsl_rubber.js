/* ==========================================================================
   GLSL: simulated latex.
   peel*   : rasterises the (fixed) original balloon mesh into the six faces of
             the peel cube map, with each vertex's detach time from the
             membrane simulation - the ray tracer draws latex wherever that
             time is still in the future.
   rubber* : the latex that has left the water (flaps, rolled rims, scraps,
             the rag on the knot) drawn as a thin translucent rubber sheet,
             depth-tested against the ray-traced scene.
   ========================================================================== */
WB_GLSL.peelVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aDir;
layout(location = 1) in float aT;
uniform int uFace;
out float vT;
void main() {
  vec3 d = aDir, f;                               // (sc, tc, major axis) per GL cube-map face
  if (uFace == 0) f = vec3(-d.z, -d.y, d.x);
  else if (uFace == 1) f = vec3(d.z, -d.y, -d.x);
  else if (uFace == 2) f = vec3(d.x, d.z, d.y);
  else if (uFace == 3) f = vec3(d.x, -d.z, -d.y);
  else if (uFace == 4) f = vec3(d.x, -d.y, d.z);
  else f = vec3(-d.x, -d.y, -d.z);
  gl_Position = vec4(f.x, f.y, 0.0, f.z);
  vT = aT;
}`;
WB_GLSL.peelFS = `#version 300 es
precision highp float;
in float vT;
out vec4 o;
void main() { o = vec4(vT, 0.0, 0.0, 1.0); }`;
// Gaussian blur of one face of the detach-time field: rounds off the mesh's saw-tooth along the tears
WB_GLSL.peelBlurFS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform ivec2 uDir;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), mx = textureSize(uSrc, 0) - 1;
  float s = 0.0;
  for (int k = -4; k <= 4; k++) s += texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), mx), 0).r * exp(-float(k * k) / 8.0);
  o = vec4(s / 4.89803, 0.0, 0.0, 1.0);             // sum of the 9 weights
}`;

/* Ripple rings: concentric capillary waves spreading from both bullet holes over the bare water,
   evaluated once per frame per direction into a cube map (surface slope, world space) so the
   ray tracer only has to look them up. */
WB_GLSL.ringFS = `#version 300 es
precision highp float;
uniform int uFace; uniform float uN, uTime, uTE, uTX, uR, uCapRing; uniform int uHasExit;
uniform vec3 uEDir, uXDir, uC, uEntry;
uniform float uBlastV, uBK, uBV0, uBL;         // blast inflation: outflow speed scale, bullet drag constant, speed, path
out vec4 o;
void main() {
  vec2 st = gl_FragCoord.xy / uN * 2.0 - 1.0; float sc = st.x, tc = st.y; vec3 d;
  if (uFace == 0) d = vec3(1.0, -tc, -sc); else if (uFace == 1) d = vec3(-1.0, -tc, sc);
  else if (uFace == 2) d = vec3(sc, 1.0, tc); else if (uFace == 3) d = vec3(sc, -1.0, -tc);
  else if (uFace == 4) d = vec3(sc, -tc, 1.0); else d = vec3(-sc, -tc, -1.0);
  d = normalize(d);
  vec2 dt = uTime - vec2(uTE, uTX);
  vec2 on = step(0.0, dt) * step(dt, vec2(0.08)) * vec2(1.0, float(uHasExit));
  vec2 ca = clamp(vec2(dot(d, uEDir), dot(d, uXDir)), -1.0, 1.0);
  vec2 s = acos(ca) * uR;                                              // arc distance from each hole
  vec2 front = 0.003 + 0.9 * dt + 0.024 * (1.0 - exp(-max(dt, 0.0) / 0.004));   // fast at first, then capillary speed
  vec2 env = on * exp(-max(s - front, 0.0) / 0.002) * exp(-s / 0.035) * exp(-max(dt, 0.0) / 0.035) * smoothstep(0.0, 0.004, s);
  vec2 w = uCapRing * env * cos((s - front) * 1300.0);
  vec3 aE = d * ca.x - uEDir, aX = d * ca.y - uXDir;                   // directions away from each hole
  // a violent shot inflates the skin before it tears: radial outflow away from the shot line once the
  // bullet has passed (w: extra radius [m], used by the latex surface)
  float bulge = 0.0;
  if (uBlastV > 0.0) {
    float c = d.y, cp = max(c, 0.0), cn = max(-c, 0.0), c3 = cp * cp * cp, c12 = c3 * c3 * c3 * c3;
    vec3 q = uC + d * uR * (1.0 + 0.035 * (1.0 - c * c) + 0.03 * cn * cn - 0.05 * cp * cp + 0.13 * c12) - uEntry;
    float tp = (exp(uBK * clamp(q.x, 0.0, uBL)) - 1.0) / (uBK * uBV0), ra = max(length(q.yz), 0.006);
    bulge = min(38.0, uBlastV * min(2.2, 0.05 / ra)) * max(uTime - tp, 0.0) * max(0.3, dot(vec3(0.0, q.yz) / ra, d));
  }
  o = vec4(aE * (w.x / max(length(aE), 1e-5)) + aX * (w.y / max(length(aX), 1e-5)), bulge);
}`;

/* The bullet: its design's profile revolved about the flight line (true dimensions, see
   WB_Core.bulletMesh), drawn as a metal mesh after the ray tracer. */
WB_GLSL.bulletVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aXRA;               // distance behind the tip, radius, angle
layout(location = 1) in vec3 aNM;                // axial / radial normal component, material
uniform mat4 uViewProj; uniform vec2 uRes, uJit, uLensShift;
uniform vec3 uBulletTip, uBulletDir;
out vec3 vP; out vec3 vN; out float vMat;
void main() {
  vec3 d = uBulletDir, t = abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 e1 = normalize(cross(d, t)), e2 = cross(d, e1), rad = e1 * cos(aXRA.z) + e2 * sin(aXRA.z);
  vP = uBulletTip - d * aXRA.x + rad * aXRA.y;
  vN = -d * aNM.x + rad * aNM.y;
  vMat = aNM.z;
  gl_Position = uViewProj * vec4(vP, 1.0);
  gl_Position.xy += (uJit * 2.0 / uRes + uLensShift) * gl_Position.w;
}`;
WB_GLSL.bulletFS = `
uniform vec3 uBulletF0, uBulletShift; uniform float uBulletRough;
uniform mat4 uVP0, uPrevVP;
in vec3 vP; in vec3 vN; in float vMat;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVel;
void main() {
  vec3 v = normalize(uCamPos - vP), n = normalize(vN);
  bool lead = vMat > 0.5 && vMat < 1.5, groove = vMat > 1.5;     // bare lead / knurled cannelure
  vec3 F0 = lead ? vec3(0.4, 0.41, 0.44) : uBulletF0 * (groove ? 0.8 : 1.0);     // oxidised lead is dull grey
  float rough = lead ? 0.55 : uBulletRough * (groove ? 1.7 : 0.6);               // drawn jackets are near-polished
  // rough-metal reflection: a jittered mirror direction per frame, averaged by the temporal resolve
  vec3 jr = vec3(hash2(gl_FragCoord.xy + uRand * 5.1), hash2(gl_FragCoord.yx + uRand * 8.3), hash2(gl_FragCoord.xy * 1.3 + uRand * 2.2)) - 0.5;
  vec3 r = reflect(-v, normalize(n + jr * rough * 0.8));
  if (dot(r, n) < 0.0) r = reflect(-v, n);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 col = directLightNS(vP, n, v, vec3(0.0), rough, F0) + F * envCheap(vP + n * 1e-4, r, false);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 40.0) col *= 40.0 / lum;
  oColor = vec4(col, 1.0);
  vec4 c0 = uVP0 * vec4(vP, 1.0), c1 = uPrevVP * vec4(vP - uBulletShift, 1.0);
  oVel = vec4(0.5 * (c0.xy / c0.w - c1.xy / c1.w), 1.0, 1.0);
}`;

WB_GLSL.rubberVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aN;
layout(location = 2) in float aTk;               // thickness relative to the inflated skin
uniform mat4 uViewProj; uniform vec2 uRes, uJit, uLensShift;
out vec3 vP; out vec3 vN; out float vTk;
void main() {
  gl_Position = uViewProj * vec4(aP, 1.0);
  gl_Position.xy += (uJit * 2.0 / uRes + uLensShift) * gl_Position.w;
  vP = aP; vN = aN; vTk = aTk;
}`;
WB_GLSL.rubberFS = `
in vec3 vP; in vec3 vN; in float vTk;
layout(location = 0) out vec4 oColor;
void main() {
  vec3 v = normalize(uCamPos - vP);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;                     // a thin sheet: lit from whichever side we see
  float tk = clamp(vTk, 0.7, 14.0), crumple = clamp((tk - 1.3) / 5.0, 0.0, 1.0);
  vec4 w1 = noised(vP * 800.0), w2 = noised(vP * 2100.0 + 7.0);
  vec3 g = w1.yzw * 0.6 + w2.yzw * 0.3; g -= n * dot(g, n);
  n = normalize(n + g * (0.05 + 0.3 * crumple));   // wrinkles where the rubber has bunched up
  // relaxed (retracted) rubber is ~7x thicker than the inflated skin: deeper colour, opaque
  float op = 1.0 - pow(1.0 - clamp(0.2 + 0.7 * uRubberOpacity, 0.05, 0.97), tk);
  vec3 body = uRubberCol * mix(1.0, 0.65, crumple);
  vec3 diff = directLightNS(vP, n, v, body * 0.9, 0.5, vec3(0.0)) + body * ambientTerm(n);
  vec3 trans = body * (uL0e * rectIrr(vP, -n, uL0c, uL0u, uL0v) + uL1e * rectIrr(vP, -n, uL1c, uL1u, uL1v)) / PI * exp(-0.3 * tk);
  float F = min(0.045 + 0.955 * pow(1.0 - max(dot(n, v), 0.0), 5.0), 0.3);    // satin: no white paper-like edges
  vec3 sheen = directLightNS(vP, n, v, vec3(0.0), 0.4, vec3(0.04)) * 0.7 + F * 0.3 * envCheap(vP + n * 2e-4, reflect(-v, n), false);
  vec3 col = (diff + trans) * op + sheen;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 40.0) col *= 40.0 / lum;
  oColor = vec4(col, op);
}`;
