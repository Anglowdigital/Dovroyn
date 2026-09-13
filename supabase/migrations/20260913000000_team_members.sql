-- Dovroyn team seats: workspace_members table
-- Run once in Supabase dashboard -> SQL Editor -> New query -> Run
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  member_email text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  unique (owner_id, member_email)
);

alter table public.workspace_members enable row level security;

create policy "owners manage their own team"
  on public.workspace_members
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
