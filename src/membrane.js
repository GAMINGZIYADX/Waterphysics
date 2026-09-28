/* ==========================================================================
   LATEX MEMBRANE  (runs in the worker, in lock-step with the fluid)
   The balloon skin is a pre-stretched rubber shell (icosphere, ~10k vertices)
   simulated with XPBD: edge springs whose rest length is the unstretched
   length (L / lambda), weak bending, frictionless one-sided contact with the
   water, gravity and air drag once it is free.
   Tearing: the bullet punches a hole at the entry (and, after the latex has
   tented, at the exit); meandering cracks run out from the hole rims at crack
   speed.  Along every crack path the mesh is pre-split into vertex copies that
   stay welded together until the crack tip passes.  Everything else - the gap
   opening along each crack, petals retracting and peeling back from their
   tips, the thickened rolled rim, flaps flung off the surface, strips cut
   free by crossing cracks and the rag left on the knot - comes out of the
   dynamics of the stretched sheet.
   Output per frame: all vertex positions (quantised like the fluid), plus the
   time each original vertex left the water (drives the ray-traced latex that
   still covers the water, and the release of the water under it).
   ========================================================================== */
var WB_MEM = (function () {
  'use strict';
  var SH = WB_SHARED;
  var LAMBDA = 2.6;          // biaxial pre-stretch of a filled water balloon
  var H0 = 2.5e-4;           // unstretched latex thickness [m]
  var RHO_L = 950;           // latex density [kg/m^3]
  var LEVEL = 5;             // icosphere subdivisions: 10242 vertices, 20480 triangles
  var DETACH = 0.001;        // [m] latex that has moved this far has left its spot on the water
  var PIN_Y = 0.975;         // directions above this are the tied neck (held by the knot)

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function norm3(a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function tbasis(a) { var t = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; var u = norm3(cross(a, t)); return [u, cross(a, u)]; }

  function icosphere(level) {
    var t = (1 + Math.sqrt(5)) / 2;
    var V = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
    var F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
             3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
    function nrm(i) { var l = Math.hypot(V[3 * i], V[3 * i + 1], V[3 * i + 2]); V[3 * i] /= l; V[3 * i + 1] /= l; V[3 * i + 2] /= l; }
    for (var i = 0; i < 12; i++) nrm(i);
    for (var lv = 0; lv < level; lv++) {
      var cache = new Map(), F2 = [];
      var mid = function (a, b) {
        var key = a < b ? a * 1048576 + b : b * 1048576 + a, m = cache.get(key);
        if (m !== undefined) return m;
        m = V.length / 3;
        V.push((V[3 * a] + V[3 * b]) / 2, (V[3 * a + 1] + V[3 * b + 1]) / 2, (V[3 * a + 2] + V[3 * b + 2]) / 2); nrm(m);
        cache.set(key, m); return m;
      };
      for (var f = 0; f < F.length; f += 3) {
        var a = F[f], b = F[f + 1], c = F[f + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        F2.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
      }
      F = F2;
    }
    return { V: V, F: F };
  }

  /* ---------------------------------------------------------------- construction */
  function Membrane(S, U) {
    this.S = S; this.U = U;
    var rnd = SH.rng(4242 + Math.round(U.bulletSpeed * 3 + U.bulletMass * 17 + U.impactOffset * 31 + U.balloonRadius * 7));
    var ico = icosphere(LEVEL), V = ico.V, F = ico.F, nv = V.length / 3, nt = F.length / 3;
    this.nv0 = nv; this.nt = nt;
    // random orientation and a tangential jitter so the tears never follow mesh lines
    var q0 = rnd() - 0.5, q1 = rnd() - 0.5, q2 = rnd() - 0.5, q3 = rnd() - 0.5, ql = Math.hypot(q0, q1, q2, q3);
    q0 /= ql; q1 /= ql; q2 /= ql; q3 /= ql;
    var M = [1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2),
             2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1),
             2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2)];
    var edgeAng = Math.sqrt(4 * Math.PI / nt * 4 / Math.sqrt(3));   // mean edge angle [rad]
    var dir = this.dir0 = new Float32Array(nv * 3);
    for (var i = 0; i < nv; i++) {
      var x = V[3 * i], y = V[3 * i + 1], z = V[3 * i + 2];
      var d = [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
      var B = tbasis(d), j1 = (rnd() - 0.5) * 0.55 * edgeAng, j2 = (rnd() - 0.5) * 0.55 * edgeAng;
      d = norm3([d[0] + B[0][0] * j1 + B[1][0] * j2, d[1] + B[0][1] * j1 + B[1][1] * j2, d[2] + B[0][2] * j1 + B[1][2] * j2]);
      dir[3 * i] = d[0]; dir[3 * i + 1] = d[1]; dir[3 * i + 2] = d[2];
    }
    this.F0 = new Uint32Array(F);
    this.edgeAng = edgeAng;
    this.buildAdjacency();
    this.buildGrid();
    this.makeHoles();
    this.makeCracks(rnd);
    this.splitTopology();
    this.buildConstraints();
    this.initState();
  }
  var P = Membrane.prototype;

  P.surfPos = function (i, out) {                  // point of the undisturbed balloon surface for vertex i
    var S = this.S, d = this.dir0, r = S.R * SH.shapeR(d[3 * i + 1]);
    out[0] = S.C[0] + d[3 * i] * r; out[1] = S.C[1] + d[3 * i + 1] * r; out[2] = S.C[2] + d[3 * i + 2] * r;
    return out;
  };

  P.buildAdjacency = function () {
    var nv = this.nv0, F = this.F0, cnt = new Int32Array(nv + 1), i, f;
    var sets = new Array(nv);
    for (i = 0; i < nv; i++) sets[i] = [];
    for (f = 0; f < F.length; f += 3) {
      for (var k = 0; k < 3; k++) {
        var a = F[f + k], b = F[f + (k + 1) % 3];
        if (sets[a].indexOf(b) < 0) sets[a].push(b);
        if (sets[b].indexOf(a) < 0) sets[b].push(a);
      }
    }
    for (i = 0; i < nv; i++) cnt[i + 1] = cnt[i] + sets[i].length;
    var nb = new Int32Array(cnt[nv]);
    for (i = 0; i < nv; i++) for (var j = 0; j < sets[i].length; j++) nb[cnt[i] + j] = sets[i][j];
    this.nbStart = cnt; this.nb = nb;
  };

  /* uniform grid over the unit sphere for nearest-vertex lookups by direction */
  P.buildGrid = function () {
    var nv = this.nv0, d = this.dir0, G = new Map(), cs = 0.045;
    for (var i = 0; i < nv; i++) {
      var key = this.gkey(Math.floor(d[3 * i] / cs), Math.floor(d[3 * i + 1] / cs), Math.floor(d[3 * i + 2] / cs));
      var l = G.get(key); if (!l) G.set(key, l = []); l.push(i);
    }
    this.grid = G; this.gcs = cs;
  };
  P.gkey = function (a, b, c) { return ((a + 64) * 128 + (b + 64)) * 128 + (c + 64); };
  P.nearest = function (x, y, z) {
    var l = Math.sqrt(x * x + y * y + z * z) || 1; x /= l; y /= l; z /= l;
    var cs = this.gcs, a = Math.floor(x / cs), b = Math.floor(y / cs), c = Math.floor(z / cs), d = this.dir0, best = 0, bd = 1e9;
    for (var r = 1; r <= 3 && bd > 1e8; r++) {
      for (var ia = a - r; ia <= a + r; ia++) for (var ib = b - r; ib <= b + r; ib++) for (var ic = c - r; ic <= c + r; ic++) {
        var L = this.grid.get(this.gkey(ia, ib, ic)); if (!L) continue;
        for (var k = 0; k < L.length; k++) {
          var v = L[k], dx = d[3 * v] - x, dy = d[3 * v + 1] - y, dz = d[3 * v + 2] - z, dd = dx * dx + dy * dy + dz * dz;
          if (dd < bd) { bd = dd; best = v; }
        }
      }
    }
    return best;
  };

  /* bullet holes: triangles inside the hole disappear when the bullet passes */
  P.makeHoles = function () {
    var S = this.S, F = this.F0, nt = this.nt, d = this.dir0, vio = S.violence;
    var rE = Math.max(0.55 * S.d, 0.0015), rX = Math.max(0.004, 0.8 * S.d + 0.003 * Math.sqrt(vio));
    this.holes = [{ a: S.eDir, t: 0, ang: rE / S.R }];
    if (S.hasExit) this.holes.push({ a: S.xDir, t: S.tX, ang: rX / S.R });
    var dead = this.triDead = new Float64Array(nt).fill(1e9);
    for (var t = 0; t < nt; t++) {
      var a = F[3 * t], b = F[3 * t + 1], c = F[3 * t + 2];
      var cen = norm3([d[3 * a] + d[3 * b] + d[3 * c], d[3 * a + 1] + d[3 * b + 1] + d[3 * c + 1], d[3 * a + 2] + d[3 * b + 2] + d[3 * c + 2]]);
      this.holes.forEach(function (h) {
        var ang = Math.acos(clamp(dot(cen, h.a), -1, 1));
        if (ang < h.ang && h.t < dead[t]) dead[t] = h.t;
      });
    }
  };

  /* Meandering cracks run out from each hole rim at crack speed, sometimes branching.
     More energetic shots start more cracks that run further (the latex shreds). */
  P.makeCracks = function (rnd) {
    var S = this.S, U = this.U, vio = S.violence, self = this, list = [];
    var nBase = Math.round(clamp(3 + 1.1 * vio, 3, 11));
    var ds = 0.011;                                          // step along the unit sphere [rad]
    function grow(p, u, h, depth, t0) {
      var pts = [p[0], p[1], p[2]], ts = [t0], t = t0, om = 0;
      var thMax = Math.min(3.0, (0.85 + 1.2 * rnd()) * (depth ? 0.55 : 1) * (1 + 0.16 * Math.log(1 + vio)));
      var v0 = U.peelSpeed * (1.25 + 0.55 * rnd()) * (1 + 0.1 * Math.log(1 + vio));
      for (var st = 0; st < 600; st++) {
        var th = Math.acos(clamp(dot(p, h.a), -1, 1));
        if (th > thMax || p[1] > PIN_Y - 0.03) break;
        // persistent random walk (smoothly varying turn rate) biased away from the hole
        om = om * 0.9 + (rnd() - 0.5) * 0.07;
        var w = cross(p, u), c = Math.cos(om), s = Math.sin(om);
        u = [u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s];
        var pa = dot(p, h.a), away = [p[0] * pa - h.a[0], p[1] * pa - h.a[1], p[2] * pa - h.a[2]], al = Math.hypot(away[0], away[1], away[2]);
        if (al > 1e-6) { u = [u[0] + 0.1 * away[0] / al, u[1] + 0.1 * away[1] / al, u[2] + 0.1 * away[2] / al]; }
        p = norm3([p[0] + u[0] * ds, p[1] + u[1] * ds, p[2] + u[2] * ds]);
        var up = dot(u, p); u = norm3([u[0] - p[0] * up, u[1] - p[1] * up, u[2] - p[2] * up]);
        var vc = v0 * (1 - 0.4 * Math.min(1, th / thMax));  // the crack slows as it runs out of stored energy
        t += ds * S.R * SH.shapeR(p[1]) / vc;
        pts.push(p[0], p[1], p[2]); ts.push(t);
        if (depth < 2 && st > 3 && rnd() < 0.01 * (1 + 0.3 * vio)) {
          var bs = (rnd() < 0.5 ? -1 : 1) * (0.35 + 0.4 * rnd()), bw = cross(p, u);
          grow(p.slice(), norm3([u[0] * Math.cos(bs) + bw[0] * Math.sin(bs), u[1] * Math.cos(bs) + bw[1] * Math.sin(bs), u[2] * Math.cos(bs) + bw[2] * Math.sin(bs)]), h, depth + 1, t);
        }
      }
      if (ts.length > 2) list.push({ pts: pts, ts: ts });
    }
    this.holes.forEach(function (h, hi) {
      var B = tbasis(h.a), n = nBase + hi;
      for (var k = 0; k < n; k++) {
        var ph = (k + 0.5 + 0.75 * (rnd() - 0.5)) / n * 2 * Math.PI + hi * 0.7;
        var u = [B[0][0] * Math.cos(ph) + B[1][0] * Math.sin(ph), B[0][1] * Math.cos(ph) + B[1][1] * Math.sin(ph), B[0][2] * Math.cos(ph) + B[1][2] * Math.sin(ph)];
        var ca = Math.cos(h.ang * 0.9), sa = Math.sin(h.ang * 0.9);
        var p = norm3([h.a[0] * ca + u[0] * sa, h.a[1] * ca + u[1] * sa, h.a[2] * ca + u[2] * sa]);
        var uu = norm3([u[0] * ca - h.a[0] * sa, u[1] * ca - h.a[1] * sa, u[2] * ca - h.a[2] * sa]);
        grow(p, uu, h, 0, h.t + 1e-6);
      }
    });
    // follow each crack polyline along mesh edges: those edges tear when the tip arrives
    var tear = this.tearT = new Map(), nv = this.nv0, d = this.dir0, nbS = this.nbStart, nb = this.nb;
    list.forEach(function (cr) {
      var n = cr.ts.length, P3 = cr.pts, cur = self.nearest(P3[0], P3[1], P3[2]), k = 0, seen = new Set([cur]);
      for (var guard = 0; guard < 4 * n + 20; guard++) {
        var tg = Math.min(n - 1, k + 3), tx = P3[3 * tg], ty = P3[3 * tg + 1], tz = P3[3 * tg + 2];
        var best = -1, bd = 1e9;
        for (var e = nbS[cur]; e < nbS[cur + 1]; e++) {
          var v = nb[e]; if (seen.has(v)) continue;
          var dx = d[3 * v] - tx, dy = d[3 * v + 1] - ty, dz = d[3 * v + 2] - tz, dd = dx * dx + dy * dy + dz * dz;
          if (dd < bd) { bd = dd; best = v; }
        }
        if (best < 0) break;
        // advance the polyline parameter to the point nearest the new vertex
        var kb = k, kd = 1e9;
        for (var kk = k; kk < Math.min(n, k + 12); kk++) {
          var ex = d[3 * best] - P3[3 * kk], ey = d[3 * best + 1] - P3[3 * kk + 1], ez = d[3 * best + 2] - P3[3 * kk + 2], e2 = ex * ex + ey * ey + ez * ez;
          if (e2 < kd) { kd = e2; kb = kk; }
        }
        var key = cur < best ? cur * nv + best : best * nv + cur, tt = cr.ts[kb];
        if (!(tear.get(key) <= tt)) tear.set(key, tt);
        seen.add(best); cur = best; k = kb;
        if (k >= n - 1) break;
      }
    });
  };

  /* Split every vertex whose triangle fan is cut (by crack edges or hole triangles)
     into one copy per fan segment; copies of the same vertex stay welded until the
     cuts on both sides between them have happened. */
  P.splitTopology = function () {
    var nv = this.nv0, nt = this.nt, F = this.F0, dead = this.triDead, tear = this.tearT;
    var inc = new Array(nv), i, v;
    for (i = 0; i < nv; i++) inc[i] = [];
    for (i = 0; i < 3 * nt; i++) inc[F[i]].push(i);
    var corner = this.corner = new Int32Array(3 * nt), copyOf = [], welds = [];
    for (v = 0; v < nv; v++) {
      var cs = inc[v], m = cs.length, byPrev = new Map(), j;
      for (j = 0; j < m; j++) { var c = cs[j], t = (c / 3) | 0, k = c % 3; byPrev.set(F[3 * t + (k + 2) % 3], j); }
      var order = new Int32Array(m), nxt = new Int32Array(m), cur = 0;
      for (j = 0; j < m; j++) {
        order[j] = cur;
        var cc = cs[cur], tt = (cc / 3) | 0, kk = cc % 3, n1 = F[3 * tt + (kk + 1) % 3];
        nxt[j] = n1; var nb = byPrev.get(n1); cur = nb === undefined ? cur : nb;
      }
      var cut = new Float64Array(m), nf = 0;
      for (j = 0; j < m; j++) {
        var ta = (cs[order[j]] / 3) | 0, tb = (cs[order[(j + 1) % m]] / 3) | 0;
        var key = v < nxt[j] ? v * nv + nxt[j] : nxt[j] * nv + v, ct = tear.has(key) ? tear.get(key) : 1e9;
        if (dead[ta] < 1e8 || dead[tb] < 1e8) ct = Math.min(ct, Math.min(dead[ta], dead[tb]));
        cut[j] = ct; if (ct < 1e8) nf++;
      }
      var base = copyOf.length;
      if (nf <= 1) {                                   // fan still one piece
        copyOf.push(v);
        for (j = 0; j < m; j++) corner[cs[j]] = base;
        continue;
      }
      var cutIdx = [];
      for (j = 0; j < m; j++) if (cut[j] < 1e8) cutIdx.push(j);
      var G = cutIdx.length;
      for (var g = 0; g < G; g++) {                   // group g: triangles after cut g up to cut g+1
        copyOf.push(v);
        var s0 = cutIdx[g] + 1, s1 = cutIdx[(g + 1) % G];
        for (var s = s0; ; s++) { var jj = s % m; corner[cs[order[jj]]] = base + g; if (jj === s1) break; }
      }
      for (var a = 0; a < G; a++) for (var b = a + 1; b < G; b++) {
        var m1 = 1e9, m2 = 1e9;
        for (g = a + 1; g <= b; g++) m1 = Math.min(m1, cut[cutIdx[g]]);
        for (g = b + 1; g <= a + G; g++) m2 = Math.min(m2, cut[cutIdx[g % G]]);
        welds.push(base + a, base + b, Math.max(m1, m2));
      }
    }
    this.nc = copyOf.length;
    this.copyOf = new Uint32Array(copyOf);
    this.wA = new Int32Array(welds.length / 3); this.wB = new Int32Array(welds.length / 3); this.wT = new Float64Array(welds.length / 3);
    for (i = 0; i < welds.length / 3; i++) { this.wA[i] = welds[3 * i]; this.wB[i] = welds[3 * i + 1]; this.wT[i] = welds[3 * i + 2]; }
  };

  P.buildConstraints = function () {
    var nt = this.nt, F = this.F0, cor = this.corner, nc = this.nc, dead = this.triDead, nv = this.nv0;
    var p0 = this.p0 = new Float64Array(nv * 3), tmp = [0, 0, 0], i, t, k;
    for (i = 0; i < nv; i++) { this.surfPos(i, tmp); p0[3 * i] = tmp[0]; p0[3 * i + 1] = tmp[1]; p0[3 * i + 2] = tmp[2]; }
    function dist(a, b) { return Math.hypot(p0[3 * a] - p0[3 * b], p0[3 * a + 1] - p0[3 * b + 1], p0[3 * a + 2] - p0[3 * b + 2]); }
    var emap = new Map();
    for (t = 0; t < nt; t++) for (k = 0; k < 3; k++) {
      var ca = cor[3 * t + k], cb = cor[3 * t + (k + 1) % 3], key = ca < cb ? ca * nc + cb : cb * nc + ca, e = emap.get(key);
      if (!e) emap.set(key, e = { a: ca, b: cb, n: 0, die: 0, L: dist(F[3 * t + k], F[3 * t + (k + 1) % 3]) / LAMBDA, w: [] });
      e.n++; e.die = Math.max(e.die, dead[t]); e.w.push(cor[3 * t + (k + 2) % 3]);
    }
    // latex: E ~ 1.5 MPa, h0 0.25 mm; stiffness scaled so the free edge retracts at the chosen speed
    var KE = 1100 * Math.pow(this.U.peelSpeed / 45, 2);
    var ne = emap.size, eA = new Int32Array(ne), eB = new Int32Array(ne), eL = new Float64Array(ne), eAl = new Float64Array(ne), eDie = new Float64Array(ne);
    var bend = [];
    i = 0;
    emap.forEach(function (e) {
      eA[i] = e.a; eB[i] = e.b; eL[i] = e.L; eAl[i] = 1 / (KE * e.n / 2); eDie[i] = e.die; i++;
      if (e.n === 2) bend.push(e.w[0], e.w[1], e.die);
    });
    this.ne = ne; this.eA = eA; this.eB = eB; this.eL = eL; this.eAl = eAl; this.eDie = eDie; this.eLam = new Float64Array(ne);
    var nb = bend.length / 3, bA = new Int32Array(nb), bB = new Int32Array(nb), bL = new Float64Array(nb), bDie = new Float64Array(nb);
    var co = this.copyOf;
    for (i = 0; i < nb; i++) { bA[i] = bend[3 * i]; bB[i] = bend[3 * i + 1]; bDie[i] = bend[3 * i + 2]; bL[i] = dist(co[bA[i]], co[bB[i]]) / LAMBDA; }
    this.nbd = nb; this.bA = bA; this.bB = bB; this.bL = bL; this.bDie = bDie; this.bLam = new Float64Array(nb); this.bAl = 1 / (0.04 * KE);
    // masses from the unstretched triangle areas; copies die with their (hole) triangles
    var mass = new Float64Array(nc), die = this.copyDie = new Float64Array(nc), rA = this.restA = new Float32Array(nc);
    for (t = 0; t < nt; t++) {
      var a = F[3 * t], b = F[3 * t + 1], c = F[3 * t + 2];
      var ux = p0[3 * b] - p0[3 * a], uy = p0[3 * b + 1] - p0[3 * a + 1], uz = p0[3 * b + 2] - p0[3 * a + 2];
      var vx = p0[3 * c] - p0[3 * a], vy = p0[3 * c + 1] - p0[3 * a + 1], vz = p0[3 * c + 2] - p0[3 * a + 2];
      var area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / (LAMBDA * LAMBDA);
      for (k = 0; k < 3; k++) { var cp = cor[3 * t + k]; mass[cp] += area / 3 * RHO_L * H0; rA[cp] += area / 3; die[cp] = Math.max(die[cp], dead[t]); }
    }
    this.mass = mass;
  };

  P.initState = function () {
    var nc = this.nc, co = this.copyOf, p0 = this.p0, d = this.dir0, S = this.S;
    var x = this.x = new Float64Array(nc * 3), i;
    this.v = new Float64Array(nc * 3); this.xp = new Float64Array(nc * 3);
    var w = this.w = new Float64Array(nc), pin = this.pin = new Uint8Array(nc);
    for (i = 0; i < nc; i++) {
      var o = co[i];
      x[3 * i] = p0[3 * o]; x[3 * i + 1] = p0[3 * o + 1]; x[3 * i + 2] = p0[3 * o + 2];
      if (d[3 * o + 1] > PIN_Y) { pin[i] = 1; w[i] = 0; } else w[i] = this.mass[i] > 0 ? 1 / this.mass[i] : 0;
    }
    this.tDet = new Float64Array(nc).fill(1e9);
    this.tDetO = new Float64Array(this.nv0).fill(1e9);
    this.rs = new Float64Array(nc);
    this.t = -1e-3; this.peelEnd = 0; this.detChanged = true;
    this.kDrag = 0.5 * SH.RHO_AIR * 0.7 / (RHO_L * H0);     // quadratic air drag of a fluttering scrap [1/m]
    this.tContactEnd = S.tPeelEnd * 2.5 + 0.004;
    // relax the pre-stretched shell on the water (mesh irregularities), then take it as the reference
    for (i = 0; i < 160; i++) { this.substep(-1e-3, 2e-5, 4, true); for (var k = 0; k < 3 * nc; k++) this.v[k] *= 0.3; }
    this.v.fill(0);
    this.x0 = new Float64Array(x);
  };

  /* Radius of the water surface under direction (dx,dy,dz) at time t: the balloon shape,
     the tent at the exit and, for violent shots, the water being blown outward. */
  P.surfR = function (dx, dy, dz, t) {
    var S = this.S, r = S.R * SH.shapeR(dy);
    var ten = SH.tentAmp(S, t);
    if (ten > 0) { var ca = clamp(dx * S.xDir[0] + dy * S.xDir[1] + dz * S.xDir[2], -1, 1), a = Math.acos(ca); r += ten * Math.exp(-a * a / 0.03); }
    if (S.blast > 0.02 && t > 0) {
      var px = S.C[0] + dx * r - S.entry[0], py = S.C[1] + dy * r - S.entry[1], pz = S.C[2] + dz * r - S.entry[2];
      var tp = SH.bulletTimeAt(S, clamp(px, 0, S.L));
      if (t > tp) {
        var ra = Math.max(Math.hypot(py, pz), 0.006), u = Math.min(38, S.blastV * this.U.energyTransfer * 0.9 * Math.min(2.2, 0.05 / ra));
        r += u * (t - tp) * Math.max(0.3, (py * dy + pz * dz) / ra);
      }
    }
    return r;
  };
  // the tied neck: stays put, then gathers into the knot and bobs with it
  P.pinPos = function (i, t, out) {
    var S = this.S, o = 3 * i, x0 = this.x0 || this.x, k = this.peelEnd > 0 ? SH.smooth(this.peelEnd, this.peelEnd + 0.004, t) : 0;
    var kx = S.knot[0], ky = S.knot[1] - 0.006, kz = S.knot[2];
    out[0] = x0[o] + (kx + (x0[o] - kx) * 0.35 - x0[o]) * k;
    out[1] = x0[o + 1] + (ky - x0[o + 1]) * k + SH.knotDY(S, t);
    out[2] = x0[o + 2] + (kz + (x0[o + 2] - kz) * 0.35 - x0[o + 2]) * k;
  };

  P.substep = function (t, dt, iters, settle) {
    var nc = this.nc, x = this.x, v = this.v, xp = this.xp, w = this.w, S = this.S, i, i3;
    var t1 = t + dt, g = this.U.gravity, kd = this.kDrag, tDet = this.tDet, die = this.copyDie, tmp = [0, 0, 0];
    for (i = 0; i < nc; i++) {
      i3 = 3 * i;
      if (w[i] > 0 && die[i] <= t1) w[i] = 0;         // fell into a bullet hole
      xp[i3] = x[i3]; xp[i3 + 1] = x[i3 + 1]; xp[i3 + 2] = x[i3 + 2];
      if (this.pin[i]) { this.pinPos(i, t1, tmp); x[i3] = tmp[0]; x[i3 + 1] = tmp[1]; x[i3 + 2] = tmp[2]; continue; }
      if (w[i] === 0) continue;
      if (tDet[i] < t) {                              // free rubber: gravity and air drag
        v[i3 + 1] -= g * dt;
        var sp = Math.sqrt(v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2]), f = 1 / (1 + kd * sp * dt);
        v[i3] *= f; v[i3 + 1] *= f; v[i3 + 2] *= f;
      }
      x[i3] += v[i3] * dt; x[i3 + 1] += v[i3 + 1] * dt; x[i3 + 2] += v[i3 + 2] * dt;
    }
    // water surface radius under every vertex (moves slowly: once per substep)
    var contact = settle || t1 < this.tContactEnd, rs = this.rs, C = S.C;
    if (contact) for (i = 0; i < nc; i++) {
      if (w[i] === 0) continue; i3 = 3 * i;
      var dx = x[i3] - C[0], dy = x[i3 + 1] - C[1], dz = x[i3 + 2] - C[2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      rs[i] = l > 1e-6 && l < 1.6 * S.R ? this.surfR(dx / l, dy / l, dz / l, t1) : 0;
    }
    this.eLam.fill(0); this.bLam.fill(0);
    for (var it = 0; it < iters; it++) {
      this.solveEdges(dt, t1);
      this.solveBend(dt, t1);
      this.solveWelds(t1);
      if (contact) this.contact(rs);
    }
    var inv = 1 / dt;
    for (i = 0; i < nc; i++) {
      if (w[i] === 0) continue; i3 = 3 * i;
      if (x[i3 + 1] < 5e-4) {                          // floor: stick-slip friction
        x[i3 + 1] = 5e-4; x[i3] = xp[i3] + (x[i3] - xp[i3]) * 0.4; x[i3 + 2] = xp[i3 + 2] + (x[i3 + 2] - xp[i3 + 2]) * 0.4;
      }
      v[i3] = (x[i3] - xp[i3]) * inv; v[i3 + 1] = (x[i3 + 1] - xp[i3 + 1]) * inv; v[i3 + 2] = (x[i3 + 2] - xp[i3 + 2]) * inv;
    }
    if (settle) return;
    // latex that has moved off its spot has uncovered the water there
    var x0 = this.x0, D2 = DETACH * DETACH, co = this.copyOf, tDO = this.tDetO;
    for (i = 0; i < nc; i++) {
      if (tDet[i] < 1e8 || (w[i] === 0 && !(die[i] <= t1))) continue;
      i3 = 3 * i;
      var ex = x[i3] - x0[i3], ey = x[i3 + 1] - x0[i3 + 1], ez = x[i3 + 2] - x0[i3 + 2];
      if (die[i] <= t1 || ex * ex + ey * ey + ez * ez > D2) {
        tDet[i] = t1;
        if (t1 < tDO[co[i]]) { tDO[co[i]] = t1; this.detChanged = true; }
      }
    }
  };

  P.solveEdges = function (dt, t1) {
    var n = this.ne, A = this.eA, B = this.eB, L0 = this.eL, al = this.eAl, die = this.eDie, lam = this.eLam, x = this.x, w = this.w;
    var idt2 = 1 / (dt * dt);
    for (var e = 0; e < n; e++) {
      if (die[e] <= t1) continue;
      var a = A[e], b = B[e], wa = w[a], wb = w[b], ws = wa + wb;
      if (ws === 0) continue;
      var a3 = 3 * a, b3 = 3 * b, dx = x[a3] - x[b3], dy = x[a3 + 1] - x[b3 + 1], dz = x[a3 + 2] - x[b3 + 2];
      var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-12) continue;
      var C = l - L0[e], at = al[e] * idt2 * (C < 0 ? 25 : 1);    // rubber buckles instead of resisting compression
      var dl = (-C - at * lam[e]) / (ws + at);
      lam[e] += dl;
      var s = dl / l;
      x[a3] += wa * s * dx; x[a3 + 1] += wa * s * dy; x[a3 + 2] += wa * s * dz;
      x[b3] -= wb * s * dx; x[b3 + 1] -= wb * s * dy; x[b3 + 2] -= wb * s * dz;
    }
  };
  P.solveBend = function (dt, t1) {
    var n = this.nbd, A = this.bA, B = this.bB, L0 = this.bL, die = this.bDie, lam = this.bLam, x = this.x, w = this.w;
    var at0 = this.bAl / (dt * dt);
    for (var e = 0; e < n; e++) {
      if (die[e] <= t1) continue;
      var a = A[e], b = B[e], wa = w[a], wb = w[b], ws = wa + wb;
      if (ws === 0) continue;
      var a3 = 3 * a, b3 = 3 * b, dx = x[a3] - x[b3], dy = x[a3 + 1] - x[b3 + 1], dz = x[a3 + 2] - x[b3 + 2];
      var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-12) continue;
      var C = l - L0[e], at = at0 * (C < 0 ? 4 : 1);
      var dl = (-C - at * lam[e]) / (ws + at);
      lam[e] += dl;
      var s = dl / l;
      x[a3] += wa * s * dx; x[a3 + 1] += wa * s * dy; x[a3 + 2] += wa * s * dz;
      x[b3] -= wb * s * dx; x[b3 + 1] -= wb * s * dy; x[b3 + 2] -= wb * s * dz;
    }
  };
  P.solveWelds = function (t1) {                      // copies of one vertex are the same point until the crack passes
    var n = this.wA.length, A = this.wA, B = this.wB, T = this.wT, x = this.x, w = this.w;
    for (var e = 0; e < n; e++) {
      if (T[e] <= t1) continue;
      var a = A[e], b = B[e], wa = w[a], wb = w[b], ws = wa + wb;
      if (ws === 0) continue;
      var a3 = 3 * a, b3 = 3 * b, fa = wa / ws, fb = wb / ws;
      for (var c = 0; c < 3; c++) { var d = x[a3 + c] - x[b3 + c]; x[a3 + c] -= fa * d; x[b3 + c] += fb * d; }
    }
  };
  P.contact = function (rs) {                         // frictionless, one-sided: latex can leave the water, not enter it
    var nc = this.nc, x = this.x, w = this.w, C = this.S.C;
    for (var i = 0; i < nc; i++) {
      var r = rs[i]; if (w[i] === 0 || r === 0) continue;
      var i3 = 3 * i, dx = x[i3] - C[0], dy = x[i3 + 1] - C[1], dz = x[i3 + 2] - C[2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < r && l > 1e-6) { var s = r / l; x[i3] = C[0] + dx * s; x[i3 + 1] = C[1] + dy * s; x[i3 + 2] = C[2] + dz * s; }
    }
  };

  /* Advance to time t1 (sub-stepped: fine while the latex tears, coarse once only scraps fall). */
  P.advanceTo = function (t1) {
    if (t1 <= 0) { this.t = t1; return; }
    if (this.t < 0) this.t = 0;
    while (this.t < t1 - 1e-12) {
      var early = this.t < 0.015, dt = early ? 1e-5 : this.t < 0.06 ? 5e-5 : 2.5e-4, iters = early ? 4 : this.t < 0.06 ? 3 : 2;
      dt = Math.min(dt, t1 - this.t);
      this.substep(this.t, dt, iters, false);
      this.t += dt;
      if (!this.peelEnd) this.checkPeelEnd();
    }
  };
  // the peel is over once (almost) all latex has left the water; the neck lets go of the rest
  P.checkPeelEnd = function () {
    var S = this.S, t = this.t;
    if (t < 0.5 * S.tPeelEnd) return;
    var nc = this.nc, n = 0, nd = 0;
    for (var i = 0; i < nc; i++) { if (this.pin[i] || this.copyDie[i] < 1e8) continue; n++; if (this.tDet[i] < 1e8) nd++; }
    if (nd >= 0.985 * n || t > 3 * S.tPeelEnd + 0.012) {
      this.peelEnd = t;
      var tDO = this.tDetO;
      for (i = 0; i < this.nv0; i++) if (tDO[i] > 1e8) tDO[i] = t;
      this.detChanged = true;
    }
  };

  /* Quantised positions of every vertex copy (same box as the fluid frames). */
  P.emit = function (QMIN, QSPAN) {
    var nc = this.nc, x = this.x, pos = new Int16Array(nc * 3);
    for (var i = 0; i < nc; i++) for (var c = 0; c < 3; c++) {
      var q = (x[3 * i + c] - QMIN[c]) / QSPAN[c];
      pos[3 * i + c] = Math.round((q < 0 ? 0 : q > 1 ? 1 : q) * 65535) - 32768;
    }
    var det = null;
    if (this.detChanged) { det = new Float32Array(this.tDetO); this.detChanged = false; }
    return { pos: pos, det: det, peelEnd: this.peelEnd };
  };
  /* Static description for the renderer. */
  P.meta = function () {
    var F = this.F0, nt = this.nt, tris = new Uint16Array(3 * nt), tris0 = new Uint16Array(3 * nt), tdie = new Float32Array(nt);
    for (var i = 0; i < 3 * nt; i++) { tris[i] = this.corner[i]; tris0[i] = F[i]; }
    for (i = 0; i < nt; i++) tdie[i] = this.triDead[i];
    return { nv0: this.nv0, nc: this.nc, nt: nt, dir0: new Float32Array(this.dir0), copyOf: new Uint16Array(this.copyOf),
             tris: tris, tris0: tris0, triDie: tdie, restA: new Float32Array(this.restA), lambda: LAMBDA };
  };

  return { Membrane: Membrane, LAMBDA: LAMBDA };
})();
if (typeof module !== 'undefined') module.exports = WB_MEM;
