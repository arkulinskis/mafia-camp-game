"""Mafia Camp: every game rule lives here.

One callable, mc_api(action, payload_json) -> JSON string {"ok": true, "data": ...} or {"ok": false, "error", "code"}.
Nobody signs in: each browser makes a random secret `token` (kept in its local storage) and sends it with every
request, plus the 4-letter camp `code`. Players also get a public `pid`, which is what other people see.

The video call itself is peer to peer (PeerJS in the browser). This server is the broker: it stores each
player's PeerJS id so the browsers can find each other, and it runs the game: roles, phases, timers, votes.
Browsers poll `state` every ~2 seconds; that poll also moves the game on when a phase's time is up.

Each room keeps the whole game in one simpleObject (`game`), so a change is one row write inside a transaction.
"""
import datetime as dt
import json
import random
import string

import anvil.server
import anvil.tables as tables
from anvil.tables import app_tables

MAX_PLAYERS = 10
MIN_PLAYERS = 3
CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # no I or O: easy to read out loud
AWAY_AFTER = 20        # seconds without a poll: shown as "away"
DROP_AFTER = 45        # seconds without a poll in the lobby: removed from the camp
ROOM_MAX_AGE_H = 24    # rooms untouched this long are cleaned up
FIXED = {"roles": 12, "dawn": 9, "verdict": 9}
DEFAULT_SETTINGS = {"day_seconds": 120, "night_seconds": 40, "vote_seconds": 35, "reveal_roles": True, "prankster": False}
ALLOWED = {"day_seconds": (60, 90, 120, 180, 240, 300), "night_seconds": (25, 40, 60), "vote_seconds": (25, 35, 50)}
ROLES = ("mafia", "nurse", "ranger", "prankster", "camper")

DEATHS = [
  "was found floating face-down in the canoe dock",
  "never came back from the midnight snack run",
  "was discovered tangled in the volleyball net",
  "vanished from the archery range without a trace",
  "was found in the arts-and-crafts cabin, glued to a lanyard",
  "went to check a noise behind the boathouse and didn't return",
  "was found under a pile of very suspicious s'mores",
  "got lost on the night hike. Permanently",
]
SAVES = [
  "The Camp Nurse was up all night with a first-aid kit. Somebody owes them a s'more.",
  "Someone was attacked last night, but the Camp Nurse patched them up just in time.",
  "A scream at 3 a.m.... then the Camp Nurse's flashlight. Everyone survived!",
]
QUIET = [
  "A quiet night. Only the crickets were plotting.",
  "Nobody was attacked last night. The Mafia must have overslept.",
]
EXILES = [
  "is sent home on the early bus",
  "is banished to the far side of the lake",
  "is put in a canoe and gently pushed away",
  "has to go home and explain this to their parents",
]


class ApiError(Exception):
  def __init__(self, message, code="error"):
    super().__init__(message)
    self.code = code


def _now():
  return dt.datetime.now(dt.timezone.utc)


def _aware(t):
  if t is None:
    return None
  return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def _clean_name(name):
  name = " ".join(str(name or "").split())[:16]
  if not name:
    raise ApiError("Pick a camp name first.", "name")
  return name


def _check_token(token):
  token = str(token or "")
  if not (16 <= len(token) <= 64) or not all(c.isalnum() or c in "-_" for c in token):
    raise ApiError("This browser couldn't make a player key. Reload the page and try again.", "token")
  return token


def _room(code):
  code = str(code or "").strip().upper()
  room = app_tables.rooms.get(code=code) if len(code) == 4 else None
  if room is None:
    raise ApiError("There's no camp with the code %s. Check the code with your host." % (code or "…"), "no_room")
  return room


def _players(room):
  return [p for p in app_tables.players.search(room=room) if not p["left"]]


def _me(room, token):
  me = app_tables.players.get(room=room, token=token)
  if me is None or me["left"]:
    raise ApiError("You're not in this camp any more.", "not_in_room")
  return me


def _seconds_since(t, now):
  t = _aware(t)
  return 1e9 if t is None else (now - t).total_seconds()


def _away(p, now):
  return _seconds_since(p["last_seen"], now) > AWAY_AFTER


