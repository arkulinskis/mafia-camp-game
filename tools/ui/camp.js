/* Test helpers for a camp, put into flow.js / phone.js / a11y.js / design.js / seed.js by tools/ui_test.py where they
   say CAMP in a comment marker. One browser tab is the host (the real UI, fake camera + mic); two "test campers" join
   through the same server bridge with their own player keys and poll like a browser would (no video: no PeerJS id).

   window.__camp.start(name)        on the home page: type the name, press Start a camp, wait for the Room page
   window.__camp.addBots(n)         n test campers join the camp and keep polling (so they count as present)
   window.__camp.go(phase)          the host presses Skip ahead (and confirms) until the camp is in that phase
   window.__camp.vote(pid)          every living test camper votes for pid
   window.__camp.roles()            {pid: role} from everyone's own view (test knowledge, not the host's)
   window.__camp.phase(), view()    the host's current view
   window.__camp.stop()             the test campers stop polling */
window.__camp = window.__camp || (function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => window.MafiaCamp._S;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  }
  function type(input, value) {
    input.focus(); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function raw(action, payload) {
    const r = JSON.parse(await S().bridge(action, JSON.stringify(payload)));
    if (!r.ok) throw new Error(action + ': ' + r.error);
    return r.data;
  }
  const bots = [];
  let timer = null;
  const NAMES = ['Ben', 'Cy', 'Dee', 'Eve'];
  async function start(name) {
    await until(() => window.UI_READY && $('.join-card'), 'the home page', 60000);
    const create = $$('.tabs button')[0]; if (!create.classList.contains('on')) create.click();
    type($('.join-card input'), name || 'Ana');
    $('.join-card .anvil-role-big button').click();
    await until(() => S().code && $('.mc-room') && window.UI_READY && $('.p-lobby'), 'the camp', 60000);
    return S().code;
  }
  async function pollBots() {
    for (const b of bots) { try { b.view = await raw('state', { token: b.token, code: S().code, peer_id: '', media: '' }); } catch (e) { /* left */ } }
  }
  async function addBots(n) {
    for (let i = 0; i < n; i++) {
      const token = 'test-camper-' + i + '-' + Math.random().toString(36).slice(2, 12);
      const v = await raw('join', { token: token, code: S().code, name: NAMES[i] });
      bots.push({ token: token, pid: v.me, name: NAMES[i], view: v });
    }
    clearInterval(timer);
    timer = setInterval(pollBots, 2000);
    await until(() => (S().view.players || []).length === 1 + bots.length, 'the test campers on the host view', 20000);
  }
  function view() { return S().view; }
  function phase() { return S().view && S().view.phase; }
  async function confirmDialog() {
    const btn = await until(() => $$('.anvil-modal-footer button').filter(vis).pop(), 'the confirm dialog');
    btn.click();
    await until(() => !$$('.modal.in, .anvil-modal').some((m) => vis(m) && m.querySelector('.anvil-modal-footer button')) || true, 'dialog closed');
    await sleep(300);
  }
  async function go(target) {
    for (let k = 0; k < 12 && phase() !== target; k++) {
      const before = phase() + '|' + view().day;
      const skip = await until(() => $$('.host-row button').find(vis), 'Skip ahead (host) in ' + phase());
      skip.click();
      await confirmDialog();
      await until(() => phase() + '|' + view().day !== before, 'the next phase after ' + before, 20000);
      await sleep(400);
    }
    if (phase() !== target) throw new Error('could not reach ' + target + ' (at ' + phase() + ')');
  }
  function roles() {
    const out = {};
    const host = view();
    if (host.my.role) out[host.me] = host.my.role;
    for (const b of bots) if (b.view && b.view.my && b.view.my.role) out[b.pid] = b.view.my.role;
    return out;
  }
  async function vote(pid) {
    for (const b of bots) { if (b.pid !== pid) { try { await raw('vote', { token: b.token, code: S().code, target: pid }); } catch (e) { /* ghost */ } } }
  }
  function stop() { clearInterval(timer); timer = null; bots.length = 0; }
  return { start, addBots, go, vote, roles, view, phase, stop, bots, until, type, sleep, raw, refresh: pollBots };
})();
