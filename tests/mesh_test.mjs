// Real multi-player test: N headless Chrome tabs (fake camera + mic), each on its own harness port = own player.
// node mesh_test.mjs <outdir>     env N=4 (players), BASE=8841, PLAY=1 (play a whole game), LIGHT=1
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
const sendingCount = `(() => { let n = 0; ${S}.conns.forEach(c => { const pc = c.call.peerConnection; if (pc && pc.getSenders().some(s => s.track)) n++; }); return n; })()`;
const streams = `(() => { let n = 0; ${S}.conns.forEach(c => { if (c.stream) n++; }); return n; })()`;
const framesIn = `[...document.querySelectorAll('.tile:not(.me) video')].filter(v => v.videoWidth > 0).length`;
const phase = `(${S}.view && ${S}.view.phase)`;
async function debug() { return (await (await fetch(`http://127.0.0.1:${BASE}/debug`)).json()); }

try {
  for (let k = 0; k < 100; k++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { await sleep(200); } }
  const pages = [];
  for (let i = 0; i < N; i++) pages.push(await Page.open(i));
  // home page shots (dark + light, desktop + phone) from page 0 before joining
  await pages[0].go(`http://127.0.0.1:${BASE}/`);
  await pages[0].shot('home-dark', { scheme: 'dark', full: true, wait: 1500 });
  await pages[0].shot('home-light', { scheme: 'light', full: true });
  await pages[0].shot('home-phone-dark', { scheme: 'dark', phone: true, full: true });
  await pages[0].shot('home-phone-light', { scheme: 'light', phone: true, full: true });
  await pages[0].send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  // host creates the camp
  await pages[0].eval(`document.getElementById('mc-name').value = 'Ana'; document.querySelector('.join-go').click(); 1`);
  await pages[0].waitFor(`${S}.code`, 20000);
  const code = await pages[0].eval(`${S}.code`);
  say('camp code ' + code);
  for (let i = 1; i < N; i++) {
    await pages[i].go(`http://127.0.0.1:${BASE + i}/#${code}`);
    await pages[i].eval(`document.getElementById('mc-name').value = '${NAMES[i]}'; document.querySelector('.join-go').click(); 1`);
  }
  const t0 = Date.now();
  for (const p of pages) await p.waitFor(`${streams} === ${N - 1}`, 90000, 'all streams');
  say(`mesh: all ${N} players connected to ${N - 1} others in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(2500);
  for (const p of pages) say(`p${p.i}: streams=${await p.eval(streams)} frames=${await p.eval(framesIn)} sending=${await p.eval(sendingCount)}`);
  // outgoing bitrate on page 0
  const rate = await pages[0].eval(`(async () => {
    async function sent() { let b = 0; for (const c of ${S}.conns.values()) { const st = await c.call.peerConnection.getStats(); st.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') b += r.bytesSent; }); } return b; }
    const a = await sent(); await new Promise(r => setTimeout(r, 4000)); const b = await sent();
    let w = 0, h = 0, fps = 0; for (const c of ${S}.conns.values()) { const st = await c.call.peerConnection.getStats(); st.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') { w = r.frameWidth; h = r.frameHeight; fps = r.framesPerSecond; } }); }
    return { kbpsTotal: Math.round((b - a) * 8 / 4 / 1000), perPeer: Math.round((b - a) * 8 / 4 / 1000 / ${S}.conns.size), w, h, fps };
  })()`);
  say('outgoing video from p0: ' + JSON.stringify(rate));
  await pages[0].shot('lobby-desktop');
  await pages[1].shot('lobby-phone', { phone: true, full: true });

  if (process.env.PLAY) {
    await pages[0].eval(`[...document.querySelectorAll('.panel button')].find(b => b.textContent.includes('Start the game')).click(); 1`);
    await pages[0].waitFor(`${phase} === 'roles'`, 10000);
    const room = (await debug()).find(r => r.code === code);
    const pidOf = {};
    for (const p of pages) pidOf[p.i] = await p.eval(`${S}.view.me`);
    const roleOf = i => room.roles[pidOf[i]];
    say('roles: ' + pages.map(p => NAMES[p.i] + '=' + roleOf(p.i)).join(', '));
    const mafiaI = pages.map(p => p.i).filter(i => roleOf(i) === 'mafia');
    const nurseI = pages.map(p => p.i).find(i => roleOf(i) === 'nurse');
    const townI = pages.map(p => p.i).filter(i => roleOf(i) !== 'mafia');
    await pages[mafiaI[0]].waitFor(`${phase} === 'roles'`, 8000); await pages[townI[0]].waitFor(`${phase} === 'roles'`, 8000);
    await pages[mafiaI[0]].shot('roles-mafia-phone', { phone: true, full: true });
    await pages[townI[0]].shot('roles-town-desktop');
    await pages[0].waitFor(`${phase} === 'night'`, 15000);
    await sleep(1500);
    for (const p of pages) say(`night p${p.i} (${roleOf(p.i)}): sending to ${await p.eval(sendingCount)} (expect ${roleOf(p.i) === 'mafia' ? mafiaI.length - 1 : 0}), asleep tiles=${await p.eval(`document.querySelectorAll('.tile.asleep').length`)}`);
    // mafia attack the first non-nurse town player; the nurse protects herself
    const victim = townI.find(i => i !== nurseI && i !== 0) ?? townI.find(i => i !== nurseI);
    for (const m of mafiaI) await pages[m].eval(`document.querySelector('.tile[data-pid="${pidOf[victim]}"] .pick').click(); 1`);
    if (nurseI !== undefined) await pages[nurseI].eval(`document.querySelector('.tile[data-pid="${pidOf[nurseI]}"] .pick').click(); 1`);
    await sleep(1200);
    await pages[mafiaI[0]].shot('night-mafia-desktop');
    await pages[townI[0]].shot('night-town-phone', { phone: true, full: true });
    await pages[0].waitFor(`${phase} === 'dawn'`, 15000);
    await sleep(800);
    await pages[0].shot('dawn-desktop');
    await pages[0].waitFor(`${phase} === 'day'`, 10000);
    await sleep(1500);
    for (const p of pages) say(`day p${p.i} (${roleOf(p.i)}${p.i === victim ? ', dead' : ''}): sending to ${await p.eval(sendingCount)} (expect ${p.i === victim ? 0 : N - 1})`);
    await pages[0].shot('day-desktop');
    await pages[victim].shot('day-ghost-phone', { phone: true, full: true });
    // everyone alive presses ready
    for (const p of pages) if (p.i !== victim) await p.eval(`(() => { const b = [...document.querySelectorAll('.panel button')].find(b => b.textContent.includes('Ready to vote')); if (b) b.click(); return 1; })()`);
    await pages[0].waitFor(`${phase} === 'vote'`, 15000);
    // everyone alive votes for the (first) mafia; the mafia votes for player 0 or 1
    for (const p of pages) {
      if (p.i === victim) continue;
      const target = p.i === mafiaI[0] ? townI.find(i => i !== victim) : mafiaI[0];
      await p.eval(`document.querySelector('.tile[data-pid="${pidOf[target]}"] .pick').click(); 1`);
      await sleep(250);
    }
    await sleep(1200);
    await pages[0].shot('vote-desktop');
    await pages[1].shot('vote-phone', { phone: true, full: true });
    await pages[0].waitFor(`${phase} === 'verdict'`, 15000);
    await sleep(800);
    await pages[0].shot('verdict-desktop');
    await pages[0].waitFor(`${phase} === 'over' || ${phase} === 'night'`, 15000);
    await sleep(1500);
    say('after verdict: ' + await pages[0].eval(phase) + ' winner=' + await pages[0].eval(`${S}.view.winner`));
    await pages[0].shot('after-verdict-desktop');
    await pages[townI[0]].shot('after-verdict-phone', { phone: true, full: true });
    for (const p of pages) say(`end p${p.i}: sending to ${await p.eval(sendingCount)}`);
  }
  const errs = pages.reduce((n, p) => n + p.errors.length, 0);
  say(`page exceptions: ${errs}`);
} catch (e) {
  say('FAILED ' + (e.stack || e));
} finally {
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));
  chrome.kill();
  process.exit(0);
}