def _new_game():
  return {"roles": {}, "alive": {}, "mafia_total": 0, "night": {}, "nurse_last": None, "checks": {},
          "votes": {}, "ready": [], "events": [], "result": None, "winner": None, "spectators": []}


def _bump(room, **cols):
  cols["version"] = (room["version"] or 0) + 1
  cols["touched"] = _now()
  room.update(**cols)


def _set_phase(room, phase, seconds=None):
  now = _now()
  _bump(room, phase=phase, phase_started=now, phase_ends=(now + dt.timedelta(seconds=seconds)) if seconds else None)


def _phase_seconds(room, phase):
  s = room["settings"] or DEFAULT_SETTINGS
  if phase in FIXED:
    return FIXED[phase]
  return {"night": s.get("night_seconds", 40), "day": s.get("day_seconds", 120), "vote": s.get("vote_seconds", 35)}[phase]


def _event(game, day, kind, text, **extra):
  e = {"day": day, "kind": kind, "text": text}
  e.update(extra)
  game["events"] = (game.get("events") or [])[-59:] + [e]


# ------------------------------------------------------------------------------------------------ roles + rules

def deal_roles(pids, prankster=False, rng=random):
  """pids -> {pid: role}. 3-5 players: 1 Mafia, 6-9: 2, 10: 3. Nurse from 4, Ranger from 5, Prankster (if on) from 7."""
  n = len(pids)
  mafia = 1 if n <= 5 else (2 if n <= 9 else 3)
  deck = ["mafia"] * mafia
  if n >= 4:
    deck.append("nurse")
  if n >= 5:
    deck.append("ranger")
  if prankster and n >= 7:
    deck.append("prankster")
  deck += ["camper"] * (n - len(deck))
  rng.shuffle(deck)
  order = list(pids)
  rng.shuffle(order)
  return dict(zip(order, deck))


def winner(game):
  """'town', 'mafia' or None, from who is still alive."""
  alive = [pid for pid, a in game["alive"].items() if a]
  mafia = sum(1 for pid in alive if game["roles"].get(pid) == "mafia")
  if mafia == 0:
    return "town"
  if mafia >= len(alive) - mafia:
    return "mafia"
  return None


def mafia_target(game, rng=random):
  """The living Mafia's choice: the most-picked target (a tie is settled at random)."""
  picks = [t for pid, t in (game["night"].get("mafia") or {}).items()
           if game["alive"].get(pid) and game["roles"].get(pid) == "mafia" and t and game["alive"].get(t)]
  if not picks:
    return None
  counts = {}
  for t in picks:
    counts[t] = counts.get(t, 0) + 1
  top = max(counts.values())
  return rng.choice(sorted(t for t, c in counts.items() if c == top))


def vote_result(game):
  """(pid or None, tally). Out only with the most votes, no tie, and more votes than 'skip'."""
  tally = {}
  for voter, target in (game.get("votes") or {}).items():
    if game["alive"].get(voter) and (target == "skip" or game["alive"].get(target)):
      tally[target] = tally.get(target, 0) + 1
  skip = tally.get("skip", 0)
  people = {t: c for t, c in tally.items() if t != "skip"}
  if not people:
    return None, tally
  top = max(people.values())
  leaders = [t for t, c in people.items() if c == top]
  if len(leaders) > 1 or top <= skip:
    return None, tally
  return leaders[0], tally


def _night_done(game):
  """Everyone with a night job has done it (and the Mafia agree)."""
  alive = [pid for pid, a in game["alive"].items() if a]
  roles = game["roles"]
  night = game["night"]
  mafia = [pid for pid in alive if roles.get(pid) == "mafia"]
  picks = night.get("mafia") or {}
  if any(not picks.get(pid) for pid in mafia) or len(set(picks.get(pid) for pid in mafia)) > 1:
    return False
  if any(roles.get(pid) == "nurse" for pid in alive) and not night.get("nurse"):
    return False
  if any(roles.get(pid) == "ranger" for pid in alive) and not night.get("ranger"):
    return False
  return True


