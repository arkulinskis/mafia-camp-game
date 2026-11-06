/* The main journey, run inside the real app (Anvil App Server) by tools/ui_test.py through tools/live/drive.mjs, with a
   fake camera + mic. The host is this tab (the real UI); two test campers join through the server (tools/ui/camp.js).
   Home -> start a camp -> lobby (code, settings, switches, dock) -> a whole game with the host skipping ahead
   (roles, night, dawn, day with Ready, vote by tapping a tile, verdict, game over, play again) -> leave -> home.
   Resolves to {ok, log}. Keep log lines ASCII (the Windows console). */
(async function () {
  /*CAMP*/
  const C = window.__camp;
  const log = [], t0 = Date.now();
  const say = (m) => log.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = C.until;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
  const text = (s) => ($(s) ? $(s).textContent.replace(/\s+/g, ' ').trim() : '');
  const ok = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); say('ok   ' + msg); };
  const btn = (re, root) => $$((root || '') + ' button').find((b) => vis(b) && re.test(b.textContent));

  try {
    // ---- home
    await until(() => window.UI_READY && $('.join-card'), 'home', 60000);
    ok(/not/.test(text('.hero h1')) && $('.lead'), 'home: the promise and the lead');
    ok($$('.tabs button').length === 2 && $$('.tabs button')[0].getAttribute('aria-pressed') === 'true', 'home: Start / Join toggle says which one is on');
    ok(!vis($('.code-row')) || !$('.code-row'), 'home: no code field while starting a camp');
    $$('.tabs button')[1].click(); await sleep(300);
    ok($$('.code-row input').some(vis) && /Join camp/.test(text('.join-card .anvil-role-big')), 'home: Join with a code shows the code field');
    const codeBox = $$('.code-row input')[0];
    C.type(codeBox, 'ab1c'); await sleep(400);
    ok(codeBox.value === 'ABC', 'home: the code field keeps capital letters only (' + codeBox.value + ')');
    $('.join-card .anvil-role-big button').click(); await sleep(800);
    ok($$('.anvil-notification, [data-notify="container"]').some(vis), 'home: a 3-letter code is refused with a message');
    ok($('#watch iframe') === null && $('#watch [data-yt-film]'), 'home: Watch section with the video cover (nothing from YouTube yet)');
    ok($('.ui-footer a[data-prepsto-open]') && $('.ui-footer [data-lk-open]') && $('.ui-footer a[href="https://arkvital.com"]') && $('.ui-footer a[href="https://addanapp.com"]'),
      'home: footer has Submit feedback, Privacy & Terms, arkvital.com, addanapp.com');
    location.hash = '#WXYZ';
    await until(() => window.UI_READY && $$('.code-row input').some((i) => vis(i) && i.value === 'WXYZ'), 'invite link #WXYZ');
    ok(true, 'home: an invite link (#WXYZ) opens Join with the code filled in');
    $$('.join-card input')[0].value = '';
    C.type($$('.join-card input')[0], 'Ana');
    $('.join-card .anvil-role-big button').click();
    await until(() => $$('.anvil-notification, [data-notify="container"]').some((n) => vis(n) && /no camp/i.test(n.textContent)), 'no camp WXYZ message', 30000);
    ok(true, 'home: joining a camp that does not exist says so');

    // ---- start a camp
    location.hash = '#home';
    await until(() => window.UI_READY && !$$('.code-row input').some(vis), 'home again');
    const code = await C.start('Ana');
    ok(/^[A-Z]{4}$/.test(code) && location.hash === '#' + code, 'room: in camp ' + code + ', the address is the invite link');
    ok(text('.cc-code') === code, 'room: the camp code in the bar');
    ok($('.ui-shell').classList.contains('immersive') && !vis($('.ui-footer')), 'room: full screen (no header / footer)');
    ok($$('.p-lobby .inv-code span').map((s) => s.textContent).join('') === code, 'lobby: the code in four boxes');
    ok(/1 of 10 campers here/.test(text('.p-lobby')), 'lobby: 1 of 10 campers here');
    ok($$('.grid .tile').length === 1 && $('.tile.me'), 'grid: my own tile');
    const start0 = btn(/Waiting for campers/, '.p-lobby');
    ok(start0 && start0.disabled, 'lobby: Start waits for 3 campers');
    ok($$('.p-lobby .anvil-role-chip.anvil-role-on').length === 3, 'lobby: one choice marked in each of the three time settings');
    btn(/^3 min$/, '.p-lobby').click();
    await until(() => C.view().settings.day_seconds === 180 && /3 min/.test(text('.p-lobby .anvil-role-chips .anvil-role-on')), 'talk time 3 min');
    ok(true, 'lobby: the host picks a talk time (3 min)');
    const reveal = $('.switch');
    const was = reveal.getAttribute('aria-checked');
    reveal.click();
    await until(() => $('.switch').getAttribute('aria-checked') !== was, 'reveal switch');
    ok(true, 'lobby: switches flip (reveal roles ' + was + ' -> ' + $('.switch').getAttribute('aria-checked') + ')');
    // dock
    const sound0 = text('.dock .sound .di');
    $('.dock .sound').click(); await sleep(300);
    ok(text('.dock .sound .di') !== sound0 && $('.dock .sound').classList.contains('off'), 'dock: Sounds off');
    $('.dock .sound').click(); await sleep(300);
    $('.dock .cam').click(); await sleep(400);
    ok(text('.dock .cam .dl') === 'Cam off' && $('.tile.me').classList.contains('camoff'), 'dock: camera off covers my tile');
    $('.dock .cam').click(); await sleep(400);
    ok(text('.dock .cam .dl') === 'Camera', 'dock: camera back on');
    $('.dock .mic').click(); await sleep(300);
    ok(text('.dock .mic .dl') === 'Muted', 'dock: mic muted');
    $('.dock .mic').click(); await sleep(300);

    // ---- two test campers, start
    await C.addBots(2);
    await until(() => /3 of 10 campers here/.test(text('.p-lobby')) && $$('.grid .tile').length === 3, 'three tiles');
    ok(true, 'lobby: two campers joined (3 tiles)');
    const start = await until(() => btn(/Start the game \(3 campers\)/, '.p-lobby'), 'Start the game (3 campers)');
    start.click();
    await until(() => C.phase() === 'roles' && $('.p-roles'), 'roles phase');
    await sleep(800);
    ok(vis($('.p-roles .role-card')) && text('.role-card h2').length > 3, 'roles: my secret role card (' + text('.role-card h2').replace('Your secret role: ', '') + ')');
    ok(/Roles/.test(text('.phase-chip')) && /\d:\d\d/.test(text('.ph-timer')), 'roles: phase chip with the clock');
    ok(vis($('.timebar')), 'roles: the time bar');
    await C.go('night');
    ok($('.p-night') && /Night 1/.test(text('.phase-chip')), 'night: the night panel');
    ok(document.documentElement.getAttribute('data-sky') === 'night', 'night: the sky turned to night');
    const myRole = C.view().my.role;
    if (myRole === 'mafia') {
      ok($$('.tile.pickable').length === 2, 'night: the Mafia can pick either camper');
    } else {
      ok(vis($('.p-night .sleep')) && $$('.tile.asleep').length >= 1, 'night: a camper sleeps, others are asleep on the tiles');
    }
    ok($('.role-pill') && vis($('.role-pill')), 'night: "Your role" pill');
    await C.go('dawn');
    ok($('.p-news .news') && /Morning, day 1/.test(text('.p-news')), 'dawn: the morning news');
    await C.go('day');
    ok($('.p-day') && btn(/Ready to vote/, '.p-day'), 'day: Talk it out with Ready to vote');
    btn(/Ready to vote/, '.p-day').click();
    await until(() => btn(/Ready \(tap to undo\)/, '.p-day'), 'ready pressed');
    ok(true, 'day: Ready to vote toggles');
    ok($$('.ev').length >= 1 && /arrived at Camp Moonlake/.test(text('.story')), 'story: the story so far');
    await C.go('vote');
    await C.refresh();
    const roles = C.roles();
    const mafia = Object.keys(roles).find((pid) => roles[pid] === 'mafia');
    ok(!!mafia, 'vote: the test knows who the Mafia is');
    if (mafia !== C.view().me) {
      const pick = await until(() => $(".tile[data-pid='" + mafia + "'] .pick:not([hidden])"), 'a vote button on the Mafia tile');
      pick.click();
      await until(() => C.view().my.vote === mafia, 'my vote');
      ok($(".tile[data-pid='" + mafia + "']").classList.contains('chosen') && /You voted for/.test(text('.p-vote')), 'vote: tapping a tile votes (tile marked, panel says so)');
    }
    await C.vote(mafia);
    await until(() => $$('.p-vote .tally-row').length >= 1, 'the tally');
    ok(true, 'vote: the tally shows the votes');
    await C.go('verdict');
    ok($('.p-news .news') && /The verdict/.test(text('.p-news')), 'verdict: the verdict card');
    await C.go('over');
    ok($('.p-over') && /Campers win/.test(text('.p-over h2')), 'over: the Campers win');
    ok($$('.p-over .reveal-row').length === 3, 'over: everyone\'s role revealed');
    btn(/Back to the campfire/, '.p-over').click();
    await until(() => C.phase() === 'lobby' && $('.p-lobby'), 'back in the lobby');
    ok(true, 'over: play again brings everyone back to the campfire');

    // ---- leave
    C.stop();
    $('.dock .leave').click();
    const yes = await until(() => $$('.anvil-modal-footer button').filter(vis).pop(), 'leave confirm');
    ok(/Leave camp/.test(yes.textContent), 'leave: asks first');
    yes.click();
    await until(() => window.UI_READY && $('.join-card') && !$('.mc-room'), 'home after leaving', 30000);
    ok(!location.hash || location.hash === '#', 'leave: back home, the address cleared');
    ok(document.title.indexOf('Mafia Camp') >= 0, 'leave: page title');
    say('PASSED');
    return { ok: true, log: log };
  } catch (e) {
    say(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
