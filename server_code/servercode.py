import anvil.google.auth, anvil.google.drive, anvil.google.mail
from anvil.google.drive import app_files
import anvil.users
import anvil.tables as tables
import anvil.tables.query as q
from anvil.tables import app_tables
import anvil.server

@anvil.server.callable
def set_offer(offer):
  user=anvil.users.get_user()
  if user is not None:
    row = tables.app_tables.users.get(email=user['email'], signed_up=user['signed_up'])
    row['offer2'] = offer
  else:
    pass

@anvil.server.callable
def get_offers():
  user=anvil.users.get_user()
  if user is not None:
    rows = tables.app_tables.users.search()
    return_array = []
    for i in rows:
      if i['email'] != user['email']:
        return_array.append(i['offer2'])
    return return_array

