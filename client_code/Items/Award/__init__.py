from anvil import *

from ._anvil_designer import AwardTemplate


class Award(AwardTemplate):
    """One end-of-game award (Camp Superlatives). item = {icon, title, name, why}."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.dom_nodes["icon"].textContent = self.item.get("icon") or ""
        self.title.text = "%s: %s" % (self.item.get("title") or "", self.item.get("name") or "")
