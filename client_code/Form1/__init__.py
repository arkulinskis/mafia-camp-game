from ._anvil_designer import Form1Template
from anvil import *
import anvil.server
import anvil.google.auth, anvil.google.drive
from anvil.google.drive import app_files
import anvil.users
import anvil.tables as tables
import anvil.tables.query as q
from anvil.tables import app_tables

import json
import time

from anvil.js.window import RTCPeerConnection, console, JSON, Peer

class Form1(Form1Template):
  def __init__(self, **properties):
    # Set Form properties and Data Bindings.
    self.init_components(**properties)
    self.peer = Peer()
    self.peer.on('open', lambda id: anvil.server.call('set_peer_id', id))
    self.peer.on('connection', lambda conn: self.set_conn(conn))

  def set_conn(self,conn):
    self.conn = conn
    self.conn.on('data', lambda data: console.log('received ', data))
    console.log("connection requested by other and established")
    
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
    # lc.onicecandidate = lambda e: print("new Ice candidate! reprinting SDP -- " + JSON.stringify(lc.localDescription))
    o = lc.createOffer()
    # time.sleep(5)
    lc.setLocalDescription(o)
    # time.sleep(2)
    # print("set sucessfully!")
    # console.log(lc)
    anvil.server.call('set_offer',JSON.stringify(lc.localDescription))

  def link_2_click(self, **event_args):
    offers = anvil.server.call('get_offers')
    offer = json.loads(offers[0])
    print(offer)
    self.rc = RTCPeerConnection()
    self.rc.onicecandidate = lambda e: console.log("New Ice Candidate! reprinting SDP" + JSON.stringify(self.rc.localDescription))
    self.rc.ondatachannel = lambda e: self.fun1(e)
    self.rc.setRemoteDescription(offer)
    a = console.log("offer set!")
    a = self.rc.createAnswer()
    a = self.rc.setLocalDescription(a)
    print("answer created")
    self.rc.dc.send("fine what about you")

  def fun1(self, e):
    self.rc.dc = e.channel; 
    self.rc.dc.onmessage = lambda e: console.log("new message from client! " + e.data); 
    self.rc.dc.onopen = lambda e: console.log("connection OPENED!!!"); 

  def link_4_click(self, **event_args):
    peer_ids = anvil.server.call('get_peer_id')
    peer_id = peer_ids[0]
    self.conn = self.peer.connect(peer_id)
    self.conn.on('open', self.set_conn_yourself)

  def set_conn_yourself(self):
    self.conn.on('data', lambda data: console.log('received ', data))
    console.log("connection requested by myself and established")


  
  def link_3_click(self, **event_args):
    self.conn.send(self.text_box_1.text)

    
