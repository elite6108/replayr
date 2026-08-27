-- Bunny Stream branded-download variants (free tier). Service-role only for
-- processor ids / ingest tokens. Clients keep the existing public watermark flag.

alter table public.clips
  add column if not exists watermark_variant_status text not null default 'none',
  add column if not exists watermark_processor text,
  add column if not exists watermark_processor_video_id text,
  add column if not exists watermark_resolution int,
  add column if not exists watermark_render_version int,
  add column if not exists watermark_error text,
  add column if not exists watermark_updated_at timestamptz;

alter table public.clips
  drop constraint if exists clips_watermark_variant_status_check;

alter table public.clips
  add constraint clips_watermark_variant_status_check
  check (watermark_variant_status in ('none', 'submitting', 'processing', 'ready', 'failed'));

create index if not exists clips_watermark_variant_reconcile_idx
  on public.clips (watermark_variant_status, watermark_updated_at);

-- Re-assert column grants so processor fields stay service-role only.
revoke select on table public.clips from anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count,
  watermark
) on table public.clips to anon, authenticated;

-- Ingest tokens for Bunny remote fetch (GET /internal/bunny-source/:token).
create table if not exists public.bunny_ingest_tokens (
  token_hash text primary key,
  clip_id uuid not null references public.clips (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists bunny_ingest_tokens_expires_idx
  on public.bunny_ingest_tokens (expires_at);

create index if not exists bunny_ingest_tokens_clip_idx
  on public.bunny_ingest_tokens (clip_id);

alter table public.bunny_ingest_tokens enable row level security;

revoke all on table public.bunny_ingest_tokens from public, anon, authenticated;
grant all on table public.bunny_ingest_tokens to service_role;

-- Atomic CAS: claim a watermark job for one clip + render version.
create or replace function public.claim_watermark_variant(
  p_clip_id uuid,
  p_render_version int,
  p_processor text default 'bunny'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
begin
  update public.clips
  set
    watermark_variant_status = 'submitting',
    watermark_processor = p_processor,
    watermark_render_version = p_render_version,
    watermark_processor_video_id = null,
    watermark_resolution = null,
    watermark_error = null,
    watermark_updated_at = now()
  where id = p_clip_id
    and watermark = true
    and watermark_variant_status in ('none', 'failed');
  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

revoke all on function public.claim_watermark_variant(uuid, int, text) from public, anon, authenticated;
grant execute on function public.claim_watermark_variant(uuid, int, text) to service_role;
