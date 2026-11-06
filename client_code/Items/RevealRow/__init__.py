from anvil import *

from ._anvil_designer import RevealRowTemplate


class RevealRow(RevealRowTemplate):
    """One player in the game-over reveal. item = {name, role, alive, color}."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.out.visible = not self.item["alive"]
        self.row.classes["out"] = not self.item["alive"]
        self.dom_nodes["dot"].style.background = self.item["color"]
