create table if not exists public.biztrack_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,
  encrypted_data text not null,
  updated_at timestamptz not null default now()
);

alter table public.biztrack_workspaces enable row level security;

create policy "Users can read their own workspace"
  on public.biztrack_workspaces for select
  using (auth.uid() = user_id);

create policy "Users can create their own workspace"
  on public.biztrack_workspaces for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own workspace"
  on public.biztrack_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
