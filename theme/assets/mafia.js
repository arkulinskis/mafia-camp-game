/* Mafia Camp: the whole interface.
 *
 *   MafiaCamp.mount(node, bridge)     bridge(action, payloadJson) -> Promise<jsonString>  (Form1 -> server game.mc_api)
 *
 * The video call is a full mesh: every browser holds one PeerJS MediaConnection to every other player (up to 9).
 * Anvil is the broker: each player's PeerJS id travels in the `state` poll, and the browser with the smaller id dials.
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
    peer: null, peerId: '', stream: null, audioTrack: null, videoTrack: null, hasCam: false, hasMic: false,
    mic: true, cam: true, conns: new Map(), tried: new Map(), tiles: new Map(), analysers: new Map(),
    audioCtx: null, pollTimer: null, tickTimer: null, meterTimer: null, polling: false, busy: false,
    lastPhase: '', storyOpen: false, failures: 0, needsTap: false,
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
  function $(sel, el) { return (el || S.root).querySelector(sel); }
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
    var box = document.querySelector('.mc-toasts');
    if (!box) { box = h('div', { class: 'mc-toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
    var t = h('div', { class: 'mc-toast ' + (kind || '') }, msg);
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 3600);
    setTimeout(function () { t.remove(); }, 4100);
  }
  function players() { return (S.view && S.view.players) || []; }
  function byPid(pid) { return players().find(function (p) { return p.pid === pid; }); }
  function byPeer(peerId) { return players().find(function (p) { return p.peer_id === peerId; }); }
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
  function homeSky() {
    var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    setSky(light ? 'day' : 'dusk');
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
  function startPeer() {
    if (S.peer && !S.peer.destroyed) return;
    if (!window.Peer) { toast('The video library did not load. Reload the page.', 'warn'); return; }
    var peer = S.peer = new window.Peer({ debug: 1 });
    peer.on('open', function (id) { S.peerId = id; poll(); });
    peer.on('call', function (call) {
      if (S.conns.has(call.peer)) dropConn(call.peer);
      call.answer(S.stream);
      setupCall(call);
    });
    peer.on('disconnected', function () {
      setTimeout(function () { if (S.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') {
        var m = /peer (\S+)/.exec(err.message || '');
        if (m) dropConn(m[1]);
        return;
      }
      console.warn('[peer]', type, err && err.message);
      if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        setTimeout(function () {
          if (S.peer !== peer) return;
          if (peer.destroyed) { S.peer = null; S.peerId = ''; startPeer(); } else if (peer.disconnected) peer.reconnect();
        }, 3000);
      }
    });
  }
  function setupCall(call) {
    var c = { call: call, t: Date.now(), stream: null, allow: null, tuned: false };
    S.conns.set(call.peer, c);
    route(c, true);  // before media flows: don't leak a frame at night
    call.on('stream', function (st) {
      if (S.conns.get(call.peer) !== c) return;
      c.stream = st;
      tune(c);
      route(c, true);
      watchAudio(call.peer, st);
      attachStreams();
    });
    function gone() { if (S.conns.get(call.peer) === c) { S.conns.delete(call.peer); unwatchAudio(call.peer); attachStreams(); } }
    call.on('close', gone);
    call.on('error', gone);
    var pc = call.peerConnection;
    if (pc) pc.addEventListener('connectionstatechange', function () {
      if (pc.connectionState === 'connected') tune(c);
      if (pc.connectionState === 'failed') { try { call.close(); } catch (e) { /* already closed */ } gone(); }
    });
  }
  function dropConn(peerId) {
    var c = S.conns.get(peerId);
    if (!c) return;
    S.conns.delete(peerId);
    unwatchAudio(peerId);
    try { c.call.close(); } catch (e) { /* fine */ }
    attachStreams();
  }
  function syncMesh() {
    var v = S.view;
    if (!v || !S.peer || !S.peerId || S.peer.disconnected) return;
    var wanted = new Map();
    players().forEach(function (p) { if (p.pid !== v.me && p.peer_id) wanted.set(p.peer_id, p); });
    S.conns.forEach(function (c, peerId) { if (!wanted.has(peerId)) dropConn(peerId); });
    var now = Date.now();
    wanted.forEach(function (p, peerId) {
      var c = S.conns.get(peerId);
      if (c) {
        var st = c.call.peerConnection && c.call.peerConnection.connectionState;
        if (st === 'failed' || st === 'closed' || (!c.stream && now - c.t > 20000)) dropConn(peerId);
        return;
      }
      if (p.away) return;
      if (S.peerId < peerId && now - (S.tried.get(peerId) || 0) > 5000) {
        S.tried.set(peerId, now);
        var call = S.peer.call(peerId, S.stream, { metadata: { pid: v.me } });
        if (call) setupCall(call);
      }
    });
  }
  function tune(c) {
    var pc = c.call.peerConnection;
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
    var p = byPeer(c.call.peer);
    var allow = !!(v && m && p && sends(m, p, v));
    if (!force && c.allow === allow) return;
    c.allow = allow;
    var pc = c.call.peerConnection;
    if (!pc) return;
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
      var pid = key === 'me' ? (S.view && S.view.me) : (byPeer(key) || {}).pid;
      var tile = pid && S.tiles.get(pid);
      if (tile) tile.el.classList.toggle('speaking', a.level > 0.035 && (key !== 'me' || S.mic));
    });
  }

  // ------------------------------------------------------------------------------------------------ polling
  function poll() {
    if (S.polling || !S.code) return;
    S.polling = true;
    api('state', { peer_id: S.peerId, media: (S.mic ? 'm' : '') + (S.cam ? 'c' : '') })
      .then(function (v) { S.failures = 0; setView(v); })
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
    renderRoom();
    routeAll();
    syncMesh();
  }

  // ------------------------------------------------------------------------------------------------ joining + leaving
  function enter(action, name, code) {
    name = (name || '').trim();
    if (!name) { toast('Pick a camp name first.', 'warn'); return; }
    store('name', name);
    S.name = name;
    audioCtx();  // a click: browsers allow sound from now on
    var btn = $('.join-go');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking your camera…'; }
    getMedia().then(function (real) {
      setupStream(real);
      if (btn) btn.textContent = 'Walking to camp…';
      return api(action, { name: name, code: code });
    }).then(function (v) {
      S.code = v.code;
      store('room', v.code);
      try { history.replaceState(null, '', '#' + v.code); } catch (e) { /* file:// */ }
      buildRoom();
      setView(v);
      startPeer();
      clearInterval(S.pollTimer); S.pollTimer = setInterval(poll, 2000);
      clearInterval(S.tickTimer); S.tickTimer = setInterval(tick, 250);
      clearInterval(S.meterTimer); S.meterTimer = setInterval(meter, 150);
    }).catch(function (e) {
      stopStream();
      S.code = '';
      toast(e.message, 'warn');
      if (btn) { btn.disabled = false; btn.textContent = action === 'create' ? 'Start a camp' : 'Join camp'; }
    });
  }
  function leaveLocal(msg) {
    clearInterval(S.pollTimer); clearInterval(S.tickTimer); clearInterval(S.meterTimer);
    S.conns.forEach(function (c, id) { dropConn(id); });
    S.analysers.forEach(function (a, key) { unwatchAudio(key); });
    if (S.peer) { try { S.peer.destroy(); } catch (e) { /* fine */ } }
    S.peer = null; S.peerId = ''; S.view = null; S.code = ''; S.tiles.clear(); S.tried.clear();
    stopStream();
    store('room', null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* fine */ }
    renderHome();
    if (msg) toast(msg);
  }
  function leave() {
    var v = S.view;
    var playing = v && v.phase !== 'lobby' && v.phase !== 'over' && v.my.alive && !v.my.spectator;
    if (!confirm(playing ? 'Leave camp in the middle of the game? You will count as out.' : 'Leave camp?')) return;
    api('leave').catch(function () { /* leaving anyway */ }).then(function () { leaveLocal(); });
  }

  // ------------------------------------------------------------------------------------------------ home screen
  function codeFromHash() {
    var m = /^#([a-z]{4})$/i.exec(location.hash || '');
    return m ? m[1].toUpperCase() : '';
  }
  function renderHome() {
    homeSky();
    var hashCode = codeFromHash();
    var lastRoom = store('room');
    var mode = hashCode ? 'join' : 'create';
    var root = S.root;
    root.innerHTML = '';
    var nameInput = h('input', { class: 'field', id: 'mc-name', maxlength: 16, autocomplete: 'nickname', placeholder: 'Your camp name', value: store('name') || '' });
    var codeInput = h('input', { class: 'field code-field', id: 'mc-code', maxlength: 4, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCD', value: hashCode });
    codeInput.addEventListener('input', function () { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    var tabs, form, go;
    function setMode(m) {
      mode = m;
      tabs.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-selected', b.dataset.mode === m); });
      form.classList.toggle('joining', m === 'join');
      go.textContent = m === 'create' ? 'Start a camp' : 'Join camp';
    }
    tabs = h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', 'data-mode': 'create', onclick: function () { setMode('create'); } }, 'Start a camp'),
      h('button', { type: 'button', role: 'tab', 'data-mode': 'join', onclick: function () { setMode('join'); codeInput.focus(); } }, 'Join with a code'));
    go = h('button', { class: 'btn primary big join-go', type: 'submit' }, 'Start a camp');
    form = h('form', { class: 'join-card', onsubmit: function (e) {
      e.preventDefault();
      if (mode === 'join' && codeInput.value.length !== 4) { toast('Camp codes have 4 letters.', 'warn'); codeInput.focus(); return; }
      enter(mode, nameInput.value, mode === 'join' ? codeInput.value : '');
    } },
      tabs,
      h('label', { class: 'lbl', for: 'mc-name' }, 'Your name at camp'), nameInput,
      h('div', { class: 'code-row' }, h('label', { class: 'lbl', for: 'mc-code' }, 'Camp code'), codeInput),
      go,
      lastRoom && lastRoom === hashCode ? h('p', { class: 'fine' }, 'Back after a reload? Press Join camp: you keep your seat and your role.') : null,
      h('p', { class: 'fine' }, 'No account needed. Your browser will ask for your camera and microphone.'));
    setMode(mode);

    root.appendChild(h('div', { class: 'mc-app mc-home' },
      h('header', { class: 'home-top' },
        h('div', { class: 'brand' }, logo(), h('span', null, 'Mafia Camp')),
        h('button', { class: 'link', 'data-lk-open': 'overview', type: 'button' }, 'Privacy & Terms')),
      h('section', { class: 'hero' },
        h('div', { class: 'hero-copy' },
          h('p', { class: 'kicker' }, 'A video party game for 3 to 10 friends'),
          h('h1', null, 'Someone at camp is ', h('em', null, 'not'), ' who they seem.'),
          h('p', { class: 'lead' }, 'Everyone gets a secret role. At night the Mafia strike while the camp sleeps. By day you look each other in the eye, argue it out on video, and vote someone onto the bus home.'),
          form),
        h('div', { class: 'hero-art', 'aria-hidden': 'true' }, scene())),
      h('section', { class: 'how' },
        h('h2', null, 'How a game goes'),
        h('ol', { class: 'steps' },
          step('🔥', 'Gather', 'Start a camp and share its 4-letter code. Up to 10 people join a tiny-tile video call, straight from browser to browser.'),
          step('🌙', 'Night', 'Cameras and mics go dark. Only the Mafia see and hear each other while they pick a victim. The Nurse and the Ranger work in secret.'),
          step('☀️', 'Day', 'Wake up to the news. Talk, accuse, defend. Then everyone taps a tile to vote. Most votes is sent home.'))),
      h('section', { class: 'roles-intro' },
        h('h2', null, 'Who\'s at camp'),
        h('div', { class: 'role-grid' }, ['mafia', 'nurse', 'ranger', 'camper', 'prankster'].map(function (r) {
          var R = ROLES[r];
          return h('div', { class: 'role-mini ' + R.side },
            h('div', { class: 'role-ic' }, R.icon), h('h3', null, R.name), h('p', null, R.short));
        }))),
      h('section', { class: 'tips' },
        h('h2', null, 'Good to know'),
        h('ul', null,
          h('li', null, h('b', null, 'Headphones'), ' stop echo when ten people talk at once.'),
          h('li', null, h('b', null, '6 to 10 players'), ' is the sweet spot. 3 works for a quick try.'),
          h('li', null, h('b', null, 'Laptop or phone.'), ' Each person sends a small video to everyone, about 1.5 Mbps up for a full camp.'),
          h('li', null, h('b', null, 'Ghosts'), ' (players who are out) keep watching, and can whisper with other ghosts.'))),
      h('footer', { class: 'foot' },
        h('span', null, '© Arkvital'),
        h('a', { class: 'link', href: 'https://prepsto.com/#f/8ta2479', target: '_blank', rel: 'noopener', 'data-prepsto-open': 'open' }, 'Submit feedback'),
        h('button', { class: 'link', 'data-lk-open': 'overview', type: 'button' }, 'Privacy & Terms'))));
    if (!nameInput.value) setTimeout(function () { nameInput.focus(); }, 50);
  }
  function step(icon, title, text) {
    return h('li', { class: 'step' }, h('div', { class: 'step-ic' }, icon), h('h3', null, title), h('p', null, text));
  }
  function logo() {
    var d = h('span', { class: 'logo', 'aria-hidden': 'true' });
    d.innerHTML = LOGO_SVG;
    return d;
  }
  var LOGO_SVG = '<svg viewBox="0 0 64 64"><defs><linearGradient id="mcg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="64"><stop offset="0" stop-color="#1d2552"/><stop offset="1" stop-color="#3b2550"/></linearGradient></defs>' +
    '<rect width="64" height="64" rx="16" fill="url(#mcg)"/><circle cx="46" cy="17" r="8" fill="#ffe8a3"/><circle cx="50" cy="14" r="7" fill="url(#mcg)"/>' +
    '<circle cx="15" cy="13" r="1.4" fill="#fff" opacity=".8"/><circle cx="26" cy="9" r="1" fill="#fff" opacity=".6"/>' +
    '<path d="M32 22 L52 50 H12 Z" fill="#ff8a3d"/><path d="M32 22 L40 50 H24 Z" fill="#a8441a"/><path d="M32 33 L36 50 H28 Z" fill="#1d1430"/></svg>';
  function scene() {
    var d = h('div', { class: 'scene' });
    d.innerHTML = '<div class="moon"></div><div class="stars"></div>' +
      '<div class="tiles-demo">' + [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
        return '<span style="--c:' + SEAT_COLORS[i] + ';--d:' + (i * 0.37).toFixed(2) + 's"><i></i></span>';
      }).join('') + '</div>' +
      '<div class="fire"><span></span><span></span><span></span></div><div class="pines"></div>';
    return d;
  }

  // ------------------------------------------------------------------------------------------------ room screen
  function buildRoom() {
    var root = S.root;
    root.innerHTML = '';
    S.tiles.clear();
    root.appendChild(h('div', { class: 'mc-app mc-room' },
      h('header', { class: 'bar' },
        h('div', { class: 'brand small' }, logo(), h('span', { class: 'hide-sm' }, 'Mafia Camp')),
        h('button', { class: 'camp-code', type: 'button', title: 'Copy the invite link', onclick: copyInvite },
          h('span', { class: 'cc-l' }, 'Camp'), h('b', { class: 'cc-code' }, S.code), h('span', { class: 'cc-copy' }, '🔗')),
        h('div', { class: 'phase-chip' }, h('span', { class: 'ph-ic' }), h('span', { class: 'ph-label' }), h('span', { class: 'ph-timer' }))),
      h('main', { class: 'room-main' },
        h('section', { class: 'stage' }, h('div', { class: 'grid' })),
        h('aside', { class: 'side' }, h('div', { class: 'panel' }), h('div', { class: 'story' }))),
      h('nav', { class: 'dock' },
        h('button', { class: 'dock-btn mic', type: 'button', onclick: toggleMic }, h('span', { class: 'di' }), h('span', { class: 'dl' })),
        h('button', { class: 'dock-btn cam', type: 'button', onclick: toggleCam }, h('span', { class: 'di' }), h('span', { class: 'dl' })),
        h('button', { class: 'dock-btn story-btn', type: 'button', onclick: function () { S.storyOpen = !S.storyOpen; renderRoom(); } }, h('span', { class: 'di' }, '📜'), h('span', { class: 'dl' }, 'Story')),
        h('button', { class: 'dock-btn sound', type: 'button', onclick: toggleSound }, h('span', { class: 'di' }), h('span', { class: 'dl' }, 'Sounds')),
        h('button', { class: 'dock-btn leave', type: 'button', onclick: leave }, h('span', { class: 'di' }, '🚪'), h('span', { class: 'dl' }, 'Leave')))));
  }
  function copyInvite() {
    var url = location.origin + location.pathname + '#' + S.code;
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: 'Mafia Camp', text: 'Join my camp: code ' + S.code, url: url }).catch(function () { /* closed */ });
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      function () { toast('Invite link copied. Send it to your campers!'); },
      function () { prompt('Copy this invite link:', url); });
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
    if (store('sound') !== 'off') chime([523, 659]);
  }
  function renderDock() {
    var mic = $('.dock .mic'), cam = $('.dock .cam'), snd = $('.dock .sound'), st = $('.dock .story-btn');
    if (!mic) return;
    mic.classList.toggle('off', !S.mic);
    mic.querySelector('.di').textContent = S.mic ? '🎙️' : '🔇';
    mic.querySelector('.dl').textContent = S.mic ? 'Mic on' : 'Muted';
    cam.classList.toggle('off', !S.cam);
    cam.querySelector('.di').textContent = S.cam ? '📷' : '🚫';
    cam.querySelector('.dl').textContent = S.cam ? 'Camera' : 'Cam off';
    var quiet = store('sound') === 'off';
    snd.classList.toggle('off', quiet);
    snd.querySelector('.di').textContent = quiet ? '🔕' : '🔔';
    st.classList.toggle('on', S.storyOpen);
  }
  function tick() {
    var t = remaining();
    var el = $('.ph-timer');
    if (!el) return;
    el.textContent = t == null ? '' : clock(t);
    el.classList.toggle('hurry', t != null && t <= 10 && S.view && (S.view.phase === 'day' || S.view.phase === 'vote' || S.view.phase === 'night'));
    var bar = $('.panel .timebar i');
    if (bar && S.view && S.view.remaining != null) {
      var total = phaseTotal(S.view);
      bar.style.width = (total ? Math.max(0, Math.min(100, (t / total) * 100)) : 0) + '%';
    }
    if (t === 0 && S.view && S.view.remaining > 0 && Date.now() - S.viewAt > 2500) poll();
  }
  function phaseTotal(v) {
    var s = v.settings || {};
    return { roles: 12, dawn: 9, verdict: 9, night: s.night_seconds, day: s.day_seconds, vote: s.vote_seconds }[v.phase] || 0;
  }

  function renderRoom() {
    var v = S.view, room = $('.mc-room');
    if (!v || !room) return;
    var P = PHASES[v.phase] || PHASES.lobby;
    setSky(P.sky);
    room.setAttribute('data-phase', v.phase);
    room.classList.toggle('ghost-me', !!v.my.ghost);
    room.classList.toggle('story-open', S.storyOpen);
    $('.ph-ic').textContent = P.icon;
    $('.ph-label').textContent = v.phase === 'night' || v.phase === 'day' || v.phase === 'vote' ? P.label + ' ' + v.day : P.label;
    renderTiles();
    renderPanel();
    renderStory();
    renderDock();
    tick();
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
      h('button', { class: 'kick', type: 'button', title: 'Send this camper home', 'aria-label': 'Remove' }, '✕'));
    t = { el: el, video: video, src: null };
    el.querySelector('.pick').addEventListener('click', function () { onPick(p.pid); });
    el.querySelector('.kick').addEventListener('click', function () {
      if (confirm('Send ' + nameOf(p.pid) + ' home? They leave this camp.')) act('kick', { pid: p.pid });
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
    var v = S.view, grid = $('.grid');
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
    var c = p.peer_id && S.conns.get(p.peer_id);
    return c && c.stream;
  }
  function attachStreams() { renderTiles(); }
  function askForTap() {
    if (S.needsTap) return;
    S.needsTap = true;
    var b = h('button', { class: 'tap-sound btn primary', type: 'button', onclick: function () {
      audioCtx();
      S.tiles.forEach(function (t) { if (t.src) t.video.play().catch(function () { /* still blocked */ }); });
      b.remove(); S.needsTap = false;
    } }, '🔊 Tap to hear camp');
    document.body.appendChild(b);
  }

  // ---- panel
  function renderPanel() {
    var v = S.view, panel = $('.panel');
    if (!v || !panel) return;
    panel.innerHTML = '';
    var my = v.my, m = me(), isHost = v.host === v.me;
    var body = [];
    var role = my.role && ROLES[my.role];
    if (role && v.phase !== 'roles') {
      body.push(h('button', { class: 'role-pill ' + role.side, type: 'button', title: 'Hold to see your role' },
        h('span', { class: 'rp-l' }, 'Your role'), h('span', { class: 'rp-v' }, role.icon + ' ' + role.name)));
    }
    if (v.phase !== 'lobby' && v.phase !== 'over' && v.remaining != null) body.push(h('div', { class: 'timebar' }, h('i')));
    var phaseFn = PANEL[v.phase] || PANEL.lobby;
    body = body.concat(phaseFn(v, my, m, isHost));
    if (my.ghost && v.phase !== 'over') {
      body.push(h('div', { class: 'note ghost' }, my.spectator
        ? '👻 The game had already started, so you are watching this round as a ghost. You can see everyone\'s role and talk with other ghosts. The living can\'t hear you. You will play the next round.'
        : '👻 You are out, so you are a ghost now. You see every role, watch the Mafia at night and can talk with other ghosts. The living can\'t hear you.'));
    }
    if (isHost && ['roles', 'night', 'dawn', 'day', 'vote', 'verdict'].indexOf(v.phase) >= 0) {
      body.push(h('div', { class: 'host-row' }, h('button', { class: 'btn ghost-btn small', type: 'button', onclick: function () {
        if (confirm('Skip to the next phase now?')) act('skip');
      } }, '⏭ Skip ahead (host)')));
    }
    add(panel, body);
  }

  function title(text, sub) { return [h('h2', { class: 'p-title' }, text), sub ? h('p', { class: 'p-sub' }, sub) : null]; }

  var PANEL = {
    lobby: function (v, my, m, isHost) {
      var n = players().length, present = players().filter(function (p) { return !p.away; }).length;
      var out = title('Around the campfire', n + ' of ' + v.max_players + ' campers here');
      out.push(h('div', { class: 'invite' },
        h('div', { class: 'inv-code' }, v.code.split('').map(function (c) { return h('span', null, c); })),
        h('div', { class: 'inv-btns' },
          h('button', { class: 'btn primary', type: 'button', onclick: copyInvite }, '🔗 Invite link'),
          h('span', { class: 'fine' }, 'or tell friends the code'))));
      if (isHost) {
        var s = v.settings;
        out.push(h('div', { class: 'settings' },
          h('h3', null, 'Game settings'),
          chips('Talk time by day', 'day_seconds', [60, 90, 120, 180, 240, 300], s.day_seconds, function (x) { return x < 120 ? x + 's' : (x / 60) + ' min'; }),
          chips('Night', 'night_seconds', [25, 40, 60], s.night_seconds, function (x) { return x + 's'; }),
          chips('Voting', 'vote_seconds', [25, 35, 50], s.vote_seconds, function (x) { return x + 's'; }),
          toggle('Reveal roles when someone is out', 'reveal_roles', s.reveal_roles),
          toggle('Add the Prankster 🤡 (7+ players)', 'prankster', s.prankster)));
        var enough = present >= v.min_players;
        out.push(h('button', { class: 'btn primary big', type: 'button', disabled: !enough, onclick: function () { act('start'); } },
          enough ? '🔥 Start the game (' + present + ' campers)' : 'Waiting for campers (' + present + '/' + v.min_players + ')'));
        out.push(h('p', { class: 'fine' }, 'Best with 6 to 10. ' + mafiaCount(present) + ' Mafia for ' + present + ' players.'));
      } else {
        out.push(h('p', { class: 'note' }, '🔥 ' + nameOf(v.host) + ' (the host) starts the game when everyone is here. Meanwhile, check your tile: it glows when you talk.'));
      }
      out.push(rulesCard());
      return out;
    },
    roles: function (v, my) {
      if (!my.role) return title('The game is starting', 'Roles are being handed out. You are watching this round.');
      var R = ROLES[my.role];
      var team = (my.team || []).filter(function (pid) { return pid !== v.me; });
      return [
        h('div', { class: 'role-card ' + R.side },
          h('p', { class: 'rc-k' }, 'Your secret role'),
          h('div', { class: 'rc-ic' }, R.icon),
          h('h2', null, R.name),
          h('p', null, R.long),
          my.role === 'mafia' && team.length ? h('p', { class: 'rc-team' }, 'Your partners: ', h('b', null, team.map(nameOf).join(', '))) : null),
        h('p', { class: 'fine center' }, 'Keep a straight face. Night falls in a few seconds…'),
      ];
    },
    night: function (v, my) {
      var R = my.role && ROLES[my.role];
      if (!my.alive || my.ghost) {
        var team = my.team || [];
        return title('Night ' + v.day, 'The camp is asleep. You can watch the Mafia (' + team.map(nameOf).join(', ') + ') choose a victim.');
      }
      if (my.role === 'mafia') {
        var partners = (my.team || []).filter(function (pid) { return pid !== v.me && (byPid(pid) || {}).alive; });
        var picks = my.picks || {};
        var agree = (my.team || []).filter(function (pid) { return (byPid(pid) || {}).alive; }).map(function (pid) { return picks[pid]; });
        var same = agree.length && agree.every(function (x) { return x && x === agree[0]; });
        return title('🔪 Pick tonight\'s victim', partners.length
          ? 'Only your partners (' + partners.map(nameOf).join(', ') + ') can see and hear you now. Agree on one name and tap their tile.'
          : 'You are the last of the Mafia. Tap the camper you want gone.')
          .concat([h('p', { class: 'note ' + (same ? 'ok' : '') }, my.pick
            ? (same ? '✓ The Mafia agree: ' + nameOf(agree[0]) + '.' : 'You picked ' + nameOf(my.pick) + '. ' + (partners.length ? 'If you disagree, the most-picked name (or a coin flip) wins.' : ''))
            : 'No target yet. If nobody picks, nobody is attacked.')]);
      }
      if (my.role === 'nurse') {
        return title('🩹 Who needs protecting?', 'Tap a tile to keep that camper safe tonight. You can pick yourself.' + (my.nurse_last ? ' Not ' + nameOf(my.nurse_last) + ' again tonight.' : ''))
          .concat([h('p', { class: 'note' + (my.pick ? ' ok' : '') }, my.pick ? '✓ You are watching over ' + nameOf(my.pick) + '.' : 'Nobody protected yet.')]);
      }
      if (my.role === 'ranger') {
        return title('🔦 Shine your flashlight', 'Tap a tile to investigate. At dawn you will know if they are Mafia.')
          .concat([h('p', { class: 'note' + (my.pick ? ' ok' : '') }, my.pick ? '✓ Investigating ' + nameOf(my.pick) + '.' : 'Nobody checked yet.'), checksList(my)]);
      }
      return [
        h('div', { class: 'sleep' }, h('div', { class: 'zz' }, h('span', null, 'z'), h('span', null, 'z'), h('span', null, 'Z')),
          h('h2', { class: 'p-title' }, 'Night ' + v.day + ': you are asleep'),
          h('p', { class: 'p-sub' }, (R ? R.icon + ' ' : '') + 'Your camera and mic are off to everyone until morning. Something is moving in the woods…')),
      ];
    },
    dawn: function (v) {
      var r = v.result || {};
      return [h('div', { class: 'news ' + (r.pid ? 'bad' : 'good') },
        h('p', { class: 'news-k' }, '🌅 Morning, day ' + v.day),
        h('p', { class: 'news-t' }, r.text || 'The sun comes up over the lake.'))];
    },
    day: function (v, my) {
      var r = v.result || {};
      var alive = players().filter(function (p) { return p.alive && p.playing; }).length;
      var ready = players().filter(function (p) { return p.ready; }).length;
      var need = Math.floor(alive / 2) + 1;
      var out = title('☀️ Talk it out', 'Who is acting strange? Accuse, defend, bluff. Voting starts when the time is up or most of you are ready.');
      if (r.text) out.unshift(h('p', { class: 'news-mini' }, r.text));
      if (my.alive && !my.ghost) {
        out.push(h('button', { class: 'btn big ' + (my.ready ? 'on' : 'primary'), type: 'button', onclick: function () { act('ready', { ready: !my.ready }); } },
          my.ready ? '✋ Ready (tap to undo)' : '✋ Ready to vote'));
      }
      out.push(h('p', { class: 'fine' }, ready + ' of ' + need + ' needed to start voting early.'));
      if (my.role === 'ranger') out.push(checksList(my));
      return out;
    },
    vote: function (v, my) {
      var alive = players().filter(function (p) { return p.alive && p.playing; });
      var voted = alive.filter(function (p) { return p.vote; }).length;
      var out = title('🗳️ Vote someone out', my.alive && !my.ghost ? 'Tap a tile to vote. Change your mind any time before the bell. Most votes is sent home; a tie sends nobody.' : 'The living are voting.');
      if (my.alive && !my.ghost) {
        out.push(h('div', { class: 'vote-row' },
          h('button', { class: 'btn ' + (my.vote === 'skip' ? 'on' : ''), type: 'button', onclick: function () { act('vote', { target: my.vote === 'skip' ? null : 'skip' }); } },
            my.vote === 'skip' ? '✓ Skipping' : '🤷 Skip vote'),
          h('span', { class: 'fine' }, my.vote && my.vote !== 'skip' ? 'You voted for ' + nameOf(my.vote) + '.' : (my.vote ? '' : 'You haven\'t voted yet.'))));
      }
      out.push(h('p', { class: 'fine' }, voted + ' of ' + alive.length + ' have voted.'));
      out.push(tallyList(v));
      if (my.role === 'ranger') out.push(checksList(my));
      return out;
    },
    verdict: function (v) {
      var r = v.result || {};
      return [h('div', { class: 'news ' + (r.pid ? 'bad' : 'good') }, h('p', { class: 'news-k' }, '🚌 The verdict'), h('p', { class: 'news-t' }, r.text || '')), tallyList(v)];
    },
    over: function (v, my, m, isHost) {
      var win = v.winner;
      var mineWon = my.role && (win === 'prankster' ? my.role === 'prankster' : (win === 'mafia' ? my.role === 'mafia' : (ROLES[my.role].side === 'town')));
      var headline = { town: '🏕️ The Campers win!', mafia: '🔪 The Mafia win!', prankster: '🤡 The Prankster wins!' }[win] || 'Game over';
      var list = players().filter(function (p) { return p.playing; });
      var out = [h('div', { class: 'over ' + (win || '') },
        h('h2', null, headline),
        my.role ? h('p', { class: 'over-you' }, mineWon ? 'That includes you. Well played! 🎉' : 'Not your side this time.') : null,
        h('ul', { class: 'reveal' }, list.map(function (p) {
          var R = p.role && ROLES[p.role];
          return h('li', { class: p.alive ? '' : 'out', style: '--seat:' + color(p) }, h('span', { class: 'rv-n' }, p.name), h('span', { class: 'rv-r' }, R ? R.icon + ' ' + R.name : '?'), p.alive ? null : h('span', { class: 'rv-x' }, 'out'));
        })))];
      if (isHost) out.push(h('button', { class: 'btn primary big', type: 'button', onclick: function () { act('again'); } }, '🔥 Back to the campfire (play again)'));
      else out.push(h('p', { class: 'note' }, nameOf(v.host) + ' can start another round.'));
      if (mineWon) confetti();
      return out;
    },
  };
  function mafiaCount(n) { return n <= 5 ? 1 : (n <= 9 ? 2 : 3); }
  function chips(label, key, values, current, fmt) {
    return h('div', { class: 'set-row' }, h('span', { class: 'set-l' }, label),
      h('div', { class: 'chips' }, values.map(function (x) {
        return h('button', { class: 'chip' + (x === current ? ' on' : ''), type: 'button', onclick: function () { var p = {}; p[key] = x; act('settings', p); } }, fmt(x));
      })));
  }
  function toggle(label, key, on) {
    return h('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
      onclick: function () { var p = {}; p[key] = !on; act('settings', p); } }, h('i'), h('span', null, label));
  }
  function checksList(my) {
    var c = my.checks || [];
    if (!c.length) return null;
    return h('div', { class: 'checks' }, h('h3', null, '🔦 Your notebook'), h('ul', null, c.map(function (x) {
      return h('li', null, 'Night ' + x.day + ': ', h('b', null, nameOf(x.pid)), x.mafia ? ' is Mafia!' : ' is innocent.');
    })));
  }
  function tallyList(v) {
    var counts = {}, by = {};
    players().forEach(function (p) {
      if (!p.vote) return;
      counts[p.vote] = (counts[p.vote] || 0) + 1;
      (by[p.vote] = by[p.vote] || []).push(p.name);
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!keys.length) return null;
    return h('ul', { class: 'tally' }, keys.map(function (k) {
      return h('li', null, h('b', null, k === 'skip' ? '🤷 Skip' : nameOf(k)), h('span', { class: 'tl-n' }, String(counts[k])), h('span', { class: 'tl-by' }, by[k].join(', ')));
    }));
  }
  function rulesCard() {
    return h('details', { class: 'rules' }, h('summary', null, 'How to play'),
      h('ul', null,
        h('li', null, '🎭 Everyone gets a secret role. The Mafia know each other.'),
        h('li', null, '🌙 Night: cameras and mics go dark. The Mafia pick a victim, the Nurse protects someone, the Ranger investigates someone.'),
        h('li', null, '🌅 Dawn: find out who was attacked.'),
        h('li', null, '☀️ Day: talk on video, then tap a tile to vote. Most votes is sent home. A tie sends nobody.'),
        h('li', null, '🏁 The Campers win when all the Mafia are gone. The Mafia win when they are as many as everyone else.')),
      h('div', { class: 'role-list' }, Object.keys(ROLES).map(function (r) {
        return h('p', null, h('b', null, ROLES[r].icon + ' ' + ROLES[r].name + ': '), ROLES[r].short);
      })));
  }

  // ---- story (the game log)
  function renderStory() {
    var v = S.view, box = $('.story');
    if (!v || !box) return;
    var ev = v.events || [];
    box.innerHTML = '';
    if (!ev.length) { box.appendChild(h('p', { class: 'fine' }, 'The story of this game will appear here.')); return; }
    box.appendChild(h('h3', null, '📜 The story so far'));
    box.appendChild(h('ol', null, ev.slice().reverse().map(function (e) {
      return h('li', { class: 'ev ev-' + e.kind }, h('span', { class: 'ev-d' }, e.day ? 'Day ' + e.day : 'Start'), h('span', null, e.text));
    })));
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

  // ------------------------------------------------------------------------------------------------ mount
  MC.mount = function (node, bridge) {
    S.bridge = bridge;
    S.root = node.querySelector('.mc-mount') || node;
    S.token = store('token') || makeToken();
    store('token', S.token);
    renderHome();
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var f = function () { if (!S.code) homeSky(); };
      if (mq.addEventListener) mq.addEventListener('change', f); else if (mq.addListener) mq.addListener(f);
    }
    window.addEventListener('hashchange', function () { if (!S.code && codeFromHash()) renderHome(); });
    window.addEventListener('beforeunload', function () { if (S.peer) { try { S.peer.destroy(); } catch (e) { /* fine */ } } });
  };
})();
