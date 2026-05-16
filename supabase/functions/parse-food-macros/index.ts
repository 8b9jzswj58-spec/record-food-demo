/**
 * parse-food-macros (template)
 *
 * Input:
 * { items: [{ name, portion, kcal, meal? }] }
 *
 * Output:
 * { ok: true, data: { items: [{ carb_g, protein_g, fat_g }] } }
 *
 * Notes:
 * - Only fill missing values in caller.
 * - Return null when uncertain.
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type MacroItem = {
  carb_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
};

function clampIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function estimateFromKcal(kcal: number): MacroItem {
  if (!Number.isFinite(kcal) || kcal <= 0) {
    return { carb_g: null, protein_g: null, fat_g: null };
  }
  // 20/50/30 fallback ratio
  return {
    carb_g: Math.round((kcal * 0.5) / 4),
    protein_g: Math.round((kcal * 0.2) / 4),
    fat_g: Math.round((kcal * 0.3) / 9),
  };
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405 });
    }
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : [];

    // TODO: replace with model-based estimation.
    const result = items.map((item: any) => {
      const kcal = Number(item?.kcal) || 0;
      const estimated = estimateFromKcal(kcal);
      return {
        carb_g: clampIntOrNull(item?.carb_g ?? estimated.carb_g),
        protein_g: clampIntOrNull(item?.protein_g ?? estimated.protein_g),
        fat_g: clampIntOrNull(item?.fat_g ?? estimated.fat_g),
      };
    });

    return new Response(JSON.stringify({ ok: true, data: { items: result } }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
});

