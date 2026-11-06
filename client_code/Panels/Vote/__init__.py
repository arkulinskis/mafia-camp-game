from anvil import *

from ._anvil_designer import VoteTemplate
from ... import mc, state


class Vote(VoteTemplate):
    """The vote: tap a tile (the engine's pick button) or skip; the count so far."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._vote = None

    def update(self, v):
        my = v.get("my") or {}
        living = bool(my.get("alive")) and not my.get("ghost")
        alive = [p for p in mc.players(v) if p.get("alive") and p.get("playing")]
        voted = len([p for p in alive if p.get("vote")])
        self._vote = my.get("vote")
        self.sub.text = ("Tap a tile to vote. Change your mind any time before the bell. Most votes is sent home; a tie "
                         "sends nobody." if living else "The living are voting.")
        self.vote_row.visible = living
        skipping = self._vote == "skip"
        self.skip_button.text = "✓ Skipping" if skipping else "🤷 Skip vote"
        self.skip_button.role = ["btn", "on"] if skipping else ["btn"]
        state.set_control_attr(self.skip_button, "aria-pressed", "true" if skipping else "false")
        if self._vote and not skipping:
            self.mine.text = "You voted for %s." % mc.name_of(v, self._vote)
        else:
            self.mine.text = "" if self._vote else "You haven't voted yet."
        self.count.text = "%d of %d have voted." % (voted, len(alive))
        self.tally.show_for(v)
        self.notebook.show_for(v)

    @handle("skip_button", "click")
    def skip_button_click(self, **event_args):
        mc.act("vote", target=None if self._vote == "skip" else "skip")
