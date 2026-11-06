"""The app starts here (anvil.yaml: startup module). Mafia Camp has no accounts: connect the engine (theme/assets/
mc-engine.js) to the server, the Privacy & Terms kit, then the page for the address (home, or an invite link #ABCD)."""
from . import legal, mc, router

mc.setup()
router.start()
legal.refresh_soon()
