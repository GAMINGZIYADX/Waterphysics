/* ==========================================================================
   GLSL: shared scene description, lights, materials, noise
   ========================================================================== */
var WB_GLSL = WB_GLSL || {};
WB_GLSL.common = `
#define PI 3.14159265359
precision highp float;
precision highp sampler3D;

uniform float uTime;          // simulation time [s]
uniform float uG;             // gravity [m/s^2]
uniform vec3  uCamPos;
uniform vec3  uCamR, uCamU, uCamF;
uniform float uTanHalf, uAspect, uNear, uFar;
uniform vec2  uRes;
uniform float uFrame;         // accumulation frame index (for jitter)
uniform int   uL1;            // always 1: makes loop bounds dynamic so the D3D compiler does not unroll them

// balloon + rubber peel model (mirrors shared.js)
uniform vec3  uC;  uniform float uR;
uniform vec3  uEDir, uXDir;
uniform float uTE, uTX, uRate, uKappa, uPeelEnd;
uniform int   uHasExit;
uniform vec3  uEU, uEV, uXU, uXV;      // bases around the entry / exit hole axes (crack azimuths)
uniform float uTent, uLipH, uLipW;     // latex tent ahead of the bullet, rolled lip height / width
uniform float uShock, uCapRing;        // impact shock ring on the skin [m], capillary ripple strength on bare water
uniform vec3  uRubberCol;  uniform float uRubberOpacity;

// lights: rectangular softboxes (centre, half-extent vectors, radiance)
uniform vec3 uL0c, uL0u, uL0v, uL0e;
uniform vec3 uL1c, uL1u, uL1v, uL1e;
uniform float uAmbient, uBackdrop;

// ---------------------------------------------------------------- utils
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// value noise with analytic derivatives: (value, d/dx, d/dy, d/dz)
vec4 noised(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash3(i), b = hash3(i + vec3(1,0,0)), c = hash3(i + vec3(0,1,0)), d = hash3(i + vec3(1,1,0));
  float e = hash3(i + vec3(0,0,1)), f1 = hash3(i + vec3(1,0,1)), g = hash3(i + vec3(0,1,1)), h = hash3(i + vec3(1,1,1));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
  return vec4(k0 + k1*u.x + k2*u.y + k3*u.z + k4*u.x*u.y + k5*u.y*u.z + k6*u.z*u.x + k7*u.x*u.y*u.z,
              du * vec3(k1 + k4*u.y + k6*u.z + k7*u.y*u.z, k2 + k5*u.z + k4*u.x + k7*u.z*u.x, k3 + k6*u.x + k5*u.y + k7*u.x*u.y));
}
float vnoise2(vec2 x) {
  vec2 i = floor(x), f = fract(x); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1,0)), u.x), mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), u.x), u.y);
}

// ---------------------------------------------------------------- balloon shape / peel
float shapeR(float c) {
  float cp = max(c, 0.0), cn = max(-c, 0.0);
  float c3 = cp * cp * cp, c12 = c3 * c3 * c3 * c3;
  return 1.0 + 0.035 * (1.0 - c * c) + 0.03 * cn * cn - 0.05 * cp * cp + 0.13 * c12;
}
uniform samplerCube uPeel;   // time the latex leaves each direction (baked from the physics model)
float peelT(vec3 d) { return textureLod(uPeel, d, 0.0).r; }
uniform samplerCube uRip;    // ring pass: capillary ripple slopes (rgb) and blast inflation of the skin (a) [m]
// distance to the latex surface (analytic): sag shape + tent at the exit + rolled lip at the tear front
float memSD(vec3 p, out float dtp) {
  vec3 d = p - uC; float l = max(length(d), 1e-5); vec3 dir = d / l;
  float r = uR * shapeR(dir.y) + textureLod(uRip, dir, 0.0).a;
  if (uTent > 0.0) { float a = acos(clamp(dot(dir, uXDir), -1.0, 1.0)); r += uTent * exp(-a * a / 0.03); }
  if (uTime > uTE && uTime < uTE + 0.004) {         // impact shock ring running over the skin
    float ph = acos(clamp(dot(dir, uEDir), -1.0, 1.0)) * uR - 55.0 * (uTime - uTE);
    r += uShock * exp(-(uTime - uTE) / 0.0012) * exp(-abs(ph) / 0.018) * sin(ph * 520.0) * (0.45 + 1.1 * vnoise2(dir.yz * 7.0 + dir.x * 3.0));
  }
  dtp = peelT(dir) - uTime;
  if (dtp > 0.0 && uTime > uTE && dtp < uLipW) { float x = dtp / uLipW; r += uLipH * 4.0 * x * (1.0 - x); }
  return l - r;
}

// ---------------------------------------------------------------- lights
vec3 edgeV(vec3 a, vec3 b) { float th = acos(clamp(dot(a, b), -0.99999, 0.99999)); return normalize(cross(a, b)) * th; }
// irradiance (per unit radiance) from a one-sided Lambertian rectangle
float rectIrr(vec3 p, vec3 n, vec3 c, vec3 hu, vec3 hv) {
  vec3 ln = normalize(cross(hu, hv));
  if (dot(p - c, ln) <= 0.0) return 0.0;
  vec3 v0 = normalize(c - hu - hv - p), v1 = normalize(c + hu - hv - p), v2 = normalize(c + hu + hv - p), v3 = normalize(c - hu + hv - p);
  vec3 F = edgeV(v0, v1) + edgeV(v1, v2) + edgeV(v2, v3) + edgeV(v3, v0);
  if (dot(F, c - p) < 0.0) F = -F;
  return max(0.0, 0.5 * dot(F, n));
}
// softbox emission incl. dark frame and slight hot centre
vec3 rectEmit(vec3 q, vec3 c, vec3 hu, vec3 hv, vec3 Le) {
  vec3 d = q - c; float u = dot(d, hu) / dot(hu, hu), v = dot(d, hv) / dot(hv, hv);
  float edge = max(abs(u), abs(v));
  float frame = 1.0 - smoothstep(0.93, 0.95, edge);
  float hot = 1.0 + 0.18 * (1.0 - u*u) * (1.0 - v*v);
  return Le * frame * hot;
}
bool hitRect(vec3 ro, vec3 rd, vec3 c, vec3 hu, vec3 hv, out float t) {
  vec3 ln = normalize(cross(hu, hv)); float den = dot(rd, ln);
  t = 1e9;
  if (den >= -1e-5) return false;
  t = dot(c - ro, ln) / den; if (t <= 0.0) return false;
  vec3 q = ro + rd * t - c;
  return abs(dot(q, hu)) <= dot(hu, hu) && abs(dot(q, hv)) <= dot(hv, hv);
}
float ggxD(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float smithVis(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2), gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
// representative-point specular from a rectangular light (Karis 2013)
vec3 rectSpec(vec3 p, vec3 n, vec3 v, float rough, vec3 F0, vec3 c, vec3 hu, vec3 hv, vec3 Le) {
  vec3 ln = normalize(cross(hu, hv));
  if (dot(p - c, ln) <= 0.0) return vec3(0.0);
  vec3 r = reflect(-v, n); float den = dot(r, ln); vec3 q = c;
  if (den < -1e-4) q = p + r * (dot(c - p, ln) / den);
  vec3 d = q - c;
  float uu = clamp(dot(d, hu) / dot(hu, hu), -1.0, 1.0), vv = clamp(dot(d, hv) / dot(hv, hv), -1.0, 1.0);
  vec3 L = c + hu * uu + hv * vv - p; float d2 = dot(L, L); L /= sqrt(d2);
  float NoL = dot(n, L); if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + v);
  float NoH = max(dot(n, H), 0.0), VoH = max(dot(v, H), 0.0), NoV = max(dot(n, v), 1e-4);
  float a = max(rough * rough, 0.002);
  float area = 4.0 * length(hu) * length(hv);
  float ap = clamp(a + sqrt(area / PI) / (2.0 * sqrt(d2)), 0.0, 1.0);   // lobe widened by the light's angular size
  float norm = 1.0;                                                    // energy already carried by the widened lobe
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
  float cosL = max(dot(-L, ln), 0.0);
  return Le * (area * cosL / d2) * ggxD(NoH, ap) * smithVis(NoV, NoL, a) * NoL * norm * F;
}
float fresnelDiel(float cosi, float eta) {  // eta = n_t / n_i
  float c = abs(cosi); float g2 = eta * eta - 1.0 + c * c;
  if (g2 < 0.0) return 1.0;
  float g = sqrt(g2);
  float A = (g - c) / (g + c), B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * A * A * (1.0 + B * B);
}

// ---------------------------------------------------------------- studio environment
// dark studio: cyclorama (floor y=0 curving into a back wall at z=-ZB)
#define ZB 2.2
#define RC 0.7
vec3 studioVoid(vec3 rd) {
  // faint bounce light in the unlit studio, a dim white ceiling card and a glow along the far walls
  // (gives metal and water something to reflect and refract)
  float up = rd.y * 0.5 + 0.5, amb = uAmbient * 4.0 + 0.4;
  vec3 c = vec3(0.010, 0.011, 0.012) * (0.4 + 0.8 * up) * (uAmbient * 2.0 + 0.3);
  c += vec3(0.05, 0.05, 0.052) * smoothstep(0.55, 0.8, rd.y) * amb;
  c += vec3(0.02) * exp(-abs(rd.y - 0.05) * 18.0) * amb;
  return c;
}
`;
