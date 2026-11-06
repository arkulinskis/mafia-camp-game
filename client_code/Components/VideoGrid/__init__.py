from anvil import *

from ._anvil_designer import VideoGridTemplate
from ... import mc


class VideoGrid(VideoGridTemplate):
    """The video tiles. The engine owns them (live streams, speaking glow, covers, pick buttons); this component only
    gives it the element to draw in, when it is on screen."""

    def __init__(self, **properties):
        super().__init__(**properties)

    @handle("", "show")
    def form_show(self, **event_args):
        mc.E.mountGrid(self.dom_nodes["grid"])
