from anvil import *

from ._anvil_designer import LobbyTemplate
from ... import mc, state

CHOICES = {
    "day_seconds": [60, 90, 120, 180, 240, 300],
    "night_seconds": [25, 40, 60],
    "vote_seconds": [25, 35, 50],
}


def _fmt(key, x):
    return (str(x) + "s" if x < 120 else "%g min" % (x / 60)) if key == "day_seconds" else str(x) + "s"


def mafia_count(n):
    return 1 if n <= 5 else (2 if n <= 9 else 3)


class Lobby(LobbyTemplate):
    """Around the campfire, before a game: who is here, the invite code and link, the host's game settings
    (talk / night / vote times, reveal roles, the Prankster) and Start; everyone else waits for the host."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._settings = None
        self._v = {}
        for panel in (self.day_chips, self.night_chips, self.vote_chips):
            panel.add_event_handler("x-pick", self._pick)

    def update(self, v):
        self._v = v
        players = mc.players(v)
        present = len([p for p in players if not p.get("away")])
        self.count.text = "%d of %d campers here" % (len(players), v.get("max_players", 10))
        code = v.get("code") or "    "
        for i, node in enumerate((self.dom_nodes["c0"], self.dom_nodes["c1"], self.dom_nodes["c2"], self.dom_nodes["c3"])):
            node.textContent = code[i] if i < len(code) else ""
        state.set_attr(self.inv_code, "aria-label", "Camp code " + " ".join(code))
        is_host = v.get("host") == v.get("me")
        self.settings.visible = is_host
        self.start_box.visible = is_host
        self.wait_note.visible = not is_host
        if is_host:
            s = v.get("settings") or {}
            if s != self._settings:
                self._settings = dict(s)
                key = state.focus_key()
                for panel, name in ((self.day_chips, "day_seconds"), (self.night_chips, "night_seconds"),
                                    (self.vote_chips, "vote_seconds")):
                    panel.items = [{"key": name, "value": x, "label": _fmt(name, x), "on": x == s.get(name)}
                                   for x in CHOICES[name]]
                    state.refocus(panel, key)
                for el, name in ((self.reveal_switch, "reveal_roles"), (self.prank_switch, "prankster")):
                    el.classes["on"] = bool(s.get(name))
                    state.set_attr(el, "aria-checked", "true" if s.get(name) else "false")
            enough = present >= v.get("min_players", 3)
            self.start_button.enabled = enough
            self.start_button.text = ("🔥 Start the game (%d campers)" % present if enough else
                                      "Waiting for campers (%d/%d)" % (present, v.get("min_players", 3)))
            self.start_note.text = "Best with 6 to 10. %d Mafia for %d players." % (mafia_count(present), present)
        else:
            self.wait_note.text = ("🔥 %s (the host) starts the game when everyone is here. Meanwhile, check your tile: "
                                   "it glows when you talk." % mc.name_of(v, v.get("host")))

    def _pick(self, key, value, **event_args):
        mc.act("settings", **{key: value})

    def reveal_click(self, event):
        mc.act("settings", reveal_roles=not (self._settings or {}).get("reveal_roles"))

    def prank_click(self, event):
        mc.act("settings", prankster=not (self._settings or {}).get("prankster"))

    @handle("invite_button", "click")
    def invite_button_click(self, **event_args):
        mc.E.copyInvite()

    @handle("start_button", "click")
    def start_button_click(self, **event_args):
        mc.act("start")
