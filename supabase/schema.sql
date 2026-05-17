create table if not exists public.drill_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  drill_uid text not null,
  drill_version integer not null default 1,
  progress_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, drill_uid)
);

create table if not exists public.drill_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  attempt_id text not null unique,
  drill_uid text not null,
  drill_version integer not null default 1,
  completed_at timestamptz not null,
  result_json jsonb not null,
  summary_json jsonb not null default '{}'::jsonb,
  import_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  last_export_batch_id text,
  last_exported_at timestamptz,
  unique (user_id, drill_uid)
);

alter table public.drill_attempts
  add column if not exists last_export_batch_id text,
  add column if not exists last_exported_at timestamptz;

alter table public.drill_progress enable row level security;
alter table public.drill_attempts enable row level security;

drop policy if exists "Users can read own drill_progress" on public.drill_progress;
create policy "Users can read own drill_progress"
  on public.drill_progress
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own drill_progress" on public.drill_progress;
create policy "Users can insert own drill_progress"
  on public.drill_progress
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own drill_progress" on public.drill_progress;
create policy "Users can update own drill_progress"
  on public.drill_progress
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own drill_progress" on public.drill_progress;
create policy "Users can delete own drill_progress"
  on public.drill_progress
  for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can read own drill_attempts" on public.drill_attempts;
create policy "Users can read own drill_attempts"
  on public.drill_attempts
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own drill_attempts" on public.drill_attempts;
create policy "Users can insert own drill_attempts"
  on public.drill_attempts
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own drill_attempts" on public.drill_attempts;
create policy "Users can update own drill_attempts"
  on public.drill_attempts
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.drill_progress to authenticated;
grant select, insert, update on public.drill_attempts to authenticated;

create table if not exists public.exercises (
  user_id uuid not null references auth.users (id) on delete cascade,
  exercise_uid text not null,
  exercise_version integer not null default 1,
  title text not null,
  description text,
  level text,
  status text not null default 'draft',
  exercise_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise_uid)
);

alter table public.exercises enable row level security;

drop policy if exists "Users can read own exercises" on public.exercises;
create policy "Users can read own exercises"
  on public.exercises
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own exercises" on public.exercises;
create policy "Users can insert own exercises"
  on public.exercises
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own exercises" on public.exercises;
create policy "Users can update own exercises"
  on public.exercises
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own exercises" on public.exercises;
create policy "Users can delete own exercises"
  on public.exercises
  for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.exercises to authenticated;
