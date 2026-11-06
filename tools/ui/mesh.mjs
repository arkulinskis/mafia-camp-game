// The real call test: N headless Chrome tabs (fake camera + mic) in the local Anvil App Server, each its own player
// (?mcp=<i> gives each tab its own player key), join one camp through the real PeerJS cloud and play a game with the
// host skipping ahead. Checks who SENDS video to whom in every phase (the night privacy rule) and saves screenshots.
//   node tools/ui/mesh.mjs <app url> <outdir>      env N=3 (players, 3-10)      (ui_test.py --mesh runs it)
// Needs the internet (PeerJS signalling + STUN). Prints MESH PASSED or MESH FAILED.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.argv[2];
const OUT = process.argv[3];
const N = +(process.env.N || 3);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.resolve(OUT, 'profile')}`,
  '--window-size=1280,900', '--no-first-run', '--disable-extensions',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'], { stdio: 'ignore' });
const log = [];
const problems = [];
const say = (s) => { log.push(s); console.log(s); };
const check = (cond, msg) => { say((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) problems.push(msg); };

class Page {
  constructor(i, ws) { this.i = i; this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(i) {
    let t;
    for (let k = 0; k < 100 && !t; k++) {
      try { t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch (e) { await sleep(200); }
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const p = new Page(i, ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { const q = p.pending.get(m.id); p.pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; say(`[p${i} EXCEPTION] ${d.exception?.description || d.text}`); problems.push('exception'); }
    });
    await p.send('Runtime.enable'); await p.send('Page.enable'); await p.send('Network.enable');
    await p.send('Network.setBypassServiceWorker', { bypass: true });
    return p;
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EVAL ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async go(url) { await this.send('Page.navigate', { url }); }
  async waitFor(expr, ms = 30000, label = expr) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await this.eval(`!!(${expr})`) === true) return true; await sleep(300); }
    say(`[p${this.i}] TIMEOUT waiting for ${label}`); problems.push('timeout: ' + label); return false;
  }
  async shot(name, phone) {
    if (phone) await this.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    if (phone) await this.send('Emulation.clearDeviceMetricsOverride');
  }
}

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Finn', 'Gus', 'Hal', 'Ivy', 'Jo'];
const S = 'window.MafiaCamp._S';
const sending = `(() => { let n = 0; ${S}.conns.forEach(c => { const pc = c.call.peerConnection; if (pc && pc.getSenders().some(s => s.track)) n++; }); return n; })()`;
const streams = `(() => { let n = 0; ${S}.conns.forEach(c => { if (c.stream) n++; }); return n; })()`;
const frames = `[...document.querySelectorAll('.tile:not(.me) video')].filter(v => v.videoWidth > 0).length`;
const phase = `(${S}.view && ${S}.view.phase)`;
const join = (name) => `(() => { const i = document.querySelector('.join-card input'); i.value = ${JSON.stringify(name)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('.join-card .anvil-role-big button').click(); return 1; })()`;
const skip = `(async () => { const b = [...document.querySelectorAll('.host-row button')].find(x => x.offsetParent); if (!b) return 'no skip';
  b.click(); for (let k = 0; k < 40; k++) { const y = [...document.querySelectorAll('.anvil-modal-footer button')].filter(x => x.offsetParent).pop(); if (y) { y.click(); return 'ok'; } await new Promise(r => setTimeout(r, 150)); } return 'no dialog'; })()`;

try {
  for (let k = 0; k < 100; k++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { await sleep(200); } }
  const pages = [];
  for (let i = 0; i < N; i++) pages.push(await Page.open(i));
  await pages[0].go(`${URL}/?mcp=0#home`);
  await pages[0].waitFor(`window.UI_READY && document.querySelector('.join-card')`, 90000, 'home');
  await pages[0].eval(join(NAMES[0]));
  await pages[0].waitFor(`${S}.code && document.querySelector('.p-lobby')`, 60000, 'camp');
  const code = await pages[0].eval(`${S}.code`);
  say('camp ' + code);
  for (let i = 1; i < N; i++) {
    await pages[i].go(`${URL}/?mcp=${i}#${code}`);
    await pages[i].waitFor(`window.UI_READY && document.querySelector('.join-card')`, 90000, 'home p' + i);
    await pages[i].eval(join(NAMES[i]));
  }
  const t0 = Date.now();
  for (const p of pages) await p.waitFor(`${streams} === ${N - 1}`, 120000, `p${p.i}: all streams`);
  say(`mesh: ${N} players connected to ${N - 1} others in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(2500);
  for (const p of pages) check(await p.eval(frames) === N - 1 && await p.eval(sending) === N - 1, `lobby p${p.i}: sees ${N - 1} videos, sends to ${N - 1}`);
  await pages[0].shot('lobby-desktop');
  await pages[1].shot('lobby-phone', true);

  await pages[0].eval(`[...document.querySelectorAll('.p-lobby button')].find(b => /Start the game/.test(b.textContent)).click(), 1`);
  await pages[0].waitFor(`${phase} === 'roles'`, 20000, 'roles');
  for (const p of pages) await p.waitFor(`${phase} === 'roles' && ${S}.view.my.role`, 20000, `p${p.i} role`);
  const roles = {};
  for (const p of pages) roles[p.i] = await p.eval(`${S}.view.my.role`);
  say('roles: ' + JSON.stringify(roles));
  await pages[0].shot('roles');
  const mafia = Object.keys(roles).filter((i) => roles[i] === 'mafia').map(Number);
  for (const target of ['night', 'dawn', 'day', 'vote']) {
    for (let k = 0; k < 6 && await pages[0].eval(phase) !== target; k++) {
      await pages[0].eval(skip);
      await sleep(2500);
    }
    for (const p of pages) await p.waitFor(`${phase} === '${target}'`, 20000, `p${p.i} ${target}`);
    await sleep(2500);  // every browser re-routes on its next poll
    for (const p of pages) {
      const n = await p.eval(sending);
      const want = target === 'night' ? (roles[p.i] === 'mafia' ? mafia.length - 1 : 0) : N - 1;
      check(n === want, `${target} p${p.i} (${roles[p.i]}): sends to ${n} (expect ${want})`);
    }
    if (target === 'night') { await pages[0].shot('night'); await pages[1].shot('night-phone', true); }
    if (target === 'day') await pages[0].shot('day');
  }
  await pages[0].shot('vote');
  say(problems.length ? 'MESH FAILED: ' + problems.join(' | ') : 'MESH PASSED');
} catch (e) {
  say('MESH FAILED: ' + (e && e.stack || e));
}
fs.writeFileSync(path.join(OUT, 'mesh-log.txt'), log.join('\n'));
chrome.kill();
process.exit(0);
