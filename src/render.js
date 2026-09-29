/* ==========================================================================
   WEBGL2 RENDERER
   ========================================================================== */
var WB_Renderer = (function () {
  'use strict';
  var G = WB_GLSL;

  function Renderer(canvas) {
    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser lacks EXT_color_buffer_float.');
    gl.getExtension('EXT_float_blend');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    // compile off the GPU process's main thread: a 30 s blocking compile trips the browser's GPU watchdog
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.pending = [];
    this.gl = gl; this.canvas = canvas;
    this.vol = { tex: null, nx: 0, ny: 0, nz: 0 };
    this.W = 0; this.H = 0; this.accumN = 0; this.ping = 0;
    this.programs();
    this.buffers();
    var wt = this.wetTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, wt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([1e4]));
    this.texParams(gl.TEXTURE_2D, gl.LINEAR);
  }
  var P = Renderer.prototype;

  /* Force the driver to finish compiling every program (ANGLE/D3D compiles lazily at first draw). */
  P.warmup = function () {
    var gl = this.gl, px = new Float32Array(4), T = (window.WB_COMPILE = window.WB_COMPILE || {});
    var fb = gl.createFramebuffer(), tex = makeTex(gl, 1, 1, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, 1, 1);
    [['trace', this.pTrace, gl.TRIANGLES, 3], ['caustic', this.pCaustic, gl.POINTS, 1], ['drop', this.pDrop, gl.TRIANGLE_STRIP, 4],
     ['mist', this.pMist, gl.TRIANGLE_STRIP, 4], ['rubber', this.pRubber, gl.TRIANGLES, 3], ['bullet', this.pBullet, gl.TRIANGLES, 3]].forEach(function (e) {
      var t0 = performance.now();
      gl.useProgram(e[1].prog); gl.bindVertexArray(this.emptyVAO);
      this.setU(e[1], { uVol: 0, uWet: 1, uDepthTex: 2, uPeel: 3, uCau: 4, uRip: 5, uL1: 1 });
      gl.drawArrays(e[2], 0, e[3]);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      T['draw_' + e[0]] = Math.round(performance.now() - t0);
    }, this);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
  };
  P.texParams = function (target, filter) {
    var gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  };

  P.compile = function (type, src) {
    var gl = this.gl, s = gl.createShader(type);
    if (/[?&]nocache/.test(location.search)) src = src.replace('\n', '\n// ' + Math.random() + '\n');
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  };
  /* Starts compiling and linking; the program is usable once poll() has returned true.
     Querying any status before then would block until the driver is done. */
  P.program = function (vs, fs, label) {
    var gl = this.gl, p = gl.createProgram();
    var sv = this.compile(gl.VERTEX_SHADER, vs), sf = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, sv); gl.attachShader(p, sf);
    gl.linkProgram(p);
    var info = { prog: p, u: {}, label: label, t0: performance.now(), sh: [[sv, vs, label + '.vs'], [sf, fs, label + '.fs']] };
    this.pending.push(info);
    return info;
  };
  P.finishProgram = function (info) {
    var gl = this.gl, p = info.prog;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      info.sh.forEach(function (e) {
        if (gl.getShaderParameter(e[0], gl.COMPILE_STATUS)) return;
        var log = gl.getShaderInfoLog(e[0]), lines = e[1].split('\n'), m = /0:(\d+)/.exec(log), ctx = '';
        if (m) { var ln = +m[1]; for (var i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 2); i++) ctx += i + ': ' + lines[i - 1] + '\n'; }
        throw new Error('Shader compile error in ' + e[2] + ':\n' + log + '\n' + ctx);
      });
      throw new Error('Link error in ' + info.label + ': ' + gl.getProgramInfoLog(p));
    }
    (window.WB_COMPILE = window.WB_COMPILE || {})[info.label] = Math.round(performance.now() - info.t0);
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var a = gl.getActiveUniform(p, i), name = a.name.replace(/\[0\]$/, '');
      info.u[name] = { loc: gl.getUniformLocation(p, a.name), type: a.type };
    }
    info.sh = null;
  };
  // true once every program is compiled and linked; without the parallel extension this blocks
  P.poll = function () {
    var gl = this.gl, ext = this.parallel;
    this.pending = this.pending.filter(function (info) {
      if (ext && !gl.getProgramParameter(info.prog, ext.COMPLETION_STATUS_KHR)) return true;
      this.finishProgram(info);
      return false;
    }, this);
    return this.pending.length === 0;
  };
  P.programs = function () {
    var hdr = '#version 300 es\n#define FRAGXY gl_FragCoord.xy\n';
    this.pTrace = this.program(G.fsQuadVS, hdr + G.common + G.scene + G.trace, 'trace');
    this.pDrop = this.program(G.dropVS, hdr + G.common + G.scene + G.dropFS, 'drop');
    this.pMist = this.program(G.mistVS, hdr + G.common + G.mistFS, 'mist');
    this.pCaustic = this.program('#version 300 es\n#define FRAGXY vec2(float(gl_VertexID), 0.0)\n' + G.common + G.scene + G.causticVS, G.causticFS, 'caustic');
    this.pSplat = this.program(G.splatVS, G.splatFS, 'splat');
    this.pBlur = this.program(G.fsQuadVS, G.blurFS, 'blur');
    this.pTAA = this.program(G.fsQuadVS, G.taaFS, 'taa');
    this.pPeel = this.program(G.peelVS, G.peelFS, 'peel');
    this.pPeelBlur = this.program(G.fsQuadVS, G.peelBlurFS, 'peelblur');
    this.pRubber = this.program(G.rubberVS, hdr + G.common + G.scene + G.rubberFS, 'rubber');
    this.pBullet = this.program(G.bulletVS, hdr + G.common + G.scene + G.bulletFS, 'bullet');
    this.pRing = this.program(G.fsQuadVS, G.ringFS, 'ring');
    this.pDown = this.program(G.fsQuadVS, G.downFS, 'down');
    this.pUp = this.program(G.fsQuadVS, G.upFS, 'up');
    this.pFinal = this.program(G.fsQuadVS, G.finalFS, 'final');
  };
  // set uniforms from a dictionary; unknown names are ignored
  P.setU = function (info, vals) {
    var gl = this.gl;
    for (var k in vals) {
      var u = info.u[k]; if (!u) continue;
      var v = vals[k];
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
        default: gl.uniform1i(u.loc, v); break;
      }
    }
  };

  P.buffers = function () {
    var gl = this.gl;
    this.emptyVAO = gl.createVertexArray();
    this.splatBuf = gl.createBuffer();
    this.splatVAO = gl.createVertexArray();
    gl.bindVertexArray(this.splatVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.inst = {};
    ['spray', 'fluid', 'mist'].forEach(function (k) {
      var vao = gl.createVertexArray(), buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (var a = 0; a < 3; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, 48, a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      this.inst[k] = { vao: vao, buf: buf, count: 0 };
    }, this);
    gl.bindVertexArray(null);
    this.splatFBO = gl.createFramebuffer();
    this.cauRes = 1024;
    this.cauTex = makeTex(gl, this.cauRes, this.cauRes, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.cauFBO = fbo(gl, [this.cauTex], null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cauFBO); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  /* Photon-trace both softboxes through the water onto the floor irradiance map. */
  P.caustics = function (u, lights, grid) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cauFBO);
    gl.viewport(0, 0, this.cauRes, this.cauRes);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (u.uHasVol) {
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.pCaustic.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, this.vol.tex);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.peelTex);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.ripTex);
      u.uVol = 0; u.uWet = 1; u.uDepthTex = 2; u.uPeel = 3; u.uCau = 4; u.uRip = 5;
      this.setU(this.pCaustic, u);
      gl.bindVertexArray(this.emptyVAO);
      lights.forEach(function (L) {
        this.setU(this.pCaustic, L);
        gl.drawArrays(gl.POINTS, 0, grid * grid);
      }, this);
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  P.setInstances = function (k, data, count) {
    var gl = this.gl, I = this.inst[k];
    gl.bindBuffer(gl.ARRAY_BUFFER, I.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 12), gl.DYNAMIC_DRAW);
    I.count = count;
  };
  /* Bake the latex peel-time field peelT(dir) into an R16F cube map (same JS
     function the simulation uses, so tear pattern and physics always agree). */
  P.setPeel = function (fn, n) {
    var gl = this.gl, t = this.peelTex || (this.peelTex = gl.createTexture());
    this.peelRes = n;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
    var data = new Float32Array(n * n);
    for (var f = 0; f < 6; f++) {
      for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
        var sc = (i + 0.5) / n * 2 - 1, tc = (j + 0.5) / n * 2 - 1, x, y, z;
        switch (f) {
          case 0: x = 1; y = -tc; z = -sc; break;
          case 1: x = -1; y = -tc; z = sc; break;
          case 2: x = sc; y = 1; z = tc; break;
          case 3: x = sc; y = -1; z = -tc; break;
          case 4: x = sc; y = -tc; z = 1; break;
          default: x = -sc; y = -tc; z = -1;
        }
        var l = Math.sqrt(x * x + y * y + z * z);
        data[j * n + i] = fn(x / l, y / l, z / l);
      }
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.R16F, n, n, 0, gl.RED, gl.FLOAT, data);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  /* Simulated latex: the fixed original mesh (for the peel cube map) ... */
  P.setPeelMesh = function (mm) {
    var gl = this.gl, M = this.pm || (this.pm = { vao: gl.createVertexArray(), dirBuf: gl.createBuffer(), tBuf: gl.createBuffer(), ibo: gl.createBuffer() });
    gl.bindVertexArray(M.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, M.dirBuf); gl.bufferData(gl.ARRAY_BUFFER, mm.dir0, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, M.tBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mm.nv0).fill(1e4), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 4, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, M.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mm.tris0, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    M.count = mm.tris0.length;
    if (!this.peelFBO || this.peelRes !== 256) {    // the cube map becomes a render target (R16F, 256^2 per face)
      var n = this.peelRes = 256, t = this.peelTex || (this.peelTex = gl.createTexture());
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
      for (var f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.R16F, n, n, 0, gl.RED, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.peelFBO = this.peelFBO || gl.createFramebuffer();
    }
  };
  /* ... re-rasterised whenever the simulation reports newly detached latex: each face is drawn
     into a scratch texture, blurred (H then V) and written into the cube map. */
  P.updatePeel = function (field) {
    var gl = this.gl, M = this.pm; if (!M) return;
    var n = this.peelRes;
    if (!this.peelTmp || this.peelTmp.n !== n) {
      var mk = function () { var t = makeTex(gl, n, n, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST); return { tex: t, fbo: fbo(gl, [t], null) }; };
      this.peelTmp = { n: n, a: mk(), b: mk() };
    }
    var T = this.peelTmp, bu = this.pPeelBlur.u;
    gl.bindBuffer(gl.ARRAY_BUFFER, M.tBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, field);
    gl.viewport(0, 0, n, n);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.clearColor(1e4, 0, 0, 1);
    for (var f = 0; f < 6; f++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.a.fbo); gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.pPeel.prog); gl.bindVertexArray(M.vao);
      gl.uniform1i(this.pPeel.u.uFace.loc, f);
      gl.drawElements(gl.TRIANGLES, M.count, gl.UNSIGNED_SHORT, 0);
      gl.useProgram(this.pPeelBlur.prog); gl.bindVertexArray(this.emptyVAO); gl.uniform1i(bu.uSrc.loc, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.b.fbo); gl.bindTexture(gl.TEXTURE_2D, T.a.tex);
      gl.uniform2i(bu.uDir.loc, 1, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.peelFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, this.peelTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindTexture(gl.TEXTURE_2D, T.b.tex);
      gl.uniform2i(bu.uDir.loc, 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  /* The rubber that has left the water, at the displayed time: interleaved pos/normal/thickness. */
  P.setMemMesh = function (m) {
    var gl = this.gl, R = this.rm || (this.rm = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0 });
    gl.bindVertexArray(R.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, R.vbo); gl.bufferData(gl.ARRAY_BUFFER, m.vtx.subarray(0, m.nc * 7), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx.subarray(0, m.count), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    R.count = m.count;
  };
  /* capillary ripple rings -> cube map of surface slopes (cheap: 6 x 128^2 pixels per frame) */
  P.updateRipples = function (u) {
    var gl = this.gl, n = 128;
    if (!this.ripTex) {
      this.ripTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.ripTex);
      for (var f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA16F, n, n, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.ripFBO = gl.createFramebuffer();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ripFBO);
    gl.viewport(0, 0, n, n);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(this.pRing.prog);
    this.setU(this.pRing, u); this.setU(this.pRing, { uN: n });
    gl.bindVertexArray(this.emptyVAO);
    for (var f2 = 0; f2 < 6; f2++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f2, this.ripTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.uniform1i(this.pRing.u.uFace.loc, f2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  P.setBulletMesh = function (m) {
    var gl = this.gl, B = this.bm || (this.bm = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0 });
    gl.bindVertexArray(B.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.vbo); gl.bufferData(gl.ARRAY_BUFFER, m.vtx, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    B.count = m.idx.length;
  };
  P.setWet = function (data, res) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.wetTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, res, res, 0, gl.RED, gl.FLOAT, data);
  };

  function makeTex(gl, w, h, ifmt, fmt, type, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fbo(gl, texs, depthRB) {
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach(function (t, i) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); });
    if (depthRB) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
    var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + st.toString(16));
    return f;
  }

  // free the render-resolution targets
  P.release = function () {
    var gl = this.gl;
    if (!this.colorTex) return;
    [this.colorTex, this.depthTex, this.velTex].forEach(function (t) { gl.deleteTexture(t); });
    gl.deleteRenderbuffer(this.depthRB);
    gl.deleteFramebuffer(this.fTrace); gl.deleteFramebuffer(this.fSprite);
    this.colorTex = null;
  };
  /* Render resolution (ray tracing, sprites): may be lower than the display; the
     temporal resolve reconstructs the display-resolution image from jittered frames. */
  P.resize = function (W, H) {
    W = Math.max(16, W | 0); H = Math.max(16, H | 0);
    if (W === this.W && H === this.H) return;
    var gl = this.gl;
    this.release();
    this.W = W; this.H = H;
    this.colorTex = makeTex(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.depthTex = makeTex(gl, W, H, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
    this.velTex = makeTex(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    this.depthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
    this.fTrace = fbo(gl, [this.colorTex, this.depthTex, this.velTex], this.depthRB);
    this.fSprite = fbo(gl, [this.colorTex, this.velTex], this.depthRB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  /* Display resolution (canvas backing store = CSS size x devicePixelRatio): history
     buffers of the temporal resolve and the bloom chain. */
  P.setOutput = function (OW, OH) {
    OW = Math.max(16, OW | 0); OH = Math.max(16, OH | 0);
    if (OW === this.OW && OH === this.OH) return;
    var gl = this.gl;
    if (this.hist) this.hist.concat(this.bloom).forEach(function (b) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); });
    this.OW = OW; this.OH = OH;
    var hf = this.floatLinear ? gl.RGBA32F : gl.RGBA16F;
    this.hist = [0, 1].map(function () {
      var t = makeTex(gl, OW, OH, hf, gl.RGBA, gl.FLOAT, gl.LINEAR);
      return { tex: t, fbo: fbo(gl, [t], null) };
    });
    this.bloom = [];
    var w = OW, h = OH;
    for (var i = 0; i < 6; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      var t = makeTex(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
      this.bloom.push({ tex: t, fbo: fbo(gl, [t], null), w: w, h: h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumN = 0; this.histValid = false;
  };

  /* Splat the particle field into the 3D density texture, one z-slice at a
     time.  `v` = { data (sorted x,y,z,aer), count, sliceStart, nx,ny,nz, min, cell, h } */
  P.splat = function (v) {
    var gl = this.gl, V = this.vol;
    if (!V.tex || V.nx !== v.nx || V.ny !== v.ny || V.nz !== v.nz) {
      if (V.tex) { gl.deleteTexture(V.tex); gl.deleteTexture(V.tex2); }
      V.tex = gl.createTexture(); V.tex2 = gl.createTexture();
      [V.tex, V.tex2].forEach(function (t) {
        gl.bindTexture(gl.TEXTURE_3D, t);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG16F, v.nx, v.ny, v.nz, 0, gl.RG, gl.HALF_FLOAT, null);
        this.texParams(gl.TEXTURE_3D, gl.LINEAR);
      }, this);
      V.nx = v.nx; V.ny = v.ny; V.nz = v.nz;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v.data.subarray(0, v.count * 4), gl.DYNAMIC_DRAW);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.splatFBO);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, v.nx, v.ny);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(gl.FUNC_ADD);
    gl.useProgram(this.pSplat.prog);
    this.setU(this.pSplat, { uVolMin: v.min, uCell: v.cell, uGrid: [v.nx, v.ny], uH: v.h });
    gl.bindVertexArray(this.splatVAO);
    gl.clearColor(0, 0, 0, 0);
    var kr = Math.ceil(2.6 * v.h / v.cell), zl = this.pSplat.u.uSliceZ.loc;   // (floor kernels reach 2.6 h)
    for (var k = 0; k < v.nz; k++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, V.tex, 0, k);
      gl.clear(gl.COLOR_BUFFER_BIT);
      var a = v.sliceStart[Math.max(0, k - kr)], b = v.sliceStart[Math.min(v.nz, k + kr + 1)];
      if (b > a) { gl.uniform1f(zl, v.min[2] + (k + 0.5) * v.cell); gl.drawArrays(gl.POINTS, a, b - a); }
    }
    gl.disable(gl.BLEND);
    // smoothing: x, y, z binomial passes (tex -> tex2 -> tex -> tex2), then swap
    if (v.smooth > 0) {
      gl.useProgram(this.pBlur.prog);
      gl.bindVertexArray(this.emptyVAO);
      var U = this.pBlur.u;
      gl.uniform3i(U.uDims.loc, v.nx, v.ny, v.nz); gl.uniform1i(U.uSrc.loc, 0);
      var axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], src = V.tex, dst = V.tex2;
      for (var pass = 0; pass < 3 * v.smooth; pass++) {
        var ax = axes[pass % 3];
        gl.uniform3i(U.uAxis.loc, ax[0], ax[1], ax[2]);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, src);
        for (k = 0; k < v.nz; k++) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dst, 0, k);
          gl.uniform1i(U.uZ.loc, k);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        var tmp = src; src = dst; dst = tmp;
      }
      V.tex = src; V.tex2 = dst;
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  /* Full frame.  `u` holds scene uniforms; `o` = { mode: 0 restart | 1 temporal | 2 accumulate (frozen),
     exposure, bloom, grain, vignette, seed } (u carries uJit, uPrevVP and the camera) */
  P.render = function (u, o) {
    var gl = this.gl, W = this.W, H = this.H;
    // ---- ray trace
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fTrace);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pTrace.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, this.vol.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.wetTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.peelTex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.cauTex);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.ripTex);
    u.uVol = 0; u.uWet = 1; u.uDepthTex = 2; u.uPeel = 3; u.uCau = 4; u.uRip = 5;
    this.setU(this.pTrace, u);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fSprite);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // ---- latex that has left the water (pulled slightly forward so it wins where it still touches it)
    if (this.rm && this.rm.count && u.uShowRubber) {
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2);
      gl.useProgram(this.pRubber.prog);
      this.setU(this.pRubber, u);
      gl.bindVertexArray(this.rm.vao);
      gl.drawElements(gl.TRIANGLES, this.rm.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // ---- droplets and the bullet (depth tested against the traced depth; they also write motion vectors)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (this.bm && this.bm.count && u.uBulletOn) {
      gl.useProgram(this.pBullet.prog);
      this.setU(this.pBullet, u);
      gl.bindVertexArray(this.bm.vao);
      gl.drawElements(gl.TRIANGLES, this.bm.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.useProgram(this.pDrop.prog);
    this.setU(this.pDrop, u);
    ['spray', 'fluid'].forEach(function (k) {
      var I = this.inst[k]; if (!I.count) return;
      gl.bindVertexArray(I.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, I.count);
    }, this);
    // ---- mist (soft, no depth write)
    if (this.inst.mist.count && u.uMist > 0) {
      gl.depthMask(false);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
      gl.useProgram(this.pMist.prog);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      this.setU(this.pMist, u);
      gl.bindVertexArray(this.inst.mist.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.inst.mist.count);
      gl.depthMask(true);
    }
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVAO);
    // ---- temporal resolve to display resolution
    var mode = this.histValid ? o.mode : 0;
    this.accumN = mode === 2 ? this.accumN + 1 : mode === 0 ? 1 : 0;
    var src = this.hist[this.ping], dst = this.hist[1 - this.ping], OW = this.OW, OH = this.OH;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, OW, OH);
    gl.useProgram(this.pTAA.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.velTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, src.tex);
    this.setU(this.pTAA, { uCur: 0, uDepth: 1, uVel: 2, uHist: 3, uRenderRes: [W, H], uOutRes: [OW, OH], uJit: u.uJit,
      uMode: mode, uPrevVP: u.uPrevVP, uCamPos: u.uCamPos, uCamR: u.uCamR, uCamU: u.uCamU, uCamF: u.uCamF,
      uTanHalf: u.uTanHalf, uAspect: u.uAspect, uMaxW: 7.0 });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.ping = 1 - this.ping; this.histValid = true;
    // ---- bloom
    var prev = dst.tex, pw = OW, ph = OH;
    gl.useProgram(this.pDown.prog);
    for (var i = 0; i < this.bloom.length; i++) {
      var B = this.bloom[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo); gl.viewport(0, 0, B.w, B.h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prev);
      this.setU(this.pDown, { uSrc: 0, uTexel: [1 / pw, 1 / ph], uFirst: i === 0 ? 1 : 0 });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prev = B.tex; pw = B.w; ph = B.h;
    }
    gl.useProgram(this.pUp.prog);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (i = this.bloom.length - 2; i >= 0; i--) {
      var Bd = this.bloom[i], Bs = this.bloom[i + 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, Bd.fbo); gl.viewport(0, 0, Bd.w, Bd.h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, Bs.tex);
      this.setU(this.pUp, { uSrc: 0, uTexel: [1 / Bs.w, 1 / Bs.h], uRadius: 1.0 });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    // ---- final (1:1 with the display pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, OW, OH);
    gl.useProgram(this.pFinal.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    this.setU(this.pFinal, { uHDR: 0, uBloom: 1, uExposure: o.exposure, uBloomAmt: o.bloom * 0.025, uGrain: o.grain,
      uTimeSeed: (o.seed % 97) + 0.5, uVignette: o.vignette, uOutRes: [OW, OH] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  return Renderer;
})();
