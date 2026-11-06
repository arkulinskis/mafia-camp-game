/* Accessibility check (WCAG 2.2 A + AA), run inside the real app by tools/ui_test.py through tools/live/drive.mjs.
   1. axe-core (APP_MAKER/vendor/axe-core, injected by ui_test.py): the home page and an invite link in light and dark,
      then the camp in every phase (the sky follows the phase there, not light / dark) and the confirm dialog.
      A "serious" or "critical" WCAG problem fails the run; smaller ones and best-practice hints are notes.
   2. Keyboard and screen-reader checks: Start / Join say which one is on, the fields have names and autocomplete,
      the settings chips and switches say their state, the dock toggles too, and Privacy & Terms keeps Tab inside.
   Resolves to {ok, log}. Keep log lines ASCII (the Windows console). */
(async function () {
  /*AXE*/
  /*CAMP*/
  const C = window.__camp;
  const PUBLIC = ['#home', '#QWER'];
  const log = [], bad = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = C.until;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
  const ascii = (s) => String(s).normalize('NFD').replace(/[^\x20-\x7e]/g, '');
  const ok = (cond, msg) => { if (cond) log.push('ok   ' + msg); else { bad.push(msg); log.push('FAIL ' + msg); } };
  async function page(hash, ready) {
    if (location.hash !== hash) window.UI_READY = false;
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && (!ready || ready()), hash, 60000);
    await sleep(900);
  }
  if (!window.axe) { const s = document.createElement('script'); s.textContent = window.__AXE_SRC; document.head.appendChild(s); }

  async function scan(hash, ready) {
    await page(hash, ready);
    for (const theme of ['light', 'dark']) { window.UI.setTheme(theme); await sleep(1100); await axeRun(hash + ' ' + theme); }
    window.UI.setTheme('auto');
  }
  async function axeRun(where) {
    const res = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    let serious = 0;
    for (const v of res.violations) {
      const wcag = v.tags.some((t) => /^wcag2/.test(t));
      const fail = wcag && (v.impact === 'serious' || v.impact === 'critical');
      const at = v.nodes.slice(0, 2).map((n) => ascii(n.target.join(' ')).slice(0, 70)).join(' | ');
      log.push((fail ? 'FAIL ' : 'note ') + where + ' ' + v.id + ' (' + v.impact + ', ' + v.nodes.length + 'x): ' + at);
      if (fail) {
        serious++; bad.push(where + ' ' + v.id);
        for (const n of v.nodes.slice(0, 3)) log.push('       ' + ascii(n.html).replace(/\s+/g, ' ').slice(0, 150) + ' :: ' + ascii((n.failureSummary || '').split(/\n/).slice(1).join(' ')).slice(0, 150));
      }
    }
    if (!serious) log.push('ok   ' + where + ': no serious WCAG problems (' + res.passes.length + ' rules pass)');
  }

  try {
    // ---------------------------------------------------------------- the home page
    await page('#home', () => $('.join-card'));
    ok($$('h1').length === 1, 'home: one main heading');
    const tabs = $$('.tabs button');
    ok(tabs.length === 2 && tabs[0].getAttribute('aria-pressed') === 'true' && tabs[1].getAttribute('aria-pressed') === 'false',
      'home: Start a camp / Join with a code say which one is chosen (aria-pressed)');
    ok(!$('[role=tablist]'), 'home: no half-built tab list');
    const name = $('.join-card input');
    ok(name.autocomplete === 'nickname' && name.closest('label'), 'home: the name field has a label and autocomplete');
    const lk = $$('[data-lk-open]').find(vis);
    if (lk) {
      lk.click();
      await until(() => window.LegalKit && window.LegalKit.isOpen(), 'the Privacy page');
      const behind = Array.from(document.body.children).filter((e) => e.id !== 'lk-root' && e.tagName !== 'SCRIPT');
      if (behind.length && behind.every((e) => e.inert)) log.push('ok   privacy page: the app behind it is inert (Tab stays inside)');
      else log.push('note privacy page: this legal-kit build predates "inert" behind the page (shared kit: rebuild + install it for mafiacamp)');
      window.LegalKit.close();
      ok(Array.from(document.body.children).every((e) => !e.inert), 'privacy page: closing it gives the app back');
    }
    for (const h of PUBLIC) await scan(h);

    // ---------------------------------------------------------------- the camp
    await page('#home', () => $('.join-card'));
    await C.start('Access');
    await sleep(900);
    ok($$('.p-lobby .anvil-role-chip button').every((b) => /^(true|false)$/.test(b.getAttribute('aria-pressed'))), 'lobby: setting chips say whether they are chosen');
    ok($$('.p-lobby .switch').every((s) => s.getAttribute('role') === 'switch' && /^(true|false)$/.test(s.getAttribute('aria-checked'))), 'lobby: switches are switches with a state');
    ok($('.dock .mic').getAttribute('aria-pressed') && $('.dock .sound').getAttribute('aria-pressed') && $('.dock .story-btn').getAttribute('aria-expanded'), 'dock: toggles say their state');
    // keyboard: after choosing a chip the focus stays on it while the list redraws
    const chip = $$('.p-lobby .anvil-role-chip button').find((b) => b.getAttribute('aria-pressed') === 'false');
    chip.focus(); const key = chip.getAttribute('data-key'); chip.click();
    await until(() => document.activeElement && document.activeElement.getAttribute('data-key') === key && document.activeElement.getAttribute('aria-pressed') === 'true', 'focus kept on the chosen chip', 15000).catch(() => null);
    ok(document.activeElement && document.activeElement.getAttribute('data-key') === key, 'lobby: the keyboard focus stays on the chosen chip');
    await axeRun('camp lobby');
    await C.addBots(2);
    (await until(() => $$('.p-lobby button').find((b) => /Start the game/.test(b.textContent)), 'Start')).click();
    await until(() => C.phase() === 'roles', 'roles');
    await sleep(1200);
    await axeRun('camp roles');
    for (const ph of ['night', 'dawn', 'day', 'vote', 'verdict']) { await C.go(ph); await sleep(1000); await axeRun('camp ' + ph); }
    await C.go('vote'); await C.refresh();
    const r = C.roles(); await C.vote(Object.keys(r).find((k) => r[k] === 'mafia'));
    await C.go('verdict'); await C.go('over'); await sleep(1000);
    await axeRun('camp over');
    C.stop();
    $('.dock .leave').click();
    await until(() => $$('.anvil-modal-footer button').some(vis), 'the leave dialog');
    await sleep(1800);  // dialogs fade in
    await axeRun('camp leave dialog');
    log.push(bad.length ? 'PROBLEMS: ' + bad.join(' | ') : 'PASSED');
    return { ok: !bad.length, log: log };
  } catch (e) {
    log.push(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
