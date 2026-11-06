"""Page addresses -> page Forms (open_form). Mafia Camp has no accounts and two pages:

    ""  / #home         the home page (start a camp or join one)
    #ABCD               a camp's invite link: the home page with "Join with a code" open and the code filled in
    #watch              the home page, scrolled to the video
    #legal, #legal/x    the Privacy & Terms kit opens its own page over the current one (nothing to do here)
    (the camp)          Pages/Room has no address of its own: once you're in, the address is the camp's invite link
                        (#ABCD, set by the engine) and stays while you play; reloading lands on the join form again
                        ("press Join camp: you keep your seat and your role").
"""
import re

import anvil
import anvil.js
from anvil.js import window

from . import mc

TITLE = "Mafia Camp: a video party game of Mafia for 3 to 10 friends"
_r: dict = {"listening": False, "page": ""}


def parse(hash_text):
    h = (hash_text or "").lstrip("#").lstrip("!").lstrip("/").split("?")[0]
    parts = [window.decodeURIComponent(p) for p in h.split("/") if p]
    return (parts[0] if parts else ""), parts[1:]


def current():
    return _r["page"]


def show():
    """Open the page for the current address."""
    name, args = parse(window.location.hash)
    if name == "legal" and _r["page"]:
        return  # the Privacy & Terms page draws itself over whatever is open
    if mc.in_room():
        return  # in a camp the address is the camp's invite link: nothing to open
    # "#home" (lower case) is the home page itself; invite links are upper case (#ABCD), but any case works
    code = name.upper() if name != "home" and re.match(r"^[A-Za-z]{4}$", name or "") else ""
    window.UI_READY = False
    window.document.title = TITLE
    from .Pages.Home import Home
    page = Home(code=code)
    _r["page"] = "home"
    anvil.open_form(page)
    page.layout.refresh("home")
    window.scrollTo(0, 0)
    window.UI_READY = True  # tests and screenshots wait for this
    if name == "watch":
        page.scroll_to_watch()


def open_room():
    """Called through the engine once this browser is in a camp (create or join worked)."""
    window.UI_READY = False
    window.document.title = "Camp " + str(mc.media().get("code") or "") + " · Mafia Camp"
    from .Pages.Room import Room
    page = Room()
    _r["page"] = "room"
    anvil.open_form(page)
    page.layout.refresh("room")
    window.scrollTo(0, 0)
    window.UI_READY = True


def go_home():
    """Back to the home page (after leaving a camp: the engine has already cleared the address)."""
    show()


def _on_hash(event):
    show()


def _on_click(event):
    """In-app links (<a href="#watch">) only change the hash. Anvil puts a <base href> in the page, so the browser
    would resolve "#watch" against the bare app address and reload the whole app whenever the visitor arrived with
    a query string (?utm_source=...)."""
    if event.defaultPrevented or event.button or event.ctrlKey or event.metaKey or event.shiftKey or event.altKey:
        return
    target = event.target
    link = target.closest("a[href^='#']") if target and getattr(target, "closest", None) else None
    if not link or link.getAttribute("target"):
        return
    event.preventDefault()
    window.location.hash = link.getAttribute("href")


def start():
    if not _r["listening"]:
        window.addEventListener("hashchange", anvil.js.report_exceptions(_on_hash))
        window.document.addEventListener("click", anvil.js.report_exceptions(_on_click))
        _r["listening"] = True
    show()
