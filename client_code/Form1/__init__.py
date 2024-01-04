from ._anvil_designer import Form1Template
from anvil import server, users
from anvil.js.window import console, Peer

class Form1(Form1Template):
  def __init__(self, **properties):
    self.init_components(**properties)
    self.peer = Peer()
    self.peer.on('open', lambda id: server.call('set_peer_id', id))
    self.peer.on('connection', lambda conn: self.set_conn(conn))

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
    peer_id = peer_ids[0]
    self.conn = self.peer.connect(peer_id)
    self.conn.on('open', self.set_conn_yourself)

  def set_conn_yourself(self):
    self.conn.on('data', lambda data: console.log('received ', data))
    console.log("connection requested by myself and established")

  def link_3_click(self, **event_args):
    self.conn.send(self.text_box_1.text)

    
