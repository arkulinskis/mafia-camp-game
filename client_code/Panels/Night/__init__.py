from anvil import *

from ._anvil_designer import NightTemplate
from ... import mc, state


class Night(NightTemplate):
    """Night: the Mafia pick a victim, the Nurse protects, the Ranger checks (all by tapping tiles); everyone else
    sleeps. Ghosts watch the Mafia."""

    def __init__(self, **properties):
        super().__init__(**properties)
        state.heading(self.title, 2)
        state.heading(self.sleep_title, 2)
        state.live(self.note)

    def update(self, v):
        my = v.get("my") or {}
        role = my.get("role")
        day = v.get("day", 0)
        name = lambda pid: mc.name_of(v, pid)  # noqa: E731
        sleeping = my.get("alive") and not my.get("ghost") and role not in ("mafia", "nurse", "ranger")
        self.sleep.visible = bool(sleeping)
        self.job.visible = not sleeping
        self.note.visible = True
        self.notebook.show_for(v)
        ok = False
        if sleeping:
            r = mc.ROLES.get(role or "")
            self.sleep_title.text = "Night %d: you are asleep" % day
            self.sleep_sub.text = ((r["icon"] + " ") if r else "") + \
                "Your camera and mic are off to everyone until morning. Something is moving in the woods…"
            return
        if not my.get("alive") or my.get("ghost"):
            self.title.text = "Night %d" % day
            self.sub.text = ("The camp is asleep. You can watch the Mafia (%s) choose a victim."
                             % ", ".join(name(p) for p in (my.get("team") or [])))
            self.note.visible = False
        elif role == "mafia":
            team = my.get("team") or []
            partners = [p for p in team if p != v.get("me") and mc.by_pid(v, p).get("alive")]
            picks = my.get("picks") or {}
            agree = [picks.get(p) for p in team if mc.by_pid(v, p).get("alive")]
            same = bool(agree) and all(x and x == agree[0] for x in agree)
            self.title.text = "🔪 Pick tonight's victim"
            self.sub.text = ("Only your partners (%s) can see and hear you now. Agree on one name and tap their tile."
                             % ", ".join(name(p) for p in partners) if partners else
                             "You are the last of the Mafia. Tap the camper you want gone.")
            if my.get("pick"):
                ok = same
                self.note.text = ("✓ The Mafia agree: %s." % name(agree[0]) if same else
                                  "You picked %s. %s" % (name(my["pick"]), "If you disagree, the most-picked name (or a coin flip) wins." if partners else ""))
            else:
                self.note.text = "No target yet. If nobody picks, nobody is attacked."
        elif role == "nurse":
            self.title.text = "🩹 Who needs protecting?"
            self.sub.text = "Tap a tile to keep that camper safe tonight. You can pick yourself." + \
                (" Not %s again tonight." % name(my["nurse_last"]) if my.get("nurse_last") else "")
            ok = bool(my.get("pick"))
            self.note.text = "✓ You are watching over %s." % name(my["pick"]) if ok else "Nobody protected yet."
        else:
            self.title.text = "🔦 Shine your flashlight"
            self.sub.text = "Tap a tile to investigate. At dawn you will know if they are Mafia."
            ok = bool(my.get("pick"))
            self.note.text = "✓ Investigating %s." % name(my["pick"]) if ok else "Nobody checked yet."
        self.note.role = ["note", "ok"] if ok else ["note"]
