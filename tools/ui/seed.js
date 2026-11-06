/* For screenshots (ui_test.py --shots): start a camp in this tab with two test campers (tools/ui/camp.js) and give the
   shot steps window.__shotGo(phase): it clears UI_READY, moves the game on to that phase, then sets UI_READY again. */
(async function () {
  /*CAMP*/
  const C = window.__camp;
  await C.start('Ana');
  await C.addBots(2);
  window.__shotGo = function (phase) {
    window.UI_READY = false;
    (async function () {
      if (C.phase() === 'lobby') {
        (await C.until(() => Array.from(document.querySelectorAll('.p-lobby button')).find((b) => /Start the game/.test(b.textContent)), 'Start')).click();
        await C.until(() => C.phase() === 'roles', 'roles');
      }
      if (phase !== 'roles') await C.go(phase);
      await C.sleep(600);
    })().catch((e) => console.warn('shotGo', e)).then(() => { window.UI_READY = true; });
    return 1;
  };
  return 'seeded';
})();
