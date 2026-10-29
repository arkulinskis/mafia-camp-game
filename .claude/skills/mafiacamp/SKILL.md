---
name: mafiacamp
description: Context, workflow and recipes for Mafia Camp (repo arkulinskis/mafia-camp-game), the user's Anvil video party game - Mafia/Werewolf at a summer camp with a 10-way peer-to-peer WebRTC call (PeerJS mesh, Anvil as broker + game server). Load this before any feature request, bug fix, restyle or deploy for Mafia Camp.
---

# Mafia Camp: working on the app

**What it is:** 3–10 friends join a "camp" by 4-letter code (no accounts), sit in one small-tile video call (320×240, voice on), get secret roles (Mafia, Camp Nurse, Ranger, Camper, optional Prankster) and play day/night cycles: night actions, dawn news, talk, open vote, verdict, until the Campers or the Mafia win. The call follows the rules: at night Campers go dark and the Mafia see/hear only each other; ghosts talk only to ghosts.

**Where it lives:**
- Repo **github.com/arkulinskis/mafia-camp-game**, branch `master`; Anvil pulls master. This folder **is** the Anvil repo ("git" layout). Live URL: not known yet (ask the user; then update apps.json `url` and legal-kit/apps/mafiacamp.json `url`, rebuild + install the kit).
- Born from the user's 2024 experiment: PeerJS in the browser + Anvil table storing peer ids ("it really works between two computers"). Keep that architecture.

**What the user wants:** "be creative, assume things". A fun, distinctive look; phone first (390px); 10 people on very small tiles with voice.

## Workflow

1. `python -I C:\Users\arkvi\Documents\CLAUDE\APP_MAKER\tools\apps_status.py mafiacamp -v`; pull Anvil's "Edited …" commits.
2. Edit here.
3. `python C:\Users\arkvi\Documents\CLAUDE\APP_MAKER\tools\gitapp_check.py mafiacamp` → `ALL CHECKS PASSED`.
4. Server rules: `python C:\Users\arkvi\Documents\CLAUDE\APP_MAKER\tools\gitapp_test.py mafiacamp tests/test_game.py` → `ALL OK`. Add cases there.
5. **The real call test** (do it after any mafia.js / game.py change that touches the mesh, phases or routing):
   - start the harness (background): `FAST=1 python ...\APP_MAKER\tools\gitapp_test.py mafiacamp tests/harness_server.py 8841 8850`
     (the real game.py on the Anvil mock, one HTTP origin per port = one player per tab; FAST=1 makes every phase a few seconds; pick other free ports if taken)
   - `N=10 PLAY=1 node tests/mesh_test.mjs <scratch dir>`: N headless Chrome tabs with fake camera + mic join one camp through the real PeerJS cloud, play a whole game, print per-tab "sending to" counts per phase (with the expected number) and outgoing bitrate, and save screenshots (home light/dark, lobby, roles, night, dawn, day, ghost, vote, verdict, end; desktop + phone). Read the PNGs.
   - stop the harness when done.
6. Bump `?v=` on mafia.css / mafia.js / icons in `anvil.yaml → native_deps.head_html` whenever those files change.
7. Commit only your files as arkulinskis with the Co-Authored-By line; `git push origin master`.
8. Schema changes: `anvil.yaml → db_schema`; the user accepts the Schema Mismatch alert.

## Architecture

