from anvil import *

from ._anvil_designer import RolesTemplate
from ... import mc


class Roles(RolesTemplate):
    """The role card that flips in when the game starts (Mafia also see their partners)."""

    def __init__(self, **properties):
        super().__init__(**properties)

    def update(self, v):
        my = v.get("my") or {}
        role = mc.ROLES.get(my.get("role") or "")
        self.watching.visible = not role
        self.card.visible = self.hint.visible = bool(role)
        if not role:
            return
        for side in ("mafia", "town", "alone"):
            self.card.classes[side] = role["side"] == side
        self.dom_nodes["icon"].textContent = role["icon"]
        self.dom_nodes["name"].textContent = role["name"]
        self.long.text = role["long"]
        team = [pid for pid in (my.get("team") or []) if pid != v.get("me")]
        self.team.visible = my.get("role") == "mafia" and bool(team)
        self.team.text = "Your partners: " + ", ".join(mc.name_of(v, pid) for pid in team)
