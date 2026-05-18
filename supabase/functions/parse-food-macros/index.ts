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

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ITEMS = 30;
const QUOTA_BUCKET = "parse_food_macros";
const QUOTA_LIMIT_PER_10_MIN = 24;
const QUOTA_WINDOW_SECONDS = 600;

async function getAuthedUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new Error("unauthorized_missing_bearer");
  }
  if (!apikey) {
    throw new Error("server_missing_anon_key");
  }
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey,
      authorization: authHeader,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) {
    throw new Error("unauthorized_invalid_token");
  }
  return String(data.id);
}

async function consumeQuota(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const rpcUrl = `${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/check_and_consume_api_quota`;
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey,
      authorization: authHeader,
    },
    body: JSON.stringify({
      p_bucket: QUOTA_BUCKET,
      p_limit: QUOTA_LIMIT_PER_10_MIN,
      p_window_seconds: QUOTA_WINDOW_SECONDS,
      p_consume: 1,
    }),
  });
  const payload = await res.json().catch(() => []);
  const row = Array.isArray(payload) ? payload[0] : null;
  if (!res.ok || !row?.allowed) {
    throw new Error("quota_exceeded");
  }
}

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
  const startAt = Date.now();
  let userId = "";
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
    }
    userId = await getAuthedUserId(req);
    await consumeQuota(req);
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ ok: false, error: "too_many_items" }), { status: 400, headers: CORS_HEADERS });
    }

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

    console.log(
      JSON.stringify({
        event: "parse_food_macros_success",
        user_id: userId,
        items_count: items.length,
        duration_ms: Date.now() - startAt,
      })
    );
    return new Response(JSON.stringify({ ok: true, data: { items: result } }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "parse_food_macros_error",
        user_id: userId || null,
        error: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startAt,
      })
    );
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown_error" }),
      { status: error instanceof Error && error.message.startsWith("unauthorized") ? 401 : error instanceof Error && error.message === "quota_exceeded" ? 429 : 500, headers: CORS_HEADERS }
    );
  }
});
