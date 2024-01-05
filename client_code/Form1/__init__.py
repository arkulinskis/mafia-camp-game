from ._anvil_designer import Form1Template
from anvil import server, users, js
from anvil.js.window import console, Peer, navigator

class Form1(Form1Template):
  def __init__(self, **properties):
    self.init_components(**properties)
    self.peer = Peer()
    self.peer.on('open', lambda id: server.call('set_peer_id', id))
    self.peer.on('connection', lambda conn: self.set_conn(conn))
    self.localStream = js.call('start_stream')
    js.get_dom_node(self.vb_me).firstElementChild.srcObject = self.localStream
    self.peer.on('call', lambda call: self.answer_call(call))

  def answer_call(self, call):
    self.call = call
    self.call.answer(self.localStream)
    self.call.on('stream', lambda stream: self.fun(stream))

  def fun(self, stream):
    js.get_dom_node(self.vb_them).firstElementChild.srcObject = stream
    
  def set_conn(self,conn):
    self.conn = conn
    self.conn.on('data', lambda data: console.log('received ', data))
    console.log("connection requested by other and established")
    
  def signupin_click(self, **event_args):
    if users.get_user() is None:
      self.user = users.login_with_form()
    else:
      users.logout()

  def link_4_click(self, **event_args):
    peer_ids = server.call('get_peer_id')
    self.peer_id = peer_ids[0]
    self.conn = self.peer.connect(self.peer_id)
    self.conn.on('open', self.set_conn_yourself)

  def set_conn_yourself(self):
    self.conn.on('data', lambda data: console.log('received ', data))
    console.log("connection requested by myself and established")

  def link_3_click(self, **event_args):
    self.conn.send(self.text_box_1.text)

  def link_1_click(self, **event_args):
    self.call = self.peer.call(self.peer_id, self.localStream)
    self.call.on('stream', lambda stream: self.fun(stream))
    

    
