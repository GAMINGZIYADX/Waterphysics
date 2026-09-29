/* ==========================================================================
   APP CORE: parameters, simulation worker bridge, frame store, volume build
   ========================================================================== */
var WB_Core = (function () {
  'use strict';
  var SH = WB_SHARED;
  var QMIN = [-3, -0.25, -3], QSPAN = [6, 3.5, 6];

  // bullet shapes and materials live in WB_SHARED.BULLETS (same keys)
  var PRESETS = {
    pellet: { label: '.177 diabolo air-rifle pellet · 0.53 g', bulletMass: 0.53, bulletCaliber: 4.5, bulletSpeed: 240 },
    lr22: { label: '.22 LR round-nose lead · 2.6 g', bulletMass: 2.6, bulletCaliber: 5.7, bulletSpeed: 330 },
    mm9: { label: '9 mm Luger 124 gr FMJ · 8.0 g', bulletMass: 8.0, bulletCaliber: 9.01, bulletSpeed: 360 },
    r556: { label: '5.56 NATO M855 spitzer boat-tail · 4.0 g', bulletMass: 4.0, bulletCaliber: 5.7, bulletSpeed: 930 },
    r762: { label: '7.62 NATO M80 ball · 9.5 g', bulletMass: 9.5, bulletCaliber: 7.82, bulletSpeed: 840 },
    bmg50: { label: '.50 BMG M33 ball · 42.8 g', bulletMass: 42.8, bulletCaliber: 12.95, bulletSpeed: 887 }
  };
  var COLORS = {
    red: { label: 'Red', c: [0.66, 0.014, 0.02] }, blue: { label: 'Blue', c: [0.06, 0.22, 0.85] },
    yellow: { label: 'Yellow', c: [0.95, 0.70, 0.04] }, green: { label: 'Green', c: [0.08, 0.60, 0.16] },
    orange: { label: 'Orange', c: [0.96, 0.33, 0.03] }, pink: { label: 'Pink', c: [0.95, 0.28, 0.52] },
    clear: { label: 'Clear latex', c: [0.93, 0.90, 0.84] }
  };
  // [group, key, label, min, max, step, default, unit, kind]  kind: 'sim' re-bakes, 'spray' regenerates spray
  var SPEC = [
    ['Projectile', 'projectile', 'Preset', PRESETS, null, null, 'lr22', '', 'sim'],
    ['Projectile', 'bulletSpeed', 'Impact speed', 50, 1000, 1, 330, 'm/s', 'sim'],
    ['Projectile', 'bulletMass', 'Bullet mass', 0.3, 50, 0.05, 2.6, 'g', 'sim'],
    ['Projectile', 'bulletCaliber', 'Caliber', 4, 14, 0.01, 5.7, 'mm', 'sim'],
    ['Projectile', 'impactOffset', 'Shot height vs. centre', -4, 4, 0.1, 0, 'cm', 'sim'],
    ['Balloon', 'balloonRadius', 'Balloon radius', 4, 11, 0.1, 7.5, 'cm', 'sim'],
    ['Balloon', 'balloonHeight', 'Height above floor', 0.3, 1.5, 0.01, 0.6, 'm', 'sim'],
    ['Balloon', 'peelSpeed', 'Latex retraction speed', 15, 100, 1, 45, 'm/s', 'sim'],
    ['Balloon', 'rubberColor', 'Latex colour', COLORS, null, null, 'red', '', ''],
    ['Balloon', 'rubberOpacity', 'Latex opacity', 0, 0.95, 0.01, 0.3, '', ''],
    ['Balloon', 'latexClarity', 'Latex clarity', 0, 1, 0.01, 0.3, '', ''],
    ['Physics', 'gravity', 'Gravity', 0, 25, 0.01, 9.81, 'm/s²', 'sim'],
    ['Physics', 'energyTransfer', 'Cavity violence', 0, 3, 0.05, 1, '×', 'sim'],
    ['Physics', 'surfaceTension', 'Surface tension', 0, 4, 0.05, 1, '×', 'sim'],
    ['Physics', 'viscosity', 'Viscosity', 0, 5, 0.05, 1, '×', 'sim'],
    ['Physics', 'particles', 'Fluid particles', 3000, 40000, 500, 14000, '', 'sim'],
    ['Spray & mist', 'sprayAmount', 'Spray droplets', 0, 2.5, 0.05, 1, '×', 'spray'],
    ['Spray & mist', 'mistAmount', 'Mist', 0, 3, 0.05, 1, '×', 'spray'],
    ['Spray & mist', 'bubbles', 'Cavitation bubbles', 0, 3, 0.05, 1, '×', ''],
    ['Lighting', 'caustics', 'Caustics (photon traced)', { on: { label: 'On' }, off: { label: 'Off' } }, null, null, 'on', '', ''],
    ['Lighting', 'keyIntensity', 'Key softbox', 0, 60, 0.5, 16, '', ''],
    ['Lighting', 'keyAz', 'Key azimuth', -180, 180, 1, 38, '°', ''],
    ['Lighting', 'keyEl', 'Key elevation', -10, 85, 1, 30, '°', ''],
    ['Lighting', 'keySize', 'Key size', 0.1, 2, 0.01, 0.9, 'm', ''],
    ['Lighting', 'rimIntensity', 'Backlight strip', 0, 120, 0.5, 32, '', ''],
    ['Lighting', 'rimAz', 'Backlight azimuth', -180, 180, 1, -150, '°', ''],
    ['Lighting', 'rimEl', 'Backlight elevation', 0, 85, 1, 42, '°', ''],
    ['Lighting', 'ambient', 'Ambient fill', 0, 0.4, 0.005, 0.05, '', ''],
    ['Lighting', 'backdrop', 'Backdrop albedo', 0, 0.8, 0.01, 0.07, '', ''],
    ['Lighting', 'bgLight', 'Background light', 0, 10, 0.1, 6, '', ''],
    ['Lighting', 'exposure', 'Exposure', -3, 3, 0.05, 0, 'EV', ''],
    ['Camera', 'fov', 'Field of view', 12, 75, 0.5, 30, '°', ''],
    ['Camera', 'renderScale', 'Render resolution (temporally upsampled)', 0.3, 1, 0.05, 0.75, '×', ''],
    ['Camera', 'maxSamples', 'Frozen-frame samples', 1, 256, 1, 64, '', ''],
    ['Camera', 'surfaceDetail', 'Surface micro-detail', 0, 3, 0.05, 1, '×', ''],
    ['Physics', 'surfaceSmooth', 'Surface smoothing passes', 0, 3, 1, 2, '', 'view'],
    ['Camera', 'fstop', 'Aperture (f-stop, frozen frames)', 1.4, 22, 0.1, 4, '', ''],
    ['Camera', 'shutter', 'Shutter (µs, frozen frames)', 0, 200, 0.5, 1, 'µs', ''],
    ['Camera', 'motionBlur', 'Motion blur (streaks, trails)', 0, 1, 0.05, 1, '×', ''],
    ['Camera', 'bloom', 'Bloom', 0, 3, 0.05, 1, '×', ''],
    ['Camera', 'grain', 'Film grain', 0, 3, 0.05, 1, '×', ''],
    ['Camera', 'vignette', 'Vignette', 0, 1, 0.01, 0.35, '', '']
  ];
  function defaults() {
    var U = { duration: 0.9 };
    SPEC.forEach(function (s) { U[s[1]] = s[6]; });
    return U;
  }

  // ---------------------------------------------------------------- worker bridge
  var GLUE = [
    'var job = null, slice = 35;',
    'function postWet(j){ var w = j.wet.slice(); self.postMessage({type:"wet", id:j.id, wet:w, res:WB_SIM.WET_RES, half:WB_SIM.WET_HALF}, [w.buffer]); }',
    'function pump(){ var j = job; if (!j) return; var t0 = Date.now();',
    '  while (Date.now() - t0 < slice && !j.done) { var f = j.advance(); if (f) {',
    '    var tr = [f.pos.buffer, f.flags.buffer, f.aer.buffer, f.mem.buffer]; if (f.det) tr.push(f.det.buffer);',
    '    self.postMessage({type:"frame", id:j.id, index:f.index, t:f.t, pos:f.pos, flags:f.flags, aer:f.aer, mem:f.mem, det:f.det, peelEnd:f.peelEnd}, tr);',
    '    if (f.index % 12 === 0) postWet(j); } }',
    '  if (j.done) { postWet(j); self.postMessage({type:"done", id:j.id}); if (job === j) job = null; return; }',
    '  setTimeout(pump, 0); }',
    'self.onmessage = function(e){ var m = e.data;',
    '  if (m.type === "bake") { slice = m.slice || 35; try { job = new WB_SIM.Bake(m.params, m.id); } catch (err) { self.postMessage({type:"error", id:m.id, msg:String(err && err.stack || err)}); return; }',
    '    self.postMessage({type:"meta", id:m.id, N:job.N, s:job.s, rdrop:job.rdrop, frames:job.frames, mem:job.mem.meta()}); setTimeout(pump, 0); }',
    '  else if (m.type === "stop") job = null; };'
  ].join('\n');

  function makeWorker(onmsg) {
    var src = document.getElementById('shared-src').textContent + '\n' + document.getElementById('sim-src').textContent + '\n' + GLUE;
    try {
      var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = function (e) { onmsg(e.data); };
      w.onerror = function (e) { console.warn('worker error', e); };
      w.local = false;
      return w;
    } catch (err) {
      // fallback: run the simulation cooperatively on the main thread
      var inner = { onmessage: null, postMessage: function (m) { onmsg(m); } };
      new Function('self', src)(inner);
      return { local: true, postMessage: function (m) { setTimeout(function () { inner.onmessage({ data: m }); }, 0); }, terminate: function () {} };
    }
  }

  // ---------------------------------------------------------------- frame store
  function Store(id, meta) {
    this.id = id; this.N = meta.N; this.s = meta.s; this.rdrop = meta.rdrop;
    this.times = meta.frames; this.frames = new Array(meta.frames.length); this.count = 0; this.done = false;
    this.P = new Float32Array(this.N * 3);
    this.sorted = new Float32Array(this.N * 4);
    this.fluid = new Float32Array(this.N * 36);
    this.kz = new Int32Array(this.N);
    this.com0 = null;
    // simulated latex: static mesh + per-frame vertex positions + detach times
    var mm = this.mm = meta.mem || null;
    this.peelEnd = 0; this.detVer = 0; this.detT = 0;
    if (mm) {
      this.memP = new Float32Array(mm.nc * 3); this.memN = new Float32Array(mm.nc * 3); this.memArea = new Float32Array(mm.nc);
      this.memVtx = new Float32Array(mm.nc * 7); this.memIdx = new Uint16Array(mm.nt * 3);
      this.det = new Float32Array(mm.nc).fill(1e9); this.detO = new Float32Array(mm.nv0).fill(1e9);
    }
  }
  Store.prototype.add = function (m) {
    this.frames[m.index] = { pos: m.pos, flags: m.flags, aer: m.aer, mem: m.mem };
    while (this.count < this.frames.length && this.frames[this.count]) this.count++;
    if (m.det && this.mm) {                          // latex that has left the water, per copy -> per mesh vertex
      this.det = m.det; this.detT = Math.max(this.detT, m.t); this.detVer++;
      var dO = this.detO.fill(1e9), co = this.mm.copyOf;
      for (var c = 0; c < m.det.length; c++) if (m.det[c] < dO[co[c]]) dO[co[c]] = m.det[c];
    }
    if (m.peelEnd && !this.peelEnd) this.peelEnd = m.peelEnd;
  };
  /* time the latex left direction (x,y,z) from the balloon centre (nearest mesh vertex) */
  Store.prototype.peelAt = function (x, y, z) {
    var mm = this.mm, d = mm.dir0, cs = 0.045, G = this.dirGrid, key = function (a, b, c) { return ((a + 64) * 128 + (b + 64)) * 128 + (c + 64); };
    if (!G) {
      G = this.dirGrid = new Map();
      for (var i = 0; i < mm.nv0; i++) {
        var k = key(Math.floor(d[3 * i] / cs), Math.floor(d[3 * i + 1] / cs), Math.floor(d[3 * i + 2] / cs)), L = G.get(k);
        if (!L) G.set(k, L = []); L.push(i);
      }
    }
    var l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    var a = Math.floor(x / cs), b = Math.floor(y / cs), c = Math.floor(z / cs), best = 0, bd = 1e9;
    for (var ia = a - 1; ia <= a + 1; ia++) for (var ib = b - 1; ib <= b + 1; ib++) for (var ic = c - 1; ic <= c + 1; ic++) {
      var LL = G.get(key(ia, ib, ic)); if (!LL) continue;
      for (var j = 0; j < LL.length; j++) {
        var v = LL[j], dx = d[3 * v] - x, dy = d[3 * v + 1] - y, dz = d[3 * v + 2] - z, dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = v; }
      }
    }
    return this.detO[best];
  };
  /* Rubber mesh at time t: interpolated positions, normals, relative thickness, and the
     triangles that have left the water (the latex still on the water is ray traced). */
  Store.prototype.assembleMem = function (i, j, w, t) {
    var mm = this.mm, A = this.frames[i].mem, B = this.frames[j].mem, nc = mm.nc, P = this.memP, c, a3;
    var k0 = QSPAN[0] / 65535, k1 = QSPAN[1] / 65535, k2 = QSPAN[2] / 65535;
    for (c = 0; c < nc; c++) {
      a3 = 3 * c;
      P[a3] = QMIN[0] + (A[a3] + (B[a3] - A[a3]) * w + 32768) * k0;
      P[a3 + 1] = QMIN[1] + (A[a3 + 1] + (B[a3 + 1] - A[a3 + 1]) * w + 32768) * k1;
      P[a3 + 2] = QMIN[2] + (A[a3 + 2] + (B[a3 + 2] - A[a3 + 2]) * w + 32768) * k2;
    }
    var T = mm.tris, die = mm.triDie, det = this.det, all = this.peelEnd > 0 && t >= this.peelEnd;
    var Nn = this.memN.fill(0), Ar = this.memArea.fill(0), idx = this.memIdx, ni = 0;
    for (var f = 0; f < mm.nt; f++) {
      if (die[f] <= t) continue;
      var a = T[3 * f], b = T[3 * f + 1], d = T[3 * f + 2];
      var ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      var vx = P[3 * d] - P[3 * a], vy = P[3 * d + 1] - P[3 * a + 1], vz = P[3 * d + 2] - P[3 * a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) / 3;
      Nn[3 * a] += nx; Nn[3 * a + 1] += ny; Nn[3 * a + 2] += nz; Ar[a] += ar;
      Nn[3 * b] += nx; Nn[3 * b + 1] += ny; Nn[3 * b + 2] += nz; Ar[b] += ar;
      Nn[3 * d] += nx; Nn[3 * d + 1] += ny; Nn[3 * d + 2] += nz; Ar[d] += ar;
      if (all || det[a] <= t || det[b] <= t || det[d] <= t) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = d; }
    }
    var V = this.memVtx, rA = mm.restA, L2 = mm.lambda * mm.lambda;
    for (c = 0; c < nc; c++) {
      a3 = 3 * c;
      var nl = Math.hypot(Nn[a3], Nn[a3 + 1], Nn[a3 + 2]) || 1, o = 7 * c;
      V[o] = P[a3]; V[o + 1] = P[a3 + 1]; V[o + 2] = P[a3 + 2];
      V[o + 3] = Nn[a3] / nl; V[o + 4] = Nn[a3 + 1] / nl; V[o + 5] = Nn[a3 + 2] / nl;
      V[o + 6] = Ar[c] > 1e-12 ? Math.min(16, rA[c] * L2 / Ar[c]) : 1;
    }
    return { vtx: V, idx: idx, count: ni, nc: nc };
  };
  /* Per-vertex detach times for the ray-traced latex field; vertices still on the water
     get "shortly after the simulated time" so the tear front interpolates sensibly. */
  Store.prototype.peelField = function () {
    var dO = this.detO, out = new Float32Array(dO.length), cap = this.peelEnd > 0 ? 1e4 : (this.count ? Math.max(this.bakedTime(), 0) : 0) + 2e-4;
    for (var i = 0; i < dO.length; i++) out[i] = Math.min(dO[i], cap);
    return out;
  };
  Store.prototype.bakedTime = function () { return this.count ? this.times[this.count - 1] : -1; };

  /* Interpolate particles at time t and build everything the renderer needs. */
  Store.prototype.assemble = function (t) {
    if (!this.count) return null;
    var times = this.times, n = this.count, lo = 0, hi = n - 1;
    if (t <= times[0]) hi = 0;
    else if (t >= times[n - 1]) lo = hi = n - 1;
    else { while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; } }
    var i = lo, j = hi, w = j > i ? (t - times[i]) / (times[j] - times[i]) : 0;
    w = Math.min(1, Math.max(0, w));
    var A = this.frames[i], B = this.frames[j], N = this.N, P = this.P;
    var k0 = QSPAN[0] / 65535, k1 = QSPAN[1] / 65535, k2 = QSPAN[2] / 65535;
    var pa = A.pos, pb = B.pos;
    for (var k = 0; k < N; k++) {
      var a = 3 * k;
      P[a] = QMIN[0] + (pa[a] + (pb[a] - pa[a]) * w + 32768) * k0;
      P[a + 1] = QMIN[1] + (pa[a + 1] + (pb[a + 1] - pa[a + 1]) * w + 32768) * k1;
      P[a + 2] = QMIN[2] + (pa[a + 2] + (pb[a + 2] - pa[a + 2]) * w + 32768) * k2;
    }
    var flags = (w < 0.5 ? A : B).flags, aer = B.aer;
    var dtAB = j > i ? times[j] - times[i] : 0;
    // classify: detached drops (flag), water lying on the floor, airborne connected water
    var sflo = 1.4 * this.s, fl = this.floorFlag || (this.floorFlag = new Uint8Array(N));
    var cls = this.cls || (this.cls = new Uint8Array(N));     // 0 bulk, 1 drop, 2 floor
    var mnA = [1e9, 1e9, 1e9], mxA = [-1e9, -1e9, -1e9], mnF = [1e9, 1e9, 1e9], mxF = [-1e9, -1e9, -1e9], na = 0, nf = 0;
    for (k = 0; k < N; k++) {
      a = 3 * k;
      fl[k] = P[a + 1] < sflo ? 1 : 0;
      if (fl[k]) { cls[k] = 2; nf++; for (var c = 0; c < 3; c++) { mnF[c] = Math.min(mnF[c], P[a + c]); mxF[c] = Math.max(mxF[c], P[a + c]); } }
      else if (flags[k] & 1) cls[k] = 1;
      else { cls[k] = 0; na++; for (c = 0; c < 3; c++) { mnA[c] = Math.min(mnA[c], P[a + c]); mxA[c] = Math.max(mxA[c], P[a + c]); } }
    }
    // robust bounds of the airborne water: 0.1%..99.9% quantiles (stray clusters become droplets; a
    // wider cut slices flat faces off an expanding cloud)
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    if (na > 0) {
      var NB = 1024, hist = this.hist || (this.hist = new Int32Array(NB)), cut = Math.floor(na * 0.001);
      for (c = 0; c < 3; c++) {
        var lo0 = mnA[c], span = Math.max(mxA[c] - lo0, 1e-6);
        hist.fill(0);
        for (k = 0; k < N; k++) if (cls[k] === 0) hist[Math.min(NB - 1, Math.floor((P[3 * k + c] - lo0) / span * NB))]++;
        var acc = 0, qa = 0, qb = NB - 1;
        for (var q = 0; q < NB; q++) { acc += hist[q]; if (acc > cut) { qa = q; break; } }
        acc = 0;
        for (q = NB - 1; q >= 0; q--) { acc += hist[q]; if (acc > cut) { qb = q; break; } }
        mn[c] = lo0 + qa / NB * span - 4 * this.s; mx[c] = lo0 + (qb + 1) / NB * span + 4 * this.s;
      }
      for (k = 0; k < N; k++) {
        if (cls[k] !== 0) continue;
        a = 3 * k;
        if (P[a] < mn[0] || P[a] > mx[0] || P[a + 1] < mn[1] || P[a + 1] > mx[1] || P[a + 2] < mn[2] || P[a + 2] > mx[2]) cls[k] = 1;
      }
    }
    if (nf > 0) for (c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], mnF[c]); mx[c] = Math.max(mx[c], mxF[c]); }
    var com = [0, 0, 0], nb = 0, ni = 0;
    for (k = 0; k < N; k++) {
      if (cls[k] === 1) { ni++; continue; }
      nb++; com[0] += P[3 * k]; com[1] += P[3 * k + 1]; com[2] += P[3 * k + 2];
    }
    var out = { t: t, bulk: nb, iso: ni, com: null, vol: null, fluidCount: 0, fluid: this.fluid };
    if (this.mem && t < (this.peelEnd > 0 ? this.peelEnd + 0.001 : 1e9)) {   // keep the whole latex membrane inside the volume
      // including its blast inflation: a box face cutting the inflated skin shows as a flat white slab
      var gb = Math.min(this.mem.rate * Math.max(t, 0), this.mem.cap);
      for (c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], this.mem.min[c] - gb); mx[c] = Math.max(mx[c], this.mem.max[c] + gb); }
    }
    if (nb > 0) {
      com = [com[0] / nb, com[1] / nb, com[2] / nb];
      if (!this.com0) this.com0 = com.slice();
      out.com = com;
      var s = this.s, h = 2.3 * s, pad = 2.0 * h + 0.6 * s;
      var cell = 0.5 * s, dims, ext = [mx[0] - mn[0] + 2 * pad, mx[1] - mn[1] + 2 * pad, mx[2] - mn[2] + 2 * pad];
      for (var it = 0; it < 40; it++) {
        dims = [Math.ceil(ext[0] / cell / 4) * 4, Math.ceil(ext[1] / cell / 4) * 4, Math.ceil(ext[2] / cell / 4) * 4];
        if (dims[0] * dims[1] * dims[2] <= 2.6e6 && Math.max(dims[0], dims[1], dims[2]) <= 256) break;
        cell *= 1.12;
      }
      var vmin = [0.5 * (mn[0] + mx[0]) - 0.5 * dims[0] * cell, 0.5 * (mn[1] + mx[1]) - 0.5 * dims[1] * cell, 0.5 * (mn[2] + mx[2]) - 0.5 * dims[2] * cell];
      // counting sort by z-slice
      var nz = dims[2], cnt = new Int32Array(nz + 1), kz = this.kz;
      for (k = 0; k < N; k++) {
        if (cls[k] === 1) { kz[k] = -1; continue; }
        var z = Math.floor((P[3 * k + 2] - vmin[2]) / cell); z = z < 0 ? 0 : z >= nz ? nz - 1 : z;
        kz[k] = z; cnt[z + 1]++;
      }
      for (z = 0; z < nz; z++) cnt[z + 1] += cnt[z];
      var start = cnt.slice(), fill = cnt.slice(0, nz), S4 = this.sorted;
      for (k = 0; k < N; k++) {
        if (kz[k] < 0) continue;
        var o = 4 * fill[kz[k]]++;
        S4[o] = P[3 * k]; S4[o + 1] = P[3 * k + 1]; S4[o + 2] = P[3 * k + 2]; S4[o + 3] = aer[k] / 255 + (fl[k] ? 2 : 0);
      }
      out.vol = { data: S4, count: nb, sliceStart: start, nx: dims[0], ny: dims[1], nz: nz, min: vmin, cell: cell, h: h, smooth: this.smooth | 0,
                  size: [dims[0] * cell, dims[1] * cell, dims[2] * cell] };
    }
    // detached water becomes ray-traced drops: a main drop plus smaller satellites trailing
    // behind it along its motion (a pinching ligament), with a spread of sizes
    var F = this.fluid, fc = 0, rd = this.rdrop;
    if (F.length < N * 36) F = this.fluid = out.fluid = new Float32Array(N * 36);
    for (k = 0; k < N; k++) {
      if (cls[k] !== 1) continue;
      a = 3 * k;
      var h1 = (k * 0.618034) % 1, h2 = (k * 0.381966 + 0.3) % 1;
      var vx = 0, vy = 0, vz = 0;
      if (dtAB > 0) { vx = (pb[a] - pa[a]) * k0 / dtAB; vy = (pb[a + 1] - pa[a + 1]) * k1 / dtAB; vz = (pb[a + 2] - pa[a + 2]) * k2 / dtAB; }
      var sp = Math.hypot(vx, vy, vz), nsat = sp > 2.5 ? 2 : 1;
      var r0 = rd * (0.42 + 0.4 * h1);
      for (var m = 0; m < nsat; m++) {
        var rr = m === 0 ? r0 : r0 * 0.42 * (0.8 + 0.4 * h2);
        var back = m === 0 ? 0 : 1.9 * r0 / Math.max(sp, 1e-6);
        var bb = 12 * fc++;
        F[bb] = P[a] - vx * back; F[bb + 1] = P[a + 1] - vy * back; F[bb + 2] = P[a + 2] - vz * back; F[bb + 3] = t;
        F[bb + 4] = vx; F[bb + 5] = vy; F[bb + 6] = vz; F[bb + 7] = rr;      // velocity: motion blur, stretching, motion vectors
        F[bb + 8] = 1; F[bb + 9] = 1e9; F[bb + 10] = h1; F[bb + 11] = 1;
      }
    }
    out.fluidCount = fc;
    if (this.mm && A.mem && B.mem) out.mem = this.assembleMem(i, j, w, t);
    return out;
  };

  // ---------------------------------------------------------------- lights & scene uniforms
  function rectLight(C, az, el, dist, w, h, L) {
    var a = az * Math.PI / 180, e = el * Math.PI / 180;
    var c = [C[0] + dist * Math.cos(e) * Math.sin(a), C[1] + dist * Math.sin(e), C[2] + dist * Math.cos(e) * Math.cos(a)];
    var n = [C[0] - c[0], C[1] - c[1], C[2] - c[2]], nl = Math.hypot(n[0], n[1], n[2]); n = [n[0] / nl, n[1] / nl, n[2] / nl];
    var up = Math.abs(n[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
    var u = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]], ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    var v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    return { c: c, u: [u[0] * w / 2, u[1] * w / 2, u[2] * w / 2], v: [v[0] * h / 2, v[1] * h / 2, v[2] * h / 2], e: L };
  }

  // speed [m/s] at which the blast inflates the still-attached skin (bound used by the shaders and the volume box)
  function bulgeRate(U, S) { return S.blast > 0.02 ? Math.min(38, S.blastV * U.energyTransfer * 0.9 * 2.2) : 0; }
  Store.prototype.setMembrane = function (S, rate) {
    var R = S.R * 1.06;
    this.mem = { min: [S.C[0] - R, S.C[1] - R, S.C[2] - R], max: [S.C[0] + R, S.topY + 0.004, S.C[2] + R], until: S.tPeelEnd + 0.001,
                 rate: rate || 0, cap: 0.5 * S.R };
  };

  /* Analytic liquid features (see GLSL analyticSD): exit plume core, entry splash cone,
     cavity-collapse jets from both holes, floor lamella + crown. */
  function liquidFeatures(U, S, t, u) {
    var A = new Float32Array(16), B = new Float32Array(16), Cc = new Float32Array(16);
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    function grow(o, a, L, r) {
      for (var c = 0; c < 3; c++) {
        var e = o[c] + a[c] * L;
        mn[c] = Math.min(mn[c], Math.min(o[c], e) - r - 0.01); mx[c] = Math.max(mx[c], Math.max(o[c], e) + r + 0.01);
      }
    }
    function set(i, o, a, L, r, cone, thick, phase, taper) {
      if (!(L > 0.0005) || !(r > 0.0005)) return;
      A.set([o[0], o[1], o[2], L], 4 * i); B.set([a[0], a[1], a[2], r], 4 * i); Cc.set([cone, thick, phase, taper], 4 * i);
      grow(o, a, L, r + (cone > 0 ? cone * L : 0));
    }
    var dir = S.dir, back = [-dir[0], -dir[1], -dir[2]], vio = Math.min(2, U.energyTransfer);
    // exit: the latex tents, ruptures, and a liquid core follows the bullet out, then breaks up
    if (S.hasExit) {
      var t0 = S.tX - 0.00015, tt = t - t0;
      if (tt > 0 && tt < 0.007) {
        var vc = Math.min(0.12 * S.vExit, 45) * Math.min(1.5, Math.sqrt(vio));
        var L = Math.min(vc * tt, 0.09);
        var aX = SH.cavityRadius(S, S.L - 1e-4, Math.max(t, S.tX + 1e-5));
        var r = Math.min(0.4 * aX + 0.003, 0.3 * S.R) * (1 - smooth(0.002, 0.006, tt));
        var o = [S.exit[0] - 0.012 * dir[0], S.exit[1], S.exit[2]];
        set(0, o, dir, L + 0.012, r, 0, 0, tt * 2600, 0.55);
      }
    }
    // entry: backward hollow splash cone
    if (false) {
      var aE = SH.cavityRadius(S, 1e-4, t);
      var Le = Math.min(7 * Math.sqrt(vio) * t, 0.03);
      set(1, [S.entry[0] + 0.004 * back[0], S.entry[1], S.entry[2]], back, Le, 0.5 * aE + 0.002, 0.95, 0.0026 * (1 - smooth(0.002, 0.004, t)), t * 1800, 0);
    }
    // cavity collapse: water squirts out of both holes along the bullet line
    var holes = [[S.entry, back, SH.cavityAt(S, 0).Tc, 2], [S.exit, dir, S.tX + SH.cavityAt(S, S.L).Tc, 3]];
    holes.forEach(function (h) {
      if (h[3] === 3 && !S.hasExit) return;
      var tc = t - h[2];
      if (tc <= 0 || tc > 0.016) return;
      var vj = 9 * vio, Lj = Math.min(vj * tc, 0.11);
      var rj = (0.0045 + 0.0035 * Math.sqrt(S.cavMax.amax / 0.025)) * (1 - smooth(0.009, 0.016, tc));
      set(h[3], [h[0][0] - 0.01 * h[1][0], h[0][1], h[0][2]], h[1], Lj + 0.01, rj, 0, 0, tc * 1500 + h[3], 0.35);
    });
    u.uJetA = A; u.uJetB = B; u.uJetC = Cc;
    // floor lamella + crown
    var tI = S.tImpact + 0.0025, vI = U.gravity * S.tImpact;
    u.uImp = [U.gravity > 0.5 ? tI : 1e9, vI, S.C[0], S.C[2]];
    u.uImp2 = [0.8 * S.R, 0.09 * vI / 3.3, 0, 0];
    if (U.gravity > 0.5 && t > tI) {
      var Rm = 0.8 * S.R + 1.4 * vI * 0.09 * 1.2 + 0.05;
      mn = [Math.min(mn[0], S.C[0] - Rm), Math.min(mn[1], -0.005), Math.min(mn[2], S.C[2] - Rm)];
      mx = [Math.max(mx[0], S.C[0] + Rm), Math.max(mx[1], 0.095), Math.max(mx[2], S.C[2] + Rm)];
    }
    if (mn[0] > mx[0]) { mn = [0, -1, 0]; mx = [0, -1, 0]; }
    u.uAnMin = mn; u.uAnMax = mx;
  }
  function sceneUniforms(U, S, t, asm, store) {
    var u = {};
    u.uTime = t; u.uG = U.gravity;
    u.uC = S.C; u.uR = S.R; u.uEDir = S.eDir; u.uXDir = S.xDir;
    // end of the peel as simulated (until the simulation gets there the latex is still on)
    var pe = store && store.peelEnd > 0 ? store.peelEnd : (store && store.mm ? 1e9 : S.tPeelEnd);
    u.uTE = 0; u.uTX = S.tX; u.uRate = S.peel.rate; u.uKappa = S.peel.kappa; u.uPeelEnd = pe < 1e8 ? pe : S.tPeelEnd; u.uHasExit = S.hasExit ? 1 : 0;
    var col = COLORS[U.rubberColor] ? COLORS[U.rubberColor].c : COLORS.red.c;
    u.uRubberCol = col; u.uRubberOpacity = U.rubberOpacity;
    u.uMembrane = t < pe ? 1 : 0;
    var white = [1.0, 0.975, 0.94];
    var C = S.C;
    var key = rectLight(C, U.keyAz, U.keyEl, 1.6, U.keySize, U.keySize * 1.25, white.map(function (x) { return x * U.keyIntensity; }));
    var rim = rectLight(C, U.rimAz, U.rimEl, 1.35, 0.3, 1.25, [0.95 * U.rimIntensity, 0.98 * U.rimIntensity, 1.0 * U.rimIntensity]);
    u.uL0c = key.c; u.uL0u = key.u; u.uL0v = key.v; u.uL0e = key.e;
    u.uL1c = rim.c; u.uL1u = rim.u; u.uL1v = rim.v; u.uL1e = rim.e;
    u.uAmbient = U.ambient; u.uBackdrop = U.backdrop; u.uBgLight = U.bgLight;
    // volume
    if (asm && asm.vol) {
      u.uHasVol = 1; u.uVolMin = asm.vol.min; u.uVolSize = asm.vol.size; u.uCell = asm.vol.cell;
    } else { u.uHasVol = 0; u.uVolMin = [0, 0, 0]; u.uVolSize = [1, 1, 1]; u.uCell = 0.01; }
    var s = store ? store.s : 0.005;
    // iso level at ~13% of the interior kernel sum (random packing, kernel radius 2.3 s)
    u.uIso = 0.13 * 0.957 * Math.pow(2.3, 3); u.uMemSlope = 1.5 * u.uIso / s; u.uBand = 2.4 * s;
    u.uEU = S.peel.eu; u.uEV = S.peel.ev; u.uXU = S.peel.xu; u.uXV = S.peel.xv;
    var prog = Math.min(1, Math.max(0, t / S.tPeelEnd)), simMem = !!(store && store.mm);
    // rolled rim where the latex still lies on the water (the lifted rim itself is the simulated mesh)
    u.uLipH = simMem ? 0.0003 + 0.0004 * prog : 0.0007 + 0.0013 * prog; u.uLipW = simMem ? 0.00004 : 0.00007 + 0.00005 * prog;
    liquidFeatures(U, S, t, u);
    u.uTent = S.hasExit ? 0.012 * (S.R / 0.075) * smooth(S.tX - 0.00022, S.tX, t) * (1 - smooth(S.tX, S.tX + 0.0003, t)) : 0;
    u.uFlowOff = asm && asm.com && store && store.com0 ? [asm.com[0] - store.com0[0], asm.com[1] - store.com0[1], asm.com[2] - store.com0[2]] : [0, 0, 0];
    // ripples scale with the shot: impact shock ring on the skin, capillary rings on the bare water
    u.uShock = 0.0016 * Math.min(2.2, Math.max(0.7, Math.sqrt(S.violence))) * (U.surfaceDetail > 0 ? 1 : 0);
    // blast inflation of the skin (same law as the membrane's contact surface); drawn by the ring pass
    u.uBlastV = S.blast > 0.02 ? S.blastV * U.energyTransfer * 0.9 : 0;
    u.uEntry = S.entry; u.uBK = S.k; u.uBV0 = S.v0; u.uBL = S.L;
    u.uBulgeMax = u.uBlastV > 0 ? bulgeRate(U, S) * Math.max(t, 0) + 0.001 : 0;
    u.uCapRing = 0.35 * Math.min(2.0, Math.max(0.6, Math.sqrt(S.violence))) * U.surfaceDetail;
    u.uRipple = 1; u.uDetail = U.surfaceDetail; u.uClarity = U.latexClarity; u.uBubble = 45 * U.bubbles; u.uMist = U.mistAmount > 0 ? 1 : 0;
    // bullet
    var sb = SH.bulletS(S, t);
    var tip = [S.entry[0] + sb, S.entry[1], S.entry[2]];
    u.uBulletTip = tip; u.uBulletDir = S.dir;
    u.uBulletR = S.d / 2; u.uBulletLen = S.bullet.len * S.d;
    u.uBulletF0 = S.bullet.f0; u.uBulletRough = S.bullet.rough;       // jacket (gilding metal / copper / brass) or lead
    u.uBulletOn = tip[0] < 3.0 ? 1 : 0;
    // latex neck / knot, recoiling on the string after the pop (the rag hanging from it is the simulated mesh)
    var te = S.tPeelEnd, dy = SH.knotDY(S, t);
    u.uKnotPos = [S.knot[0], S.knot[1] + dy, S.knot[2]];
    u.uWadPos = [S.knot[0], S.knot[1] + dy - 0.007, S.knot[2]];
    u.uWadR = simMem ? 0 : 0.012 * (S.R / 0.075) * smooth(0.45 * te, te, t);
    u.uNeckOn = simMem ? 1 - smooth(pe, pe + 0.004, t) : 1 - smooth(0.45 * te, 0.9 * te, t);
    u.uTopY = S.topY;
    return u;
  }
  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  /* Bullet mesh: the design's true profile (WB_SHARED.BULLETS, in calibres) revolved about the
     flight line.  Vertex: [distance behind the tip, radius, angle, axial normal, radial normal,
     material (0 jacket, 1 lead, 2 cannelure groove)]. */
  function bulletMesh(S) {
    var bs = S.bullet, d = S.d, Rb = d / 2, L = bs.len * d, Ln = bs.nose * d, rm = bs.meplat * Rb;
    var Lbt = bs.bt * d, Rbase = bs.base * Rb, xc = bs.can > 0 ? bs.can * L : -1, dc = 0.012 * d;
    function prof(x) {
      var y = Rb;
      if (bs.type === 2) {                            // diabolo: domed head, narrow waist, flared skirt
        var xh = 0.4 * L, xw = 0.53 * L;
        if (x < xh) { var e = (xh - x) / xh; return Rb * Math.sqrt(Math.max(1 - e * e, 0)); }
        return x < xw ? Rb - 0.4 * Rb * (x - xh) / (xw - xh) : 0.6 * Rb + 0.44 * Rb * (x - xw) / (L - xw);
      }
      if (x < Ln) {
        var u = Ln - x;
        if (bs.type === 1) { var e1 = u / Ln; y = Rb * Math.sqrt(Math.max(1 - e1 * e1, 0)); }     // round nose
        else { var rho = (Rb * Rb + Ln * Ln) / (2 * Rb); y = Math.sqrt(Math.max(rho * rho - u * u, 0)) + Rb - rho; }  // tangent ogive
      } else if (x > L - Lbt) y = Rb - (x - (L - Lbt)) * (Rb - Rbase) / Lbt;                   // boat-tail
      if (xc > 0) y -= dc * (1 - smooth(0, 4 * dc, Math.abs(x - xc)));                           // crimp groove
      return Math.max(y, 0);
    }
    var x0 = 0;                                        // flat meplat face
    if (bs.type === 1) x0 = Ln * (1 - Math.sqrt(Math.max(0, 1 - (rm / Rb) * (rm / Rb))));
    else if (bs.type === 0) { var rho0 = (Rb * Rb + Ln * Ln) / (2 * Rb), yy = rm - Rb + rho0; x0 = Ln - Math.sqrt(Math.max(0, rho0 * rho0 - yy * yy)); }
    var xs = [], i, k;
    var noseEnd = bs.type === 2 ? 0.4 * L : Ln;
    for (i = 0; i <= 48; i++) { var s = i / 48; xs.push(x0 + (noseEnd - x0) * s * s * (2 - s) * 0.5 + (noseEnd - x0) * s * 0.5); }
    for (i = 1; i <= 40; i++) xs.push(noseEnd + (L - noseEnd) * i / 40);
    var NS = 48, V = [], I = [];
    function ring(x, y, na, nr, mat) {
      var base = V.length / 6;
      for (var j = 0; j <= NS; j++) V.push(x, y, j / NS * 2 * Math.PI, na, nr, mat);
      return base;
    }
    function strip(a, b) { for (var j = 0; j < NS; j++) I.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1); }
    // side: normal of the surface of revolution from the profile slope
    var prev = -1;
    for (i = 0; i < xs.length; i++) {
      var x = xs[i], h = Math.max(1e-6 * d, 0.002 * L), sl = (prof(Math.min(L, x + h)) - prof(Math.max(x0, x - h))) / (Math.min(L, x + h) - Math.max(x0, x - h));
      var nl = Math.sqrt(1 + sl * sl), mat = bs.lead === 2 ? 1 : (xc > 0 && Math.abs(x - xc) < 4 * dc ? 2 : 0);
      var r0 = ring(x, prof(x), -sl / nl, 1 / nl, mat);
      if (prev >= 0) strip(prev, r0);
      prev = r0;
    }
    // meplat face (forward) and base (backward, exposed lead core on FMJ)
    var cap = function (x, rOut, rIn, na, matOut, matIn, flip) {
      var a = ring(x, rOut, na, 0, matOut), b = ring(x, rIn, na, 0, matOut), c = ring(x, rIn, na, 0, matIn), e = ring(x, 0, na, 0, matIn);
      if (flip) { strip(b, a); strip(e, c); } else { strip(a, b); strip(c, e); }
    };
    var tipMat = bs.lead === 2 ? 1 : 0, baseLead = bs.lead >= 1 ? 1 : 0;
    cap(x0, prof(x0), prof(x0) * 0.5, -1, tipMat, tipMat, true);
    cap(L, prof(L), prof(L) * (bs.lead === 1 ? 0.8 : 0.5), 1, bs.lead === 2 ? 1 : 0, baseLead, false);
    return { vtx: new Float32Array(V), idx: new Uint16Array(I) };
  }

  return { PRESETS: PRESETS, COLORS: COLORS, SPEC: SPEC, defaults: defaults, makeWorker: makeWorker, Store: Store,
           sceneUniforms: sceneUniforms, bulletMesh: bulletMesh, bulgeRate: bulgeRate };
})();
