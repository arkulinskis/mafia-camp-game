from anvil import *

from ._anvil_designer import InviteTemplate
from ... import state


class Invite(InviteTemplate):
    """The invite link to copy by hand, when the browser won't let the page copy it (no clipboard access)."""

    def __init__(self, url="", **properties):
        super().__init__(**properties)
        self.link_box.text = url
        state.set_control_attr(self.link_box, "readonly", "")

    @handle("", "show")
    def form_show(self, **event_args):
        el = state.control(self.link_box)
        getattr(el, "focus")()
        getattr(el, "select")()

    @handle("close_button", "click")
    def close_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=True)
