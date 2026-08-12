/**
 * HARVEY CORE — the visual identity of the assistant.
 *
 * Replaces two separate orbs that had drifted apart: a Canvas-2D particle
 * plasma on /jarvis and a THREE.js WebGL sphere on /operator. Two renderers
 * meant two behaviours, two performance profiles and two things to fix; this
 * is one module both surfaces mount, so the core looks and reacts identically
 * everywhere Harvey appears.
 *
 * It is Canvas 2D on purpose. WebGL bought nothing the design needs, and
 * dropping it retires the 603KB vendored three.min.js — which matters here
 * because the repo's deploy path cannot npm install and every byte in
 * public/ ships in the image.
 *
 * THE DESIGN: a wireframe sphere on black, lit from within. Latitude and
 * longitude lines give it structure and honest depth (the far hemisphere is
 * genuinely dimmer, not faked), a shell of particles gives it life, and a
 * luminous core carries the state. Everything else — rings, ticks, the scan
 * sweep — is instrument chrome kept deliberately sparse. Restraint is the
 * whole aesthetic: one accent colour, thin strokes, black space around it.
 *
 * PERFORMANCE RULES, because this runs continuously behind a live voice
 * session and must never be the reason a frame drops:
 *   - no shadowBlur anywhere in the frame loop (it was the old orb's killer)
 *   - glow comes from pre-rendered sprites drawn additively
 *   - device pixel ratio capped at 2
 *   - the loop parks itself when the tab is hidden or the element is offscreen
 *
 * API
 *   HarveyCore.mount(canvas, opts) -> instance
 *   HarveyCore.setState("idle" | "listening" | "thinking" | "speaking")
 *   HarveyCore.setLevel(0..1)   // live audio amplitude, drives the core
 *   HarveyCore.destroy()
 */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;

  /* One accent, three weights. Everything on screen is a tint of this, which
     is what keeps it reading as a single designed object. */
  var THEME = {
    accent: [56, 214, 255],
    hot: [214, 246, 255],
    deep: [16, 92, 140],
  };

  var STATES = {
    idle: { spin: 0.085, tilt: 0.20, lineA: 0.30, dotA: 0.55, coreR: 0.20, glow: 0.55, ringA: 0.30, sweep: 0.0, jitter: 0.0015, breathe: 0.035 },
    listening: { spin: 0.150, tilt: 0.26, lineA: 0.48, dotA: 0.85, coreR: 0.26, glow: 0.95, ringA: 0.55, sweep: 0.0, jitter: 0.0040, breathe: 0.055 },
    thinking: { spin: 0.520, tilt: 0.34, lineA: 0.55, dotA: 0.95, coreR: 0.22, glow: 0.85, ringA: 0.70, sweep: 1.0, jitter: 0.0090, breathe: 0.030 },
    speaking: { spin: 0.190, tilt: 0.24, lineA: 0.52, dotA: 0.90, coreR: 0.30, glow: 1.15, ringA: 0.60, sweep: 0.0, jitter: 0.0060, breathe: 0.090 },
  };

  function rgba(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /** Pre-rendered radial sprite — the only source of glow in this renderer. */
  function sprite(size, stops) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (var i = 0; i < stops.length; i++) grd.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function HarveyCoreInstance(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d", { alpha: true });
    var self = this;

    var W = 0, H = 0, cx = 0, cy = 0, R = 0, dpr = 1;
    var raf = null, lastT = 0, running = false;
    var yaw = 0, sweepPhase = 0, tRun = 0;

    var stateName = "idle";
    var cur = {};
    for (var k in STATES.idle) cur[k] = STATES.idle[k];

    var level = 0, levelSmooth = 0;

    /* --- geometry, built once ------------------------------------------- */
    var LATS = 7, LONGS = 12, RING_SEG = 64, CHUNK = 7;
    var lats = [], longs = [], dots = [];

    function buildGeometry() {
      lats = [];
      for (var i = 1; i <= LATS; i++) {
        var phi = (i / (LATS + 1)) * Math.PI;
        var ring = [];
        for (var s = 0; s <= RING_SEG; s++) {
          var th = (s / RING_SEG) * TAU;
          ring.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)]);
        }
        lats.push(ring);
      }
      longs = [];
      for (var j = 0; j < LONGS; j++) {
        var theta = (j / LONGS) * Math.PI; // half turn: the other half is the same great circle
        var line = [];
        for (var p = 0; p <= RING_SEG; p++) {
          var a = (p / RING_SEG) * TAU;
          line.push([Math.sin(a) * Math.cos(theta), Math.cos(a), Math.sin(a) * Math.sin(theta)]);
        }
        longs.push(line);
      }
      /* Particle shell: evenly distributed via the golden spiral so there are
         no visible clumps or seams, which a naive random sphere always has. */
      dots = [];
      var N = 210;
      var golden = Math.PI * (3 - Math.sqrt(5));
      for (var d = 0; d < N; d++) {
        var y = 1 - (d / (N - 1)) * 2;
        var rad = Math.sqrt(Math.max(0, 1 - y * y));
        var ang = golden * d;
        dots.push({
          x: Math.cos(ang) * rad, y: y, z: Math.sin(ang) * rad,
          seed: Math.random() * TAU,
          br: 0.45 + Math.random() * 0.55,
        });
      }
    }
    buildGeometry();

    /* --- sprites ---------------------------------------------------------- */
    var coreSprite = sprite(256, [
      [0, rgba(THEME.hot, 1)],
      [0.08, rgba(THEME.hot, 0.70)],
      [0.24, rgba(THEME.accent, 0.34)],
      [0.55, rgba(THEME.deep, 0.12)],
      [1, rgba(THEME.accent, 0)],
    ]);
    var haloSprite = sprite(512, [
      [0, rgba(THEME.accent, 0.22)],
      [0.28, rgba(THEME.accent, 0.09)],
      [0.70, rgba(THEME.accent, 0.02)],
      [1, rgba(THEME.accent, 0)],
    ]);
    /* Tight falloff: the first version spread to 35% and every particle read
       as a soft blob, which muddied the wireframe behind it. The reference
       language is fine points of light, so the core of the sprite is small
       and the halo is faint. */
    var dotSprite = sprite(32, [
      [0, rgba(THEME.hot, 1)],
      [0.14, rgba(THEME.hot, 0.72)],
      [0.30, rgba(THEME.accent, 0.30)],
      [1, rgba(THEME.accent, 0)],
    ]);

    function resize() {
      /* Take the box CSS already gave the canvas rather than forcing a square.
         Forcing one put /operator's core in the top-left corner: that page
         stretches the canvas across a wide container, so a square sized to the
         SHORTER side and pinned at inset:0 sat well left of centre. Measuring
         the real box and centring the drawing inside it makes the module drop
         into any layout. */
      var rect = canvas.getBoundingClientRect();
      var host = canvas.parentElement;
      var cw = rect.width || (host && host.clientWidth) || 420;
      var ch = rect.height || (host && host.clientHeight) || 420;
      if (cw < 2 || ch < 2) { cw = ch = 420; }
      /* Only impose a size when CSS gave the element none of its own. */
      if (!rect.width || !rect.height) {
        canvas.style.width = cw + "px";
        canvas.style.height = ch + "px";
      }
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      W = canvas.width; H = canvas.height;
      cx = W / 2; cy = H / 2;
      /* RADIUS BUDGET. Everything drawn sits inside half the canvas, so the
         outermost element (tick ring + tick length) must stay under 0.5.
         R 0.30 -> ticks at 1.44R + 0.07R = 0.453 of the min dimension. The
         first cut used 2.05R and silently clipped the ring at the corners. */
      R = Math.min(W, H) * 0.30;
    }

    /* Rotation: yaw about Y, then a fixed tilt about X so the pole is never
       dead-on — a sphere spun on a vertical axis alone reads as a flat disc. */
    var TILT = 0.42, cosT = Math.cos(TILT), sinT = Math.sin(TILT);
    var PERSP = 3.0;

    function project(p, cosY, sinY, scale) {
      var x = p[0] * cosY + p[2] * sinY;
      var z = -p[0] * sinY + p[2] * cosY;
      var y = p[1] * cosT - z * sinT;
      var z2 = p[1] * sinT + z * cosT;
      var f = PERSP / (PERSP + z2);
      return [cx + x * R * scale * f, cy + y * R * scale * f, z2];
    }

    /**
     * Draw one ring in chunks so depth can fade ALONG the line. A single
     * stroke per ring would be cheaper but flattens the sphere: the whole
     * illusion is that the far side is genuinely dimmer than the near side.
     */
    function strokeRing(pts, cosY, sinY, scale, baseAlpha, width) {
      var n = pts.length - 1;
      var per = Math.ceil(n / CHUNK);
      for (var c = 0; c < CHUNK; c++) {
        var s0 = c * per, s1 = Math.min(n, s0 + per);
        if (s1 <= s0) continue;
        var zsum = 0, count = 0;
        ctx.beginPath();
        for (var i = s0; i <= s1; i++) {
          var q = project(pts[i], cosY, sinY, scale);
          zsum += q[2]; count++;
          if (i === s0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
        var zm = zsum / count;                    // -1 (far) .. +1 (near)
        var depth = (1 - zm) * 0.5;               // 0 far .. 1 near
        var a = baseAlpha * (0.10 + depth * 0.95);
        if (a <= 0.012) continue;
        ctx.strokeStyle = rgba(zm > 0.25 ? THEME.hot : THEME.accent, a);
        ctx.lineWidth = width * (0.65 + depth * 0.6);
        ctx.stroke();
      }
    }

    function frame(now) {
      if (!running) return;
      var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
      lastT = now;
      tRun += dt;

      /* Ease every parameter toward the active state so transitions read as
         the same object changing mood, never as a cut. */
      var tgt = STATES[stateName] || STATES.idle;
      var k = 1 - Math.pow(0.002, dt);
      for (var key in cur) cur[key] += ((tgt[key] || 0) - cur[key]) * k;

      levelSmooth += (level - levelSmooth) * (1 - Math.pow(0.004, dt));
      yaw += cur.spin * dt;
      sweepPhase += dt * 0.55;

      var cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      var breathe = 1 + Math.sin(tRun * 1.15) * cur.breathe + levelSmooth * 0.10;

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";

      // --- ambient halo ---------------------------------------------------
      /* Must fade out INSIDE the canvas. The element is border-radius:50%, so
         anything still luminous at the canvas edge gets hard-clipped into a
         visible disc outline — which is exactly what a 2.2R halo did. The
         budget is 0.5/0.30 = 1.66R; 1.5R leaves margin. */
      var haloR = R * 1.5 * (1 + levelSmooth * 0.12);
      ctx.globalAlpha = clamp(cur.glow * 0.55, 0, 1);
      ctx.drawImage(haloSprite, cx - haloR, cy - haloR, haloR * 2, haloR * 2);
      ctx.globalAlpha = 1;

      // --- wireframe ------------------------------------------------------
      var lw = Math.max(0.6, R * 0.0055);
      for (var i = 0; i < lats.length; i++) strokeRing(lats[i], cosY, sinY, breathe, cur.lineA, lw);
      for (var j = 0; j < longs.length; j++) strokeRing(longs[j], cosY, sinY, breathe, cur.lineA * 0.72, lw * 0.85);

      // --- particle shell -------------------------------------------------
      var ds = R * 0.032;
      for (var d = 0; d < dots.length; d++) {
        var p = dots[d];
        var wob = 1 + Math.sin(tRun * 1.7 + p.seed) * cur.jitter * 12;
        var q = project([p.x, p.y, p.z], cosY, sinY, breathe * wob);
        var depth = (1 - q[2]) * 0.5;
        var a = cur.dotA * p.br * (0.06 + depth * depth * 1.05);
        if (a <= 0.02) continue;
        var s = ds * (0.5 + depth * 0.9);
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.drawImage(dotSprite, q[0] - s, q[1] - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;

      // --- orbital ring: one tilted ellipse, the "instrument" cue ---------
      if (cur.ringA > 0.02) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.sin(tRun * 0.22) * 0.16);
        ctx.scale(1, 0.26);
        ctx.beginPath();
        ctx.arc(0, 0, R * 1.16 * breathe, 0, TAU);
        ctx.strokeStyle = rgba(THEME.accent, cur.ringA * 0.5);
        ctx.lineWidth = Math.max(0.7, R * 0.008) / 0.26 * 0.26;
        ctx.stroke();
        ctx.restore();
      }

      // --- scan sweep: only while thinking, so it MEANS something ---------
      if (cur.sweep > 0.02) {
        /* A tapered trail, not a solid arc. Drawn in segments whose alpha
           falls off behind the leading edge so it reads as something sweeping
           round, the way a radar does — a hard bar with round caps just looks
           like a loading spinner. Accent, never white: one colour is the rule
           that keeps the whole thing looking designed. */
        var a0 = (sweepPhase % 1) * TAU;
        var segs = 14, span = 0.85;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(1, R * 0.011);
        for (var sg = 0; sg < segs; sg++) {
          var f0 = sg / segs, f1 = (sg + 1) / segs;
          var fade = Math.pow(1 - f0, 2.1);
          ctx.beginPath();
          ctx.arc(cx, cy, R * 1.30, a0 - f1 * span, a0 - f0 * span);
          ctx.strokeStyle = rgba(sg === 0 ? THEME.hot : THEME.accent, cur.sweep * 0.62 * fade);
          ctx.stroke();
        }
        ctx.restore();
      }

      /* --- bezel: a thin ring with four arc accents ----------------------
         Sixty loose dashes scattered around the sphere read as debris, not as
         an instrument. A continuous hairline circle with a few heavier arcs
         at the quarters gives the same precision cue with a fraction of the
         marks — which is the whole brief: fewer elements, better placed. */
      var bezelR = R * 1.30;
      ctx.beginPath();
      ctx.arc(cx, cy, bezelR, 0, TAU);
      ctx.strokeStyle = rgba(THEME.accent, 0.10 + cur.ringA * 0.10);
      ctx.lineWidth = Math.max(0.5, R * 0.004);
      ctx.stroke();

      var spinB = tRun * 0.10;
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(THEME.accent, 0.34 + cur.ringA * 0.34);
      for (var q = 0; q < 4; q++) {
        var qa = spinB + q * (TAU / 4);
        ctx.beginPath();
        ctx.arc(cx, cy, bezelR, qa - 0.13, qa + 0.13);
        ctx.stroke();
      }

      /* Twelve short radial ticks, counter-rotating. Two elements moving at
         different rates is what makes it feel mechanical rather than looped. */
      ctx.lineWidth = Math.max(0.5, R * 0.005);
      ctx.strokeStyle = rgba(THEME.accent, 0.30 + cur.ringA * 0.20);
      for (var t = 0; t < 12; t++) {
        var ang = (t / 12) * TAU - tRun * 0.045;
        var r0 = bezelR * 1.045, r1 = bezelR * 1.085;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
        ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // --- core: the state lives here -------------------------------------
      var coreR = R * (cur.coreR + levelSmooth * 0.16) * (1 + Math.sin(tRun * 2.1) * 0.05);
      var cs = coreR * 3.0;
      ctx.globalAlpha = clamp(0.45 + cur.glow * 0.40, 0, 1);
      ctx.drawImage(coreSprite, cx - cs, cy - cs, cs * 2, cs * 2);
      ctx.globalAlpha = 1;
      /* A small hard centre reads as a light SOURCE; a large one reads as a
         white sticker stuck on the sphere, which is what the first cut did. */
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, coreR * 0.17), 0, TAU);
      ctx.fillStyle = rgba(THEME.hot, 0.98);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      raf = global.requestAnimationFrame(frame);
    }

    /* The loop parks when nobody can see it — a voice console is often left
       open in a background tab, and burning a core there is inexcusable. */
    function start() {
      if (running) return;
      running = true; lastT = 0;
      raf = global.requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      if (raf) global.cancelAnimationFrame(raf);
      raf = null;
    }

    var onVis = function () { (document.hidden ? stop : start)(); };
    document.addEventListener("visibilitychange", onVis);

    var ro = null;
    if (global.ResizeObserver) {
      ro = new ResizeObserver(function () { resize(); });
      ro.observe(canvas.parentElement || canvas);
    }
    global.addEventListener("resize", resize);

    if (opts.onActivate) {
      canvas.style.cursor = "pointer";
      canvas.addEventListener("click", opts.onActivate);
      canvas.addEventListener("touchstart", function (e) { e.preventDefault(); opts.onActivate(e); }, { passive: false });
    }

    resize();
    start();

    this.setState = function (s) {
      if (STATES[s]) stateName = s;
    };
    this.getState = function () { return stateName; };
    this.setLevel = function (v) { level = clamp(Number(v) || 0, 0, 1); };
    this.resize = resize;
    this.destroy = function () {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      global.removeEventListener("resize", resize);
      if (ro) ro.disconnect();
    };
    void self;
  }

  var active = null;

  var HarveyCore = {
    mount: function (canvas, opts) {
      if (!canvas) return null;
      if (active) active.destroy();
      active = new HarveyCoreInstance(canvas, opts);
      return active;
    },
    /**
     * Maps every status string the voice pipeline has ever used onto the four
     * visual states. The pipeline says "processing", "responding", "busy" and
     * more depending on which surface is driving; normalising here means the
     * renderer has one vocabulary and callers keep theirs.
     */
    setState: function (s) {
      if (!active) return;
      var v = String(s || "idle").toLowerCase();
      if (v === "listening" || v === "listen" || v === "recording") active.setState("listening");
      else if (v === "speaking" || v === "responding" || v === "talking") active.setState("speaking");
      else if (v === "thinking" || v === "processing" || v === "busy" || v === "working") active.setState("thinking");
      else active.setState("idle");
    },
    setLevel: function (v) { if (active) active.setLevel(v); },
    instance: function () { return active; },
    destroy: function () { if (active) { active.destroy(); active = null; } },
  };

  global.HarveyCore = HarveyCore;
})(window);
