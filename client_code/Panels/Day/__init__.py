from anvil import *

from ._anvil_designer import DayTemplate
from ... import mc, state


class Day(DayTemplate):
    """Day: talk it out on video; the hot seat (each living camper gets a short turn first, if the host left it on);
    "Ready to vote" (most of the living who are here ready = voting starts early); ghosts bet on the verdict."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._ready = False

    def update(self, v):
        my = v.get("my") or {}
        players = mc.players(v)
        here = [p for p in players if p.get("alive") and p.get("playing") and not p.get("away")]
        ready = len([p for p in here if p.get("ready")])
        r = v.get("result") or {}
        self.news.visible = bool(r.get("text"))
        self.news.text = r.get("text") or ""
        self._hot(v)
        self._ready = bool(my.get("ready"))
        self.ready_button.visible = bool(my.get("alive")) and not my.get("ghost")
        self.ready_button.text = "✋ Ready (tap to undo)" if self._ready else "✋ Ready to vote"
        self.ready_button.role = ["btn", "big", "on"] if self._ready else ["btn", "primary", "big"]
        state.set_control_attr(self.ready_button, "aria-pressed", "true" if self._ready else "false")
        self.count.text = "%d of %d needed to start voting early." % (ready, len(here) // 2 + 1)
        self.ghost_bet.show_for(v)
        self.notebook.show_for(v)

    @handle("ready_button", "click")
    def ready_button_click(self, **event_args):
        mc.act("ready", ready=not self._ready)

    def _hot(self, v):
        hot = v.get("hot")
        self.hot_box.visible = bool(hot)
        if not hot:
            return
        self.hot_box.classes["open"] = bool(hot.get("open"))
        if hot.get("open"):
            self.hot_who.text = "🔥 Everyone has had a turn. Open talk!"
            self.hot_q.visible = False
            return
        secs = int(round(hot.get("left") or 0))
        if hot.get("pid") == v.get("me"):
            who = "🔥 You're in the hot seat (%d s)" % secs
        else:
            who = "🔥 Hot seat %d of %d: %s (%d s)" % (hot.get("n", 1), hot.get("of", 1), mc.name_of(v, hot.get("pid")), secs)
        self.hot_who.text = who
        self.hot_q.visible = True
        self.hot_q.text = hot.get("prompt") or ""
