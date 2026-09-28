/* ==========================================================================
   FLUID SIMULATION  (Position Based Fluids, Macklin & Müller 2013)
   Runs inside a Web Worker.  Internal length unit = particle spacing `s`,
   so kernel constants are resolution independent.  Output frames are
   quantised to Int16 in a fixed world box.
   ========================================================================== */
var WB_SIM = (function () {
  'use strict';
  var SH = WB_SHARED;
  var QMIN = [-3, -0.25, -3], QSPAN = [6, 3.5, 6];
  var MAXN = 48;
  var H = 2.0, H2 = 4.0;
  var POLY6 = 315 / (64 * Math.PI * Math.pow(H, 9));
  var SPIKY = -45 / (Math.PI * Math.pow(H, 6));
  var COH = 32 / (Math.PI * Math.pow(H, 9));
  var WET_RES = 1024, WET_HALF = 1.2;            // wet map covers [-1.2,1.2]^2 m (2.3 mm texels)

  function frameSchedule(tMax) {
    var ts = [0], t = 0;
    function run(step, until) { while (t + step <= until + 1e-9) { t += step; ts.push(t); } }
    run(0.0002, 0.004); run(0.0005, 0.02); run(0.001, 0.06); run(0.0025, tMax);
    return ts;
  }

  function Bake(U, id) {
    this.id = id; this.U = U;
    var S = this.S = SH.computeSetup(U);
    this.gravity = U.gravity;
    var Nt = Math.max(1000, Math.round(U.particles));
    var s = Math.cbrt(S.waterVolume / Nt), pts = null;
    for (var it = 0; it < 7; it++) {
      pts = this.lattice(s);
      var n = pts.length / 3;
      if (Math.abs(n - Nt) / Nt < 0.015) break;
      s *= Math.cbrt(n / Nt);
    }
    this.s = s;
    var N = this.N = pts.length / 3;
    this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3);
    this.q = new Float32Array(N * 3); this.dq = new Float32Array(N * 3);
    this.lam = new Float32Array(N); this.dl = new Float32Array(N); this.rho = new Float32Array(N);
    this.nb = new Int32Array(N * MAXN); this.nbc = new Uint8Array(N);
    this.iso = new Uint8Array(N); this.released = new Uint8Array(N);
    this.stored = new Float32Array(N);
    this.aer = new Float32Array(N); this.hit = new Uint8Array(N); this.tHit = new Float32Array(N); this.tCav = new Float32Array(N);
    this.rHit = new Float32Array(N); this.sHit = new Float32Array(N); this.aMax = new Float32Array(N); this.coll = new Uint8Array(N);
    this.held = new Uint8Array(N);
    for (var i = 0; i < N * 3; i++) this.p[i] = pts[i] / s;
    this.Ci = [S.C[0] / s, S.C[1] / s, S.C[2] / s];
    this.Ri = S.R / s;
    // the latex skin, simulated alongside; each particle is held until the rubber over it has left
    this.mem = new WB_MEM.Membrane(S, U);
    this.memV = new Int32Array(N);
    for (i = 0; i < N; i++) {
      var dx = this.p[3 * i] - this.Ci[0], dy = this.p[3 * i + 1] - this.Ci[1], dz = this.p[3 * i + 2] - this.Ci[2];
      this.memV[i] = this.mem.nearest(dx, dy, dz);
    }
    this.relT = this.mem.tDetO;                    // live: filled in as the membrane tears
    var oc = this.mem.origCopy = new Int32Array(this.mem.nv0).fill(-1);
    for (i = 0; i < this.mem.nc; i++) if (oc[this.mem.copyOf[i]] < 0) oc[this.mem.copyOf[i]] = i;
    var ts = 1; while (ts < N * 2) ts <<= 1;
    this.tableSize = ts;
    this.cellCount = new Int32Array(ts); this.cellStart = new Int32Array(ts);
    this.fill = new Int32Array(ts); this.cellOf = new Int32Array(N); this.sorted = new Int32Array(N);
    this.CX = new Int32Array(N); this.CY = new Int32Array(N); this.CZ = new Int32Array(N);
    this.rng = SH.rng(1234567);
    this.iters = 2;
    this.eps = 0.02;
    this.rho0 = this.restDensity();
    this.wet = new Float32Array(WET_RES * WET_RES); this.wet.fill(1e4);
    this.t = -0.02;
    this.frames = frameSchedule(U.duration || 1.0);
    this.nextFrame = 0;
    this.done = false;
    this.rdrop = 0.62 * s;                 // radius of an isolated particle as a drop [m]
    this.settle();
  }

  Bake.prototype.lattice = function (s) {
    var S = this.S, R = S.R, C = S.C, out = [], rnd = SH.rng(99);
    var m = 0.5 * s, n = Math.ceil(1.15 * R / s);
    for (var ix = -n; ix <= n; ix++) for (var iy = -n; iy <= n; iy++) for (var iz = -n; iz <= n; iz++) {
      var x = (ix + 0.5) * s, y = (iy + 0.5) * s, z = (iz + 0.5) * s;
      var l = Math.sqrt(x * x + y * y + z * z);
      if (l < 1e-9) continue;
      if (l > R * SH.shapeR(y / l) - m) continue;
      out.push(C[0] + x + (rnd() - 0.5) * 0.8 * s, C[1] + y + (rnd() - 0.5) * 0.8 * s, C[2] + z + (rnd() - 0.5) * 0.8 * s);
    }
    return out;
  };

  Bake.prototype.restDensity = function () {
    // density of an ideal interior lattice site (matches the initial packing)
    var r = 0;
    for (var x = -2; x <= 2; x++) for (var y = -2; y <= 2; y++) for (var z = -2; z <= 2; z++) {
      var r2 = x * x + y * y + z * z;
      if (r2 < H2) { var d = H2 - r2; r += POLY6 * d * d * d; }
    }
    return r;
  };

  function hash(ix, iy, iz) {
    return (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481));
  }

  var HALF = [];
  (function () {
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++)
      if (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0)) HALF.push(dx, dy, dz);
  })();

  /* Half-shell neighbour search on a spatial hash; bucket collisions are
     filtered by comparing integer cell coordinates, pairs inserted both ways. */
  Bake.prototype.neighbors = function () {
    var N = this.N, q = this.q, mask = this.tableSize - 1;
    var cnt = this.cellCount, st = this.cellStart, fill = this.fill, cellOf = this.cellOf, sorted = this.sorted;
    var CX = this.CX, CY = this.CY, CZ = this.CZ;
    cnt.fill(0);
    for (var i = 0; i < N; i++) {
      var a0 = Math.floor(q[3 * i] * 0.5), b0 = Math.floor(q[3 * i + 1] * 0.5), c0 = Math.floor(q[3 * i + 2] * 0.5);
      CX[i] = a0; CY[i] = b0; CZ[i] = c0;
      var h = hash(a0, b0, c0) & mask;
      cellOf[i] = h; cnt[h]++;
    }
    var acc = 0;
    for (var c = 0; c < this.tableSize; c++) { st[c] = acc; fill[c] = acc; acc += cnt[c]; }
    for (i = 0; i < N; i++) sorted[fill[cellOf[i]]++] = i;
    var nb = this.nb, nbc = this.nbc;
    nbc.fill(0);
    for (i = 0; i < N; i++) {
      var xi = q[3 * i], yi = q[3 * i + 1], zi = q[3 * i + 2];
      var ci = CX[i], cj = CY[i], ck = CZ[i];
      for (var o = -3; o < HALF.length; o += 3) {
        var tx, ty, tz, hh;
        if (o < 0) { tx = ci; ty = cj; tz = ck; hh = cellOf[i]; }
        else { tx = ci + HALF[o]; ty = cj + HALF[o + 1]; tz = ck + HALF[o + 2]; hh = hash(tx, ty, tz) & mask; }
        var e = st[hh] + cnt[hh];
        for (var a = st[hh]; a < e; a++) {
          var j = sorted[a];
          if (o < 0 && j <= i) continue;
          if (CX[j] !== tx || CY[j] !== ty || CZ[j] !== tz) continue;
          var rx = xi - q[3 * j], ry = yi - q[3 * j + 1], rz = zi - q[3 * j + 2];
          if (rx * rx + ry * ry + rz * rz < H2) {
            if (nbc[i] < MAXN) nb[i * MAXN + nbc[i]++] = j;
            if (nbc[j] < MAXN) nb[j * MAXN + nbc[j]++] = i;
          }
        }
      }
    }
  };

  /* XPBD density constraint.  Compliance alpha = 1/(rho c^2) (per particle,
     internal units) makes the solve timestep-consistent: water behaves as a
     weakly compressible fluid with artificial sound speed CS. */
  Bake.prototype.solve = function (dt) {
    var N = this.N, q = this.q, nb = this.nb, nbc = this.nbc, lam = this.lam, dl = this.dl, rho = this.rho, dq = this.dq;
    var rho0 = this.rho0, inv0 = 1 / rho0, iso = this.iso;
    var cs = 70 / this.s, at = 1 / (cs * cs * dt * dt);
    var W0 = POLY6 * H2 * H2 * H2;
    var dqr = 0.2 * H, dd = H2 - dqr * dqr, wdq = POLY6 * dd * dd * dd;
    var kc = 0.03 * Math.min(1, (dt / 0.0008) * (dt / 0.0008)) / this.iters;
    for (var i = 0; i < N; i++) {
      if (iso[i]) { dl[i] = 0; continue; }
      var xi = q[3 * i], yi = q[3 * i + 1], zi = q[3 * i + 2];
      var dens = W0, gx = 0, gy = 0, gz = 0, s2 = 0, base = i * MAXN, n = nbc[i];
      for (var k = 0; k < n; k++) {
        var j = nb[base + k];
        var rx = xi - q[3 * j], ry = yi - q[3 * j + 1], rz = zi - q[3 * j + 2];
        var r2 = rx * rx + ry * ry + rz * rz;
        if (r2 >= H2) continue;
        var d = H2 - r2; dens += POLY6 * d * d * d;
        if (r2 > 1e-12) {
          var r = Math.sqrt(r2), hr = H - r, g = SPIKY * hr * hr / r * inv0;
          var ax = g * rx, ay = g * ry, az = g * rz;
          gx += ax; gy += ay; gz += az; s2 += ax * ax + ay * ay + az * az;
        }
      }
      rho[i] = dens;
      var Cc = dens * inv0 - 1;
      var d0 = (-Cc - at * lam[i]) / (s2 + gx * gx + gy * gy + gz * gz + at);
      if (lam[i] + d0 > 0) d0 = -lam[i];          // unilateral: pressure only pushes
      lam[i] += d0; dl[i] = d0;
    }
    for (i = 0; i < N; i++) {
      var i3 = 3 * i;
      if (iso[i]) { dq[i3] = dq[i3 + 1] = dq[i3 + 2] = 0; continue; }
      xi = q[i3]; yi = q[i3 + 1]; zi = q[i3 + 2];
      var px = 0, py = 0, pz = 0, li = dl[i];
      base = i * MAXN; n = nbc[i];
      for (k = 0; k < n; k++) {
        j = nb[base + k];
        rx = xi - q[3 * j]; ry = yi - q[3 * j + 1]; rz = zi - q[3 * j + 2];
        r2 = rx * rx + ry * ry + rz * rz;
        if (r2 >= H2 || r2 < 1e-12) continue;
        r = Math.sqrt(r2); hr = H - r;
        d = H2 - r2;
        var w = POLY6 * d * d * d / wdq, w2 = w * w;
        var sc = -kc * w2 * w2;
        var f = (li + dl[j] + sc) * SPIKY * hr * hr / r;
        px += f * rx; py += f * ry; pz += f * rz;
      }
      dq[i3] = px * inv0; dq[i3 + 1] = py * inv0; dq[i3 + 2] = pz * inv0;
    }
    for (i = 0; i < 3 * N; i++) q[i] += dq[i];
  };

  /* floor + membrane constraints; on the last iteration records the outward
     momentum the stretched membrane is holding back. */
  Bake.prototype.collide = function (t1, dt, last) {
    var N = this.N, q = this.q, p = this.p, Ci = this.Ci, Ri = this.Ri, relT = this.relT, memV = this.memV;
    var margin = 0.5, mu = Math.min(0.25, 10 * dt), held = this.held, stored = this.stored, s = this.s;
    for (var i = 0; i < N; i++) {
      var i3 = 3 * i;
      if (t1 < relT[memV[i]]) {
        var dx = q[i3] - Ci[0], dy = q[i3 + 1] - Ci[1], dz = q[i3 + 2] - Ci[2];
        var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l > 1e-6) {
          var lim = Ri * SH.shapeR(dy / l) - margin;
          if (l > lim) {
            var sc = lim / l;
            if (last) {
              var nx = dx / l, ny = dy / l, nz = dz / l;
              var want = ((q[i3] - p[i3]) * nx + (q[i3 + 1] - p[i3 + 1]) * ny + (q[i3 + 2] - p[i3 + 2]) * nz) / dt * s;
              if (t1 < this.S.tX + 0.001 && want > 0.4 && want > stored[i]) stored[i] = want;
              held[i] = 1;
            }
            q[i3] = Ci[0] + dx * sc; q[i3 + 1] = Ci[1] + dy * sc; q[i3 + 2] = Ci[2] + dz * sc;
          }
        }
      }
      if (q[i3 + 1] < 0.5) {
        q[i3 + 1] = 0.5;
        var mf = this.iso[i] ? 0.85 : mu;
        q[i3] = p[i3] + (q[i3] - p[i3]) * (1 - mf);
        q[i3 + 2] = p[i3 + 2] + (q[i3 + 2] - p[i3 + 2]) * (1 - mf);
      }
    }
  };

  /* Hydrodynamic ram: as the bullet passes, the water around the path gets a
     radial (cylindrical line-source) velocity whose kinetic energy matches a
     fraction of the drag work, plus the axial momentum the drag imparts. */
  Bake.prototype.bullet = function (t0, t1) {
    var S = this.S, N = this.N, p = this.p, v = this.v, s = this.s, U = this.U;
    var ex = S.entry[0] / s, ey = S.entry[1] / s, ez = S.entry[2] / s;
    var rb = S.d / 2, r0 = Math.max(rb, 0.6 * s), rax = Math.max(0.015, 2.2 * rb + s);
    var blast = S.blast * U.energyTransfer, lnR = Math.log(S.R / r0);
    var ucap = Math.min(38, Math.max(16, 1.6 * S.blastV * Math.sqrt(U.energyTransfer)));
    for (var i = 0; i < N; i++) {
      if (this.hit[i]) continue;
      var i3 = 3 * i;
      var sx = (p[i3] - ex) * s;                     // path coordinate [m]
      if (sx < -0.5 * s || sx > S.L + 0.5 * s) continue;
      var sc = Math.max(0, Math.min(S.L, sx));
      var tp = SH.bulletTimeAt(S, sc);
      if (tp >= t1) continue;
      this.hit[i] = 1;
      var ry = (p[i3 + 1] - ey) * s, rz = (p[i3 + 2] - ez) * s;
      var r = Math.sqrt(ry * ry + rz * rz);
      var vb = SH.bulletV(S, tp);
      var Ep = S.m * S.k * vb * vb;                  // drag force = energy per unit length [J/m]
      var cav = SH.cavityAt(S, sc);
      var nyy = r > 1e-7 ? ry / r : 0, nzz = r > 1e-7 ? rz / r : 1;
      var jit = 0.85 + 0.3 * this.rng();
      // coherent outward blast: only when the cavity is comparable to the balloon
      if (blast > 0) {
        var gam = Math.sqrt(blast * Ep / (Math.PI * SH.RHO_W * lnR));
        var ur = Math.min(gam / Math.max(r, r0), ucap);
        v[i3 + 1] += ur * nyy * jit / s; v[i3 + 2] += ur * nzz * jit / s;
      }
      // axial momentum the drag hands to the water around the path
      var ux = (S.m * S.k * vb) / (SH.RHO_W * Math.PI * rax * rax) * Math.exp(-(r * r) / (rax * rax));
      v[i3] += Math.min(ux, 0.6 * ucap) * jit / s;
      this.tHit[i] = tp; this.tCav[i] = cav.Tc; this.rHit[i] = r; this.sHit[i] = sc; this.aMax[i] = cav.amax;
      var ra = 0.3 * cav.amax + r0;
      var ae = Math.exp(-(r * r) / (ra * ra));
      if (ae > this.aer[i]) this.aer[i] = ae;
    }
  };

  /* Cavity collapse (at t_pass + Tc): the inrushing water meets on the axis;
     most of the energy becomes heat, sound and a bubble cloud, the rest a
     churning core and jets squeezed out through the two holes. */
  Bake.prototype.collapse = function (t0, t1) {
    var N = this.N, v = this.v, s = this.s, S = this.S, U = this.U;
    var vj = 7.5 * Math.min(1.6, U.energyTransfer);
    for (var i = 0; i < N; i++) {
      if (!this.hit[i] || this.coll[i]) continue;
      var tc = this.tHit[i] + this.tCav[i];
      if (tc >= t1) continue;
      this.coll[i] = 1;
      var a = Math.max(this.aMax[i], 1e-3), r = this.rHit[i], sx = this.sHit[i], i3 = 3 * i;
      var core = Math.exp(-(r * r) / (1.69 * a * a));
      if (core < 0.02) continue;
      var sig = 0.12 * Math.sqrt(0.5 * S.m * S.k * S.v0 * S.v0 / (SH.RHO_W * Math.PI * 1.69 * a * a)) * core * U.energyTransfer;
      var gx = this.rng() * 2 - 1, gy = this.rng() * 2 - 1, gz = this.rng() * 2 - 1;
      v[i3] += gx * sig / s; v[i3 + 1] += gy * sig / s; v[i3 + 2] += gz * sig / s;
      var w = Math.exp(-(r * r) / (0.36 * a * a));
      var de = sx, dxh = S.L - sx, reach = 1.4 * a;
      if (de < reach) v[i3] -= vj * w * (1 - de / reach) * (0.7 + 0.6 * this.rng()) / s;
      if (S.hasExit && dxh < reach) v[i3] += vj * w * (1 - dxh / reach) * (0.7 + 0.6 * this.rng()) / s;
    }
  };

  /* When the rubber leaves a particle, the surface water gets a small tangential kick
     in the direction the latex slid off (the rubber drags a thin film with it). */
  Bake.prototype.release = function (t1) {
    var N = this.N, p = this.p, v = this.v, Ci = this.Ci, Ri = this.Ri, s = this.s, M = this.mem;
    var kick = 0.003 * this.U.peelSpeed, relT = this.relT, memV = this.memV, oc = M.origCopy, mx = M.x, m0 = M.x0;
    for (var i = 0; i < N; i++) {
      if (this.released[i] || t1 < relT[memV[i]]) continue;
      this.released[i] = 1;
      var i3 = 3 * i;
      var dx = p[i3] - Ci[0], dy = p[i3 + 1] - Ci[1], dz = p[i3 + 2] - Ci[2];
      var l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      var nx = dx / l, ny = dy / l, nz = dz / l;
      if (l < Ri * SH.shapeR(ny) - 1.1) continue;
      var c = oc[memV[i]]; if (c < 0) continue;
      var gx = mx[3 * c] - m0[3 * c], gy = mx[3 * c + 1] - m0[3 * c + 1], gz = mx[3 * c + 2] - m0[3 * c + 2];
      var gn = gx * nx + gy * ny + gz * nz; gx -= gn * nx; gy -= gn * ny; gz -= gn * nz;
      var gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (gl > 1e-9) {
        var mag = kick * (0.4 + 1.2 * this.rng()) / s / gl;
        v[i3] += gx * mag + nx * 0.05 / s;
        v[i3 + 1] += gy * mag + ny * 0.05 / s;
        v[i3 + 2] += gz * mag + nz * 0.05 / s;
      }
    }
  };

  /* XSPH viscosity + Akinci cohesion (surface tension) + air drag. */
  Bake.prototype.forces = function (dt) {
    var N = this.N, q = this.q, v = this.v, nb = this.nb, nbc = this.nbc, rho = this.rho, iso = this.iso;
    var U = this.U, s = this.s, rho0 = this.rho0;
    var c = Math.min(0.5, 0.012 * U.viscosity * dt / 0.0008);
    // cohesion strength tuned so the effective tension ~ water's 0.072 N/m at this resolution
    var gam = U.surfaceTension * 2.4 * 0.072 / (SH.RHO_W * s * s) / s / 0.02;
    var dv = this.dq;
    for (var i = 0; i < N; i++) {
      var i3 = 3 * i, n = nbc[i], base = i * MAXN;
      var ax = 0, ay = 0, az = 0, sx = 0, sy = 0, sz = 0;
      if (!iso[i]) {
        var coh = this.released[i] ? 1 : 0;
        var xi = q[i3], yi = q[i3 + 1], zi = q[i3 + 2], vx = v[i3], vy = v[i3 + 1], vz = v[i3 + 2];
        for (var k = 0; k < n; k++) {
          var j = nb[base + k], j3 = 3 * j;
          var rx = xi - q[j3], ry = yi - q[j3 + 1], rz = zi - q[j3 + 2];
          var r2 = rx * rx + ry * ry + rz * rz;
          if (r2 >= H2 || r2 < 1e-12) continue;
          var d = H2 - r2, w = POLY6 * d * d * d / rho0;
          sx += (v[j3] - vx) * w; sy += (v[j3 + 1] - vy) * w; sz += (v[j3 + 2] - vz) * w;
          var r = Math.sqrt(r2), hr = H - r, r3 = r * r2, hr3 = hr * hr * hr;
          var Cf = r > 1 ? COH * hr3 * r3 : COH * (2 * hr3 * r3 - 1);
          var Kij = 2 * rho0 / (rho[i] + rho[j] + 1e-6);
          var f = -gam * coh * Kij * Cf / r;
          ax += f * rx; ay += f * ry; az += f * rz;
        }
      }
      dv[i3] = c * sx + ax * dt; dv[i3 + 1] = c * sy + ay * dt; dv[i3 + 2] = c * sz + az * dt;
    }
    for (i = 0; i < 3 * N; i++) v[i] += dv[i];
  };

  Bake.prototype.step = function (dt) {
    var N = this.N, p = this.p, v = this.v, q = this.q, s = this.s, iso = this.iso;
    var t0 = this.t, t1 = t0 + dt, i, i3;
    this.mem.advanceTo(t1);                         // latex first: it decides which water is still held
    var gy = -this.gravity * dt / s;
    var rd = this.rdrop, kd = 0.375 * (SH.RHO_AIR / SH.RHO_W) * 0.47 / rd;
    var rel = this.released;
    for (i = 0; i < N; i++) {
      i3 = 3 * i;
      if (rel[i]) v[i3 + 1] += gy;
      if (iso[i]) {
        var vx = v[i3] * s, vy = v[i3 + 1] * s, vz = v[i3 + 2] * s;
        var sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        var f = Math.max(0, 1 - kd * sp * dt);
        v[i3] *= f; v[i3 + 1] *= f; v[i3 + 2] *= f;
      }
    }
    if (t1 > 0 && t0 < this.S.tX + 1e-4) this.bullet(t0, t1);
    if (t1 > 0 && t0 < this.S.cavEnd + 2e-4) this.collapse(t0, t1);
    for (i = 0; i < 3 * N; i++) q[i] = p[i] + v[i] * dt;
    this.neighbors();
    for (i = 0; i < N; i++) iso[i] = this.nbc[i] < 2 ? 1 : 0;
    this.held.fill(0); this.lam.fill(0);
    for (var it = 0; it < this.iters; it++) {
      this.solve(dt);
      this.collide(t1, dt, it === this.iters - 1);
    }
    var inv = 1 / dt;
    for (i = 0; i < N; i++) {
      i3 = 3 * i;
      v[i3] = (q[i3] - p[i3]) * inv; v[i3 + 1] = (q[i3 + 1] - p[i3 + 1]) * inv; v[i3 + 2] = (q[i3 + 2] - p[i3 + 2]) * inv;
    }
    this.forces(dt);
    var vc = 40 / s, vc2 = vc * vc;
    for (i = 0; i < N; i++) {
      i3 = 3 * i;
      var s2 = v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2];
      if (s2 > vc2) { var k = vc / Math.sqrt(s2); v[i3] *= k; v[i3 + 1] *= k; v[i3 + 2] *= k; }
    }
    var tmp = this.p; this.p = this.q; this.q = tmp;
    this.release(t1);
    this.t = t1;
    this.markWet(t1);
  };

  Bake.prototype.markWet = function (t) {
    var N = this.N, p = this.p, s = this.s, wet = this.wet, sc = WET_RES / (2 * WET_HALF);
    var rr = 0.6 * s * sc, ri = Math.ceil(rr), r2 = rr * rr;
    var marked = this.wetMarked || (this.wetMarked = new Uint8Array(N));
    for (var i = 0; i < N; i++) {
      if (p[3 * i + 1] > 1.3) continue;
      if (this.iso[i]) { if (marked[i]) continue; marked[i] = 1; }   // a lone drop leaves one spot
      var fx = (p[3 * i] * s + WET_HALF) * sc, fz = (p[3 * i + 2] * s + WET_HALF) * sc;
      var cx = Math.floor(fx), cz = Math.floor(fz);
      for (var dz = -ri; dz <= ri; dz++) for (var dx = -ri; dx <= ri; dx++) {
        var ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= WET_RES || iz >= WET_RES) continue;
        var ux = ix + 0.5 - fx, uz = iz + 0.5 - fz;
        if (ux * ux + uz * uz > r2) continue;
        var k = iz * WET_RES + ix;
        if (t < wet[k]) wet[k] = t;
      }
    }
  };

  Bake.prototype.maxSpeed = function () {
    var N = this.N, v = this.v, m = 0;
    for (var i = 0; i < N; i++) {
      if (this.iso[i]) continue;
      var a = v[3 * i], b = v[3 * i + 1], c = v[3 * i + 2], s2 = a * a + b * b + c * c;
      if (s2 > m) m = s2;
    }
    return Math.sqrt(m) * this.s;
  };

  Bake.prototype.settle = function () {
    // relax the lattice against the membrane under gravity, then zero velocities
    var t = this.t;
    for (var k = 0; k < 40; k++) { this.t = -1; this.step(0.001); }
    this.v.fill(0); this.t = t; this.released.fill(0); this.stored.fill(0);
  };

  /* Advance until the next output frame time; returns the frame or null. */
  Bake.prototype.advance = function () {
    if (this.done) return null;
    var tf = this.frames[this.nextFrame];
    if (this.t >= tf - 1e-9) return this.emit();
    var vmax = this.maxSpeed();
    var dt = Math.min(0.001, 0.8 * this.s / Math.max(vmax, 1e-3));
    dt = Math.max(dt, 1.5e-5);
    if (this.t < 0) dt = Math.min(dt, -this.t + 1e-9);
    if (this.t + dt > tf) dt = tf - this.t;
    if (dt > 1e-9) this.step(dt); else this.t = tf;
    if (this.t >= tf - 1e-9) return this.emit();
    return null;
  };

  Bake.prototype.emit = function () {
    var N = this.N, p = this.p, s = this.s;
    var pos = new Int16Array(N * 3), flags = new Uint8Array(N), aer = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      for (var c = 0; c < 3; c++) {
        var x = (p[3 * i + c] * s - QMIN[c]) / QSPAN[c];
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        pos[3 * i + c] = Math.round(x * 65535) - 32768;
      }
      flags[i] = this.iso[i];
      var ag = 0;
      if (this.aer[i] > 0) {
        var x2 = (this.frames[this.nextFrame] - this.tHit[i]) / Math.max(this.tCav[i], 1e-5);
        ag = x2 <= 0.55 ? 0 : x2 >= 1.05 ? 1 : (x2 - 0.55) / 0.5;
        ag = ag * ag * (3 - 2 * ag);
      }
      aer[i] = Math.round(Math.min(1, this.aer[i] * ag) * 255);
    }
    var tf = this.frames[this.nextFrame], S = this.S;
    if (tf > 0 && tf < S.cavEnd) this.cavityDisplace(pos, tf);
    var me = this.mem.emit(QMIN, QSPAN);
    var fr = { index: this.nextFrame, t: tf, pos: pos, flags: flags, aer: aer, mem: me.pos, det: me.det, peelEnd: me.peelEnd };
    this.nextFrame++;
    if (this.nextFrame >= this.frames.length) this.done = true;
    return fr;
  };

  /* Kinematic temporary cavity: area-preserving radial map r' = sqrt(r^2+a^2)
     around the bullet path, applied to the output frame only (the cavity
     opens and collapses within a few ms and leaves no net flow). */
  Bake.prototype.cavityDisplace = function (pos, t) {
    var N = this.N, p = this.p, s = this.s, S = this.S;
    var ex = S.entry[0], ey = S.entry[1], ez = S.entry[2];
    for (var i = 0; i < N; i++) {
      var x = p[3 * i] * s, y = p[3 * i + 1] * s, z = p[3 * i + 2] * s;
      var a = SH.cavityRadius(S, x - ex, t) * S.cavKin;
      if (a <= 0) continue;
      var dy = y - ey, dz = z - ez, r = Math.sqrt(dy * dy + dz * dz);
      var ny, nz;
      if (r < 1e-5) { var an = i * 2.39996323; ny = Math.cos(an); nz = Math.sin(an); r = 0; }
      else { ny = dy / r; nz = dz / r; }
      var r2 = Math.sqrt(r * r + a * a);
      var Y = ey + ny * r2, Z = ez + nz * r2;
      var qy = (Y - QMIN[1]) / QSPAN[1], qz = (Z - QMIN[2]) / QSPAN[2];
      pos[3 * i + 1] = Math.round(Math.min(1, Math.max(0, qy)) * 65535) - 32768;
      pos[3 * i + 2] = Math.round(Math.min(1, Math.max(0, qz)) * 65535) - 32768;
    }
  };

  return { Bake: Bake, frameSchedule: frameSchedule, QMIN: QMIN, QSPAN: QSPAN, WET_RES: WET_RES, WET_HALF: WET_HALF };
})();
if (typeof module !== 'undefined') module.exports = WB_SIM;
