from anvil import *

from ._anvil_designer import TallyTemplate
from ... import mc


class Tally(TallyTemplate):
    """The vote count on the vote and verdict panels. show_for(view) fills it."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._key = None

    def show_for(self, v):
        counts, by = {}, {}
        for p in mc.players(v):
            if p.get("vote"):
                counts[p["vote"]] = counts.get(p["vote"], 0) + 1
                by.setdefault(p["vote"], []).append(p["name"])
        keys = sorted(counts, key=lambda k: -counts[k])
        items = [{"who": "🤷 Skip" if k == "skip" else mc.name_of(v, k), "count": str(counts[k]), "by": ", ".join(by[k])}
                 for k in keys]
        self.visible = bool(items)
        if items != self._key:
            self._key = items
            self.rows.items = items
