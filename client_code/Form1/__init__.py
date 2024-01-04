from ._anvil_designer import Form1Template
from anvil import *
import anvil.google.auth, anvil.google.drive
from anvil.google.drive import app_files
import anvil.users
import anvil.tables as tables
import anvil.tables.query as q
from anvil.tables import app_tables

import json
import time

from anvil.js.window import RTCPeerConnection, console

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
    lc =  RTCPeerConnection()
    dc = lc.createDataChannel("channel")
    dc.onmessage = lambda e: print("just got a message" + e.data)
    dc.onopen = lambda e: print("connection opened!")
    lc.onicecandidate = lambda e: print("new Ice candidate! reprinting SDP -- " + str(lc.localDescription.sdp) + " -- " + str(lc.localDescription.toJSON))
    o = lc.createOffer()
    time.sleep(5)
    lc.setLocalDescription(o)
    time.sleep(2)
    print("set sucessfully!")
    console.log(lc)