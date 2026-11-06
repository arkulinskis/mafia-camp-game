import datetime

from anvil import *

from ._anvil_designer import ShellTemplate


class Shell(ShellTemplate):
    """The frame around both pages: the sky (stars, horizon and pines, coloured by html[data-sky]), the home page's
    header and its footer (Submit feedback, Privacy & Terms, Contact developer, Parent company).
    In a camp the Room page is full-screen: refresh("room") adds the class "immersive", which hides both.

    Anvil keeps ONE Shell while pages come and go (open_form only swaps the "content" slot when the layout matches),
    so everything that depends on the open page is set in refresh(), which the router calls after every page change."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.copyright_label.text = "© %d Arkvital" % datetime.date.today().year
        self.refresh("")

    def refresh(self, page):
        self.classes["immersive"] = page == "room"
