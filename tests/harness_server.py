"""Local harness: the real game server (app.game on the Anvil mock) behind a tiny HTTP server, plus a page that
mounts mafia.js with a fetch() bridge. Listens on several ports so each browser tab is its own origin (own
localStorage = own player). Run through gitapp_test.py:  python tools/gitapp_test.py mafiacamp harness_server.py 8801 8810
FAST=1 shortens every phase so a whole game runs in a minute."""
import json
import os
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anvil.server
from app import game as G

ASSETS = pathlib.Path(os.environ["ANVIL_APP_YAML"]).parent / "theme" / "assets"
LOCK = threading.Lock()
if os.environ.get("FAST"):
  G.FIXED.update({"roles": 4, "dawn": 3, "verdict": 3})
  G.ALLOWED.update({"day_seconds": (8, 60, 90, 120, 180, 240, 300), "night_seconds": (8, 25, 40, 60), "vote_seconds": (8, 25, 35, 50)})
  G.DEFAULT_SETTINGS.update({"day_seconds": 8, "night_seconds": 8, "vote_seconds": 8})

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1530">
<link href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" href="/_/theme/favicon.svg">
<style>%s</style>
<link rel="stylesheet" href="/_/theme/mafia.css">
<script src="/_/theme/legal-kit.js"></script>
<script src="/_/theme/peerjs.min.js"></script>
<script src="/_/theme/mafia.js"></script>
</head><body><div id="form"><div class="mc-mount"></div></div>
<script>
function bridge(a, j) { return fetch('/api', {method: 'POST', body: JSON.stringify({a: a, j: j})}).then(function (r) { return r.text(); }); }
MafiaCamp.mount(document.getElementById('form'), bridge);
</script></body></html>"""


class H(BaseHTTPRequestHandler):
  def log_message(self, *a):
    pass

  def _send(self, code, body, ctype):
    data = body.encode("utf-8") if isinstance(body, str) else body
    self.send_response(code)
    self.send_header("Content-Type", ctype)
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(data)

  def do_GET(self):
    path = self.path.split("?")[0].split("#")[0]
    if path in ("/", "/index.html"):
      return self._send(200, PAGE % (ASSETS / "theme.css").read_text(encoding="utf-8"), "text/html; charset=utf-8")
    if path.startswith("/_/theme/"):
      f = ASSETS / path[len("/_/theme/"):]
      if f.is_file():
        ctype = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png"}.get(f.suffix, "application/octet-stream")
        return self._send(200, f.read_bytes(), ctype + ("; charset=utf-8" if f.suffix in (".js", ".css") else ""))
    if path == "/debug":
      from anvil.tables import app_tables as T
      rooms = [{"code": r["code"], "phase": r["phase"], "roles": (r["game"] or {}).get("roles")} for r in T.rooms.search()]
      return self._send(200, json.dumps(rooms), "application/json")
    self._send(404, "not found", "text/plain")

  def do_POST(self):
    n = int(self.headers.get("Content-Length") or 0)
    req = json.loads(self.rfile.read(n) or b"{}")
    with LOCK:
      out = anvil.server.call("mc_api", req["a"], req["j"])
    self._send(200, out, "application/json")


ports = [int(x) for x in sys.argv[1:]] or [8801]
if len(ports) == 2 and ports[1] > ports[0] + 1:
  ports = list(range(ports[0], ports[1] + 1))
servers = [ThreadingHTTPServer(("127.0.0.1", p), H) for p in ports]
for s in servers[1:]:
  threading.Thread(target=s.serve_forever, daemon=True).start()
print("harness on ports", ports, flush=True)
servers[0].serve_forever()
