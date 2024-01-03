from ._anvil_designer import Form1Template
from anvil import *
import anvil.google.auth, anvil.google.drive
from anvil.google.drive import app_files
import anvil.users
import anvil.tables as tables
import anvil.tables.query as q
from anvil.tables import app_tables

from anvil.js.window import RTCPeerConnection

class Form1(Form1Template):
  def __init__(self, **properties):
    # Set Form properties and Data Bindings.
    self.init_components(**properties)

    # Any code you write here will run before the form opens.

  def signupin_click(self, **event_args):
    if anvil.users.get_user() is None:
      self.user = anvil.users.login_with_form()
    else:
      anvil.users.logout()

  def link_1_click(self, **event_args):
    lc = RTCPeerConnection()
    dc = lc.createDataChannel("channel")
    dc.onmessage(print("just got a message" + e.data))
    dc.onopen = e => console.log("connection opened!");
    lc.onicecandidate = e => console.log("new Ice candidate! reprinting SDP" + JSON.stringify(lc.localDescription));
    lc.createOffer().then(o => lc.setLocalDescription(o)).then(a=>console.log("set sucessfully!"));
