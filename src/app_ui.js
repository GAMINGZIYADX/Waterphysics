/* ==========================================================================
   APP: UI, camera, playback loop, public API (window.WB)
   ========================================================================== */
(function () {
  'use strict';
  var SH = WB_SHARED, Core = WB_Core;
  var $ = function (id) { return document.getElementById(id); };
  var U = Core.defaults(), S = SH.computeSetup(U);
  var renderer, worker, store = null, bakeId = 0, asm = null, spray = null;
  var simT = 0, tStart = -0.0008, playing = true, buffering = false, speedMul = 1;
  var needAssemble = true, resetAccum = true, interacting = false, lastInteract = 0;
  var histReset = true, lastStill = false, prevVP = null, prevTime = 0;   // temporal anti-aliasing state
  var fps = 60, frameCount = 0, lastT = performance.now(), seed = 0;
  var holdEnd = 0;

  function showError(e) { var el = $('err'); el.style.display = 'block'; el.textContent = (e && e.message) ? e.message : String(e); console.error(e); }

  // ---------------------------------------------------------------- camera
  var cam = { target: [0, 0.6, 0], az: 28, el: 6, dist: 0.62, auto: true, view: 'hero' };
  var VIEWS = {
    hero: { label: 'Hero', az: 28, el: 6, dist: 0.62, fov: 30 },
    side: { label: 'Side', az: 0, el: 1, dist: 0.72, fov: 30 },
    exit: { label: 'Exit side', az: 118, el: 9, dist: 0.66, fov: 30 },
    low: { label: 'Low', az: 42, el: -14, dist: 0.7, fov: 34 },
    top: { label: 'Top', az: 10, el: 68, dist: 0.8, fov: 30 },
    wide: { label: 'Wide', az: 22, el: 16, dist: 1.9, fov: 32 },
    floor: { label: 'Floor splash', az: 30, el: 24, dist: 1.25, fov: 34, floor: true }
  };
  function setView(name) {
    var v = VIEWS[name]; if (!v) return;
    cam.view = name; cam.az = v.az; cam.el = v.el; cam.dist = v.dist; U.fov = v.fov; cam.auto = true;
    cam.target = v.floor ? [S.C[0], 0.08, S.C[2]] : S.C.slice();
    syncControl('fov');
    document.querySelectorAll('#views button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === name); });
    resetAccum = true; histReset = true;
  }
  function camBasis() {
    var a = cam.az * Math.PI / 180, e = cam.el * Math.PI / 180;
    var pos = [cam.target[0] + cam.dist * Math.cos(e) * Math.sin(a), cam.target[1] + cam.dist * Math.sin(e), cam.target[2] + cam.dist * Math.cos(e) * Math.cos(a)];
    if (pos[1] < 0.03) pos[1] = 0.03;             // never below the (one-sided) floor
    var f = norm(sub(cam.target, pos)), r = norm(crossv(f, [0, 1, 0])), u = crossv(r, f);
    return { pos: pos, f: f, r: r, u: u };
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function crossv(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function viewProj(B, fovy, aspect, near, far) {
    var t = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    var Pm = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    var r = B.r, u = B.u, f = B.f, p = B.pos;
    var V = [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0,
             -(r[0] * p[0] + r[1] * p[1] + r[2] * p[2]), -(u[0] * p[0] + u[1] * p[1] + u[2] * p[2]), (f[0] * p[0] + f[1] * p[1] + f[2] * p[2]), 1];
    var M = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var rr = 0; rr < 4; rr++) {
      var s = 0; for (var k = 0; k < 4; k++) s += Pm[k * 4 + rr] * V[c * 4 + k]; M[c * 4 + rr] = s;
    }
    return M;
  }
  function autoFrame(dt) {
    if (!cam.auto || !asm || !asm.com || VIEWS[cam.view] && VIEWS[cam.view].floor) return;
    var v = VIEWS[cam.view] || VIEWS.hero;
    var ty = Math.max(0.1, Math.min(S.C[1], asm.com[1]));
    var k = 1 - Math.exp(-dt * 3);
    cam.target[1] += (ty - cam.target[1]) * k;
    cam.target[0] += (asm.com[0] * 0.5 - cam.target[0]) * k;
    var fall = Math.max(0, S.C[1] - asm.com[1]) / Math.max(S.C[1], 0.1);
    var want = v.dist * (1 + 0.55 * fall + (asm.vol ? Math.min(1.2, Math.max(0, asm.vol.size[0] - 0.3) * 0.7) : 0));
    cam.dist += (want - cam.dist) * k;
  }

  // ---------------------------------------------------------------- playback rate (speed ramp)
  function rate(t) {
    var a = Math.log(1 / 1500), b = Math.log(1 / 25);
    var x = Math.min(1, Math.max(0, (t - 0.0012) / (0.07 - 0.0012))); x = x * x * (3 - 2 * x);
    return Math.exp(a + (b - a) * x);
  }
  var wallTab = null;
  function buildWall() {
    var n = 3000, t0 = tStart, t1 = U.duration, W = new Float64Array(n + 1), T = new Float64Array(n + 1);
    // non-uniform sampling: dense early
    for (var i = 0; i <= n; i++) { var x = i / n; T[i] = t0 + (t1 - t0) * x * x * x; }
    for (i = 1; i <= n; i++) W[i] = W[i - 1] + (T[i] - T[i - 1]) / rate(0.5 * (T[i] + T[i - 1]));
    wallTab = { T: T, W: W, total: W[n] };
  }
  function tToFrac(t) {
    var T = wallTab.T, W = wallTab.W, lo = 0, hi = T.length - 1;
    if (t <= T[0]) return 0; if (t >= T[hi]) return 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    var w = (t - T[lo]) / (T[hi] - T[lo]);
    return (W[lo] + (W[hi] - W[lo]) * w) / wallTab.total;
  }
  function fracToT(f) {
    var T = wallTab.T, W = wallTab.W, target = f * wallTab.total, lo = 0, hi = W.length - 1;
    if (target <= 0) return T[0]; if (target >= W[hi]) return T[hi];
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (W[m] <= target) lo = m; else hi = m; }
    return T[lo] + (T[hi] - T[lo]) * (target - W[lo]) / (W[hi] - W[lo]);
  }
  function buildTicks() {
    var sc = $('scrub'); sc.querySelectorAll('.tick').forEach(function (e) { e.remove(); });
    [[0, 'impact'], [0.001, '1 ms'], [0.005, '5 ms'], [0.02, '20 ms'], [0.1, '100 ms'], [0.3, '300 ms'], [0.6, '600 ms']].forEach(function (p) {
      if (p[0] > U.duration) return;
      var d = document.createElement('div'); d.className = 'tick'; d.textContent = p[1];
      d.style.left = (tToFrac(p[0]) * 100) + '%'; sc.appendChild(d);
    });
  }

  // ---------------------------------------------------------------- simulation bake
  function onWorker(m) {
    if (m.id !== bakeId) return;
    if (m.type === 'meta') { store = new Core.Store(m.id, m); store.setMembrane(S); needAssemble = true; }
    else if (m.type === 'frame' && store) { store.add(m); if (buffering || store.count === 1) needAssemble = true; }
    else if (m.type === 'wet') { if (!renderer) return; renderer.setWet(m.wet, m.res); U._wetHalf = m.half; resetAccum = true; }
    else if (m.type === 'done' && store) { store.done = true; }
    else if (m.type === 'error') showError('Simulation error:\n' + m.msg);
  }
  function startBake(keepJob) {
    if (!keepJob) bakeId++;
    store = null; asm = null;
    S = SH.computeSetup(U);
    tStart = -Math.min(0.0008, 0.3 / U.bulletSpeed);
    buildWall(); buildTicks();
    regenSpray();
    renderer.setPeel(function (x, y, z) { return SH.peelT(x, y, z, S.peel); }, 192);
    if (!keepJob) worker.postMessage({ type: 'bake', id: bakeId, params: JSON.parse(JSON.stringify(U)), slice: worker.local ? 10 : 40 });
    renderer.setWet(new Float32Array([1e4]), 1);
    needAssemble = true; resetAccum = true; histReset = true;
    if (!cam.auto) return;
    cam.target = (VIEWS[cam.view] && VIEWS[cam.view].floor) ? [S.C[0], 0.08, S.C[2]] : S.C.slice();
  }
  function regenSpray() {
    spray = WB_SPRAY.generate(S, U);
    renderer.setInstances('spray', spray.drops, spray.dropCount);
    renderer.setInstances('mist', spray.mist, spray.mistCount);
    resetAccum = true;
  }
  var bakeTimer = 0, sprayTimer = 0;
  function scheduleBake() { clearTimeout(bakeTimer); bakeTimer = setTimeout(function () { startBake(); seek(tStart); play(true); }, 350); }
  function scheduleSpray() { clearTimeout(sprayTimer); sprayTimer = setTimeout(regenSpray, 120); }

  // ---------------------------------------------------------------- UI construction
  var controls = {};
  function fmt(v, step) {
    var d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    return (+v).toFixed(d);
  }
  function buildUI() {
    var root = $('controls'), groups = {};
    Core.SPEC.forEach(function (s) {
      var g = s[0], key = s[1];
      if (!groups[g]) {
        var det = document.createElement('details'); det.open = (g === 'Projectile' || g === 'Balloon' || g === 'Lighting');
        var sm = document.createElement('summary'); sm.textContent = g; det.appendChild(sm);
        root.appendChild(det); groups[g] = det;
      }
      var row = document.createElement('div'); row.className = 'row';
      var lab = document.createElement('label'); lab.textContent = s[2]; if (s[8] === 'sim') lab.className = 'rebake';
      var val = document.createElement('span'); val.className = 'val';
      row.appendChild(lab); row.appendChild(val);
      var inp;
      if (typeof s[3] === 'object') {
        inp = document.createElement('select');
        Object.keys(s[3]).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = s[3][k].label; inp.appendChild(o); });
        inp.value = U[key];
        inp.addEventListener('change', function () { setParam(key, inp.value, true); });
      } else {
        inp = document.createElement('input'); inp.type = 'range'; inp.min = s[3]; inp.max = s[4]; inp.step = s[5]; inp.value = U[key];
        inp.addEventListener('input', function () { setParam(key, +inp.value, true); });
      }
      lab.htmlFor = inp.id = 'c-' + key;
      row.appendChild(inp); groups[g].appendChild(row);
      controls[key] = { inp: inp, val: val, spec: s };
      syncControl(key);
    });
    var note = document.createElement('div'); note.className = 'note';
    note.textContent = 'Keys: Space freeze/play · ←/→ step · R restart · 1–7 camera views · F auto-frame · H hide panel';
    root.appendChild(note);
    var vb = $('views');
    Object.keys(VIEWS).forEach(function (k, i) {
      var b = document.createElement('button'); b.textContent = (i + 1) + ' ' + VIEWS[k].label; b.dataset.v = k;
      b.addEventListener('click', function () { setView(k); });
      vb.appendChild(b);
    });
  }
  function syncControl(key) {
    var c = controls[key]; if (!c) return;
    var s = c.spec;
    if (typeof s[3] === 'object') { c.inp.value = U[key]; c.val.textContent = ''; }
    else { c.inp.value = U[key]; c.val.textContent = fmt(U[key], s[5]) + (s[7] ? ' ' + s[7] : ''); }
  }
  function setParam(key, v, fromUI) {
    var c = controls[key], kind = c ? c.spec[8] : '';
    if (key === 'projectile') {
      var p = Core.PRESETS[v]; if (!p) return;
      U.projectile = v;
      ['bulletMass', 'bulletCaliber', 'bulletSpeed'].forEach(function (k) { U[k] = p[k]; syncControl(k); });
    } else U[key] = v;
    syncControl(key);
    if (kind === 'sim') scheduleBake();
    else if (kind === 'spray') scheduleSpray();
    else if (kind === 'view') needAssemble = true;
    if (key === 'renderScale') applyScale();
    resetAccum = true;
  }

  // ---------------------------------------------------------------- playback
  function play(on) { playing = on === undefined ? !playing : !!on; if (playing && simT >= U.duration - 1e-6) seek(tStart); $('b-play').textContent = playing ? '⏸' : '▶'; resetAccum = true; }
  function seek(t) { simT = Math.max(tStart, Math.min(U.duration, t)); needAssemble = true; resetAccum = true; histReset = true; holdEnd = 0; }
  function step(dir) {
    play(false);
    if (!store || !store.count) return;
    var T = store.times, n = store.count, i;
    if (dir > 0) { for (i = 0; i < n; i++) if (T[i] > simT + 1e-7) break; seek(i < n ? T[i] : T[n - 1]); }
    else { for (i = n - 1; i >= 0; i--) if (T[i] < simT - 1e-7) break; seek(i >= 0 ? T[i] : tStart); }
  }

  function bindUI() {
    $('b-play').onclick = function () { play(); };
    $('b-restart').onclick = function () { seek(tStart); play(true); };
    $('b-back').onclick = function () { step(-1); };
    $('b-fwd').onclick = function () { step(1); };
    $('toggle').onclick = function () { document.body.classList.toggle('nopanel'); onResize(); };
    var r = $('rate');
    r.oninput = function () { speedMul = Math.pow(10, +r.value); updateRateLabel(); };
    var sc = $('scrub'), dragging = false;
    function scrubTo(e) { var b = sc.getBoundingClientRect(); seek(fracToT(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)))); }
    sc.addEventListener('pointerdown', function (e) { dragging = true; sc.setPointerCapture(e.pointerId); play(false); scrubTo(e); });
    sc.addEventListener('pointermove', function (e) { if (dragging) scrubTo(e); });
    sc.addEventListener('pointerup', function () { dragging = false; });
    window.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.key !== ' ') return;
      var k = e.key;
      if (k === ' ') { play(); e.preventDefault(); }
      else if (k === 'ArrowRight') step(1);
      else if (k === 'ArrowLeft') step(-1);
      else if (k === 'r' || k === 'R') { seek(tStart); play(true); }
      else if (k === 'h' || k === 'H') { document.body.classList.toggle('nopanel'); onResize(); }
      else if (k === 'f' || k === 'F') { cam.auto = !cam.auto; }
      else if (k >= '1' && k <= '7') setView(Object.keys(VIEWS)[+k - 1]);
    });
    // orbit / pan / zoom
    var cv = $('view'), ptrs = {}, mode = 0, lx = 0, ly = 0, pinch = 0;
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId); ptrs[e.pointerId] = [e.clientX, e.clientY];
      mode = (e.button === 2 || e.shiftKey) ? 2 : 1; lx = e.clientX; ly = e.clientY; interacting = true; cv.classList.add('drag');
      var ids = Object.keys(ptrs); if (ids.length === 2) { var a = ptrs[ids[0]], b = ptrs[ids[1]]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    cv.addEventListener('pointermove', function (e) {
      if (!ptrs[e.pointerId]) return;
      ptrs[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch > 0) cam.dist = Math.max(0.12, Math.min(6, cam.dist * pinch / d));
        pinch = d; cam.auto = false; resetAccum = true; lastInteract = performance.now(); return;
      }
      var dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (mode === 1) { cam.az -= dx * 0.3; cam.el = Math.max(-85, Math.min(85, cam.el + dy * 0.3)); }
      else {
        var B = camBasis(), k = cam.dist * 0.0016;
        for (var i = 0; i < 3; i++) cam.target[i] += (-B.r[i] * dx + B.u[i] * dy) * k;
        cam.auto = false;
      }
      resetAccum = true; lastInteract = performance.now();
    });
    function up(e) { delete ptrs[e.pointerId]; if (!Object.keys(ptrs).length) { interacting = false; mode = 0; cv.classList.remove('drag'); } pinch = 0; }
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', function (e) {
      e.preventDefault(); cam.dist = Math.max(0.12, Math.min(6, cam.dist * Math.exp(e.deltaY * 0.0012)));
      cam.auto = false; resetAccum = true; lastInteract = performance.now();
    }, { passive: false });
    window.addEventListener('resize', onResize);
  }
  function updateRateLabel() {
    $('rate-l').textContent = 'Playback ' + (speedMul >= 1 ? speedMul.toFixed(speedMul < 3 ? 1 : 0) : speedMul.toFixed(2)) + '×';
  }
  var outW = 0, outH = 0, dynScale = 1, slowFrames = 0, fastFrames = 0;
  /* The canvas backing store always matches the physical display pixels (CSS size x
     devicePixelRatio, capped at 2); the ray tracer renders at renderScale x that and the
     temporal resolve rebuilds the full display resolution from jittered frames. */
  function onResize() {
    var cv = $('view'), dpr = Math.min(window.devicePixelRatio || 1, 2), b = cv.getBoundingClientRect();
    var w = Math.max(64, Math.round(b.width * dpr)), h = Math.max(64, Math.round(b.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    outW = w; outH = h;
    renderer.setOutput(w, h);
    applyScale();
  }
  function applyScale() {
    var sc = U.renderScale * dynScale;
    renderer.resize(Math.round(outW * sc), Math.round(outH * sc));
    resetAccum = true;
  }
  // re-size when the page moves to a screen with a different pixel density (or the browser zoom changes)
  (function watchDPR() {
    if (!window.matchMedia) return;
    var mq = matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    var fn = function () { if (renderer) onResize(); watchDPR(); };
    if (mq.addEventListener) mq.addEventListener('change', fn, { once: true }); else if (mq.addListener) mq.addListener(fn);
  })();
  function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
  /* dynamic resolution: keep playback interactive on slower GPUs, refine at full scale when frozen */
  function adaptScale(dt, still) {
    if (still) { if (dynScale < 1) { dynScale = 1; applyScale(); } return; }
    if (dt > 0.045) { slowFrames++; fastFrames = 0; } else if (dt < 0.022) { fastFrames++; slowFrames = 0; } else { slowFrames = fastFrames = 0; }
    if (slowFrames > 6 && dynScale > 0.4) { dynScale = Math.max(0.4, dynScale * 0.85); slowFrames = 0; applyScale(); }
    else if (fastFrames > 40 && dynScale < 1) { dynScale = Math.min(1, dynScale * 1.1); fastFrames = 0; applyScale(); }
  }

  // ---------------------------------------------------------------- HUD
  function phase(t) {
    if (t < 0) return 'Bullet in flight · ' + U.bulletSpeed.toFixed(0) + ' m/s';
    if (t < S.tX) return 'Bullet inside the water · ' + SH.bulletV(S, t).toFixed(0) + ' m/s · cavity opening';
    if (t < S.tPeelEnd) return 'Latex tearing & retracting at ' + U.peelSpeed.toFixed(0) + ' m/s · bullet exited at ' + S.vExit.toFixed(0) + ' m/s';
    if (asm && asm.vol && asm.vol.min[1] + 0.3 * asm.vol.cell > 0.02) return 'Unsupported water falling · still holding the balloon’s shape';
    return 'Impact · the water sheets out across the floor';
  }
  function hud() {
    var ms = simT * 1000;
    $('hud-t').textContent = 't = ' + (ms >= 0 ? '+' : '−') + Math.abs(ms).toFixed(ms < 10 && ms > -10 ? 3 : ms < 100 ? 2 : 1) + ' ms';
    $('hud-ph').textContent = phase(simT);
    var r = rate(simT) * speedMul;
    var st = (playing ? 'playing at 1/' + Math.round(1 / r) + ' real speed (≈ ' + Math.round(60 / r).toLocaleString() + ' fps camera)' : 'frozen — orbit freely; image refines (' + renderer.accumN + '/' + U.maxSamples + ')');
    if (buffering) st = 'simulating ahead… ' + st;
    $('hud-s').textContent = st;
    var bt = store ? store.bakedTime() : -1;
    $('stats').textContent = (renderer.W + '×' + renderer.H + ' → ' + renderer.OW + '×' + renderer.OH) + ' · ' + fps.toFixed(0) + ' fps\n' +
      (store ? (store.N + ' particles · sim ' + (store.done ? 'complete' : (bt * 1000).toFixed(0) + ' ms')) : 'initialising simulation…') +
      (asm ? '\ndroplets ' + (asm.fluidCount + (spray ? spray.dropCount : 0)) + ' · mist ' + (spray ? spray.mistCount : 0) : '');
    $('stats').style.whiteSpace = 'pre';
    var sc = $('scrub');
    sc.querySelector('.head').style.left = (tToFrac(simT) * 100) + '%';
    sc.querySelector('.baked').style.width = (store ? (store.done ? 100 : tToFrac(Math.max(bt, tStart)) * 100) : 0) + '%';
  }

  // ---------------------------------------------------------------- main loop
  var lastTickAt = 0, capturing = false;
  function tick(now) {
    if (capturing || !renderer) return;
    if (now === undefined) now = performance.now();
    lastTickAt = performance.now();
    var dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000)); lastT = now;
    frameCount++; fps = fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    if (playing && store && store.count) {     // the clock starts once the first simulated frame exists
      var bt = store.bakedTime();
      var nt = simT + rate(simT) * speedMul * dt;
      if (nt <= 0 || (store && (store.done || nt <= bt))) { simT = nt; buffering = false; }
      else { buffering = true; simT = Math.max(simT, Math.min(nt, Math.max(bt, 0))); }
      if (simT >= U.duration) { simT = U.duration; holdEnd += dt; if (holdEnd > 2.5) { seek(tStart); } }
      needAssemble = true;
    }
    if (needAssemble && store && store.count) {
      store.smooth = U.surfaceSmooth;
      asm = store.assemble(Math.max(simT, 0));
      if (asm.vol) renderer.splat(asm.vol);
      renderer.setInstances('fluid', asm.fluid, asm.fluidCount);
      needAssemble = false; resetAccum = true;
    }
    autoFrame(dt);
    var still = !playing && !interacting && !resetAccum && (now - lastInteract > 60);
    adaptScale(dt, !playing && !interacting);
    hud();
    if (still && renderer.accumN >= U.maxSamples) return;
    draw(still);
  }
  function rafLoop(now) { requestAnimationFrame(rafLoop); tick(now); }
  // when the page is not being composited rAF stalls; keep simulating/rendering on a timer
  setInterval(function () { if (performance.now() - lastTickAt > 250) tick(performance.now()); }, 50);
  function draw(still) {
    var B = camBasis(), fovy = U.fov * Math.PI / 180, aspect = outW / outH;
    // frozen frames integrate a real camera: shutter interval (motion blur) and thin-lens aperture (depth of field)
    var tS = still && U.shutter > 0 ? simT + (Math.random() - 0.5) * U.shutter * 1e-6 : simT;
    var u = Core.sceneUniforms(U, S, tS, asm, store);
    var tanH = Math.tan(fovy / 2), focus = Math.max(0.05, cam.dist);
    var lensR = still ? (0.012 / tanH) / (2 * U.fstop) : 0, lx = 0, ly = 0;
    if (lensR > 0) { var lr = lensR * Math.sqrt(Math.random()), la = Math.random() * 6.2832; lx = lr * Math.cos(la); ly = lr * Math.sin(la); }
    u.uLensR = lensR; u.uLens = [lx, ly]; u.uFocus = focus;
    u.uLensShift = [lx / (focus * tanH * aspect), ly / (focus * tanH)];
    var BL = { pos: [B.pos[0] + B.r[0] * lx + B.u[0] * ly, B.pos[1] + B.r[1] * lx + B.u[1] * ly, B.pos[2] + B.r[2] * lx + B.u[2] * ly], r: B.r, u: B.u, f: B.f };
    seed = (seed + 1) % 100000;
    // temporal AA: restart on jumps, blend with reprojected history while moving, average everything once frozen
    var mode = still ? (lastStill ? 2 : 0) : (histReset ? 0 : 1);
    lastStill = still; histReset = false;
    var hi = mode === 2 ? renderer.accumN + 1 : (frameCount % 16) + 1;           // Halton(2,3): stratified sub-pixel offsets
    var jit = [halton(hi, 2) - 0.5, halton(hi, 3) - 0.5];
    var vp0 = viewProj(B, fovy, aspect, 0.01, 200);
    u.uCamPos = B.pos; u.uCamR = B.r; u.uCamU = B.u; u.uCamF = B.f;
    u.uTanHalf = Math.tan(fovy / 2); u.uAspect = aspect; u.uNear = 0.01; u.uFar = 200;
    u.uRes = [renderer.W, renderer.H]; u.uFrame = seed; u.uL1 = 1; u.uAccum = 1; u.uRand = Math.random() * 100;
    u.uJit = jit; u.uViewProj = viewProj(BL, fovy, aspect, 0.01, 200);
    u.uVP0 = vp0; u.uPrevVP = mode === 1 && prevVP ? prevVP : vp0;
    u.uPrevTime = mode === 1 ? prevTime : tS;
    prevVP = vp0; prevTime = tS;
    u.uWetHalf = U._wetHalf || 1.6;
    // ---- caustics: photons from both softboxes through the water onto the floor
    var cauOn = U.caustics !== 'off';
    u.uCauOn = cauOn ? 1 : 0; u.uShadowFloor = cauOn ? 0.08 : 0.3;
    var cc = S.C;
    u.uCauSize = 2.5; u.uCauMin = [cc[0] - 1.25, cc[2] - 1.25]; u.uCauRes = 1024;
    if (cauOn && asm && asm.vol) {
      var V = asm.vol, cv = [V.min[0] + V.size[0] / 2, V.min[1] + V.size[1] / 2, V.min[2] + V.size[2] / 2];
      var rv = 0.5 * Math.hypot(V.size[0], V.size[1], V.size[2]), grid = 200;
      var Ls = [[u.uL0c, u.uL0u, u.uL0v, u.uL0e], [u.uL1c, u.uL1u, u.uL1v, u.uL1e]].map(function (L) {
        var ju = still ? Math.random() * 1.8 - 0.9 : 0, jv = still ? Math.random() * 1.8 - 0.9 : 0;
        var o = [L[0][0] + L[1][0] * ju + L[2][0] * jv, L[0][1] + L[1][1] * ju + L[2][1] * jv, L[0][2] + L[1][2] * ju + L[2][2] * jv];
        var d = norm(sub(cv, o)), du = norm(crossv(d, Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0])), dv = crossv(du, d);
        var ln = norm(crossv(L[1], L[2]));
        return { uPOrig: o, uPLn: ln, uPLe: L[3], uPArea: 4 * Math.hypot(L[1][0], L[1][1], L[1][2]) * Math.hypot(L[2][0], L[2][1], L[2][2]),
                 uDiskC: cv, uDiskU: du.map(function (x) { return x * rv; }), uDiskV: dv.map(function (x) { return x * rv; }),
                 uPGrid: [grid, grid], uPJit: still ? [Math.random() - 0.5, Math.random() - 0.5] : [0, 0] };
      });
      renderer.caustics(u, Ls, grid);
    } else renderer.caustics({ uHasVol: 0 }, [], 0);
    renderer.render(u, { mode: mode, exposure: Math.pow(2, U.exposure), bloom: U.bloom, grain: U.grain,
      vignette: U.vignette, seed: seed });
    resetAccum = false;
  }
  function waitBaked(t, timeoutMs) {
    var t0 = performance.now();
    return new Promise(function (res) {
      (function chk() {
        if (store && store.count && (store.done || store.bakedTime() >= t)) res(true);
        else if (performance.now() - t0 > timeoutMs) res(false);
        else setTimeout(chk, 60);
      })();
    });
  }
  /* Render a converged still of the current state and POST it to the dev server.
     live = true renders what playback shows instead: `samples` temporally resolved
     frames at the normal render scale (no depth of field / shutter). */
  function capture(name, samples, w, h, live) {
    samples = samples || 48;
    play(false);
    capturing = true;
    var cv = $('view');
    w = w || 1280; h = h || 720;
    cv.width = w; cv.height = h; outW = w; outH = h;
    var sc = live ? U.renderScale : 1;
    renderer.setOutput(w, h); renderer.resize(Math.round(w * sc), Math.round(h * sc)); histReset = true;
    return waitBaked(Math.max(simT, 0), 120000).then(function (ok) {
      store.smooth = U.surfaceSmooth;
      asm = store.assemble(Math.max(simT, 0));
      if (asm.vol) renderer.splat(asm.vol);
      renderer.setInstances('fluid', asm.fluid, asm.fluidCount);
      needAssemble = false;
      for (var k = 0; k < 20; k++) autoFrame(0.1);
      resetAccum = true; draw(false);
      for (var i = 1; i < samples; i++) { frameCount++; draw(!live); }
      hud();
      return new Promise(function (res) { $('view').toBlob(res, 'image/png'); });
    }).then(function (blob) {
      return fetch('/capture/' + encodeURIComponent(name), { method: 'POST', body: blob }).then(function (r) { return r.text(); });
    }).then(function (path) { capturing = false; onResize(); return path; }, function (e) { capturing = false; throw e; });
  }

  // ---------------------------------------------------------------- public API (used for scripted screenshots)
  window.WB = {
    play: function () { play(true); }, pause: function () { play(false); },
    seek: function (ms) { seek(ms / 1000); }, time: function () { return simT * 1000; },
    view: function (name) { setView(name); }, views: function () { return Object.keys(VIEWS); },
    orbit: function (az, el, dist, target) { cam.az = az; cam.el = el; if (dist) cam.dist = dist; if (target) { cam.target = target.slice(); cam.auto = false; } resetAccum = true; },
    set: function (k, v) { setParam(k, v); }, get: function (k) { return U[k]; }, params: function () { return JSON.parse(JSON.stringify(U)); },
    info: function () { return { bakedMs: store ? store.bakedTime() * 1000 : -1, done: !!(store && store.done), N: store ? store.N : 0, fps: fps, samples: renderer.accumN, setup: { tExitMs: S.tX * 1e3, vExit: S.vExit, EdepJ: S.Edep, peelEndMs: S.tPeelEnd * 1e3, cavityMaxCm: S.cavMax.amax * 100 } }; },
    capture: capture,
    bench: function (n, w, h) {          // average GPU time of a full frame at w x h
      n = n || 5; capturing = true;
      var cv = $('view'); cv.width = w || 1280; cv.height = h || 720; outW = cv.width; outH = cv.height;
      renderer.setOutput(outW, outH); renderer.resize(outW, outH); histReset = true;
      var gl = renderer.gl, px = new Uint8Array(4);
      draw(false); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var t0 = performance.now();
      for (var i = 0; i < n; i++) draw(true);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var ms = (performance.now() - t0) / n;
      capturing = false; onResize();
      return ms;
    },
    ready: function (samples, timeoutMs) {
      samples = samples || 32; timeoutMs = timeoutMs || 60000;
      var t0 = performance.now();
      return new Promise(function (res) {
        (function chk() {
          var ok = store && store.count && (store.done || store.bakedTime() >= simT) && !needAssemble && renderer.accumN >= Math.min(samples, U.maxSamples);
          if (ok || performance.now() - t0 > timeoutMs) res(!!ok); else setTimeout(chk, 100);
        })();
      });
    }
  };

  // ---------------------------------------------------------------- boot
  try {
    // start the physics first so it runs while the GPU driver compiles the shaders
    worker = Core.makeWorker(onWorker);
    bakeId++;
    worker.postMessage({ type: 'bake', id: bakeId, params: JSON.parse(JSON.stringify(U)), slice: worker.local ? 10 : 40 });
    $('hud-t').textContent = 'Compiling ray-tracing shaders…';
    $('hud-ph').textContent = 'first visit only (the browser caches them) — the physics is already simulating';
  } catch (e) { showError(e); }
  // let the notice paint before the (blocking, one-time) shader compile
  setTimeout(function () {
    try {
      renderer = new WB_Renderer($('view'));
      renderer.warmup();
      buildUI(); bindUI(); updateRateLabel();
      onResize();
      setView('hero');
      startBake(true);
      seek(tStart);
      // reduced motion: open on a frozen frame of the peel instead of auto-playing
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { play(false); seek(0.003); }
      requestAnimationFrame(rafLoop);
    } catch (e) { showError(e); }
  }, 60);
})();
