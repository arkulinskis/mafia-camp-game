"""Mafia Camp's JavaScript engine (theme/assets/mc-engine.js, window.MafiaCamp) seen from Python.

The engine owns everything that streams or draws: camera + mic, the WebRTC video mesh and who-hears-whom routing,
the 2 s `state` poll, the phase clock, the video tiles (pick / vote / kick buttons on them), sounds, music, confetti.
The pages, panels and dialogs are Forms; they reach the engine only through this module:

    mc.setup()                   once at start-up: the server bridge + mc.host (the Python callbacks the engine uses)
    mc.enter(action, name, code, status)   "create" / "join"; True once in the camp (then Pages/Room opens itself)
    mc.act(action, **payload)    a game action (start, settings, act, ready, vote, skip, again, kick); the new view comes
                                 back through the view callback
    mc.view()                    the last view from the server (a dict) or None; mc.attach(room) gets every new one
    mc.ROLES                     the roles (name, icon, side, short, long) from the engine, as Python dicts
    mc.E                         window.MafiaCamp itself (mountGrid, bindClock, toggleMic, media ...)
"""
import json

import anvil
import anvil.js
import anvil.server
from anvil import alert, confirm
from anvil.js import window

from . import state

E = window.MafiaCamp
_s: dict = {"view": None, "room": None}


def py_value(x):
    """JS -> plain Python (dicts, lists, str, numbers)."""
    if x is None:
        return None
    return json.loads(window.JSON.stringify(x))


def js_value(x):
    """Python -> a real JS object (not a proxy of a Python dict)."""
    return window.JSON.parse(json.dumps(x))


ROLES = py_value(E.roles)
COLORS = py_value(E.colors)
PHASES = {
    "lobby": ("🔥", "Campfire"), "roles": ("🎭", "Roles"), "night": ("🌙", "Night"), "dawn": ("🌅", "Dawn"),
    "day": ("☀️", "Day"), "vote": ("🗳️", "Vote"), "verdict": ("🚌", "Verdict"), "over": ("🏁", "Game over"),
}


# ---------------------------------------------------------------- the server bridge (was Form1.bridge)
def bridge(action, payload_json):
    """JSON text in, JSON text out: the engine's only way to the server (game.mc_api). No spinner: it polls."""
    try:
        with anvil.server.no_loading_indicator:
            return anvil.server.call_s("mc_api", action, payload_json)
    except Exception as e:
        if type(e).__name__ == "SessionExpiredError":
            return json.dumps({"ok": False, "error": "Your session expired. Reloading...", "code": "session"})
        return json.dumps({"ok": False, "error": "Connection hiccup. Trying again...", "code": "network"})


# ---------------------------------------------------------------- what the engine asks Python to do
def _toast(msg, kind=""):
    state.toast(msg, "error" if kind == "warn" else None)


def _confirm(text, yes="OK"):
    return bool(confirm(text, buttons=[("Cancel", False), (yes, True)]))


def _view(view_json):
    v = json.loads(view_json)
    _s["view"] = v
    room = _s["room"]
    if room is not None:
        room.update(v)


def _entered():
    from . import router
    router.open_room()


def _left(msg=""):
    from . import router
    _s["view"] = None
    _s["room"] = None
    router.go_home()
    if msg:
        state.toast(msg)


def _dock():
    room = _s["room"]
    if room is not None:
        room.update_dock()


def _copy(url):
    from .Dialogs.Invite import Invite
    alert(Invite(url=url), buttons=[], role="app-dialog", title="Invite link")


def setup():
    host = js_value({})
    for name, fn in (("toast", _toast), ("confirm", _confirm), ("view", _view), ("entered", _entered),
                     ("left", _left), ("dock", _dock), ("copy", _copy)):
        host[name] = fn
    E.init(bridge, host)


# ---------------------------------------------------------------- for the Forms
def enter(action, name, code, status=None):
    return bool(E.enter(action, name, code, status))


def act(action, **payload):
    E.act(action, json.dumps(payload))


def view():
    return _s["view"]


def attach(room):
    """The Room page that shows every new view (None when it closes)."""
    _s["room"] = room


def in_room():
    return bool(E.inRoom())


def media():
    return py_value(E.media())


def saved(key):
    return str(E.saved(key) or "")


def players(v):
    return (v or {}).get("players") or []


def name_of(v, pid):
    for p in players(v):
        if p["pid"] == pid:
            return p["name"]
    return "someone"


def by_pid(v, pid):
    for p in players(v):
        if p["pid"] == pid:
            return p
    return {}


def color(p):
    return COLORS[((p.get("seat") or 1) - 1) % len(COLORS)]


def role_label(role):
    r = ROLES.get(role or "")
    return (r["icon"] + " " + r["name"]) if r else "?"
