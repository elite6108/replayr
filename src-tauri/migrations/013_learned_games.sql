create table if not exists install_identity (
  id integer primary key check (id = 1),
  install_id text not null
);

create table if not exists learned_games (
  process_name text primary key,
  window_title text not null,
  last_seen_at text not null
);
