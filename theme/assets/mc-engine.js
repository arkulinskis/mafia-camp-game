/* Mafia Camp engine: the video call, the game clock and the video tiles (everything that streams or draws).
 * The pages, panels, menus and dialogs are Python Forms (client_code); client_code/mc.py is this file's only caller.
 *
 *   MafiaCamp.init(bridge, host)      bridge(action, payloadJson) -> Promise<jsonString>   (mc.py -> server game.mc_api)
 *                                     host = Python callbacks: toast(msg, kind), confirm(text, yes) -> Promise<bool>,
 *                                     entered(), view(json), left(msg), dock(), copy(url)
 *   MafiaCamp.enter(action, name, code, status)   create / join: camera, server, call, polling. status('camera'|'walking')
 *   MafiaCamp.mountGrid(el), bindClock(timerEl, barEl)   the Room page's video tiles and phase clock
 *   MafiaCamp.act(action, payloadJson), leave(), copyInvite(), toggleMic(), toggleCam(), toggleSound(), media(),
 *   confetti(), homeSky(), saved(key), view(), roles (ROLES), colors (SEAT_COLORS)
 *
 * The video call is a full mesh: every browser holds one RTCPeerConnection to every other player (up to 9).
 * Anvil is the go-between: each player's call id travels in the `state` poll, the browser with the smaller pid dials,
 * and the offer/answer notes go through the server's `signal` / `inbox` actions (no PeerJS). Relays: Cloudflare TURN.
 * Video is 320x240 @ 15 fps, capped at ~180 kbps per connection, so 9 outgoing streams fit a normal home upload.
 *
 * Who hears and sees whom is enforced by the SENDER: per connection, the outgoing audio/video track is swapped for
 * nothing (RTCRtpSender.replaceTrack(null)) when the rules say so:
 *   lobby, roles, game over  everyone <-> everyone
 *   night                    living Campers send nothing; the living Mafia send only to each other and to ghosts
 *   day                      the living send to everyone
 *   ghosts (and spectators)  send only to other ghosts, any time
 */
