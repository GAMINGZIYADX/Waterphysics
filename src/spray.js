/* ==========================================================================
   SPRAY + MIST (analytic, deterministic).  Each droplet follows the exact
   linear-drag trajectory  p(t) = p0 + v_t t + (v0 - v_t) tau (1 - e^{-t/tau}),
   with tau from Schiller-Naumann drag for its size, evaluated in the vertex
   shader, so any instant can be shown without integrating.
   Layout per instance (12 floats): p0.xyz t0 | v0.xyz r | tau tEnd seed kind
   ========================================================================== */
var WB_SPRAY = (function () {
  'use strict';
  var SH = WB_SHARED;

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function basis(a) {
    var t = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = norm(cross(a, t)), v = cross(a, u);
    return [u, v];
  }
  // direction in a cone of half-angle th around axis a; bias>1 concentrates toward the axis
  function cone(rnd, a, th, bias) {
    var c = 1 - Math.pow(rnd(), bias) * (1 - Math.cos(th)), s = Math.sqrt(Math.max(0, 1 - c * c));
    var ph = rnd() * 2 * Math.PI, B = basis(a);
    return [a[0] * c + (B[0][0] * Math.cos(ph) + B[1][0] * Math.sin(ph)) * s,
            a[1] * c + (B[0][1] * Math.cos(ph) + B[1][1] * Math.sin(ph)) * s,
            a[2] * c + (B[0][2] * Math.cos(ph) + B[1][2] * Math.sin(ph)) * s];
  }
  function logn(rnd, median, sigma) {
    var u1 = Math.max(rnd(), 1e-9), u2 = rnd();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  function yAt(p0y, v0y, tau, g, dt) {
    var vt = -g * tau;
    return p0y + vt * dt + (v0y - vt) * tau * (1 - Math.exp(-dt / tau));
  }
  // first time the drop reaches the floor (y = r)
  function landTime(p0, v0, tau, r, g, t0) {
    var dt = 0, step = 0.0005, prev = p0[1];
    for (var i = 0; i < 4000; i++) {
      var nd = dt + step, y = yAt(p0[1], v0[1], tau, g, nd);
      if (y <= r) {
        var a = dt, b = nd;
        for (var k = 0; k < 30; k++) { var m = 0.5 * (a + b); if (yAt(p0[1], v0[1], tau, g, m) <= r) b = m; else a = m; }
        return t0 + b;
      }
      dt = nd; prev = y; step = Math.min(step * 1.05, 0.01);
      if (dt > 4) break;
    }
    return t0 + 4;
  }

  /* peelFn(x,y,z) -> time the latex leaves that direction (from the membrane simulation once
     it is known, otherwise the analytic estimate); peelEnd -> end of the peel */
  function generate(S, U, peelFn, peelEnd) {
    var pf = peelFn || function (x, y, z) { return SH.peelT(x, y, z, S.peel); }, pEnd = peelEnd || S.tPeelEnd;
    var rnd = SH.rng(1000 + Math.round(U.bulletSpeed * 7 + U.balloonRadius * 131 + U.impactOffset * 17 + U.bulletMass * 29));
    var g = U.gravity, drops = [], mist = [], land = [];
    var amt = U.sprayAmount, mamt = U.mistAmount;
    var energy = Math.sqrt(Math.max(S.Edep, 0.5) / 50);           // 1 for a .22 LR through 15 cm of water
    var eScale = Math.min(Math.max(energy, 0.25), 5);

    function drop(p, v, t0, r) {
      var sp = Math.hypot(v[0], v[1], v[2]);
      var tau = SH.dropletTau(r, sp * 0.35);
      var tl = landTime(p, v, tau, r, g, t0);
      drops.push(p[0], p[1], p[2], t0, v[0], v[1], v[2], r, tau, tl, rnd(), 0);
    }
    function puff(p, v, t0, r0, dens, life) {
      var sp = Math.hypot(v[0], v[1], v[2]);
      var tau = SH.dropletTau(30e-6, sp * 0.3) * 1.8;
      mist.push(p[0], p[1], p[2], t0, v[0], v[1], v[2], r0, tau, life, rnd(), dens);
    }

    var bx = S.dir;                       // bullet direction (+x)
    var nEx = Math.round(6500 * amt * eScale), nEn = Math.round(1500 * amt * eScale);   // back-spray ~1/4 of the exit

    // ---------------- exit plume: fine fast spray on the axis, coarser & slower toward the cone edge
    if (S.hasExit) {
      var vmax = 0.35 * S.vExit + 5;
      for (var i = 0; i < nEx; i++) {
        var u = rnd(), sp = 1.5 + (vmax - 1.5) * Math.pow(u, 2.4);
        var t0 = S.tX + Math.pow(rnd(), 1.6) * (0.2e-3 + 2.2e-3 * (1 - u));
        var a = SH.cavityRadius(S, S.L - 1e-4, t0) * 0.8 + 0.003;
        var ph = rnd() * 6.2832, rr = Math.sqrt(rnd()) * a;
        var p = [S.exit[0] + rnd() * 0.004, S.exit[1] + Math.cos(ph) * rr, S.exit[2] + Math.sin(ph) * rr];
        var th = (5 + 50 * Math.pow(1 - u, 1.4)) * Math.PI / 180;
        var d = cone(rnd, bx, th, 1.3);
        var r = Math.min(Math.max(logn(rnd, 0.00022 * Math.pow(10 / sp, 0.45), 0.6), 3e-5), 0.0022);
        drop(p, [d[0] * sp, d[1] * sp, d[2] * sp], t0, r);
      }
      var nM = Math.round(520 * mamt * eScale);
      for (i = 0; i < nM; i++) {
        u = rnd(); sp = 3 + 0.3 * S.vExit * Math.pow(u, 1.6);
        t0 = S.tX + Math.pow(rnd(), 2) * 1.6e-3;
        d = cone(rnd, bx, (6 + 32 * rnd()) * Math.PI / 180, 1.2);
        p = [S.exit[0], S.exit[1] + (rnd() - 0.5) * 0.012, S.exit[2] + (rnd() - 0.5) * 0.012];
        puff(p, [d[0] * sp, d[1] * sp, d[2] * sp], t0, 0.0015 + 0.002 * rnd(), 0.1 + 0.08 * rnd(), 0.06 + 0.1 * rnd());
      }
    }

    // ---------------- entry splash-back: a hollow crown thrown backwards around the hole
    var back = [-bx[0], -bx[1], -bx[2]];
    for (i = 0; i < nEn; i++) {
      u = rnd(); sp = 1.0 + 22 * eScale * Math.pow(u, 1.8);
      t0 = Math.pow(rnd(), 1.7) * 1.3e-3;
      a = SH.cavityRadius(S, 1e-4, t0) * 0.85 + 0.002;
      ph = rnd() * 6.2832;
      var B = basis(back), rad = [B[0][0] * Math.cos(ph) + B[1][0] * Math.sin(ph), B[0][1] * Math.cos(ph) + B[1][1] * Math.sin(ph), B[0][2] * Math.cos(ph) + B[1][2] * Math.sin(ph)];
      p = [S.entry[0] + rad[0] * a * 0.9, S.entry[1] + rad[1] * a * 0.9, S.entry[2] + rad[2] * a * 0.9];
      var open = 0.3 + 1.0 * rnd();
      d = norm([back[0] + rad[0] * open, back[1] + rad[1] * open, back[2] + rad[2] * open]);
      r = Math.min(Math.max(logn(rnd, 0.0002 * Math.pow(6 / sp, 0.4), 0.6), 3e-5), 0.0018);
      drop(p, [d[0] * sp, d[1] * sp, d[2] * sp], t0, r);
    }
    for (i = 0; i < Math.round(70 * mamt * eScale); i++) {
      sp = 2 + 14 * rnd() * eScale; t0 = rnd() * 1.0e-3;
      d = cone(rnd, back, 50 * Math.PI / 180, 1.0);
      puff([S.entry[0], S.entry[1] + (rnd() - 0.5) * 0.01, S.entry[2] + (rnd() - 0.5) * 0.01], [d[0] * sp, d[1] * sp, d[2] * sp],
           t0, 0.002 + 0.002 * rnd(), 0.05 + 0.04 * rnd(), 0.06 + 0.08 * rnd());
    }

    // ---------------- collapse jets: when the cavity closes, water squirts out of both holes
    var Tc = S.cavMax.Tc;
    [[S.entry, back, 0], [S.exit, bx, S.tX]].forEach(function (h, k) {
      if (k === 1 && !S.hasExit) return;
      var n = Math.round(700 * amt * eScale);
      for (var j = 0; j < n; j++) {
        var tt = h[2] + Tc * (0.8 + 0.5 * rnd());
        var spd = (3 + 9 * Math.pow(rnd(), 1.5)) * Math.min(2, U.energyTransfer);
        var dd = cone(rnd, h[1], 22 * Math.PI / 180, 1.5);
        var pp = [h[0][0] + (rnd() - 0.5) * 0.006, h[0][1] + (rnd() - 0.5) * 0.01, h[0][2] + (rnd() - 0.5) * 0.01];
        drop(pp, [dd[0] * spd, dd[1] * spd, dd[2] * spd], tt, Math.min(logn(rnd, 0.0005, 0.6), 0.0025));
      }
    });

    // ---------------- rim spray: film of water flung off by the retracting latex lip
    var nRim = Math.round(1400 * amt);
    for (i = 0; i < nRim; i++) {
      var cth = 1 - 2 * rnd(), sth = Math.sqrt(1 - cth * cth), phi = rnd() * 6.2832;
      var dir = [sth * Math.cos(phi), cth, sth * Math.sin(phi)];
      var tp = pf(dir[0], dir[1], dir[2]);
      if (tp > pEnd * 0.98) continue;
      var rr0 = S.R * SH.shapeR(dir[1]) * 1.004;
      p = [S.C[0] + dir[0] * rr0, S.C[1] + dir[1] * rr0, S.C[2] + dir[2] * rr0];
      var e = 0.05, Bt = basis(dir);
      var g1 = pf(dir[0] + e * Bt[0][0], dir[1] + e * Bt[0][1], dir[2] + e * Bt[0][2]) - pf(dir[0] - e * Bt[0][0], dir[1] - e * Bt[0][1], dir[2] - e * Bt[0][2]);
      var g2 = pf(dir[0] + e * Bt[1][0], dir[1] + e * Bt[1][1], dir[2] + e * Bt[1][2]) - pf(dir[0] - e * Bt[1][0], dir[1] - e * Bt[1][1], dir[2] - e * Bt[1][2]);
      var gt = norm([g1 * Bt[0][0] + g2 * Bt[1][0], g1 * Bt[0][1] + g2 * Bt[1][1], g1 * Bt[0][2] + g2 * Bt[1][2]]);
      var vt = (0.05 + 0.2 * Math.pow(rnd(), 1.5)) * U.peelSpeed, vn = 0.4 + 2.2 * rnd();
      r = Math.min(Math.max(logn(rnd, 0.0001, 0.6), 3e-5), 0.0008);
      drop(p, [gt[0] * vt + dir[0] * vn, gt[1] * vt + dir[1] * vn, gt[2] * vt + dir[2] * vn], tp, r);
      if (rnd() < 0.06 * mamt) puff(p, [gt[0] * vt * 0.4 + dir[0], gt[1] * vt * 0.4 + dir[1], gt[2] * vt * 0.4 + dir[2]], tp, 0.004, 0.03, 0.25);
    }

    // ---------------- blast spray: a violent shot (cavity as large as the balloon) throws the whole
    // surface outward, radially away from the shot line, within a few tenths of a millisecond
    if (S.blast > 0.02) {
      var bf = S.blast / 0.5, nB = Math.round(5500 * amt * bf * Math.min(2.5, Math.sqrt(S.Edep / 440)));
      for (i = 0; i < nB; i++) {
        cth = 1 - 2 * rnd(); sth = Math.sqrt(1 - cth * cth); phi = rnd() * 6.2832;
        dir = [sth * Math.cos(phi), cth, sth * Math.sin(phi)];
        rr0 = S.R * SH.shapeR(dir[1]);
        p = [S.C[0] + dir[0] * rr0, S.C[1] + dir[1] * rr0, S.C[2] + dir[2] * rr0];
        var sx = p[0] - S.entry[0], ry = p[1] - S.entry[1], rz = p[2] - S.entry[2], rax = Math.max(Math.hypot(ry, rz), 0.004);
        var tpass = SH.bulletTimeAt(S, Math.max(0, Math.min(S.L, sx)));
        var sp2 = S.blastV * (0.5 + 0.9 * rnd()) * Math.min(2.2, Math.max(0.6, 0.05 / rax));
        var db = norm([dir[0] * 0.45 + bx[0] * 0.25 + (rnd() - 0.5) * 0.3, ry / rax * 0.8 + dir[1] * 0.45 + (rnd() - 0.5) * 0.3, rz / rax * 0.8 + dir[2] * 0.45 + (rnd() - 0.5) * 0.3]);
        r = Math.min(Math.max(logn(rnd, 0.00045, 0.7), 5e-5), 0.003);
        // the surface water can only fly once the latex over it has gone
        var tb = Math.max(tpass + (0.12 + 0.5 * rnd()) * 1e-3, pf(dir[0], dir[1], dir[2]) + 5e-5 * rnd());
        drop(p, [db[0] * sp2, db[1] * sp2, db[2] * sp2], tb, r);
        if (rnd() < 0.05 * mamt) puff(p, [db[0] * sp2 * 0.5, db[1] * sp2 * 0.5, db[2] * sp2 * 0.5], tb + 5e-5, 0.005, 0.06, 0.15);
      }
    }

    // ---------------- floor impact: crown sheet rim throws droplets out and up
    if (g > 0.5 && S.tImpact < U.duration) {
      var tI = S.tImpact, vI = g * tI, nC = Math.round(2600 * amt);
      for (i = 0; i < nC; i++) {
        // lamella rim: races out at ~1.5x the impact speed; fingers shed drops out and up
        var dtc = Math.pow(rnd(), 1.3) * 0.11;
        var ang = rnd() * 6.2832 + 0.08 * Math.sin(i * 1.7);
        var ringR = 0.8 * S.R + 1.5 * vI * dtc * Math.exp(-dtc / 0.12);
        var decay = Math.exp(-dtc / 0.06);
        var up = (0.15 + 0.6 * rnd()) * vI * decay, out = (0.7 + 0.8 * rnd()) * vI * (0.5 + 0.7 * decay);
        p = [S.C[0] + Math.cos(ang) * ringR, 0.003 + 0.01 * rnd(), S.C[2] + Math.sin(ang) * ringR];
        drop(p, [Math.cos(ang) * out, Math.max(0.15, up), Math.sin(ang) * out], tI + dtc, Math.min(logn(rnd, 0.0011, 0.6), 0.0045));
      }
      for (i = 0; i < Math.round(60 * mamt); i++) {
        ang = rnd() * 6.2832; ringR = 0.9 * S.R + 0.1 * rnd();
        puff([S.C[0] + Math.cos(ang) * ringR, 0.01, S.C[2] + Math.sin(ang) * ringR], [Math.cos(ang) * 1.5, 0.6, Math.sin(ang) * 1.5],
             tI + rnd() * 0.05, 0.008, 0.035, 0.12);
      }
    }

    return {
      drops: new Float32Array(drops), dropCount: drops.length / 12,
      mist: new Float32Array(mist), mistCount: mist.length / 12
    };
  }

  return { generate: generate };
})();
