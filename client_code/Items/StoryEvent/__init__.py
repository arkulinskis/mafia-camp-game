from anvil import *

from ._anvil_designer import StoryEventTemplate


class StoryEvent(StoryEventTemplate):
    """One line of the story so far. item = {day, kind, text} from the server's game events."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.when.text = "Day %d" % self.item["day"] if self.item.get("day") else "Start"
        self.row.classes["ev-" + str(self.item.get("kind") or "")] = True
