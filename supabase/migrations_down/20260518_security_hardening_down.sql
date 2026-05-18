-- Rollback for 20260518_security_hardening.sql

begin;

drop function if exists public.check_and_consume_api_quota(text, integer, integer, integer);

drop trigger if exists trg_api_usage_buckets_updated_at on public.api_usage_buckets;
drop function if exists public.tg_set_api_usage_buckets_updated_at();
drop table if exists public.api_usage_buckets;

-- Keep RLS enabled but drop hardened policies for these tables.
drop policy if exists "diet_records_select_own" on public.diet_records;
drop policy if exists "diet_records_insert_own" on public.diet_records;
drop policy if exists "diet_records_update_own" on public.diet_records;
drop policy if exists "diet_records_delete_own" on public.diet_records;

drop policy if exists "diet_user_settings_select_own" on public.diet_user_settings;
drop policy if exists "diet_user_settings_insert_own" on public.diet_user_settings;
drop policy if exists "diet_user_settings_update_own" on public.diet_user_settings;

commit;
