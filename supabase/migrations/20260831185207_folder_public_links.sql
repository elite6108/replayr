-- Phase 3: public folder links.
-- Anonymous access is Worker/service-role only. Authenticated clients never
-- receive SELECT on the raw token. Folder public != clip public.

alter table public.folders
  add column if not exists public_enabled boolean not null default false,
  add column if not exists allow_public_downloads boolean not null default false,
  add column if not exists public_token_hash text null,
  add column if not exists public_enabled_at timestamptz null;

create unique index if not exists folders_public_token_hash_idx
  on public.folders (public_token_hash)
  where public_token_hash is not null;

-- Raw token is service-role only so members cannot reconstruct the public URL
-- via PostgREST. Lookup uses folders.public_token_hash.
create table public.folder_public_secrets (
  folder_id uuid primary key references public.folders (id) on delete cascade,
  token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.folder_public_secrets enable row level security;
alter table public.folder_public_secrets force row level security;

revoke all on table public.folder_public_secrets from anon, authenticated;
grant select, insert, update, delete on table public.folder_public_secrets to service_role;
