from anvil import *
import anvil.js

from ._anvil_designer import RoomTemplate
from ... import mc, state

GAME_PHASES = ("roles", "night", "dawn", "day", "vote", "verdict")


def _panel_form(phase):
    """The side panel's Form for a phase (one instance per phase change, so its entrance animations play once)."""
    if phase == "roles":
        from ...Panels.Roles import Roles
        return Roles()
    if phase == "night":
        from ...Panels.Night import Night
        return Night()
    if phase in ("dawn", "verdict"):
        from ...Panels.News import News
        return News()
    if phase == "day":
        from ...Panels.Day import Day
        return Day()
    if phase == "vote":
        from ...Panels.Vote import Vote
        return Vote()
    if phase == "over":
        from ...Panels.Over import Over
        return Over()
    from ...Panels.Lobby import Lobby
    return Lobby()


class Room(RoomTemplate):
    """The camp (no address of its own: the browser bar shows the invite link #ABCD). The video tiles are the engine's
    (Components/VideoGrid); this page draws the bar (camp code, phase and clock), the side panel for the phase
    (Panels/*), the story so far and the dock (mic, camera, story, sounds, leave). mc.py hands it every new view
    (the 2 s poll and every action) through update()."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self._panel_key = ""
        self._panel = None
        self._story_key = (-1, "")
        self.story_open = False
        self.dom_nodes["cc_code"].textContent = mc.media().get("code") or ""
        self.dom_nodes["title"].textContent = "Mafia Camp: camp " + (mc.media().get("code") or "")

    @handle("", "show")
    def form_show(self, **event_args):
        mc.E.bindClock(self.dom_nodes["ph_timer"], self.dom_nodes["bar"])
        mc.attach(self)
        v = mc.view()
        if v:
            self.update(v)
        self.update_dock()

    @handle("", "hide")
    def form_hide(self, **event_args):
        mc.attach(None)

    # ---- every new view
    def update(self, v):
        phase = v.get("phase") or "lobby"
        my = v.get("my") or {}
        is_host = v.get("host") == v.get("me")
        state.set_attr(self.room, "data-phase", phase)
        self.room.classes["ghost-me"] = bool(my.get("ghost"))
        icon, label = mc.PHASES.get(phase, mc.PHASES["lobby"])
        self.dom_nodes["ph_ic"].textContent = icon
        self.dom_nodes["ph_label"].textContent = label + (" %d" % v.get("day", 0) if phase in ("night", "day", "vote") else "")

        role = mc.ROLES.get(my.get("role") or "")
        self.role_pill.visible = bool(role) and phase != "roles"
        if role:
            self.dom_nodes["rp_value"].textContent = role["icon"] + " " + role["name"]
            for side in ("mafia", "town", "alone"):
                self.role_pill.classes[side] = role["side"] == side
        self.timebar.visible = phase not in ("lobby", "over") and v.get("remaining") is not None

        key = phase + "|" + str(v.get("day", 0))
        if key != self._panel_key:
            self._panel_key = key
            self.phase_slot.clear()
            self._panel = _panel_form(phase)
            self.phase_slot.add_component(self._panel)
        panel = self._panel
        if panel is not None:
            panel.update(v)

        ghost = bool(my.get("ghost")) and phase != "over"
        self.ghost_note.visible = ghost
        if ghost:
            self.ghost_note.text = ("👻 The game had already started, so you are watching this round as a ghost. You can see "
                                    "everyone's role and talk with other ghosts. The living can't hear you. You will play "
                                    "the next round." if my.get("spectator") else
                                    "👻 You are out, so you are a ghost now. You see every role, watch the Mafia at night and "
                                    "can talk with other ghosts. The living can't hear you.")
        self.host_row.visible = is_host and phase in GAME_PHASES
        self._story(v.get("events") or [])

    def _story(self, events):
        last = events[-1].get("text") if events else ""
        if (len(events), last) == self._story_key:
            return
        self._story_key = (len(events), last)
        self.story_empty.visible = not events
        self.story_head.visible = bool(events)
        self.story_panel.items = list(reversed(events))

    def update_dock(self):
        m = mc.media()
        self.mic_btn.classes["off"] = not m["mic"]
        self.dom_nodes["mic_ic"].textContent = "🎙️" if m["mic"] else "🔇"
        self.dom_nodes["mic_l"].textContent = "Mic on" if m["mic"] else "Muted"
        state.set_attr(self.mic_btn, "aria-pressed", "false" if m["mic"] else "true")
        state.set_attr(self.mic_btn, "aria-label", "Mute microphone" if m["mic"] else "Microphone muted: turn it on")
        self.cam_btn.classes["off"] = not m["cam"]
        self.dom_nodes["cam_ic"].textContent = "📷" if m["cam"] else "🚫"
        self.dom_nodes["cam_l"].textContent = "Camera" if m["cam"] else "Cam off"
        state.set_attr(self.cam_btn, "aria-label", "Turn camera off" if m["cam"] else "Camera off: turn it on")
        self.sound_btn.classes["off"] = not m["sound"]
        self.dom_nodes["sound_ic"].textContent = "🔔" if m["sound"] else "🔕"
        state.set_attr(self.sound_btn, "aria-pressed", "true" if m["sound"] else "false")
        self.story_btn.classes["on"] = self.story_open
        state.set_attr(self.story_btn, "aria-expanded", "true" if self.story_open else "false")
        self.room.classes["story-open"] = self.story_open

    # ---- the bar and the dock
    def code_click(self, event):
        mc.E.copyInvite()

    def mic_click(self, event):
        mc.E.toggleMic()

    def cam_click(self, event):
        mc.E.toggleCam()

    def sound_click(self, event):
        mc.E.toggleSound()

    def story_click(self, event):
        self.story_open = not self.story_open
        self.update_dock()

    def leave_click(self, event):
        mc.E.leave()

    @handle("skip_button", "click")
    def skip_button_click(self, **event_args):
        if confirm("Skip to the next phase now?", buttons=[("Cancel", False), ("Skip ahead", True)]):
            mc.act("skip")
