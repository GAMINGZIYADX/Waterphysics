/* ==========================================================================
   GLSL: caustics by photon tracing.  Each vertex is one photon leaving a
   softbox toward the water; it is refracted into and out of the water volume
   (Fresnel-weighted, latex-tinted) and splatted where it lands on the floor.
   The floor shader adds the resulting irradiance map.
   ========================================================================== */
WB_GLSL.causticVS = `
uniform vec2  uPGrid;                 // photons per side
uniform vec3  uPOrig, uPLn, uPLe;     // photon origin (point on the softbox), softbox normal, radiance
uniform float uPArea;                 // softbox area
uniform vec3  uDiskC, uDiskU, uDiskV; // aim rectangle covering the water volume
uniform vec2  uPJit;
uniform float uCauRes;
out vec3 vFlux;

float pMarchIn(vec3 ro, vec3 rd, float t0, float t1) {
  float st = uCell * 0.6, t = t0;
  for (int i = 0; i < 400 * uL1; i++) {
    if (t > t1) return -1.0;
    if (field(ro + rd * t) > uIso) {
      float a = t - st, b = t;
      for (int k = 0; k < 6 * uL1; k++) { float m = 0.5 * (a + b); if (field(ro + rd * m) > uIso) b = m; else a = m; }
      return b;
    }
    t += st;
  }
  return -1.0;
}
float pMarchOut(vec3 ro, vec3 rd, float t1) {
  float st = uCell * 0.6, t = st * 0.5;
  for (int i = 0; i < 500 * uL1; i++) {
    if (field(ro + rd * t) < uIso) {
      float a = max(t - st, 0.0), b = t;
      for (int k = 0; k < 6 * uL1; k++) { float m = 0.5 * (a + b); if (field(ro + rd * m) < uIso) b = m; else a = m; }
      return b;
    }
    t += st;
    if (t > t1) return t1;
  }
  return t;
}
vec3 pNormal(vec3 p) {
  float e = uCell * 0.9;
  vec3 g = vec3(0.0);
  for (int k = 0; k < 4 * uL1; k++) {
    vec3 o = vec3(((k + 3) >> 1) & 1, (k >> 1) & 1, k & 1) * 2.0 - 1.0;
    g += o * field(p + o * e);
  }
  return dot(g, g) > 1e-12 ? -normalize(g) : vec3(0.0, 1.0, 0.0);
}
float pLatex(vec3 p) {                 // latex coverage at a surface point
  if (uMembrane == 0) return 0.0;
  float dt; float sd = memSD(p, dt);
  return (abs(sd) < uBand * 1.6 && dt > 0.0) ? 1.0 : 0.0;
}
void main() {
  gl_PointSize = 2.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vFlux = vec3(0.0);
  float n = uPGrid.x;
  float i = mod(float(gl_VertexID), n), j = floor(float(gl_VertexID) / n);
  vec2 uv = (vec2(i, j) + 0.5 + uPJit) / uPGrid * 2.0 - 1.0;
  vec3 tgt = uDiskC + uDiskU * uv.x + uDiskV * uv.y;
  vec3 ro = uPOrig, rd = normalize(tgt - ro);
  float cosE = dot(rd, uPLn);
  if (cosE <= 0.0 || uHasVol == 0) return;
  vec3 dn = normalize(cross(uDiskU, uDiskV));
  float dA = 4.0 * length(uDiskU) * length(uDiskV) / (uPGrid.x * uPGrid.y);
  vec3 flux = uPLe * uPArea * cosE * dA * abs(dot(rd, dn)) / dot(tgt - ro, tgt - ro);
  float t0, t1;
  if (!boxHit(ro, rd, uVolMin, uVolMin + uVolSize, t0, t1)) return;
  float tw = pMarchIn(ro, rd, max(t0, 0.0), t1);
  if (tw < 0.0) return;                           // missed the water: plain direct light handles it
  vec3 p = ro + rd * tw, nrm = pNormal(p);
  if (p.y < 0.016) return;                        // thin films on the floor are optically flat: no focusing
  flux *= 1.0 - fresnelDiel(max(-dot(rd, nrm), 1e-3), 1.333);
  if (pLatex(p) > 0.0) flux *= uRubberCol * (1.0 - 0.6 * uRubberOpacity);
  rd = refract(rd, nrm, 1.0 / 1.333); p -= nrm * 3e-4;
  bool inside = true;
  for (int k = 0; k < 4 * uL1; k++) {
    if (!inside) break;
    float tb0, tb1; boxHit(p, rd, uVolMin, uVolMin + uVolSize, tb0, tb1);
    float tf = rd.y < -1e-5 ? -p.y / rd.y : 1e9;
    float te = pMarchOut(p, rd, min(tb1, tf));
    if (tf <= te + 1e-5) { p += rd * tf; inside = false; break; }   // lands on the floor under the water
    p += rd * te;
    vec3 ne = pNormal(p);
    vec3 td = refract(rd, -ne, 1.333);
    if (dot(td, td) < 0.5) { rd = reflect(rd, ne); p -= ne * 3e-4; continue; }
    flux *= 1.0 - fresnelDiel(max(dot(rd, ne), 1e-3), 1.0 / 1.333);
    if (pLatex(p) > 0.0) flux *= uRubberCol * (1.0 - 0.6 * uRubberOpacity);
    rd = td; p += ne * 3e-4; inside = false;
    if (rd.y >= -1e-4) return;                    // leaves upward: no floor caustic
    p += rd * (-p.y / rd.y);
  }
  if (inside) return;
  vec2 c = (p.xz - uCauMin) / uCauSize;
  if (any(lessThan(c, vec2(0.0))) || any(greaterThan(c, vec2(1.0)))) return;
  float texA = (uCauSize / uCauRes) * (uCauSize / uCauRes);
  vFlux = flux / (texA * 4.0);                    // 2x2 point footprint
  gl_Position = vec4(c * 2.0 - 1.0, 0.0, 1.0);
}`;
WB_GLSL.causticFS = `#version 300 es
precision highp float;
in vec3 vFlux;
out vec4 o;
void main() { o = vec4(vFlux, 0.0); }`;
