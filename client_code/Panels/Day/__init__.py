from anvil import *

from ._anvil_designer import DayTemplate
from ... import mc, state


class Day(DayTemplate):
    """Day: talk it out on video; "Ready to vote" (most of the living ready = voting starts early)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._ready = False

    def update(self, v):
        my = v.get("my") or {}
        players = mc.players(v)
        alive = len([p for p in players if p.get("alive") and p.get("playing")])
        ready = len([p for p in players if p.get("ready")])
        r = v.get("result") or {}
        self.news.visible = bool(r.get("text"))
        self.news.text = r.get("text") or ""
        self._ready = bool(my.get("ready"))
        self.ready_button.visible = bool(my.get("alive")) and not my.get("ghost")
        self.ready_button.text = "✋ Ready (tap to undo)" if self._ready else "✋ Ready to vote"
        self.ready_button.role = ["btn", "big", "on"] if self._ready else ["btn", "primary", "big"]
        state.set_control_attr(self.ready_button, "aria-pressed", "true" if self._ready else "false")
        self.count.text = "%d of %d needed to start voting early." % (ready, alive // 2 + 1)
        self.notebook.show_for(v)

    @handle("ready_button", "click")
    def ready_button_click(self, **event_args):
        mc.act("ready", ready=not self._ready)
