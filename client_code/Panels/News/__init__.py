from anvil import *

from ._anvil_designer import NewsTemplate


class News(NewsTemplate):
    """Dawn (who was attacked in the night) and the verdict (who the camp sent home, with the vote count)."""

    def __init__(self, **properties):
        super().__init__(**properties)

    def update(self, v):
        r = v.get("result") or {}
        dawn = v.get("phase") == "dawn"
        self.box.classes["bad"] = bool(r.get("pid"))
        self.box.classes["good"] = not r.get("pid")
        self.dom_nodes["head"].textContent = "🌅 Morning, day %d" % v.get("day", 0) if dawn else "🚌 The verdict"
        self.text.text = r.get("text") or ("The sun comes up over the lake." if dawn else "")
        self.tally.visible = not dawn
        if not dawn:
            self.tally.show_for(v)
