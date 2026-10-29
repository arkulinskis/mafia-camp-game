from ._anvil_designer import Form1Template
from anvil import *
import anvil.server
import anvil.js
import json

from .. import legal

# Mafia Camp
# ----------
# The whole interface (video grid, game screens, the WebRTC mesh through PeerJS) is plain JavaScript in
# theme/assets/mafia.js, mounted inside this form. This form is only the bridge to the server:
# bridge(action, payload_json) -> JSON string from the server function game.mc_api.
# A Python function called from JavaScript that waits on the server returns a Promise on the JS side.


class Form1(Form1Template):
  def __init__(self, **properties):
    super().__init__(**properties)
    self._mounted = False
    self.add_event_handler('show', self._on_show)

  def _on_show(self, **event_args):
    if self._mounted:
      return
    self._mounted = True
    anvil.js.window.MafiaCamp.mount(anvil.js.get_dom_node(self), self.bridge)
    legal.refresh_soon()

  def bridge(self, action, payload_json):
    try:
      with anvil.server.no_loading_indicator:
        return anvil.server.call_s('mc_api', action, payload_json)
    except Exception as e:
      name = type(e).__name__
      if name == 'SessionExpiredError':
        return json.dumps({'ok': False, 'error': 'Your session expired. Reloading...', 'code': 'session'})
      return json.dumps({'ok': False, 'error': 'Connection hiccup. Trying again...', 'code': 'network'})