def _hurry(room, seconds=3):
  """Cut the phase short (everyone has acted): a few seconds left, so nobody learns exactly who was last."""
  ends = _now() + dt.timedelta(seconds=seconds)
  if room["phase_ends"] is None or _aware(room["phase_ends"]) > ends:
    room["phase_ends"] = ends


def _names(room):
  return {p["pid"]: p["name"] for p in app_tables.players.search(room=room)}


def _role_word(role):
  return {"mafia": "the Mafia", "nurse": "the Camp Nurse", "ranger": "the Ranger", "prankster": "the Prankster",
          "camper": "a Camper"}.get(role, "a mystery")


def _advance(room, rng=random):
  """Move to the next phase. Called inside a transaction."""
  game = room["game"] or _new_game()
  phase = room["phase"]
  day = room["day"] or 0
  names = _names(room)
  reveal = (room["settings"] or DEFAULT_SETTINGS).get("reveal_roles", True)

  def finish(kind):
    game["winner"] = kind
    text = {"town": "The Campers caught every last Mafia member. Camp is saved!",
            "mafia": "The Mafia outnumber the Campers. Camp Moonlake is theirs now.",
            "prankster": "The Prankster got themselves voted out. That was the plan all along!"}[kind]
    _event(game, day, "over", text)
    room["game"] = game
    _set_phase(room, "over")

  if phase == "roles":
    room["day"] = 1
    game["night"] = {}
    room["game"] = game
    _set_phase(room, "night", _phase_seconds(room, "night"))
    return

  if phase == "night":
    victim = mafia_target(game, rng)
    saved = victim is not None and game["night"].get("nurse") == victim
    ranger_t = game["night"].get("ranger")
    for pid, role in game["roles"].items():
      if role == "ranger" and game["alive"].get(pid) and ranger_t:
        game["checks"].setdefault(pid, []).append({"day": day, "pid": ranger_t, "mafia": game["roles"].get(ranger_t) == "mafia"})
    game["nurse_last"] = game["night"].get("nurse")
    if victim and not saved:
      game["alive"][victim] = False
      line = rng.choice(DEATHS)
      role = game["roles"].get(victim)
      text = "%s %s." % (names.get(victim, "Someone"), line) + (" They were %s." % _role_word(role) if reveal else "")
      game["result"] = {"kind": "dawn", "pid": victim, "role": role if reveal else None, "text": text}
    elif saved:
      game["result"] = {"kind": "dawn", "pid": None, "saved": True, "text": rng.choice(SAVES)}
    else:
      game["result"] = {"kind": "dawn", "pid": None, "text": rng.choice(QUIET)}
    _event(game, day, "dawn", game["result"]["text"])
    game["night"] = {}
    room["game"] = game
    _set_phase(room, "dawn", FIXED["dawn"])
    return

  if phase == "dawn":
    w = winner(game)
    if w:
      return finish(w)
    game["ready"] = []
    room["game"] = game
    _set_phase(room, "day", _phase_seconds(room, "day"))
    return

  if phase == "day":
    game["votes"] = {}
    room["game"] = game
    _set_phase(room, "vote", _phase_seconds(room, "vote"))
    return

  if phase == "vote":
    out, tally = vote_result(game)
    if out:
      game["alive"][out] = False
      role = game["roles"].get(out)
      text = "The camp has spoken: %s %s." % (names.get(out, "Someone"), rng.choice(EXILES))
      if reveal or role == "prankster":
        text += " They were %s." % _role_word(role)
      game["result"] = {"kind": "verdict", "pid": out, "role": role if (reveal or role == "prankster") else None,
                        "text": text, "tally": tally}
    else:
      why = "It's a tie" if tally and any(t != "skip" for t in tally) else "The camp couldn't decide"
      game["result"] = {"kind": "verdict", "pid": None, "text": "%s, so nobody is sent home today." % why, "tally": tally}
    _event(game, day, "verdict", game["result"]["text"])
    room["game"] = game
    _set_phase(room, "verdict", FIXED["verdict"])
    return

  if phase == "verdict":
    out = (game.get("result") or {}).get("pid")
    if out and game["roles"].get(out) == "prankster":
      return finish("prankster")
    w = winner(game)
    if w:
      return finish(w)
    room["day"] = day + 1
    game["night"] = {}
    game["votes"] = {}
    room["game"] = game
    _set_phase(room, "night", _phase_seconds(room, "night"))
    return


