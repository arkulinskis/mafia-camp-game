/* ark-music.js: the shared background-music player for Arkvital apps (canonical copy:
   APP_MAKER/media/public/ark-music.js; tools/music_sync.py copies it into each app).
   The music files are on Firebase Hosting: https://arkvital-media.web.app/music/<slug>.mp3
   (track list and which app uses what: APP_MAKER/media/manifest.json). Set window.ARK_MEDIA_BASE first to move them.

   ArkMusic.play('dont-stress-out')            loop one track
   ArkMusic.play(['cosmic', 'high-notes'])     playlist, loops the list
   ArkMusic.play(list, {shuffle: true, volume: 0.5, fade: 2, from: 'random'})
   ArkMusic.stop(fadeSeconds)                  fade out and stop
   ArkMusic.volume(0..1)                       app's music volume (slider)
   ArkMusic.duck(0..1)                         extra dip, e.g. 0.3 while a voice speaks; duck(1) to undo
   ArkMusic.enabled(bool)                      off = silent and nothing loads; on = resumes the last request
   ArkMusic.pause() / ArkMusic.resume()        hold the track where it is (a paused session), then carry on
   ArkMusic.onfail(fn)                         fn(slug) when a file can't load (play your synth music instead)
   ArkMusic.current()                          slug playing now, or null
   ArkMusic.state()                            {slug, time, paused, list, ...} for tests

   Volume goes through Web Audio when it can (iPhones ignore <audio>.volume), so the files are served with CORS.
   Browsers block sound until the first tap or key press; requests made before that start on the first gesture. */
