-- Rollback for macro backend prepare migration

begin;

drop function if exists public.item_missing_macros(jsonb);

alter table public.diet_records
  drop column if exists macros_updated_at,
  drop column if exists macros_rollout_version;

drop table if exists public.diet_records_backup;

commit;

