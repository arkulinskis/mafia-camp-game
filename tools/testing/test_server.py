"""Server tests against the strict mock of Anvil (tools/testing/mock).

    python tools/testing/test_server.py          -> prints ALL OK, or the first failure

The app's server modules become the package `app` (as Anvil lays them out) with the tables from anvil.yaml's own
db_schema, then tools/testing/test_game.py runs: every game rule through game.mc_api (create, join, state, settings,
start, act, ready, vote, skip, again, kick, leave), the pure functions (deal_roles, winner, mafia_target,
vote_result), whole games, host hand-over. Add cases there for every rule change.
"""
import os
import pathlib
import runpy
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
_tmp = pathlib.Path(tempfile.mkdtemp())
shutil.copytree(PROJECT / "server_code", _tmp / "app", ignore=shutil.ignore_patterns("__pycache__"))
(_tmp / "app" / "__init__.py").write_text("")
os.environ["ANVIL_APP_YAML"] = str(PROJECT / "anvil.yaml")  # the mock's tables follow the app's own schema
sys.path[:0] = [str(HERE / "mock"), str(_tmp)]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import anvil.server  # noqa: E402,F401

# Privacy & Terms: no accounts in Mafia Camp, so the kit's state says "signed out".
from app import legal_server  # noqa: E402
st = anvil.server.call("legal_state")
assert st.get("signedIn") is False, st
print("legal_state ok")

runpy.run_path(str(HERE / "test_game.py"), run_name="__main__")
