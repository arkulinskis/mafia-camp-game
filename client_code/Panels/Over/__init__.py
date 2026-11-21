from anvil import *

from anvil.js import window

from ._anvil_designer import OverTemplate
from ... import mc, state

HEADLINES = {"town": "🏕️ The Campers win!", "mafia": "🔪 The Mafia win!", "prankster": "🤡 The Prankster wins!"}
APP_URL = "https://mafia-camp-game.anvil.app"


class Over(OverTemplate):
    """Game over: who won, everyone's role, confetti for the winners, the camp superlatives (awards from what
    happened), the Ghost Oracle (how the ghosts' bets went), "Copy the camp story" to paste in the group chat;
    the host starts another round."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._key = None
        self._akey = None
        self._story = ""

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
        headline = HEADLINES.get(win or "", "Game over")
        self.dom_nodes["headline"].textContent = headline
        self.you.visible = bool(role)
        self.you.text = "That includes you. Well played! 🎉" if mine else "Not your side this time."
        playing = [p for p in mc.players(v) if p.get("playing")]
        items = [{"name": p["name"], "role": mc.role_label(p.get("role")), "alive": bool(p.get("alive")),
                  "color": mc.color(p)} for p in playing]
        if items != self._key:
            self._key = items
            self.reveal.items = items
        awards = [dict(a, name=mc.name_of(v, a.get("pid"))) for a in (v.get("awards") or [])]
        if awards != self._akey:
            self._akey = awards
            self.awards.items = awards
        self.awards_box.visible = bool(awards)
        oracle = v.get("oracle") or []
        self.oracle_box.visible = bool(oracle)
        self.oracle.text = " · ".join("%s %d/%d" % (mc.name_of(v, o["pid"]), o.get("right", 0), o.get("tries", 0))
                                      for o in oracle)
        self._story = self._make_story(v, headline, items, awards)
        is_host = v.get("host") == v.get("me")
        self.again_button.visible = is_host
        self.wait_note.visible = not is_host
        self.wait_note.text = "%s can start another round." % mc.name_of(v, v.get("host"))
        if mine:
            mc.E.confetti()

    def _make_story(self, v, headline, items, awards):
        lines = ["Mafia Camp, camp %s: %s" % (v.get("code") or "", headline), ""]
        for e in v.get("events") or []:
            if e.get("kind") in ("dawn", "verdict"):
                lines.append("Day %s: %s" % (e.get("day"), e.get("text")))
        lines.append("")
        lines.append("Who was who: " + ", ".join("%s (%s%s)" % (i["name"], i["role"], "" if i["alive"] else ", out")
                                                  for i in items))
        for a in awards:
            lines.append("%s %s: %s. %s" % (a.get("icon"), a.get("title"), a.get("name"), a.get("why")))
        lines.append("")
        lines.append("Play a round with your friends: " + APP_URL)
        return "\n".join(lines)

    @handle("copy_button", "click")
    def copy_button_click(self, **event_args):
        try:
            window.navigator.clipboard.writeText(self._story)
            state.toast("Camp story copied. Paste it in your group chat!")
        except Exception:
            alert(TextArea(text=self._story, height=260), title="The camp story", large=False, buttons=[("Done", True)],
                  role="app-dialog")

    @handle("again_button", "click")
    def again_button_click(self, **event_args):
        mc.act("again")
