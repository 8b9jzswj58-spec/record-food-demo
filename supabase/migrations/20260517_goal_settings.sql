-- Persist per-user daily kcal goal in backend

create table if not exists public.diet_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goal_kcal integer not null default 1600,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diet_user_settings_goal_positive check (goal_kcal > 0)
);

alter table public.diet_user_settings enable row level security;

drop policy if exists "select_own_goal" on public.diet_user_settings;
create policy "select_own_goal"
on public.diet_user_settings
for select
using (auth.uid() = user_id);

drop policy if exists "insert_own_goal" on public.diet_user_settings;
create policy "insert_own_goal"
on public.diet_user_settings
for insert
with check (auth.uid() = user_id);

drop policy if exists "update_own_goal" on public.diet_user_settings;
create policy "update_own_goal"
on public.diet_user_settings
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.tg_set_diet_user_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_diet_user_settings_updated_at on public.diet_user_settings;
create trigger trg_diet_user_settings_updated_at
before update on public.diet_user_settings
for each row
execute function public.tg_set_diet_user_settings_updated_at();
