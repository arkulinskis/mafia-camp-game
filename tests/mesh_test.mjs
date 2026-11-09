// Real multi-player call test for the Anvil handshake: N headless Chrome tabs (fake camera + mic), one harness port each.
// node tests/mesh_test.mjs <outdir>     env N=4 (players), BASE=8841, PLAY=1 (start a game and check night routing)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const N = +(process.env.N || 4);
const BASE = +(process.env.BASE || 8841);
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.resolve(OUT, 'profile')}`,
  '--window-size=1280,900', '--no-first-run', '--disable-extensions',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'], { stdio: 'ignore' });
const log = [];
const say = s => { log.push(s); console.log(s); };

class Page {
  constructor(i, ws) { this.i = i; this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }
  static async open(i) {
    let t;
    for (let k = 0; k < 100 && !t; k++) {
      try { t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch (e) { await sleep(200); }
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    const p = new Page(i, ws);
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { const q = p.pending.get(m.id); p.pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; p.errors.push(d.exception?.description || d.text); say(`[p${i} EXCEPTION] ${d.exception?.description || d.text}`); }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        const text = m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ');
        say(`[p${i} console.${m.params.type}] ${text.slice(0, 300)}`);
      }
    });
    await p.send('Runtime.enable'); await p.send('Page.enable');
    return p;
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EVAL ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async go(url) { await this.send('Page.navigate', { url }); await sleep(1200); }
  async waitFor(expr, ms = 20000, label = expr) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await this.eval(`!!(${expr})`) === true) return true; await sleep(300); }
    say(`[p${this.i}] TIMEOUT waiting for ${label}`); return false;
  }
  async shot(name, opts = {}) {
    if (opts.phone) await this.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    if (opts.scheme) await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.scheme }] });
    await sleep(opts.wait || 500);
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!opts.full });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    if (opts.phone) await this.send('Emulation.clearDeviceMetricsOverride');
    say(`[shot] ${name}`);
  }
}

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Finn', 'Gus', 'Hal', 'Ivy', 'Jo'];
const S = 'window.MafiaCamp._S';
const up = `(() => { let n = 0; ${S}.conns.forEach(c => { if (c.up) n++; }); return n; })()`;
const sending = `(() => { let n = 0; ${S}.conns.forEach(c => { if (c.pc.getSenders().some(s => s.track)) n++; }); return n; })()`;
const framesIn = `[...document.querySelectorAll('.tile video')].filter(v => !v.muted && v.videoWidth > 0).length`;
const phase = `(${S}.view && ${S}.view.phase)`;
async function debug() { return (await (await fetch(`http://127.0.0.1:${BASE}/debug`)).json()); }
async function allUp(pages, label, ms = 30000) {
  const t0 = Date.now(), want = pages.length - 1;
  while (Date.now() - t0 < ms) {
    const counts = []; for (const p of pages) counts.push(await p.eval(up));
    if (counts.every(c => c === want)) { say(`${label}: all ${pages.length} connected to ${want} others in ${((Date.now() - t0) / 1000).toFixed(1)} s`); return true; }
    await sleep(500);
  }
  const counts = []; for (const p of pages) counts.push(await p.eval(up));
  say(`${label}: FAIL connected counts ${JSON.stringify(counts)} (want ${want})`); return false;
}
let ok = true;
try {
  for (let k = 0; k < 100; k++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { await sleep(200); } }
  const pages = [];
  for (let i = 0; i < N; i++) { pages.push(await Page.open(i)); await pages[i].go(`http://127.0.0.1:${BASE + i}/`); }
  const t0 = Date.now();
  await pages[0].eval(`MafiaCamp.enter('create', 'Ana', '').then(String)`);
  const code = await pages[0].eval(`${S}.code`);
  say('camp ' + code);
  for (let i = 1; i < N; i++) say(`p${i} join: ` + await pages[i].eval(`MafiaCamp.enter('join', '${NAMES[i]}', '${code}').then(String)`));
  ok = await allUp(pages, 'lobby') && ok;
  say(`(from first join: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  await sleep(2500);
  for (const p of pages) { const f = await p.eval(framesIn); if (f !== N - 1) { ok = false; say(`p${p.i} FAIL video frames from ${f} of ${N - 1}`); } }
  say('video frames: checked on every tab');
  await pages[0].shot('lobby');

  // one player reloads: everyone must reconnect to the new visit
  const r = N - 1;
  await pages[r].go(`http://127.0.0.1:${BASE + r}/`);
  const t1 = Date.now();
  await pages[r].eval(`MafiaCamp.enter('join', '${NAMES[r]}', '${code}').then(String)`);
  ok = await allUp(pages, 'after a reload') && ok;

  if (process.env.PLAY) {
    await pages[0].eval(`MafiaCamp.act('start', '{}')`);
    if (!await pages[0].waitFor(`${phase} === 'night'`, 30000)) ok = false;
    await sleep(3000);
    const roles = (await debug()).rooms.find(x => x.code === code).roles;
    for (const p of pages) {
      const mePid = await p.eval(`${S}.view.me`);
      const mafia = Object.keys(roles).filter(k => roles[k] === 'mafia');
      const want = roles[mePid] === 'mafia' ? mafia.length - 1 : 0;
      const got = await p.eval(sending);
      say(`night p${p.i} (${roles[mePid]}): sending to ${got}, expected ${want}`);
      if (got !== want) ok = false;
    }
    await pages[0].shot('night');
  }
  const dbg = await debug();
  say('notes left undelivered on the server: ' + dbg.signals_waiting);
  for (const p of pages) if (p.errors.length) { ok = false; say(`p${p.i} errors: ${p.errors.join(' | ')}`); }
  say(ok ? 'MESH OK' : 'MESH FAILED');
} finally { chrome.kill(); fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n')); }
