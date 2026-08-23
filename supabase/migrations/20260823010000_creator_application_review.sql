-- Operator review fields for creator applications.
-- Status is pending by default. Only the Worker service role updates it.

alter table public.creator_applications
  add column if not exists status text not null default 'pending',
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table public.creator_applications
  drop constraint if exists creator_applications_status_check;

alter table public.creator_applications
  add constraint creator_applications_status_check
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists creator_applications_status_idx
  on public.creator_applications (status, created_at desc);
