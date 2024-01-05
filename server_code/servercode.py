from anvil import server, users, tables

@server.callable
def set_peer_id(peer_id):
  user = users.get_user()
  if user is not None: tables.app_tables.users.get(email=user['email'], signed_up=user['signed_up'])['peer_id_str'] = peer_id

@server.callable
def get_peer_id():
  user=users.get_user()
  if user is not None:
    rows = tables.app_tables.users.search()
    return_array = []
    for i in rows:
      if i['email'] != user['email']:
        return_array.append(i['peer_id_str'])
    return return_array


@server.callable
def a():
  pass