(function () {
  if (window.ArkMusic) return;
  var BASE = (window.ARK_MEDIA_BASE || 'https://arkvital-media.web.app/') + 'music/';
  var ctx = null, master = null, useGraph = true;
  var vol = 0.6, duckLvl = 1, on = true, held = false, failFns = [];
  var want = null;          // last request {list, opts}
  var cur = null;           // {el, gain, slug}
  var unlocked = false, pendingStart = false, idx = 0, order = [];

  function graph() {
    if (ctx || !useGraph) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC(); master = ctx.createGain(); master.connect(ctx.destination);
    } catch (e) { useGraph = false; ctx = null; }
    return ctx;
  }
  function level() { return on ? vol * duckLvl : 0; }
  function applyMaster(t) {
    t = t == null ? 0.25 : t;
    if (master) { var now = ctx.currentTime; master.gain.cancelScheduledValues(now); master.gain.setTargetAtTime(level(), now, t / 3); }
    else if (cur) cur.el.volume = Math.max(0, Math.min(1, level() * cur.mix));
  }

  function makeVoice(slug) {
    var el = new Audio();
    el.crossOrigin = 'anonymous'; el.preload = 'auto'; el.src = BASE + slug + '.mp3';
    var v = { el: el, slug: slug, gain: null, mix: 0 };
    if (graph()) {
      try { var src = ctx.createMediaElementSource(el); v.gain = ctx.createGain(); v.gain.gain.value = 0; src.connect(v.gain); v.gain.connect(master); }
      catch (e) { v.gain = null; }
    }
    el.addEventListener('error', function () { if (cur === v) { failFns.forEach(function (f) { try { f(slug); } catch (e) {} }); cur = null; } });
    el.addEventListener('ended', function () { if (cur === v) advance(); });
    return v;
  }
  function fadeVoice(v, to, sec, then) {
    if (v.gain) {
      var now = ctx.currentTime; v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now); v.gain.gain.linearRampToValueAtTime(to, now + Math.max(0.01, sec));
      v.mix = to; if (then) setTimeout(then, sec * 1000 + 30);
      return;
    }
    var from = v.mix, t0 = Date.now(), dur = Math.max(10, sec * 1000);
    (function step() {
      var k = Math.min(1, (Date.now() - t0) / dur); v.mix = from + (to - from) * k;
      v.el.volume = Math.max(0, Math.min(1, level() * v.mix));
      if (k < 1) setTimeout(step, 40); else if (then) then();
    })();
  }
  function retire(v, sec) { fadeVoice(v, 0, sec, function () { try { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } catch (e) {} }); }

  function startSlug(slug, opts) {
    var old = cur, fade = opts.fade == null ? 1.5 : opts.fade;
    var v = makeVoice(slug); cur = v;
    v.el.loop = order.length === 1 && opts.loop !== false;
    if (opts.from === 'random' && !old) {
      v.el.addEventListener('loadedmetadata', function once() { v.el.removeEventListener('loadedmetadata', once); if (v.el.duration > 60) v.el.currentTime = Math.random() * v.el.duration * 0.6; });
    }
    if (old) retire(old, fade);
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
    var p = v.el.play();
    if (p && p.catch) p.catch(function (e) { if (e && e.name === 'NotAllowedError') { pendingStart = true; } });
    applyMaster(0); fadeVoice(v, 1, old ? fade : Math.min(fade, 1));
  }
  function advance() {
    if (!want || !order.length) return;
    idx = (idx + 1) % order.length;
    if (idx === 0 && want.opts.shuffle) order = shuffled(order);
    startSlug(order[idx], want.opts);
  }
  function shuffled(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function same(a, b) { return a && b && a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }

  function gesture() {
    unlocked = true;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
    if (pendingStart && cur && on && !held) { pendingStart = false; var p = cur.el.play(); if (p && p.catch) p.catch(function () { pendingStart = true; }); }
  }
  ['pointerdown', 'keydown', 'touchend', 'click'].forEach(function (ev) { window.addEventListener(ev, gesture, { capture: true, passive: true }); });
  document.addEventListener('visibilitychange', function () {
    if (!cur) return;
    if (document.hidden) { cur.el.pause(); } else if (on && want && !held) { var p = cur.el.play(); if (p && p.catch) p.catch(function () { pendingStart = true; }); }
  });

  window.ArkMusic = {
    base: BASE,
    url: function (slug) { return BASE + slug + '.mp3'; },
    play: function (list, opts) {
      opts = opts || {}; list = [].concat(list || []).filter(Boolean);
      if (opts.volume != null) vol = +opts.volume;
      if (!list.length) return this.stop(opts.fade);
      if (want && same(want.list, list) && cur) { if (held) this.resume(); applyMaster(); return this; }  // already playing this
      held = false;
      want = { list: list, opts: opts };
      order = opts.shuffle ? shuffled(list) : list.slice(); idx = 0;
      if (on) startSlug(order[0], opts);
      return this;
    },
    pause: function () {
      if (!cur || held) return this;
      held = true; var v = cur;
      fadeVoice(v, 0, 0.5, function () { if (held && cur === v) v.el.pause(); });
      return this;
    },
    resume: function () {
      if (!held) return this;
      held = false;
      if (cur && on) { var p = cur.el.play(); if (p && p.catch) p.catch(function () { pendingStart = true; }); fadeVoice(cur, 1, 0.8); }
      return this;
    },
    stop: function (fade) {
      want = null; pendingStart = false; held = false;
      if (cur) { retire(cur, fade == null ? 1 : fade); cur = null; }
      return this;
    },
    volume: function (v) { if (v == null) return vol; vol = Math.max(0, Math.min(1, +v)); applyMaster(); return this; },
    duck: function (k, sec) { duckLvl = Math.max(0, Math.min(1, k == null ? 1 : +k)); applyMaster(sec == null ? 0.4 : sec); return this; },
    enabled: function (b) {
      if (b == null) return on;
      b = !!b; if (b === on) return this; on = b;
      if (!on) { if (cur) { var c = cur; cur = null; retire(c, 0.6); } }
      else if (want) { var w = want; want = null; this.play(w.list, w.opts); }
      return this;
    },
    onfail: function (fn) { failFns.push(fn); return this; },
    current: function () { return cur ? cur.slug : null; },
    state: function () {  // for tests: what is playing and how far in
      return { slug: cur ? cur.slug : null, time: cur ? cur.el.currentTime : 0, paused: cur ? cur.el.paused : true, held: held,
        on: on, volume: vol, duck: duckLvl, list: want ? want.list.slice() : [], webAudio: !!(cur && cur.gain) };
    },
    unlocked: function () { return unlocked; }
  };
})();