@tables.in_transaction
def _tick(code):
  room = app_tables.rooms.get(code=code)
  if room is None:
    return
  ends = _aware(room["phase_ends"])
  if ends is not None and _now() >= ends:
    _advance(room)


# ------------------------------------------------------------------------------------------------ the view

def _view(room, me):
  """Everything this player may see. Roles only when the rules allow it."""
  now = _now()
  game = room["game"] or _new_game()
  phase = room["phase"]
  in_game = phase != "lobby"
  roles = game.get("roles") or {}
  alive = game.get("alive") or {}
  my_pid = me["pid"]
  my_role = roles.get(my_pid) if in_game else None
  i_am_ghost = in_game and phase != "over" and not alive.get(my_pid)
  reveal = (room["settings"] or DEFAULT_SETTINGS).get("reveal_roles", True)
  players = []
  for p in sorted(_players(room), key=lambda r: r["seat"] or 0):
    pid = p["pid"]
    role = None
    if in_game and pid in roles:
      if phase == "over" or pid == my_pid or i_am_ghost:
        role = roles[pid]
      elif my_role == "mafia" and roles[pid] == "mafia":
        role = "mafia"
      elif not alive.get(pid) and (reveal or roles[pid] == "prankster"):
        role = roles[pid]
    players.append({
      "pid": pid, "name": p["name"], "seat": p["seat"], "peer_id": p["peer_id"] or "", "away": _away(p, now),
      "mic": "m" in (p["media"] or ""), "cam": "c" in (p["media"] or ""),
      "host": room["host"] == pid, "playing": in_game and pid in roles,
      "alive": bool(alive.get(pid)) if in_game and pid in roles else (not in_game),
      "role": role,
      "ready": pid in (game.get("ready") or []) if phase == "day" else False,
      "vote": (game.get("votes") or {}).get(pid) if phase in ("vote", "verdict") else None,
    })
  ends = _aware(room["phase_ends"])
  my = {"role": my_role, "alive": bool(alive.get(my_pid)) if in_game else True, "ghost": i_am_ghost,
        "spectator": in_game and my_pid not in roles}
  night = game.get("night") or {}
  if phase == "night" and my_role and alive.get(my_pid):
    if my_role == "mafia":
      my["picks"] = {pid: t for pid, t in (night.get("mafia") or {}).items()}
      my["pick"] = (night.get("mafia") or {}).get(my_pid)
    elif my_role in ("nurse", "ranger"):
      my["pick"] = night.get(my_role)
  if my_role == "nurse":
    my["nurse_last"] = game.get("nurse_last")
  if my_role == "ranger":
    my["checks"] = (game.get("checks") or {}).get(my_pid, [])
  if my_role == "mafia" or i_am_ghost:
    my["team"] = [pid for pid, r in roles.items() if r == "mafia"]
  if phase == "day":
    my["ready"] = my_pid in (game.get("ready") or [])
  if phase == "vote":
    my["vote"] = (game.get("votes") or {}).get(my_pid)
  counts = {"mafia_total": game.get("mafia_total") or 0}
  if in_game:
    counts["alive"] = sum(1 for a in alive.values() if a)
  return {
    "code": room["code"], "phase": phase, "day": room["day"] or 0, "version": room["version"] or 0,
    "remaining": max(0.0, (ends - now).total_seconds()) if ends else None,
    "settings": room["settings"] or DEFAULT_SETTINGS, "host": room["host"], "me": my_pid, "my": my,
    "players": players, "result": game.get("result") if phase in ("dawn", "day", "vote", "verdict", "over") else None,
    "events": (game.get("events") or [])[-30:], "winner": game.get("winner"), "counts": counts,
    "min_players": MIN_PLAYERS, "max_players": MAX_PLAYERS,
  }


# ------------------------------------------------------------------------------------------------ actions

def _new_code():
  for _ in range(50):
    code = "".join(random.choice(CODE_LETTERS) for _ in range(4))
    if app_tables.rooms.get(code=code) is None:
      return code
  raise ApiError("Couldn't find a free camp code. Please try again.")


