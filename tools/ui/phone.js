/* Phone-width check (run at 390 px wide by tools/ui_test.py): the home page, an invite link and the camp in every
   phase load without errors and without sideways scrolling; the dock fits and the story opens from it.
   Resolves to {ok, log}. */
(async function () {
  /*CAMP*/
  const C = window.__camp;
  const log = [], bad = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = C.until;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  function measure(where) {
    const w = document.documentElement.scrollWidth, vw = screen.width;  // innerWidth grows with a too-wide page
    const wide = $$('body *').filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1; })
      .slice(0, 3).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 2).join('.'));
    if (w > vw + 1) bad.push(where + ' scrolls sideways (' + w + ' > ' + vw + ') ' + wide.join(' '));
    log.push((w > vw + 1 ? 'WIDE ' : 'ok   ') + where + ' (' + w + ')');
  }
  async function check(hash, ready) {
    if (location.hash !== hash) window.UI_READY = false;  // the old page stays until the router runs
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && (!ready || ready()), hash, 30000);
    await sleep(500);
    measure(hash);
  }
  try {
    await check('#home', () => $('.join-card'));
    await check('#QWER', () => $$('.code-row input').some((i) => i.value === 'QWER'));
    await check('#home', () => $('.join-card'));
    await C.start('Phone');
    measure('camp: lobby');
    const dock = $('.dock').getBoundingClientRect();
    if (dock.right > screen.width + 1 || dock.bottom > innerHeight + 1) bad.push('the dock does not fit the screen');
    $('.dock .story-btn').click(); await sleep(300);
    if (!($('.story').getBoundingClientRect().height > 0)) bad.push('the Story button does not open the story');
    log.push('ok   dock: Story opens the story on a phone');
    await C.addBots(2);
    (await until(() => $$('.p-lobby button').find((b) => /Start the game/.test(b.textContent)), 'Start')).click();
    await until(() => C.phase() === 'roles', 'roles');
    await sleep(900);
    measure('camp: roles');
    for (const ph of ['night', 'dawn', 'day', 'vote', 'verdict']) {
      await C.go(ph);
      await sleep(500);
      measure('camp: ' + ph);
      if (C.phase() === 'over') break;
    }
    C.stop();
    log.push(bad.length ? 'PROBLEMS: ' + bad.join(' | ') : 'PASSED');
    return { ok: !bad.length, log: log };
  } catch (e) {
    log.push(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
