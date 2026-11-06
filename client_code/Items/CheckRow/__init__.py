from anvil import *

from ._anvil_designer import CheckRowTemplate


class CheckRow(CheckRowTemplate):
    """One line of the Ranger's notebook. item = {text, mafia}."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.text.role = ["check-mafia"] if self.item.get("mafia") else []
