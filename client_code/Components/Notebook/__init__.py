from anvil import *

from ._anvil_designer import NotebookTemplate
from ... import mc


class Notebook(NotebookTemplate):
    """The Ranger's notebook on the night, day and vote panels. show_for(view) fills it (hidden for everyone else)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._key = None
        self.box.visible = False

    def show_for(self, v):
        my = v.get("my") or {}
        checks = my.get("checks") or [] if my.get("role") == "ranger" else []
        items = [{"text": "Night %s: %s %s" % (c["day"], mc.name_of(v, c["pid"]), "is Mafia!" if c["mafia"] else "is innocent."),
                  "mafia": bool(c["mafia"])} for c in checks]
        self.box.visible = bool(items)
        if items != self._key:
            self._key = items
            self.rows.items = items
