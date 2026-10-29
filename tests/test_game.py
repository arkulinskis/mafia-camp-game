import datetime as dt
import json
import random

import anvil.server
from anvil.tables import app_tables as T
from app import game as G


def call(action, **p):
  return json.loads(anvil.server.call("mc_api", action, json.dumps(p)))


def ok(action, **p):
  r = call(action, **p)
  assert r["ok"], (action, r)
  return r["data"]


def err(action, want=None, **p):
  r = call(action, **p)
  assert not r["ok"], (action, "should fail", r)
  if want:
    assert r["code"] == want, (action, r)
  return r["error"]


def tok(i):
  return "token-%02d-abcdefghijklmnop" % i


def expire(code):
  room = T.rooms.get(code=code)
  room["phase_ends"] = G._now() - dt.timedelta(seconds=1)


def roles_of(code):
  return T.rooms.get(code=code)["game"]["roles"]


# ---- deal_roles
for n in range(3, 11):
  r = G.deal_roles(["p%d" % i for i in range(n)], prankster=True)
  vals = list(r.values())
  assert len(r) == n
  assert vals.count("mafia") == (1 if n <= 5 else 2 if n <= 9 else 3), (n, vals)
  assert vals.count("nurse") == (1 if n >= 4 else 0)
  assert vals.count("ranger") == (1 if n >= 5 else 0)
  assert vals.count("prankster") == (1 if n >= 7 else 0)
print("deal_roles ok")

# ---- vote_result
g = {"alive": {"a": True, "b": True, "c": True, "d": True}, "votes": {"a": "b", "c": "b", "d": "a"}}
assert G.vote_result(g)[0] == "b"
g["votes"] = {"a": "b", "c": "a"}
assert G.vote_result(g)[0] is None  # tie
g["votes"] = {"a": "b", "c": "skip", "d": "skip"}
assert G.vote_result(g)[0] is None  # skip wins
print("vote_result ok")

# ---- bad input
err("create", "name", token=tok(1), name="   ")
err("create", "token", token="short", name="Al")
err("join", "no_room", token=tok(1), name="Al", code="ZZZZ")
r = call("nope")
assert not r["ok"]
r = json.loads(anvil.server.call("mc_api", "create", "not json"))
assert not r["ok"] and r["code"] == "bad_input", r

# ---- lobby
v = ok("create", token=tok(0), name="Ana")
code = v["code"]
assert v["host"] == v["me"] and v["phase"] == "lobby" and len(code) == 4
names = ["Ana", "Ben", "Cy", "Dee", "Eve", "Finn", "Gus", "Hal", "Ivy", "Jo"]
pids = {0: v["me"]}
for i in range(1, 10):
  pids[i] = ok("join", token=tok(i), name=names[i], code=code.lower())["me"]
err("join", "full", token=tok(10), name="Kim", code=code)
# same name gets a number
v = ok("join", token=tok(9), name="Ana", code=code)  # rejoin with a new name: unique
assert [p["name"] for p in v["players"] if p["pid"] == pids[9]] == ["Ana 2"], v["players"]
assert len(v["players"]) == 10
# no tokens leak, peer ids do
dump = json.dumps(v)
assert "token-" not in dump
ok("state", token=tok(1), code=code, peer_id="peer-B")
v = ok("state", token=tok(0), code=code, peer_id="peer-A")
assert {p["pid"]: p["peer_id"] for p in v["players"]}[pids[1]] == "peer-B"
# only the host can change settings / start
err("settings", "not_host", token=tok(1), code=code, day_seconds=60)
err("start", "not_host", token=tok(1), code=code)
err("settings", "bad_input", token=tok(0), code=code, day_seconds="x")
err("settings", None, token=tok(0), code=code, day_seconds=61)
v = ok("settings", token=tok(0), code=code, day_seconds=60, prankster=True, reveal_roles=True)
assert v["settings"]["day_seconds"] == 60 and v["settings"]["prankster"]
# kick in the lobby
v = ok("kick", token=tok(0), code=code, pid=pids[9])
assert len(v["players"]) == 9
err("state", "not_in_room", token=tok(9), code=code)
print("lobby ok")

# ---- start
for i in range(9):
  ok("state", token=tok(i), code=code, peer_id="peer-%d" % i)
v = ok("start", token=tok(0), code=code)
assert v["phase"] == "roles"
err("start", None, token=tok(0), code=code)
roles = roles_of(code)
inv = {}
for pid, role in roles.items():
  inv.setdefault(role, []).append(pid)
assert len(inv["mafia"]) == 2 and len(inv["nurse"]) == 1 and len(inv["ranger"]) == 1 and len(inv["prankster"]) == 1
tok_of = {pids[i]: tok(i) for i in range(9)}
name_of = {pids[i]: names[i] for i in range(9)}

# what a camper sees: own role only
camper = inv["camper"][0]
v = ok("state", token=tok_of[camper], code=code)
seen = {p["pid"]: p["role"] for p in v["players"]}
assert seen[camper] == "camper" and sum(1 for r in seen.values() if r) == 1, seen
# what the mafia see: themselves + their team
m1, m2 = inv["mafia"]
v = ok("state", token=tok_of[m1], code=code)
seen = {p["pid"]: p["role"] for p in v["players"]}
assert seen[m1] == "mafia" and seen[m2] == "mafia" and sum(1 for r in seen.values() if r) == 2, seen
assert sorted(v["my"]["team"]) == sorted(inv["mafia"])

# acting during roles fails; then night
err("act", None, token=tok_of[m1], code=code, target=camper)
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "night" and v["day"] == 1, v["phase"]