def _cleanup():
  cutoff = _now() - dt.timedelta(hours=ROOM_MAX_AGE_H)
  for room in app_tables.rooms.search():
    t = _aware(room["touched"])
    if t is None or t < cutoff:
      for p in app_tables.players.search(room=room):
        p.delete()
      room.delete()


def _new_pid(room):
  taken = {p["pid"] for p in app_tables.players.search(room=room)}
  while True:
    pid = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    if pid not in taken:
      return pid


def _unique_name(room, name, skip_pid=None):
  taken = {p["name"].lower() for p in _players(room) if p["pid"] != skip_pid}
  base, n = name, 2
  while name.lower() in taken:
    name = "%s %d" % (base[:13], n)
    n += 1
  return name


def _free_seat(room):
  used = {p["seat"] for p in _players(room)}
  return next(i for i in range(1, 100) if i not in used)


def _add_player(room, token, name, now):
  old = app_tables.players.get(room=room, token=token)
  if old is not None:
    old.delete()
  return app_tables.players.add_row(room=room, token=token, pid=_new_pid(room), name=_unique_name(room, name),
                                    seat=_free_seat(room), peer_id="", media="mc", joined=now, last_seen=now, left=False)


def _drop_stale_lobby(room, now):
  if room["phase"] != "lobby":
    return False
  gone = [p for p in _players(room) if _seconds_since(p["last_seen"], now) > DROP_AFTER]
  for p in gone:
    p.delete()
  return bool(gone)


def _fix_host(room, now):
  """If the host has gone away, the longest-present camper takes over."""
  present = [p for p in _players(room) if not _away(p, now)]
  hosts = [p for p in _players(room) if p["pid"] == room["host"]]
  if hosts and not _away(hosts[0], now):
    return
  if present:
    room["host"] = sorted(present, key=lambda p: (_aware(p["joined"]), p["seat"]))[0]["pid"]


def a_create(p):
  _cleanup()  # old camps go when a new one starts (the privacy policy promises ~24 h)
  return _create(p)


@tables.in_transaction
def _create(p):
  token = _check_token(p.get("token"))
  name = _clean_name(p.get("name"))
  now = _now()
  room = app_tables.rooms.add_row(code=_new_code(), created=now, touched=now, phase="lobby", phase_started=now,
                                  phase_ends=None, day=0, version=1, settings=dict(DEFAULT_SETTINGS),
                                  game=_new_game(), host="")
  me = _add_player(room, token, name, now)
  room["host"] = me["pid"]
  return _view(room, me)


@tables.in_transaction
def a_join(p):
  token = _check_token(p.get("token"))
  name = _clean_name(p.get("name"))
  room = _room(p.get("code"))
  now = _now()
  _drop_stale_lobby(room, now)
  me = app_tables.players.get(room=room, token=token)
  if me is not None and not me["left"]:
    me.update(name=_unique_name(room, name, me["pid"]), last_seen=now)  # coming back (reload): same seat, same role
  else:
    if len(_players(room)) >= MAX_PLAYERS:
      raise ApiError("This camp is full (%d campers). Ask the host to start a second camp." % MAX_PLAYERS, "full")
    me = _add_player(room, token, name, now)
    if room["phase"] != "lobby":
      game = room["game"]
      game["spectators"] = (game.get("spectators") or []) + [me["pid"]]
      room["game"] = game
  _fix_host(room, now)
  _bump(room)
  return _view(room, me)


def a_state(p):
  """The poll: heartbeat + PeerJS id, moves the game on when its time is up, returns the view."""
  token = _check_token(p.get("token"))
  room = _room(p.get("code"))
  me = _me(room, token)
  now = _now()
  peer_id = str(p.get("peer_id") or "")[:80]
  media = "".join(c for c in "mc" if c in str(p.get("media", "mc")))  # m = mic on, c = camera on
  if peer_id != (me["peer_id"] or "") or media != (me["media"] or "") or _seconds_since(me["last_seen"], now) > 5:
    me.update(peer_id=peer_id, media=media, last_seen=now)
  ends = _aware(room["phase_ends"])
  code = room["code"]
  if ends is not None and now >= ends:
    _tick(code)
  elif room["phase"] == "lobby" and random.random() < 0.15:
    _housekeep(code)
  elif random.random() < 0.1:
    _host_check(code)
  else:
    return _view(room, me)
  room = app_tables.rooms.get(code=code)  # re-read after the transaction changed it
  return _view(room, me)


