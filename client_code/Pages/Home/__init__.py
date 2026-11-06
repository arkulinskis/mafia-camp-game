import re

from anvil import *
import anvil.js
from anvil.js import window

from ._anvil_designer import HomeTemplate
from ... import mc, state


class Home(HomeTemplate):
    """The home page ("" or an invite link #ABCD): what the game is, and the card to start a camp or join one.
    Joining runs in the engine (camera, server, video call); once in, the engine opens Pages/Room through mc.py."""

    def __init__(self, code="", **properties):
        super().__init__(**properties)
        self.mode = "join" if code else "create"
        self.name_box.text = mc.saved("name")
        self.code_box.text = code
        self.back_note.visible = bool(code) and mc.saved("room") == code
        state.set_control_attr(self.name_box, "maxlength", 16)
        state.set_control_attr(self.name_box, "autocomplete", "nickname")
        state.set_control_attr(self.code_box, "maxlength", 4)
        state.set_control_attr(self.code_box, "autocomplete", "off")
        state.set_control_attr(self.code_box, "autocapitalize", "characters")
        state.set_control_attr(self.code_box, "spellcheck", "false")
        state.set_control_attr(self.code_box, "aria-label", "Camp code")
        self._set_mode(self.mode)
        mc.E.homeSky()

    @handle("", "show")
    def form_show(self, **event_args):
        if not self.name_box.text:
            window.setTimeout(lambda: state.focus(self.name_box), 50)

    def scroll_to_watch(self):
        anvil.js.get_dom_node(self.watch).scrollIntoView()

    # ---- start or join
    def _set_mode(self, mode):
        self.mode = mode
        self.tab_create.classes["on"] = mode == "create"
        self.tab_join.classes["on"] = mode == "join"
        self.code_row.visible = mode == "join"
        self.go_button.text = "Start a camp" if mode == "create" else "Join camp"

    def tab_create_click(self, event):
        self._set_mode("create")

    def tab_join_click(self, event):
        self._set_mode("join")
        state.focus(self.code_box)

    @handle("code_box", "change")
    def code_box_change(self, **event_args):
        clean = re.sub(r"[^A-Z]", "", (self.code_box.text or "").upper())[:4]
        if clean != self.code_box.text:
            self.code_box.text = clean

    @handle("name_box", "pressed_enter")
    def name_box_pressed_enter(self, **event_args):
        self.go_button_click()

    @handle("code_box", "pressed_enter")
    def code_box_pressed_enter(self, **event_args):
        self.go_button_click()

    @handle("go_button", "click")
    def go_button_click(self, **event_args):
        if not self.go_button.enabled:
            return
        code = (self.code_box.text or "").strip().upper()
        if self.mode == "join" and len(code) != 4:
            state.toast("Camp codes have 4 letters.", "error")
            state.focus(self.code_box)
            return
        self.go_button.enabled = False
        ok = mc.enter(self.mode, self.name_box.text or "", code if self.mode == "join" else "", self._status)
        if not ok:  # (on success the Room page has already replaced this one)
            self.go_button.enabled = True
            self._set_mode(self.mode)

    def _status(self, step):
        self.go_button.text = "Checking your camera…" if step == "camera" else "Walking to camp…"
