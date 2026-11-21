from anvil import *

from ._anvil_designer import GhostBetTemplate
from ... import mc, state


class GhostBet(GhostBetTemplate):
    """Ghost bets (2026-11-20): a camper who is out taps a tile (the engine's pick button) to guess who the living
    send home today, or bets on nobody. Scored at the verdict; the Ghost Oracle shows the scores at game over.
    show_for(view) fills it (hidden for the living and for spectators)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._bet = None
        self.box.visible = False

    def show_for(self, v):
        my = v.get("my") or {}
        on = bool(my.get("ghost") and my.get("role")) and v.get("phase") in ("day", "vote")
        self.box.visible = on
        if not on:
            return
        self._bet = my.get("bet")
        if self._bet == "skip":
            self.line.text = "Your bet: nobody goes home today. Tap a tile to change it."
        elif self._bet:
            self.line.text = "Your bet: %s goes home today. Tap another tile to change it." % mc.name_of(v, self._bet)
        else:
            self.line.text = "You can't talk to the living, but you can call it: tap a tile to bet who goes home today."
        nobody = self._bet == "skip"
        self.nobody_button.text = "✓ Betting on nobody" if nobody else "🤷 Bet: nobody goes home"
        self.nobody_button.role = ["btn", "on"] if nobody else ["btn"]
        state.set_control_attr(self.nobody_button, "aria-pressed", "true" if nobody else "false")

    @handle("nobody_button", "click")
    def nobody_button_click(self, **event_args):
        mc.act("bet", target=None if self._bet == "skip" else "skip")
