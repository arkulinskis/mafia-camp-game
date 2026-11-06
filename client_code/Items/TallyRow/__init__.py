from anvil import *

from ._anvil_designer import TallyRowTemplate


class TallyRow(TallyRowTemplate):
    """One name in the vote count. item = {who, count, by}."""

    def __init__(self, **properties):
        super().__init__(**properties)