@tables.in_transaction
def _housekeep(code):
  room = app_tables.rooms.get(code=code)
  if room is not None and _drop_stale_lobby(room, _now()):
    _fix_host(room, _now())
    _bump(room)


@tables.in_transaction
def _host_check(code):
  room = app_tables.rooms.get(code=code)
  if room is not None:
    before = room["host"]
    _fix_host(room, _now())
    if room["host"] != before:
      _bump(room)


def _mutation(f):
  """Host/player actions: look up room + me, run inside a transaction, return the fresh view."""
  @tables.in_transaction
  def run(p):
    token = _check_token(p.get("token"))
    room = _room(p.get("code"))
    me = _me(room, token)
    if f(p, room, me) == "left":
      return {"left": True}
    return _view(room, me)
  run.__name__ = f.__name__
  return run


def _require_host(room, me):
  if room["host"] != me["pid"]:
    raise ApiError("Only the host can do that.", "not_host")


@_mutation
def a_leave(p, room, me):
  if room["phase"] == "lobby" or me["pid"] not in (room["game"] or {}).get("roles", {}):
    me.delete()
  else:
    game = room["game"]
    if game["alive"].get(me["pid"]):
      game["alive"][me["pid"]] = False
      _event(game, room["day"] or 0, "left", "%s packed their bags and left camp." % me["name"])
      room["game"] = game
    me["left"] = True
  remaining = _players(room)
  if remaining:
    _fix_host(room, _now())
    if room["host"] == me["pid"]:
      room["host"] = remaining[0]["pid"]
  _bump(room)
  return "left"


@_mutation
def a_settings(p, room, me):
  _require_host(room, me)
  if room["phase"] != "lobby":
    raise ApiError("Settings can only change before the game starts.")
  s = dict(room["settings"] or DEFAULT_SETTINGS)
  for k, allowed in ALLOWED.items():
    if k in p:
      v = int(p[k])
      if v not in allowed:
        raise ApiError("That time isn't one of the choices.")
      s[k] = v
  for k in ("reveal_roles", "prankster"):
    if k in p:
      s[k] = bool(p[k])
  room["settings"] = s
  _bump(room)


@_mutation
def a_start(p, room, me):
  _require_host(room, me)
  if room["phase"] != "lobby":
    raise ApiError("The game has already started.")
  now = _now()
  _drop_stale_lobby(room, now)
  playing = [x for x in _players(room) if not _away(x, now)]
  if len(playing) < MIN_PLAYERS:
    raise ApiError("You need at least %d campers to start (6 to 10 is best)." % MIN_PLAYERS, "too_few")
  game = _new_game()
  game["roles"] = deal_roles([x["pid"] for x in playing], (room["settings"] or {}).get("prankster", False))
  game["alive"] = {pid: True for pid in game["roles"]}
  game["mafia_total"] = sum(1 for r in game["roles"].values() if r == "mafia")
  game["spectators"] = [x["pid"] for x in _players(room) if x["pid"] not in game["roles"]]
  m = game["mafia_total"]
  _event(game, 0, "start", "%d campers arrived at Camp Moonlake. %s secretly the Mafia."
         % (len(playing), "One of them is" if m == 1 else "%d of them are" % m))
  room["game"] = game
  room["day"] = 0
  _set_phase(room, "roles", FIXED["roles"])


