# Macro Backend Rollout (Safe Path)

## 1) Apply migration

- Run `supabase/migrations/20260516_macro_backend_prepare.sql`
- This only adds:
  - `diet_records_backup` table
  - rollout columns on `diet_records`
  - helper function `item_missing_macros`

## 2) Deploy functions

- Deploy `supabase/functions/parse-food`
- Deploy `supabase/functions/parse-food-macros`

## 3) Frontend switch

- Keep current frontend behavior
- Add backend-first logic:
  - use `carb_g/protein_g/fat_g` from parse-food when present
  - use parse-food-macros only for missing items

## 4) Backfill old records (later)

- Batch by date range and user range
- Only fill missing keys
- Before each batch, copy source rows into `diet_records_backup` with one `backup_batch` id

### One-command backfill script

Run from repo root:

```bash
SUPABASE_URL="https://fwwsoilsbgympvkajnih.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
BACKUP_BATCH="macro-backfill-20260516" \
deno run -A supabase/scripts/backfill_macros.ts
```

Optional env:

- `PAGE_SIZE` (default `200`)
- `MAX_ROWS` (default `0`, means no cap)
- `MACRO_FN_NAME` (default `parse-food-macros`)

## Rollback

1. Point frontend back to old parsing flow.
2. Disable new macro usage in UI.
3. Run `supabase/migrations/20260516_macro_backend_prepare_down.sql` if schema rollback is needed.
4. Restore rows from `diet_records_backup` for affected `backup_batch` if data rollback is needed.
