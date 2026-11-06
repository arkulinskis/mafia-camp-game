from anvil import *

from ._anvil_designer import ChipTemplate
from ... import state


class Chip(ChipTemplate):
    """One choice in a lobby setting (talk time, night, voting). item = {key, value, label, on}.
    A click goes to Panels/Lobby as the event x-pick (it sends the setting to the server)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.chip.role = ["chip", "on"] if self.item["on"] else ["chip"]
        state.set_control_attr(self.chip, "aria-pressed", "true" if self.item["on"] else "false")
        state.set_control_attr(self.chip, "data-key", "%s-%s" % (self.item["key"], self.item["value"]))

    @handle("chip", "click")
    def chip_click(self, **event_args):
        if self.parent is not None:
            self.parent.raise_event("x-pick", key=self.item["key"], value=self.item["value"])
