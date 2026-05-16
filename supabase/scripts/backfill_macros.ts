/**
 * Backfill macros for existing diet_records.items
 *
 * Rules:
 * - Only fill missing macro keys: carb_g / protein_g / fat_g
 * - Never overwrite existing macro values
 * - Backup each source row into diet_records_backup before update
 *
 * Run:
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   BACKUP_BATCH=macro-backfill-20260516 \
 *   deno run -A supabase/scripts/backfill_macros.ts
 */

type AnyObj = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKUP_BATCH = Deno.env.get("BACKUP_BATCH") || `macro-backfill-${Date.now()}`;
const PAGE_SIZE = Number(Deno.env.get("PAGE_SIZE") || "200");
const MAX_ROWS = Number(Deno.env.get("MAX_ROWS") || "0"); // 0 = no cap
const MACRO_FN_NAME = Deno.env.get("MACRO_FN_NAME") || "parse-food-macros";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const restHeaders: HeadersInit = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

function hasMissingMacros(item: AnyObj): boolean {
  return !("carb_g" in item) || !("protein_g" in item) || !("fat_g" in item);
}

function normalizeMacro(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function mergeMissingMacros(item: AnyObj, patch: AnyObj): AnyObj {
  return {
    ...item,
    carb_g: "carb_g" in item ? item.carb_g : normalizeMacro(patch?.carb_g),
    protein_g: "protein_g" in item ? item.protein_g : normalizeMacro(patch?.protein_g),
    fat_g: "fat_g" in item ? item.fat_g : normalizeMacro(patch?.fat_g),
  };
}

async function fetchRows(offset: number): Promise<AnyObj[]> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/diet_records`);
  url.searchParams.set("select", "id,user_id,meal,items,created_at");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  const res = await fetch(url, { headers: restHeaders });
  if (!res.ok) throw new Error(`fetch rows failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function callMacroFn(items: AnyObj[]): Promise<AnyObj[]> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${MACRO_FN_NAME}`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ items }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok) {
    throw new Error(`macro fn failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return Array.isArray(body?.data?.items) ? body.data.items : [];
}

async function backupRow(row: AnyObj): Promise<void> {
  const payload = [{ backup_batch: BACKUP_BATCH, source_record: row }];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/diet_records_backup`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`backup failed: ${res.status} ${await res.text()}`);
}

async function updateRow(id: string | number, nextItems: AnyObj[]): Promise<void> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/diet_records`);
  url.searchParams.set("id", `eq.${id}`);
  const payload = {
    items: nextItems,
    macros_rollout_version: "v1",
    macros_updated_at: new Date().toISOString(),
  };
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
}

async function main() {
  let offset = 0;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    if (MAX_ROWS > 0 && scanned >= MAX_ROWS) break;
    const rows = await fetchRows(offset);
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      if (MAX_ROWS > 0 && scanned > MAX_ROWS) break;

      try {
        const rowId = row?.id as string | number | undefined;
        const items = Array.isArray(row?.items) ? row.items as AnyObj[] : [];
        if (!rowId || items.length === 0) {
          skipped += 1;
          continue;
        }

        const missingTargets: { idx: number; payload: AnyObj }[] = [];
        items.forEach((item, idx) => {
          if (item && typeof item === "object" && hasMissingMacros(item)) {
            missingTargets.push({
              idx,
              payload: {
                name: String(item.name || ""),
                portion: String(item.portion || ""),
                kcal: Math.max(0, Number(item.kcal) || 0),
                meal: String(row.meal || ""),
              },
            });
          }
        });

        if (missingTargets.length === 0) {
          skipped += 1;
          continue;
        }

        const patches = await callMacroFn(missingTargets.map((x) => x.payload));
        const nextItems = items.map((item) => ({ ...item }));
        missingTargets.forEach((target, i) => {
          nextItems[target.idx] = mergeMissingMacros(nextItems[target.idx], patches[i] || {});
        });

        await backupRow(row);
        await updateRow(rowId, nextItems);
        updated += 1;
      } catch (err) {
        failed += 1;
        console.error("row backfill failed:", { id: row?.id, error: String(err) });
      }
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(JSON.stringify({ backupBatch: BACKUP_BATCH, scanned, updated, skipped, failed }, null, 2));
}

await main();