```
client_code/Form1/       mounts window.MafiaCamp.mount(node, bridge); bridge(action, json) -> call_s('mc_api') (no spinner)
server_code/game.py      ALL rules. mc_api(action, payload_json) -> {"ok", "data"} | {"ok": false, "error", "code"}
                         actions: create, join, state (the 2 s poll: heartbeat + peer_id + mic/cam, moves the phase on when
                         its time is up), leave, settings, start, act (night jobs), ready, vote, skip, again, kick
                         deal_roles / winner / mafia_target / vote_result are pure functions (tested directly)
                         _view(room, me) decides what each player may see (roles only when the rules allow)
theme/assets/mafia.js    UI (home, room: grid of tiles, side panel per phase, story, dock) + mesh + routing
theme/assets/mafia.css   design tokens per html[data-sky] = dusk | night | dawn | day
theme/assets/theme.css   Anvil startup spinner (tent/moon tile + ember arc)
theme/assets/peerjs.min.js  PeerJS 1.5.2 (defaults: 0.peerjs.com signalling, Google STUN, PeerJS TURN relays)
tests/                   test_game.py, harness_server.py, mesh_test.mjs
```

**Tables** (server-only): `rooms` (code, host pid, phase, phase_started/phase_ends, day, version, settings, game simpleObject:
roles, alive, night picks, nurse_last, checks, votes, ready, events, result, winner, spectators), `players` (room, token = secret
per browser, pid = public id, name, seat, peer_id, media "mc", joined, last_seen, left). `users` + `friendships` are leftovers from
the 2024 experiment (kept, unused; users holds the legal_* columns).

**Identity:** the browser makes a random token (localStorage `mc.token`) and sends it with every call. Never return tokens.

**Mesh:** full mesh; the browser with the smaller PeerJS id dials (`peer.call`), the other answers. syncMesh() after every
poll: dial missing peers (5 s backoff), drop conns whose peer id vanished, failed, or got no stream in 20 s.

**Routing (privacy at night):** `sends(from, to, view)` in mafia.js; per connection `route()` swaps each transceiver's sender
track for the local track or `null`. Done right after call()/answer() (before media flows) and on every view. Receivers draw
covers (asleep / ghost / connecting / camera off) from the same rule. The server only gives a browser the roles it may know
(own, Mafia partners, everyone's if you're a ghost, the dead's if reveal_roles), which is exactly what the rule needs.

## Recipes

- **New role:** add to `deal_roles` (+ counts), night job in `a_act` and `_night_done`, resolution in `_advance` ("night"),
  win rule in `winner`, `_role_word`; client: ROLES entry, pickMode(), PANEL.night text, tags. Test both sides.
- **New phase timer/setting:** DEFAULT_SETTINGS + ALLOWED (server), chips() in PANEL.lobby, phaseTotal() (client).
- **Change video quality:** getMedia() constraints and tune() maxBitrate in mafia.js. 10 players = 9 uploads each.

## Gotchas

- Don't raise inside an `@tables.in_transaction` function to signal a normal outcome: Anvil rolls the transaction back
  (a_leave returns "left" for that reason).
- `a_state` runs the phase tick in its own transaction, then re-reads the room row before building the view.
- Phases end early ("hurry" to 3 s) when everyone has acted, so nobody learns exactly who was last.
- Headless Chrome needs `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`
  (and background-throttling off) for the mesh test. Same-origin tabs share localStorage = same player, hence one port per tab.
- Full-page phone screenshots draw the fixed dock mid-page; that's the capture, not the layout.
- Signalling and relays are PeerJS's free public servers. If calls fail on strict networks (offices, some mobile carriers),
  the fix is a paid TURN service in `new Peer({config: {iceServers: …}})` (update the legal kit providers too).
- Anvil free plans: 10 players × 1 poll / 2 s ≈ 5 server calls a second while a camp is open.

## Privacy & Terms (legal kit)

From `C:/Users/arkvi/Documents/CLAUDE/APP_MAKER/legal-kit`: change `apps/mafiacamp.json` there (providers peerjs + google_stun
live in kit.json), `python -I build.py mafiacamp && python -I install.py mafiacamp`, commit and push here. Don't edit
theme/assets/legal-kit.js, client_code/legal.py or server_code/legal_server.py here. The "Privacy & Terms" buttons use
`data-lk-open="overview"`. No sign-up form (no accounts), so no consent tick box.