(function () {
  'use strict';

  var MC = window.MafiaCamp = {};
  var S = {
    bridge: null, root: null, view: null, viewAt: 0, token: '', name: '', code: '',
    callId: '', ready: false, ice: null, seen: new Set(), fastTimer: null, inboxBusy: false, stream: null, audioTrack: null, videoTrack: null, hasCam: false, hasMic: false,
    mic: true, cam: true, conns: new Map(), tried: new Map(), tiles: new Map(), analysers: new Map(),
    audioCtx: null, pollTimer: null, tickTimer: null, meterTimer: null, polling: false, busy: false,
    lastPhase: '', failures: 0, needsTap: false, grid: null, host: {}, clockEl: null, barEl: null,
  };
  MC._S = S;

  var SEAT_COLORS = ['#ff8a3d', '#4fd1a1', '#8fb3ff', '#ff6fae', '#ffd166', '#b58cff', '#5ad1e6', '#ff7a6b', '#a3e36b', '#f4a3ff'];
  var PHASES = {
    lobby: { icon: '🔥', label: 'Campfire', sky: 'dusk' },
    roles: { icon: '🎭', label: 'Roles', sky: 'dusk' },
    night: { icon: '🌙', label: 'Night', sky: 'night' },
    dawn: { icon: '🌅', label: 'Dawn', sky: 'dawn' },
    day: { icon: '☀️', label: 'Day', sky: 'day' },
    vote: { icon: '🗳️', label: 'Vote', sky: 'day' },
    verdict: { icon: '🚌', label: 'Verdict', sky: 'day' },
    over: { icon: '🏁', label: 'Game over', sky: 'dusk' },
  };
  var ROLES = {
    mafia: { name: 'The Mafia', icon: '🔪', side: 'mafia',
      short: 'Pick a victim each night. Act innocent by day.',
      long: 'Each night you and your partners choose one camper to get rid of. At night only the Mafia can see and hear each other. By day, blend in. You win when the Mafia are as many as everyone else.' },
    nurse: { name: 'Camp Nurse', icon: '🩹', side: 'town',
      short: 'Protect one camper each night.',
      long: 'Each night pick someone to protect, yourself included. If the Mafia attack them, they survive. Not the same person two nights in a row. You win with the Campers.' },
    ranger: { name: 'The Ranger', icon: '🔦', side: 'town',
      short: 'Investigate one camper each night.',
      long: 'Each night shine your flashlight on someone. At dawn you learn whether they are Mafia. Share it carefully: the Mafia will come for you. You win with the Campers.' },
    camper: { name: 'Camper', icon: '🏕️', side: 'town',
      short: 'Find the Mafia and vote them out.',
      long: 'No night job: you sleep. By day, listen, ask questions and vote. You win when every Mafia member has been sent home.' },
    prankster: { name: 'The Prankster', icon: '🤡', side: 'alone',
      short: 'Get yourself voted out by day.',
      long: 'You win alone if the camp votes you out during the day. Be just suspicious enough. If the Mafia get you at night, you lose.' },
  };

  // ------------------------------------------------------------------------------------------------ tiny helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function store(key, val) {
    try {
      if (arguments.length === 1) return localStorage.getItem('mc.' + key);
      if (val == null) localStorage.removeItem('mc.' + key); else localStorage.setItem('mc.' + key, val);
    } catch (e) { return null; }
  }
  function makeToken() {
    var a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function api(action, payload) {
    payload = payload || {};
    payload.token = S.token;
    if (S.code && !payload.code) payload.code = S.code;
    return Promise.resolve(S.bridge(action, JSON.stringify(payload))).then(function (txt) {
      var r = JSON.parse(txt);
      if (!r.ok) { var e = new Error(r.error || 'Something went wrong.'); e.code = r.code; throw e; }
      return r.data;
    });
  }
  function toast(msg, kind) {
    try { if (S.host.toast) S.host.toast(String(msg), kind || ''); } catch (e) { /* the page is changing */ }
  }
  // Yes/no questions go to Python (an Anvil confirm dialog); a Python function that waits returns a Promise here.
  function ask(text, yes) {
    return Promise.resolve(S.host.confirm ? S.host.confirm(text, yes || 'OK') : window.confirm(text)).then(function (r) { return !!r; });
  }
  function players() { return (S.view && S.view.players) || []; }
  function byPid(pid) { return players().find(function (p) { return p.pid === pid; }); }
  function me() { return S.view && byPid(S.view.me); }
  function nameOf(pid) { var p = byPid(pid); return p ? p.name : 'someone'; }
  function color(p) { return SEAT_COLORS[(((p && p.seat) || 1) - 1) % SEAT_COLORS.length]; }
  function remaining() {
    if (!S.view || S.view.remaining == null) return null;
    return Math.max(0, S.view.remaining - (Date.now() - S.viewAt) / 1000);
  }
  function clock(sec) {
    sec = Math.ceil(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setSky(sky) {
    document.documentElement.setAttribute('data-sky', sky);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', { day: '#cfe8f3', dawn: '#2c2a5a', night: '#070b1f', dusk: '#151233' }[sky] || '#151233');
  }
  function homeSky() {  // the home page follows light / dark (app-kit.js sets html.ui-dark): daylight or dusk
    setSky(document.documentElement.classList.contains('ui-dark') ? 'dusk' : 'day');
  }

  // ------------------------------------------------------------------------------------------------ sounds
  function audioCtx() {
    if (!S.audioCtx) {
      var A = window.AudioContext || window.webkitAudioContext;
      if (A) S.audioCtx = new A();
    }
    if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
    return S.audioCtx;
  }
  function chime(notes) {
    var ctx = S.audioCtx;
    if (!ctx || store('sound') === 'off') return;
    var t = ctx.currentTime + 0.02;
    notes.forEach(function (f, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.16 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.55);
    });
  }
  var PHASE_SOUND = { night: [660, 494, 392], dawn: [392, 494, 660], day: [523, 659], vote: [587, 587, 784], verdict: [440, 349], over: [523, 659, 784, 1047], roles: [440, 554, 659] };
  // Background music per phase: real tracks streamed by ArkMusic (theme/assets/ark-music.js). It plays only in this
  // browser (never into the call), kept quiet, and dips further while people talk (day + vote). The Sounds button
  // turns it off with the chimes.
  var PHASE_MUSIC = {
    lobby: ['midwest-western'], roles: ['waves'], night: ['spiralis'], dawn: ['bright-road'], day: ['bright-road'],
    vote: ['dark-terrain'], verdict: ['waves'], over: ['nailed-it', 'midwest-western']
  };
  function music(phase) {
    var M = window.ArkMusic;
    if (!M) return;
    M.enabled(store('sound') !== 'off');
    if (!phase || !PHASE_MUSIC[phase]) { M.stop(1.5); return; }
    M.play(PHASE_MUSIC[phase], { volume: 0.22, fade: 2 });
    M.duck(phase === 'day' || phase === 'vote' ? 0.55 : 1, 1);
  }

  // ------------------------------------------------------------------------------------------------ camera + mic
  function blankVideoTrack() {
    var c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    var g = c.getContext('2d');
    function draw() {
      g.fillStyle = '#141a3a'; g.fillRect(0, 0, 320, 240);
      g.font = '72px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('🏕️', 160, 120);
    }
    draw();
    setInterval(draw, 1000);
    var track = c.captureStream(2).getVideoTracks()[0];
    track._blank = true;
    return track;
  }
  function silentAudioTrack() {
    var ctx = audioCtx();
    if (!ctx) return null;
    var track = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    track._blank = true;
    return track;
  }
  function getMedia() {
    var md = navigator.mediaDevices;
    var video = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' };
    var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!md || !md.getUserMedia) return Promise.resolve(null);
    return md.getUserMedia({ video: video, audio: audio })
      .catch(function () { return md.getUserMedia({ audio: audio }).then(function (s) { toast('No camera: you are joining with voice only.'); return s; }); })
      .catch(function () { return md.getUserMedia({ video: video }).then(function (s) { toast('No microphone: others will see you but not hear you.'); return s; }); })
      .catch(function () { toast('Camera and microphone are blocked. You can still watch and play.', 'warn'); return null; });
  }
  function setupStream(real) {
    var vt = real && real.getVideoTracks()[0];
    var at = real && real.getAudioTracks()[0];
    S.hasCam = !!vt; S.hasMic = !!at;
    S.videoTrack = vt || blankVideoTrack();
    S.audioTrack = at || silentAudioTrack();
    S.stream = new MediaStream([S.videoTrack].concat(S.audioTrack ? [S.audioTrack] : []));
    S.cam = S.hasCam && store('cam') !== 'off';
    S.mic = S.hasMic && store('mic') !== 'off';
    S.videoTrack.enabled = S.cam || !S.hasCam;
    if (S.audioTrack) S.audioTrack.enabled = S.mic;
    if (at) watchAudio('me', new MediaStream([at]));
  }
  function stopStream() {
    if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); });
    S.stream = null; S.videoTrack = null; S.audioTrack = null;
  }

  // ------------------------------------------------------------------------------------------------ the mesh
  // Plain browser WebRTC, no outside go-between: the handshake travels through Anvil. The player with the smaller pid
  // dials. Each side sends ONE note (the dialler an 'offer', the other an 'answer'), each carrying the encryption
  // fingerprint and every network address the browser found, so two server hops are enough. Notes arrive with the 2 s
  // state poll; while a dialler waits for its answer it also checks the inbox every 0.6 s.
  function startCall() {
    S.callId = makeToken().slice(0, 16);  // new each visit: a reload tells the others to dial again
    api('ice').catch(function () { return null; }).then(function (ice) {
      if (!S.code) return;
      S.ice = (ice && ice.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }];
      S.ready = true;
      poll();
    });
  }
  function newConn(pid, remote) {
    var pc = new RTCPeerConnection({ iceServers: S.ice });
    var c = { pc: pc, pid: pid, remote: remote, t: Date.now(), stream: null, up: false, waiting: false, allow: null, tuned: false };
    S.conns.set(pid, c);
    pc.ontrack = function (e) {
      if (S.conns.get(pid) !== c) return;
      if (!c.stream) c.stream = e.streams[0] || new MediaStream();
      if (c.stream.getTracks().indexOf(e.track) < 0) c.stream.addTrack(e.track);
      if (e.track.kind === 'audio') { unwatchAudio(pid); watchAudio(pid, c.stream); }
      route(c, true);
    };
    pc.addEventListener('connectionstatechange', function () {
      if (S.conns.get(pid) !== c) return;
      if (pc.connectionState === 'connected') { c.up = true; tune(c); attachStreams(); }
      if (pc.connectionState === 'failed') dropConn(pid);
    });
    return c;
  }
  function addTracks(c) {
    S.stream.getTracks().forEach(function (t) { c.pc.addTrack(t, S.stream); });
    c.added = true;
    route(c, true);  // before media flows: don't leak a frame at night
  }
  function gathered(pc) {  // wait for every network address (at most 3 s), so one note carries them all
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (res) {
      function done() { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); res(); } }
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(res, 3000);
    });
  }
  function dial(p) {
    var c = newConn(p.pid, p.peer_id);
    c.waiting = true;
    addTracks(c);
    c.pc.createOffer()
      .then(function (o) { return c.pc.setLocalDescription(o); })
      .then(function () { return gathered(c.pc); })
      .then(function () {
        if (S.conns.get(c.pid) !== c) return;
        return api('signal', { to: c.pid, kind: 'offer', call: S.callId, target: c.remote, sdp: c.pc.localDescription.sdp })
          .then(fastInbox);
      })
      .catch(function (e) { console.warn('[dial]', e && e.message); if (S.conns.get(c.pid) === c) dropConn(c.pid); });
  }
  function onSignal(s) {
    if (!s || S.seen.has(s.id)) return;
    S.seen.add(s.id);
    if (s.target !== S.callId || !byPid(s.from)) return;  // meant for an earlier visit, or they left
    var c = S.conns.get(s.from);
    if (s.kind === 'offer') {
      if (c) dropConn(s.from);  // they dialled again: start fresh
      c = newConn(s.from, s.call);
      c.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
        .then(function () { addTracks(c); return c.pc.createAnswer(); })
        .then(function (a) { return c.pc.setLocalDescription(a); })
        .then(function () { return gathered(c.pc); })
        .then(function () {
          if (S.conns.get(c.pid) !== c) return;
          return api('signal', { to: c.pid, kind: 'answer', call: S.callId, target: s.call, sdp: c.pc.localDescription.sdp });
        })
        .catch(function (e) { console.warn('[answer]', e && e.message); if (S.conns.get(c.pid) === c) dropConn(c.pid); });
    } else if (s.kind === 'answer') {
      if (!c || !c.waiting || c.remote !== s.call) return;
      c.waiting = false;
      c.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
        .catch(function (e) { console.warn('[answer in]', e && e.message); if (S.conns.get(c.pid) === c) dropConn(c.pid); });
    }
  }
  function fastInbox() {
    if (S.fastTimer) return;
    S.fastTimer = setInterval(function () {
      var waiting = false;
      S.conns.forEach(function (c) { if (c.waiting) waiting = true; });
      if (!waiting || !S.code) { clearInterval(S.fastTimer); S.fastTimer = null; return; }
      if (S.inboxBusy) return;
      S.inboxBusy = true;
      api('inbox', {}).then(function (r) { (r.signals || []).forEach(onSignal); })
        .catch(function () { /* the next poll brings them */ })
        .then(function () { S.inboxBusy = false; });
    }, 600);
  }
  function dropConn(pid) {
    var c = S.conns.get(pid);
    if (!c) return;
    S.conns.delete(pid);
    unwatchAudio(pid);
    try { c.pc.close(); } catch (e) { /* fine */ }
    attachStreams();
  }
  function syncMesh() {
    var v = S.view;
    if (!v || !S.ready) return;
    var wanted = new Map();
    players().forEach(function (p) { if (p.pid !== v.me && p.peer_id) wanted.set(p.pid, p); });
    S.conns.forEach(function (c, pid) { if (!wanted.has(pid)) dropConn(pid); });
    var now = Date.now();
    wanted.forEach(function (p, pid) {
      var c = S.conns.get(pid);
      if (c) {
        var st = c.pc.connectionState, age = now - c.t;
        if (st === 'failed' || st === 'closed' || (p.peer_id !== c.remote && age > 8000) || (!c.up && age > 25000)) dropConn(pid);
        return;
      }
      if (p.away) return;
      if (v.me < pid && now - (S.tried.get(pid) || 0) > 6000) {
        S.tried.set(pid, now);
        dial(p);
      }
    });
  }
  function tune(c) {
    var pc = c.pc;
    if (!pc || c.tuned) return;
    pc.getTransceivers().forEach(function (t) {
      var s = t.sender;
      if (!s || !s.getParameters || !t.receiver || !t.receiver.track || t.receiver.track.kind !== 'video') return;
      var p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = 180000;
      p.encodings[0].maxFramerate = 15;
      s.setParameters(p).then(function () { c.tuned = true; }).catch(function () { /* older browser: fine */ });
    });
  }
  // Would `from` send their camera + mic to `to` right now?
  function sends(from, to, v) {
    var ph = v.phase;
    if (ph === 'lobby' || ph === 'over' || ph === 'roles') return true;
    if (!from.alive) return !to.alive;
    if (ph === 'night') return from.role === 'mafia' && (!to.alive || to.role === 'mafia');
    return true;
  }
  function route(c, force) {
    var v = S.view, m = me();
    var p = byPid(c.pid);
    var allow = !!(v && m && p && sends(m, p, v));
    if (!force && c.allow === allow) return;
    c.allow = allow;
    var pc = c.pc;
    if (!pc || !c.added || pc.signalingState === 'closed') return;  // (the answerer adds its tracks after the offer)
    pc.getTransceivers().forEach(function (t) {
      var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
      if (!kind || !t.sender) return;
      var want = allow ? (kind === 'audio' ? S.audioTrack : S.videoTrack) : null;
      if (t.sender.track !== want) t.sender.replaceTrack(want).catch(function () { /* closed */ });
    });
    if (!c.tuned) tune(c);
  }
  function routeAll() { S.conns.forEach(function (c) { route(c, false); }); }

  // ------------------------------------------------------------------------------------------------ speaking glow
  function watchAudio(key, stream) {
    var ctx = S.audioCtx, tr = stream.getAudioTracks()[0];
    if (!ctx || !tr) return;
    try {
      var src = ctx.createMediaStreamSource(new MediaStream([tr]));
      var an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      S.analysers.set(key, { an: an, src: src, buf: new Uint8Array(an.fftSize), level: 0 });
    } catch (e) { /* no analyser: no glow */ }
  }
  function unwatchAudio(key) {
    var a = S.analysers.get(key);
    if (a) { try { a.src.disconnect(); } catch (e) { /* fine */ } S.analysers.delete(key); }
  }
  function meter() {
    S.analysers.forEach(function (a, key) {
      a.an.getByteTimeDomainData(a.buf);
      var sum = 0;
      for (var i = 0; i < a.buf.length; i++) { var x = (a.buf[i] - 128) / 128; sum += x * x; }
      var rms = Math.sqrt(sum / a.buf.length);
      a.level = a.level * 0.6 + rms * 0.4;
      var pid = key === 'me' ? (S.view && S.view.me) : key;
      var tile = pid && S.tiles.get(pid);
      if (tile) tile.el.classList.toggle('speaking', a.level > 0.035 && (key !== 'me' || S.mic));
    });
  }

  // ------------------------------------------------------------------------------------------------ polling
  function poll() {
    if (S.polling || !S.code) return;
    S.polling = true;
    api('state', { peer_id: S.ready ? S.callId : '', media: (S.mic ? 'm' : '') + (S.cam ? 'c' : '') })
      .then(function (v) { S.failures = 0; setView(v); (v.signals || []).forEach(onSignal); })
      .catch(function (e) {
        if (e.code === 'not_in_room' || e.code === 'no_room') { leaveLocal(e.message); return; }
        if (e.code === 'session') { location.reload(); return; }
        S.failures++;
        if (S.failures === 3) toast('Having trouble reaching camp. Still trying…', 'warn');
      })
      .then(function () { S.polling = false; });
  }
  function act(action, payload, okMsg) {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    return api(action, payload || {}).then(function (v) {
      if (v && v.left) { leaveLocal(); return; }
      setView(v);
      if (okMsg) toast(okMsg);
    }).catch(function (e) { toast(e.message, 'warn'); })
      .then(function () { S.busy = false; });
  }
  function setView(v) {
    var before = S.view;
    S.view = v; S.viewAt = Date.now();
    if (before && before.phase !== v.phase) {
      if (PHASE_SOUND[v.phase]) chime(PHASE_SOUND[v.phase]);
      if (v.phase === 'night' && v.my.alive && !v.my.ghost && v.my.role !== 'mafia') toast('Night falls. Your camera and mic are off to everyone until morning. 🌙');
    }
    if (!before || before.phase !== v.phase) music(v.phase);
    setSky((PHASES[v.phase] || PHASES.lobby).sky);
    renderTiles();
    tick();
    try { if (S.host.view) S.host.view(JSON.stringify(v)); } catch (e) { console.warn('[view]', e); }
    routeAll();
    syncMesh();
  }
  // ------------------------------------------------------------------------------------------------ joining + leaving
  function enter(action, name, code, status) {
    name = (name || '').trim();
    if (!name) { toast('Pick a camp name first.', 'warn'); return Promise.resolve(false); }
    store('name', name);
    S.name = name;
    audioCtx();  // a click: browsers allow sound from now on
    if (status) status('camera');
    return getMedia().then(function (real) {
      setupStream(real);
      if (status) status('walking');
      return api(action, { name: name, code: code });
    }).then(function (v) {
      S.code = v.code;
      store('room', v.code);
      try { history.replaceState(null, '', '#' + v.code); } catch (e) { /* file:// */ }
      setView(v);
      try { if (S.host.entered) S.host.entered(); } catch (e) { console.warn('[entered]', e); }
      startCall();
      clearInterval(S.pollTimer); S.pollTimer = setInterval(poll, 2000);
      clearInterval(S.tickTimer); S.tickTimer = setInterval(tick, 250);
      clearInterval(S.meterTimer); S.meterTimer = setInterval(meter, 150);
      return true;
    }).catch(function (e) {
      stopStream();
      S.code = '';
      toast(e.message, 'warn');
      return false;
    });
  }
  function leaveLocal(msg) {
    clearInterval(S.pollTimer); clearInterval(S.tickTimer); clearInterval(S.meterTimer);
    S.conns.forEach(function (c, id) { dropConn(id); });
    S.analysers.forEach(function (a, key) { unwatchAudio(key); });
    clearInterval(S.fastTimer); S.fastTimer = null;
    S.ready = false; S.callId = ''; S.seen.clear(); S.view = null; S.code = ''; S.tiles.clear(); S.tried.clear();
    S.grid = null; S.clockEl = null; S.barEl = null;
    stopStream();
    store('room', null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* fine */ }
    music(null);
    homeSky();
    try { if (S.host.left) S.host.left(msg || ''); } catch (e) { console.warn('[left]', e); }
  }
  function leave() {
    var v = S.view;
    var playing = v && v.phase !== 'lobby' && v.phase !== 'over' && v.my.alive && !v.my.spectator;
    return ask(playing ? 'Leave camp in the middle of the game? You will count as out.' : 'Leave camp?', 'Leave camp').then(function (yes) {
      if (!yes) return false;
      return api('leave').catch(function () { /* leaving anyway */ }).then(function () { leaveLocal(); return true; });
    });
  }

  // ------------------------------------------------------------------------------------------------ room controls
  function copyInvite() {
    var url = location.origin + location.pathname + '#' + S.code;
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: 'Mafia Camp', text: 'Join my camp: code ' + S.code, url: url }).catch(function () { /* closed */ });
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      function () { toast('Invite link copied. Send it to your campers!'); },
      function () { if (S.host.copy) S.host.copy(url); });
  }
  function toggleMic() {
    if (!S.hasMic) { toast('No microphone was found.', 'warn'); return; }
    S.mic = !S.mic; S.audioTrack.enabled = S.mic; store('mic', S.mic ? null : 'off');
    renderDock(); poll();
  }
  function toggleCam() {
    if (!S.hasCam) { toast('No camera was found.', 'warn'); return; }
    S.cam = !S.cam; S.videoTrack.enabled = S.cam; store('cam', S.cam ? null : 'off');
    renderDock(); renderTiles(); poll();
  }
  function toggleSound() {
    store('sound', store('sound') === 'off' ? null : 'off');
    renderDock();
    if (window.ArkMusic) window.ArkMusic.enabled(store('sound') !== 'off');
    if (store('sound') !== 'off') chime([523, 659]);
  }
  function renderDock() {  // the dock buttons are Python (Pages/Room): it reads media() again
    try { if (S.host.dock) S.host.dock(); } catch (e) { /* the page is changing */ }
  }
  function tick() {
    var t = remaining();
    var el = S.clockEl;
    if (el) {
      el.textContent = t == null ? '' : clock(t);
      el.classList.toggle('hurry', t != null && t <= 10 && !!S.view && (S.view.phase === 'day' || S.view.phase === 'vote' || S.view.phase === 'night'));
    }
    var bar = S.barEl;
    if (bar && S.view && S.view.remaining != null) {
      var total = phaseTotal(S.view);
      bar.style.transform = 'scaleX(' + (total ? Math.max(0, Math.min(1, t / total)) : 0).toFixed(4) + ')';
    }
    if (t === 0 && S.view && S.view.remaining > 0 && Date.now() - S.viewAt > 2500) poll();
  }
  function phaseTotal(v) {
    var s = v.settings || {};
    return { roles: 12, dawn: 9, verdict: 9, night: s.night_seconds, day: s.day_seconds, vote: s.vote_seconds }[v.phase] || 0;
  }

  // ---- tiles
  function pickMode(v) {
    var my = v.my, m = me();
    if (!m || !my.alive || my.ghost) return null;
    if (v.phase === 'night' && (my.role === 'mafia' || my.role === 'nurse' || my.role === 'ranger')) {
      var team = my.team || [];
      return {
        action: 'act', selected: my.pick || null,
        verb: { mafia: '🔪 Target', nurse: '🩹 Protect', ranger: '🔦 Check' }[my.role],
        chosen: { mafia: 'Your target', nurse: 'Protected', ranger: 'Checking' }[my.role],
        can: function (p) {
          if (!p.alive || !p.playing) return false;
          if (my.role === 'mafia') return team.indexOf(p.pid) < 0;
          if (my.role === 'nurse') return p.pid !== my.nurse_last;
          return p.pid !== v.me;
        },
      };
    }
    if (v.phase === 'vote') {
      return { action: 'vote', selected: my.vote && my.vote !== 'skip' ? my.vote : null, verb: '🗳️ Vote', chosen: 'Your vote',
        can: function (p) { return p.alive && p.playing && p.pid !== v.me; } };
    }
    return null;
  }
  function tileFor(p) {
    var t = S.tiles.get(p.pid);
    if (t) return t;
    var video = h('video', { autoplay: true, playsinline: true });
    video.playsInline = true;
    var el = h('div', { class: 'tile', 'data-pid': p.pid },
      video,
      h('div', { class: 'cover' }, h('div', { class: 'cv-ic' }), h('div', { class: 'cv-t' })),
      h('div', { class: 'tile-top' }, h('span', { class: 'seat' }), h('span', { class: 'tname' }), h('span', { class: 'ticons' })),
      h('div', { class: 'tags' }),
      h('button', { class: 'pick', type: 'button' }),
      h('button', { class: 'kick', type: 'button', title: 'Send this camper home', 'aria-label': 'Send ' + p.name + ' home' }, '✕'));
    t = { el: el, video: video, src: null };
    el.querySelector('.pick').addEventListener('click', function () { onPick(p.pid); });
    el.querySelector('.kick').addEventListener('click', function () {
      ask('Send ' + nameOf(p.pid) + ' home? They leave this camp.', 'Send home').then(function (yes) { if (yes) act('kick', { pid: p.pid }); });
    });
    S.tiles.set(p.pid, t);
    return t;
  }
  function onPick(pid) {
    var v = S.view, mode = v && pickMode(v);
    if (!mode) return;
    var target = mode.selected === pid ? null : pid;
    if (mode.action === 'vote') act('vote', { target: target });
    else act('act', { target: target });
  }
  function renderTiles() {
    var v = S.view, grid = S.grid;
    if (!v || !grid) return;
    var list = players().slice().sort(function (a, b) { return (a.seat || 0) - (b.seat || 0); });
    var keep = {};
    list.forEach(function (p) { keep[p.pid] = true; });
    S.tiles.forEach(function (t, pid) { if (!keep[pid]) { t.el.remove(); S.tiles.delete(pid); } });
    grid.setAttribute('data-n', list.length);
    var mode = pickMode(v), m = me(), isHost = v.host === v.me;
    var votes = {}, picks = {};
    if (v.phase === 'vote' || v.phase === 'verdict') list.forEach(function (p) { if (p.vote && p.vote !== 'skip') (votes[p.vote] = votes[p.vote] || []).push(p.name); });
    if (v.my.picks) Object.keys(v.my.picks).forEach(function (who) { var t = v.my.picks[who]; if (t) (picks[t] = picks[t] || []).push(who === v.me ? 'you' : nameOf(who)); });
    var checks = {};
    (v.my.checks || []).forEach(function (c) { checks[c.pid] = c.mafia; });
    list.forEach(function (p, i) {
      var t = tileFor(p), el = t.el;
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
      var mine = p.pid === v.me;
      var visible = mine ? true : !!(m && sends(p, m, v));
      var hasStream = mine || !!streamFor(p);
      el.style.setProperty('--seat', color(p));
      el.classList.toggle('me', mine);
      el.classList.toggle('dead', v.phase !== 'lobby' && !p.alive);
      el.classList.toggle('away', !!p.away && !mine);
      var asleep = !visible && p.alive && v.phase === 'night';
      el.classList.toggle('asleep', asleep);
      el.classList.toggle('hidden-media', !visible);
      el.classList.toggle('connecting', !mine && visible && !hasStream && !p.away);
      el.classList.toggle('camoff', mine ? !S.cam : !p.cam);
      el.querySelector('.seat').textContent = p.seat;
      el.querySelector('.tname').textContent = mine ? p.name + ' (you)' : p.name;
      var icons = [];
      if (p.host) icons.push('<span title="Host">👑</span>');
      if (!(mine ? S.mic : p.mic)) icons.push('<span title="Muted">🔇</span>');
      if (p.ready) icons.push('<span title="Ready to vote">✋</span>');
      el.querySelector('.ticons').innerHTML = icons.join('');
      // cover
      var ic = '', tx = '';
      if (v.phase !== 'lobby' && !p.alive) { ic = '👻'; tx = p.playing ? (p.role ? ROLES[p.role].name : 'Out') : 'Watching'; }
      else if (asleep) { ic = '💤'; tx = 'Asleep'; }
      else if (p.away && !mine) { ic = '📶'; tx = 'Away'; }
      else if (!visible) { ic = '🌫️'; tx = ''; }
      else if (!mine && !hasStream) { ic = '⏳'; tx = 'Connecting…'; }
      else if (mine ? !S.cam : !p.cam) { ic = initials(p.name); tx = 'Camera off'; }
      el.querySelector('.cv-ic').textContent = ic;
      el.querySelector('.cv-t').textContent = tx;
      el.classList.toggle('covered', !!ic);
      // tags: roles I may see, mafia picks, ranger results, votes
      var tags = [];
      if (p.role && (mine || v.phase === 'over' || v.my.ghost || v.my.role === 'mafia') && p.alive) tags.push(tag(ROLES[p.role].icon + ' ' + ROLES[p.role].name, p.role));
      if (v.phase === 'over' && p.role && !p.alive) tags.push(tag(ROLES[p.role].icon + ' ' + ROLES[p.role].name, p.role));
      if (picks[p.pid]) tags.push(tag('🔪 ' + picks[p.pid].join(', '), 'mafia'));
      if (checks[p.pid] !== undefined && p.pid !== v.me) tags.push(tag(checks[p.pid] ? '🔦 Mafia!' : '🔦 Innocent', checks[p.pid] ? 'mafia' : 'ok'));
      if (votes[p.pid]) tags.push(tag('🗳️ ' + votes[p.pid].length, 'vote', votes[p.pid].join(', ')));
      var tg = el.querySelector('.tags');
      tg.innerHTML = '';
      tags.forEach(function (x) { tg.appendChild(x); });
      // pick button
      var pick = el.querySelector('.pick');
      var can = !!(mode && mode.can(p));
      var chosen = !!(mode && mode.selected === p.pid);
      el.classList.toggle('pickable', can);
      el.classList.toggle('chosen', chosen);
      pick.hidden = !can;
      pick.textContent = chosen ? '✓ ' + mode.chosen : (mode ? mode.verb : '');
      var kick = el.querySelector('.kick');
      kick.hidden = !(isHost && !mine && (v.phase === 'lobby' || v.phase === 'over' || p.away));
      // media
      var src = mine ? S.stream : streamFor(p);
      if (t.src !== src) {
        t.src = src;
        t.video.srcObject = src || null;
        t.video.muted = mine;
        if (src) { var pr = t.video.play(); if (pr && pr.catch) pr.catch(function () { askForTap(); }); }
      }
    });
  }
  function tag(text, kind, title) { return h('span', { class: 'tag ' + (kind || ''), title: title || null }, text); }
  function initials(name) { return (name || '?').split(' ').map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function streamFor(p) {
    var c = S.conns.get(p.pid);
    return c && c.up ? c.stream : null;
  }
  function attachStreams() { renderTiles(); }
  function askForTap() {
    if (S.needsTap) return;
    S.needsTap = true;
    var b = h('button', { class: 'tap-sound mc-btn primary', type: 'button', onclick: function () {
      audioCtx();
      S.tiles.forEach(function (t) { if (t.src) t.video.play().catch(function () { /* still blocked */ }); });
      b.remove(); S.needsTap = false;
    } }, '🔊 Tap to hear camp');
    document.body.appendChild(b);
  }

  // ---- confetti for the winners
  function confetti() {
    if (S.confettiFor === S.view.version || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    S.confettiFor = S.view.version;
    var box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (var i = 0; i < 60; i++) {
      box.appendChild(h('i', { style: 'left:' + (Math.random() * 100).toFixed(1) + '%;background:' + SEAT_COLORS[i % 10] +
        ';animation-delay:' + (Math.random() * 0.8).toFixed(2) + 's;animation-duration:' + (2 + Math.random() * 1.5).toFixed(2) + 's' }));
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 4500);
  }


  // ------------------------------------------------------------------------------------------------ the Python side
  // Tests open several players in one browser with ?mcp=1, ?mcp=2 ... (each its own player key).
  var TOKEN_KEY = 'token' + ((/[?&]mcp=(\d+)/.exec(location.search) || [])[1] || '');
  MC.init = function (bridge, host) {
    S.bridge = bridge;
    S.host = host || {};
    S.token = store(TOKEN_KEY) || makeToken();
    store(TOKEN_KEY, S.token);
    homeSky();
    new MutationObserver(function () { if (!S.code) homeSky(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('beforeunload', function () { S.conns.forEach(function (c) { try { c.pc.close(); } catch (e) { /* fine */ } }); });
  };
  MC.enter = enter;
  MC.leave = leave;
  MC.act = function (action, payloadJson) { return act(action, payloadJson ? JSON.parse(payloadJson) : {}); };
  MC.copyInvite = copyInvite;
  MC.toggleMic = toggleMic;
  MC.toggleCam = toggleCam;
  MC.toggleSound = toggleSound;
  MC.media = function () {
    return { mic: !!S.mic, cam: !!S.cam, hasMic: !!S.hasMic, hasCam: !!S.hasCam, sound: store('sound') !== 'off', code: S.code };
  };
  MC.mountGrid = function (el) { S.grid = el; S.tiles.forEach(function (t) { t.el.remove(); }); S.tiles.clear(); renderTiles(); };
  MC.bindClock = function (timerEl, barEl) { S.clockEl = timerEl; S.barEl = barEl; tick(); };
  MC.inRoom = function () { return !!S.code; };
  MC.view = function () { return S.view ? JSON.stringify(S.view) : ''; };
  MC.saved = function (key) { return store(key) || ''; };
  MC.homeSky = homeSky;
  MC.confetti = function () { if (S.view) confetti(); };
  MC.roles = ROLES;
  MC.colors = SEAT_COLORS;
})();

(function () {
  // Watch section: swap the video's cover for YouTube's player (privacy-enhanced) only when it's pressed.
  if (!window.__ytFilm) {
    window.__ytFilm = true;
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-yt-film]') : null;
      if (!b) return;
      var f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + b.getAttribute('data-yt-film') + '?autoplay=1&rel=0&playsinline=1';
      f.title = b.getAttribute('data-yt-title') || 'Video';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      b.parentNode.replaceChild(f, b);
    });
  }
})();
