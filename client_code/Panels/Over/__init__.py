from anvil import *

from ._anvil_designer import OverTemplate
from ... import mc

HEADLINES = {"town": "🏕️ The Campers win!", "mafia": "🔪 The Mafia win!", "prankster": "🤡 The Prankster wins!"}


class Over(OverTemplate):
    """Game over: who won, everyone's role, confetti for the winners; the host starts another round."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._key = None

    def update(self, v):
        my = v.get("my") or {}
        win = v.get("winner")
        role = my.get("role")
        if not role:
            mine = False
        elif win == "prankster":
            mine = role == "prankster"
        elif win == "mafia":
            mine = role == "mafia"
        else:
            mine = mc.ROLES[role]["side"] == "town"
        for w in ("town", "mafia", "prankster"):
            self.box.classes[w] = win == w
        self.dom_nodes["headline"].textContent = HEADLINES.get(win or "", "Game over")
        self.you.visible = bool(role)
        self.you.text = "That includes you. Well played! 🎉" if mine else "Not your side this time."
        items = [{"name": p["name"], "role": mc.role_label(p.get("role")), "alive": bool(p.get("alive")),
                  "color": mc.color(p)} for p in mc.players(v) if p.get("playing")]
        if items != self._key:
            self._key = items
            self.reveal.items = items
        is_host = v.get("host") == v.get("me")
        self.again_button.visible = is_host
        self.wait_note.visible = not is_host
        self.wait_note.text = "%s can start another round." % mc.name_of(v, v.get("host"))
        if mine:
            mc.E.confetti()

    @handle("again_button", "click")
    def again_button_click(self, **event_args):
        mc.act("again")
