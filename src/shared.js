/* ==========================================================================
   SHARED PHYSICS SETUP  (evaluated both on the main thread and in the worker)
   Units: SI (m, s, kg).  y is up, ground plane is y = 0.
   ========================================================================== */
var WB_SHARED = (function () {
  'use strict';
  var RHO_W = 1000, RHO_AIR = 1.204, MU_AIR = 1.81e-5;

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /* Deterministic smooth "noise" on the unit sphere.  The exact same formula
     lives in the GLSL so the simulation and the renderer agree on where the
     rubber has torn. */
  function peelNoise(x, y, z) {
    return 0.55 * Math.sin(6.1 * x + 2.3 * y + 1.7) * Math.sin(4.7 * z - 3.1 * x + 0.4) +
           0.35 * Math.sin(9.3 * y - 5.2 * z + 2.2) * Math.cos(7.9 * x + 1.3) +
           0.22 * Math.sin(31.0 * x + 17.0 * y + 0.3) * Math.sin(27.0 * z - 19.0 * x + 1.1);
  }
  /* Latex splits along a few radial cracks that run ahead of the peel, so each
     hole opens as a ragged star whose petals then roll back. */
  // a few irregular, meandering cracks per hole; they run ahead only near the hole
  var CRACKS = [[0.4, 1.0, 1.9, 0.55, 3.3, 0.85, 4.9, 0.4], [0.9, 0.75, 2.6, 1.0, 4.0, 0.45, 5.6, 0.7]];
  function crackSpeed(dx, dy, dz, a, u, v, hole) {
    var x = dx * u[0] + dy * u[1] + dz * u[2], y = dx * v[0] + dy * v[1] + dz * v[2];
    var th = Math.acos(clamp(dx * a[0] + dy * a[1] + dz * a[2], -1, 1));
    var phi = Math.atan2(y, x), s = 0, C = CRACKS[hole];
    for (var i = 0; i < 4; i++) {
      var c = C[2 * i] + 0.35 * Math.sin(6.0 * th + 1.7 * i + hole) + 0.12 * Math.sin(17.0 * th + i);
      var d = phi - c;
      d = d - 6.283185307 * Math.floor((d + 3.141592654) / 6.283185307);
      var wdt = 0.012 + 0.03 * th;                          // cracks widen as the petals open
      s += C[2 * i + 1] * Math.exp(-d * d / wdt);
    }
    return 1 + 2.0 * s * Math.exp(-th / 0.8);
  }

  /* Radius multiplier of a hanging water balloon as a function of c = dir.y.
     Gravity makes it sag into a teardrop: wide, round bottom and a pointed
     top that runs into the neck. */
  function shapeR(c) {
    var cp = c > 0 ? c : 0, cn = c < 0 ? -c : 0;
    var c3 = cp * cp * cp, c12 = c3 * c3 * c3 * c3;
    return 1 + 0.035 * (1 - c * c) + 0.03 * cn * cn - 0.05 * cp * cp + 0.13 * c12;
  }

  /* Time at which the latex peels off the water in direction (dx,dy,dz).
     Tears start at the entry and exit holes and run over the surface at the
     retraction speed; the knot (top) anchors the rubber so the front slows
     towards it and the knot region is uncovered last. */
  function peelT(dx, dy, dz, pp) {
    var nz = 1 + 0.18 * peelNoise(dx, dy, dz);
    var up = 0.5 * (1 + dy);
    var fk = 1 + pp.kappa * up * Math.sqrt(up);
    var thE = Math.acos(clamp(dx * pp.e[0] + dy * pp.e[1] + dz * pp.e[2], -1, 1));
    var tE = pp.tE + thE * fk * nz / (pp.rate * crackSpeed(dx, dy, dz, pp.e, pp.eu, pp.ev, 0));
    if (!pp.hasExit) return tE;
    var thX = Math.acos(clamp(dx * pp.x[0] + dy * pp.x[1] + dz * pp.x[2], -1, 1));
    var tX = pp.tX + thX * fk * nz / (pp.rate * crackSpeed(dx, dy, dz, pp.x, pp.xu, pp.xv, 1));
    return tE < tX ? tE : tX;
  }
  function holeBasis(a) {
    var t = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]];
    var l = Math.hypot(u[0], u[1], u[2]); u = [u[0] / l, u[1] / l, u[2] / l];
    return [u, [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]];
  }

  /* Bullet designs, dimensions in calibres d (real projectiles):
       type   0 spitzer (tangent ogive), 1 round nose (elliptical ogive), 2 diabolo pellet
       len    overall length, nose  ogive length, meplat  flat-tip radius / (d/2)
       bt     boat-tail length, base  base radius / (d/2), can  cannelure position (fraction of len, 0 none)
       lead   0 full jacket, 1 jacket with exposed lead base, 2 bare lead
       cd     drag coefficient in water, f0 / rough  jacket reflectance (linear) and roughness */
  var BULLETS = {
    pellet: { type: 2, len: 1.25, nose: 0.5, meplat: 0, bt: 0, base: 1, can: 0, lead: 2, cd: 0.9, f0: [0.56, 0.57, 0.6], rough: 0.4 },
    lr22: { type: 1, len: 1.95, nose: 0.85, meplat: 0.2, bt: 0, base: 1, can: 0, lead: 2, cd: 0.32, f0: [0.6, 0.6, 0.62], rough: 0.36 },
    mm9: { type: 1, len: 1.72, nose: 0.92, meplat: 0.16, bt: 0.05, base: 0.93, can: 0, lead: 1, cd: 0.3, f0: [0.94, 0.72, 0.47], rough: 0.2 },
    r556: { type: 0, len: 4.03, nose: 2.25, meplat: 0.07, bt: 0.7, base: 0.8, can: 0.64, lead: 1, cd: 0.25, f0: [0.955, 0.64, 0.54], rough: 0.2 },
    r762: { type: 0, len: 3.7, nose: 1.95, meplat: 0.07, bt: 0.6, base: 0.84, can: 0.6, lead: 1, cd: 0.25, f0: [0.96, 0.68, 0.52], rough: 0.24 },
    bmg50: { type: 0, len: 4.52, nose: 2.3, meplat: 0.06, bt: 0.74, base: 0.8, can: 0.6, lead: 1, cd: 0.25, f0: [0.955, 0.63, 0.53], rough: 0.22 }
  };

  /* Convert UI parameters into a physical setup shared by sim + renderer. */
  function computeSetup(U) {
    var S = {};
    var R = U.balloonRadius / 100;                 // cm -> m
    var C = [0, U.balloonHeight, 0];
    S.R = R; S.C = C; S.g = U.gravity;
    S.m = U.bulletMass / 1000;                     // g -> kg
    S.d = U.bulletCaliber / 1000;                  // mm -> m
    S.v0 = U.bulletSpeed;
    S.bullet = BULLETS[U.projectile] || BULLETS.lr22;
    S.Cd = S.bullet.cd;                            // drag coefficient in water (subsonic in water: c = 1480 m/s)
    S.A = Math.PI * S.d * S.d / 4;
    S.k = RHO_W * S.Cd * S.A / (2 * S.m);          // exponential velocity decay constant [1/m]
    var oy = clamp(U.impactOffset / 100, -0.8 * R, 0.8 * R);
    S.oy = oy;
    S.dir = [1, 0, 0];

    // Find where the bullet line (y = C.y + oy, z = 0) pierces the membrane.
    function f(x) {
      var dx = x, dy = oy, l = Math.sqrt(dx * dx + dy * dy);
      return l - R * shapeR(dy / l);
    }
    function root(a, b) { // f(a) > 0 > f(b)
      for (var i = 0; i < 60; i++) { var mid = 0.5 * (a + b); if (f(mid) > 0) a = mid; else b = mid; }
      return 0.5 * (a + b);
    }
    var xe = root(-1.5 * R, 0), xx = root(1.5 * R, 0);
    S.entry = [C[0] + xe, C[1] + oy, C[2]];
    S.exit = [C[0] + xx, C[1] + oy, C[2]];
    S.L = xx - xe;                                  // water path length
    var le = Math.sqrt(xe * xe + oy * oy), lx = Math.sqrt(xx * xx + oy * oy);
    S.eDir = [xe / le, oy / le, 0];
    S.xDir = [xx / lx, oy / lx, 0];

    // Ballistics inside the water: dv/ds = -k v  ->  v = v0 e^{-ks}
    S.vExit = S.v0 * Math.exp(-S.k * S.L);
    S.tX = (Math.exp(S.k * S.L) - 1) / (S.k * S.v0);
    S.hasExit = S.vExit > 12;
    S.Edep = 0.5 * S.m * (S.v0 * S.v0 - S.vExit * S.vExit);
    S.etaCav = 0.5;
    S.cavMax = cavityAt(S, 0);                     // largest cavity is at the entry
    S.cavEnd = S.tX + S.cavMax.Tc;

    // Peel (rubber retraction) parameters
    var be = holeBasis(S.eDir), bx = holeBasis(S.xDir);
    S.peel = {
      e: S.eDir, x: S.xDir, eu: be[0], ev: be[1], xu: bx[0], xv: bx[1], tE: 0, tX: S.tX, hasExit: S.hasExit,
      rate: U.peelSpeed / R,                       // angular speed of the tear front [rad/s]
      kappa: 1.25
    };
    // Fraction of the cavity energy left as lasting outward flow: ~0 while the
    // cavity is small compared with the balloon (it collapses and its energy
    // goes into jets, bubbles and heat); approaches 1/2 when the cavity is as
    // large as the balloon and blows it apart.
    S.blast = clamp((S.cavMax.amax / R - 0.45) / 0.55, 0, 1) * 0.5;
    S.tImpact = Math.sqrt(2 * Math.max(0.01, C[1] - 1.03 * R) / Math.max(U.gravity, 0.1));
    S.waterVolume = estimateVolume(R);
    S.waterMass = S.waterVolume * RHO_W;
    // rms speed of the water if the blast share of the deposited energy became outward flow:
    // ~0 for a .22 LR (cavity collapses), ~15 m/s for 5.56 NATO, ~35 m/s for .50 BMG
    S.blastV = Math.sqrt(2 * S.blast * S.Edep / S.waterMass);
    S.violence = clamp(Math.sqrt(S.Edep / 50), 0.3, 7);   // 1 = .22 LR through 15 cm of water
    // the kinematic (collapsing) cavity model only applies while the blast has not blown the water apart
    S.cavKin = 1 - 0.8 * clamp(S.blast / 0.5, 0, 1);
    // Last moment any rubber remains on the water (the knot region)
    var tEnd = 0;
    for (var i = 0; i < 400; i++) {
      var th = Math.acos(1 - 2 * (i + 0.5) / 400), ph = i * 2.39996323;
      var dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = Math.sin(th) * Math.sin(ph);
      var tt = peelT(dx, dy, dz, S.peel); if (tt > tEnd) tEnd = tt;
    }
    S.tPeelEnd = tEnd;
    // Knot sits on top of the tapered neck
    S.topY = C[1] + R * shapeR(1);
    S.knot = [C[0], S.topY + 0.012 + 0.10 * R, C[2]];
    return S;
  }

  function estimateVolume(R) {
    var v = 0, n = 200;
    for (var i = 0; i < n; i++) {
      var c = -1 + 2 * (i + 0.5) / n, r = R * shapeR(c);
      v += (r * r * r / 3) * (2 / n) * 2 * Math.PI;   // ∫ r^3/3 dΩ
    }
    return v;
  }

  /* Bullet distance travelled along the path, relative to the entry point. */
  function bulletS(S, t) {
    if (t <= 0) return S.v0 * t;
    if (t <= S.tX) return Math.log(1 + S.k * S.v0 * t) / S.k;
    return S.L + S.vExit * (t - S.tX);
  }
  function bulletV(S, t) {
    if (t <= 0) return S.v0;
    if (t <= S.tX) return S.v0 / (1 + S.k * S.v0 * t);
    return S.vExit;
  }
  /* Time the bullet reaches path coordinate s (relative to entry). */
  function bulletTimeAt(S, s) {
    if (s <= 0) return s / S.v0;
    if (s <= S.L) return (Math.exp(S.k * s) - 1) / (S.k * S.v0);
    return S.tX + (s - S.L) / S.vExit;
  }

  /* Temporary cavity behind the bullet.  The drag work per unit length E'
     opens a (near-vacuum) cylindrical cavity against atmospheric pressure:
     pi a_max^2 p_atm = eta_c E'.  It collapses on a Rayleigh time scale. */
  var P_ATM = 101325;
  function cavityAt(S, s) {
    var v = S.v0 * Math.exp(-S.k * Math.max(0, Math.min(S.L, s)));
    var Ep = S.m * S.k * v * v;
    var amax = Math.sqrt(S.etaCav * Ep / (Math.PI * P_ATM));
    return { amax: amax, Tc: 2.2 * amax * Math.sqrt(RHO_W / P_ATM), Ep: Ep };
  }
  function cavityRadius(S, s, t) {
    if (s < 0 || s > S.L) return 0;
    var tau = t - bulletTimeAt(S, s);
    if (tau <= 0) return 0;
    var c = cavityAt(S, s);
    if (tau >= c.Tc) return 0;
    return c.amax * Math.pow(Math.sin(Math.PI * tau / c.Tc), 0.65);
  }

  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  /* Height of the latex tent the bullet pushes out ahead of itself just before it exits. */
  function tentAmp(S, t) {
    if (!S.hasExit) return 0;
    return 0.012 * (S.R / 0.075) * smooth(S.tX - 0.00022, S.tX, t) * (1 - smooth(S.tX, S.tX + 0.0003, t));
  }
  /* Vertical recoil of the knot on the string once the water no longer hangs from it. */
  function knotDY(S, t) {
    var tr = t - 0.65 * S.tPeelEnd;
    if (tr <= 0) return 0;
    var w = 2 * Math.PI * 4.5, z = 0.22;
    return (2.2 / w) * Math.exp(-z * w * tr) * Math.sin(w * tr);
  }

  /* Small deterministic PRNG (mulberry32). */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Drag relaxation time of a water droplet of radius r moving at speed v in
     air (Schiller-Naumann corrected Stokes drag, evaluated at a representative
     speed so the closed-form linear-drag trajectory is a good fit). */
  function dropletTau(r, v) {
    var d = 2 * r;
    var tauStokes = RHO_W * d * d / (18 * MU_AIR);
    var Re = RHO_AIR * Math.max(v, 0.05) * d / MU_AIR;
    return tauStokes / (1 + 0.15 * Math.pow(Re, 0.687));
  }

  return {
    RHO_W: RHO_W, RHO_AIR: RHO_AIR, MU_AIR: MU_AIR, BULLETS: BULLETS,
    clamp: clamp, peelNoise: peelNoise, shapeR: shapeR, peelT: peelT,
    computeSetup: computeSetup, bulletS: bulletS, bulletV: bulletV,
    bulletTimeAt: bulletTimeAt, rng: rng, dropletTau: dropletTau,
    cavityAt: cavityAt, cavityRadius: cavityRadius, P_ATM: P_ATM,
    smooth: smooth, tentAmp: tentAmp, knotDY: knotDY
  };
})();
if (typeof module !== 'undefined') module.exports = WB_SHARED;