@_mutation
def a_act(p, room, me):
  """Night jobs: the Mafia pick a target, the Nurse protects, the Ranger investigates."""
  if room["phase"] != "night":
    raise ApiError("You can only do that at night.")
  game = room["game"]
  pid = me["pid"]
  role = game["roles"].get(pid)
  if not game["alive"].get(pid) or role not in ("mafia", "nurse", "ranger"):
    raise ApiError("You have no job tonight. Sleep tight!")
  target = p.get("target") or None
  if target is not None and not game["alive"].get(target):
    raise ApiError("Pick someone who is still at camp.")
  if role == "mafia":
    if target and game["roles"].get(target) == "mafia":
      raise ApiError("That's one of your own!")
    game["night"].setdefault("mafia", {})[pid] = target
  elif role == "nurse":
    if target and target == game.get("nurse_last"):
      raise ApiError("You protected them last night. Pick someone else tonight.")
    game["night"]["nurse"] = target
  elif role == "ranger":
    if target == pid:
      raise ApiError("You already know you're innocent.")
    game["night"]["ranger"] = target
  room["game"] = game
  if _night_done(game):
    _hurry(room)
  _bump(room)


@_mutation
def a_ready(p, room, me):
  if room["phase"] != "day":
    raise ApiError("Voting isn't open yet.")
  game = room["game"]
  pid = me["pid"]
  if not game["alive"].get(pid):
    raise ApiError("Ghosts don't get a say. Boo.")
  ready = [x for x in (game.get("ready") or []) if x != pid]
  if p.get("ready", True):
    ready.append(pid)
  game["ready"] = ready
  room["game"] = game
  alive = sum(1 for a in game["alive"].values() if a)
  if len(ready) * 2 > alive:
    _advance(room)
  else:
    _bump(room)


@_mutation
def a_vote(p, room, me):
  if room["phase"] != "vote":
    raise ApiError("It isn't time to vote.")
  game = room["game"]
  pid = me["pid"]
  if not game["alive"].get(pid):
    raise ApiError("Ghosts don't get a vote. Boo.")
  target = p.get("target")
  if target != "skip":
    if target == pid:
      raise ApiError("You can't vote for yourself.")
    if not game["alive"].get(target):
      raise ApiError("Pick someone who is still at camp.")
  votes = game.get("votes") or {}
  if target is None:
    votes.pop(pid, None)
  else:
    votes[pid] = target
  game["votes"] = votes
  room["game"] = game
  alive = [x for x, a in game["alive"].items() if a]
  if all(x in votes for x in alive):
    _hurry(room)
  _bump(room)


@_mutation
def a_skip(p, room, me):
  _require_host(room, me)
  if room["phase"] in ("lobby", "over"):
    raise ApiError("There's nothing to skip.")
  _advance(room)


@_mutation
def a_again(p, room, me):
  _require_host(room, me)
  if room["phase"] != "over":
    raise ApiError("Finish this game first (or everyone can leave).")
  now = _now()
  for x in _players(room):
    if _seconds_since(x["last_seen"], now) > DROP_AFTER:
      x.delete()
  room["game"] = _new_game()
  room["day"] = 0
  _set_phase(room, "lobby")


@_mutation
def a_kick(p, room, me):
  _require_host(room, me)
  target = app_tables.players.get(room=room, pid=str(p.get("pid") or ""))
  if target is None or target["left"] or target["pid"] == me["pid"]:
    raise ApiError("That camper isn't here.")
  game = room["game"]
  if room["phase"] == "lobby" or target["pid"] not in game.get("roles", {}):
    target.delete()
  else:
    if game["alive"].get(target["pid"]):
      game["alive"][target["pid"]] = False
      _event(game, room["day"] or 0, "left", "%s was sent home by the host." % target["name"])
      room["game"] = game
    target["left"] = True
  _bump(room)


ACTIONS = {"create": a_create, "join": a_join, "state": a_state, "leave": a_leave, "settings": a_settings,
           "start": a_start, "act": a_act, "ready": a_ready, "vote": a_vote, "skip": a_skip, "again": a_again,
           "kick": a_kick}


@anvil.server.callable
def mc_api(action, payload_json="{}"):
  try:
    payload = json.loads(payload_json or "{}")
    if not isinstance(payload, dict) or action not in ACTIONS:
      raise ApiError("Unknown request.")
    return json.dumps({"ok": True, "data": ACTIONS[action](payload)})
  except ApiError as e:
    return json.dumps({"ok": False, "error": str(e), "code": e.code})
  except (ValueError, TypeError):
    return json.dumps({"ok": False, "error": "That request didn't make sense. Please try again.", "code": "bad_input"})
