/**
 * parse-food (template)
 *
 * Goal:
 * - Keep current output contract
 * - Add optional macro fields: carb_g/protein_g/fat_g
 * - Allow null for unknown values
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type ParsedItem = {
  name: string;
  portion: string;
  kcal: number;
  confidence?: number;
  emoji?: string;
  carb_g?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
};

type ParseFoodResponse = {
  ok: boolean;
  data?: { items: ParsedItem[] };
  error?: string;
};

function clampIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function normalizeItem(raw: any): ParsedItem {
  return {
    name: String(raw?.name ?? "未命名食物").slice(0, 32),
    portion: String(raw?.portion ?? "1份").slice(0, 32),
    kcal: Math.max(0, Math.round(Number(raw?.kcal) || 0)),
    confidence: Number.isFinite(Number(raw?.confidence)) ? Number(raw.confidence) : undefined,
    emoji: typeof raw?.emoji === "string" ? raw.emoji : undefined,
    carb_g: clampIntOrNull(raw?.carb_g),
    protein_g: clampIntOrNull(raw?.protein_g),
    fat_g: clampIntOrNull(raw?.fat_g),
  };
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405 });
    }

    // TODO: Replace this template with your existing LLM parsing logic.
    // This fallback keeps your API contract stable.
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.mock_items) ? body.mock_items : [];
    const normalized = items.map(normalizeItem);

    const response: ParseFoodResponse = {
      ok: true,
      data: { items: normalized },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    const response: ParseFoodResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
});