# ---- night 1: mafia attack camper, nurse saves them
nurse, ranger, prank = inv["nurse"][0], inv["ranger"][0], inv["prankster"][0]
err("act", None, token=tok_of[camper], code=code, target=m1)       # campers have no job
err("act", None, token=tok_of[m1], code=code, target=m2)           # not your own
err("act", None, token=tok_of[ranger], code=code, target=ranger)   # not yourself
ok("act", token=tok_of[m1], code=code, target=camper)
v = ok("state", token=tok_of[m2], code=code)
assert v["my"]["picks"][m1] == camper
v = ok("state", token=tok_of[nurse], code=code)
assert "picks" not in v["my"]
ok("act", token=tok_of[m2], code=code, target=camper)
ok("act", token=tok_of[nurse], code=code, target=camper)
ok("act", token=tok_of[ranger], code=code, target=m1)
room = T.rooms.get(code=code)
assert (G._aware(room["phase_ends"]) - G._now()).total_seconds() <= 3.5  # everybody acted: hurried
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "dawn" and v["result"]["pid"] is None and v["result"].get("saved"), v["result"]
v = ok("state", token=tok_of[ranger], code=code)
assert v["my"]["checks"] == [{"day": 1, "pid": m1, "mafia": True}], v["my"]
v = ok("state", token=tok_of[nurse], code=code)
assert v["my"]["nurse_last"] == camper
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "day"

# ---- day 1: ready majority moves to the vote
alive = list(roles)
for pid in alive[:5]:
  v = ok("ready", token=tok_of[pid], code=code)
assert v["phase"] == "vote", v["phase"]
err("vote", None, token=tok_of[m1], code=code, target=m1)  # not yourself
# everyone votes for mafia m1 -> out
for pid in alive:
  ok("vote", token=tok_of[pid], code=code, target=(m1 if pid != m1 else m2))
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "verdict" and v["result"]["pid"] == m1 and v["result"]["role"] == "mafia", v["result"]
# a ghost sees every role
v = ok("state", token=tok_of[m1], code=code)
assert all(p["role"] for p in v["players"]), v["players"]
assert v["my"]["ghost"]
err("vote", None, token=tok_of[m1], code=code, target=m2)
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "night" and v["day"] == 2

# ---- night 2: nurse can't protect the same person twice; mafia kills the nurse
err("act", None, token=tok_of[nurse], code=code, target=camper)
ok("act", token=tok_of[m2], code=code, target=nurse)
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "dawn" and v["result"]["pid"] == nurse and v["result"]["role"] == "nurse", v["result"]
expire(code)
ok("state", token=tok(0), code=code)
# ---- day 2: vote the prankster out -> prankster wins
ok("skip", token=tok(0), code=code) if T.rooms.get(code=code)["phase"] == "day" else None
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "vote", v["phase"]
for pid, a in T.rooms.get(code=code)["game"]["alive"].items():
  if a and pid != prank:
    ok("vote", token=tok_of[pid], code=code, target=prank)
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "verdict" and v["result"]["role"] == "prankster"
expire(code)
v = ok("state", token=tok(0), code=code)
assert v["phase"] == "over" and v["winner"] == "prankster", (v["phase"], v["winner"])
assert all(p["role"] for p in v["players"])
err("again", "not_host", token=tok(1) if pids[1] != v["host"] else tok(2), code=code)
v = ok("again", token=tok(0), code=code)
assert v["phase"] == "lobby" and all(p["role"] is None for p in v["players"])
print("full game (prankster) ok")

# ---- a mafia win, with a late joiner as spectator and a leaver
v = ok("create", token=tok(20), name="Host")
c2 = v["code"]
for i in range(21, 24):
  ok("join", token=tok(i), name="P%d" % i, code=c2)
ok("start", token=tok(20), code=c2)
spec = ok("join", token=tok(30), name="Late", code=c2)
assert spec["my"]["spectator"] and spec["my"]["ghost"] and spec["my"]["role"] is None
assert not [p for p in spec["players"] if p["pid"] == spec["me"]][0]["playing"]
roles = roles_of(c2)
toks = {}
for i in range(20, 24):
  toks[T.players.get(room=T.rooms.get(code=c2), token=tok(i))["pid"]] = tok(i)
mafia = [p for p, r in roles.items() if r == "mafia"][0]
others = [p for p in roles if p != mafia]
expire(c2)
ok("state", token=tok(20), code=c2)  # night 1
nurse = [p for p, r in roles.items() if r == "nurse"][0]
victim = [p for p in others if p != nurse][0]
ok("act", token=toks[mafia], code=c2, target=victim)
ok("act", token=toks[nurse], code=c2, target=nurse)
expire(c2)
v = ok("state", token=tok(20), code=c2)
assert v["result"]["pid"] == victim
# someone alive leaves -> 1 mafia vs 1 left
leaver = [p for p in others if p != victim and p != mafia][0]
r = ok("leave", token=toks[leaver], code=c2)
assert r == {"left": True}
expire(c2)
v = ok("state", token=toks[mafia], code=c2)
assert v["phase"] == "over" and v["winner"] == "mafia", (v["phase"], v["winner"])
print("mafia win ok")

# ---- host goes away -> someone present takes over
v = ok("create", token=tok(40), name="H")
c3 = v["code"]
ok("join", token=tok(41), name="X", code=c3)
host_row = T.players.get(room=T.rooms.get(code=c3), token=tok(40))
host_row["last_seen"] = G._now() - dt.timedelta(seconds=30)
random.seed(1)
for _ in range(60):
  v = ok("state", token=tok(41), code=c3)
assert v["host"] == v["me"], v["host"]
print("host hand-over ok")
print("ALL OK")
