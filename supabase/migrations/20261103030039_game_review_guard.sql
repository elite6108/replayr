-- Who created a pending game, and force the service-only policies on the
-- match tables so a table owner cannot read around them.
alter table public.games
  add column if not exists created_by uuid references auth.users (id) on delete set null;

create index if not exists games_created_by_pending_idx
  on public.games (created_by)
  where status = 'pending' and created_by is not null;

alter table public.game_matches force row level security;
alter table public.game_match_confirmations force row level security;
alter table public.game_import_state force row level security;
