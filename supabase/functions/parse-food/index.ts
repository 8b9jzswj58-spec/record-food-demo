import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type ParsedItem = {
  name: string;
  portion: string;
  kcal: number;
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

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_INPUT_TEXT_LENGTH = 200;
const MAX_IMAGES = 5;
const MAX_IMAGE_BASE64_LENGTH = 3_500_000;
const QUOTA_BUCKET = "parse_food";
const QUOTA_LIMIT_PER_10_MIN = 8;
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

function estimateMacros(kcal: number): { carb_g: number | null; protein_g: number | null; fat_g: number | null } {
  if (!Number.isFinite(kcal) || kcal <= 0) return { carb_g: null, protein_g: null, fat_g: null };
  return {
    carb_g: Math.max(0, Math.round((kcal * 0.5) / 4)),
    protein_g: Math.max(0, Math.round((kcal * 0.2) / 4)),
    fat_g: Math.max(0, Math.round((kcal * 0.3) / 9)),
  };
}

function pickEmojiByName(name: string): string {
  const text = String(name || "");
  if (/鸡|鸭|鹅|肉|排|肠|鱼|虾|蟹|蛋/.test(text)) return "🍗";
  if (/米饭|面|粉|饼|包|馒头|粥|饭|三明治|面包/.test(text)) return "🍞";
  if (/可乐|茶|咖啡|奶|饮|果汁|汽水|水/.test(text)) return "🥤";
  if (/蔬菜|生菜|西兰花|黄瓜|番茄|沙拉/.test(text)) return "🥗";
  if (/水果|苹果|香蕉|橙|葡萄|草莓/.test(text)) return "🍎";
  return "🍽️";
}

function extractJsonFromText(raw: string): any {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return { items: JSON.parse(arrMatch[0]) };
    } catch {
      // continue
    }
  }
  return null;
}

function normalizeItem(raw: any): ParsedItem {
  const kcal = Math.max(0, Math.round(Number(raw?.kcal) || 0));
  const macros = {
    carb_g: clampIntOrNull(raw?.carb_g),
    protein_g: clampIntOrNull(raw?.protein_g),
    fat_g: clampIntOrNull(raw?.fat_g),
  };
  const estimated = estimateMacros(kcal);
  return {
    name: String(raw?.name || "未命名食物").trim().slice(0, 32) || "未命名食物",
    portion: String(raw?.portion || "1份").trim().slice(0, 32) || "1份",
    kcal,
    emoji: String(raw?.emoji || pickEmojiByName(String(raw?.name || ""))).slice(0, 8),
    carb_g: macros.carb_g ?? estimated.carb_g,
    protein_g: macros.protein_g ?? estimated.protein_g,
    fat_g: macros.fat_g ?? estimated.fat_g,
  };
}

function parseKcal(text: string): number {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|大卡|卡)/i);
  if (!m) return 0;
  return Math.max(0, Math.round(Number(m[1]) || 0));
}

function parseNameAndPortion(line: string): { name: string; portion: string } {
  const cleaned = String(line || "").replace(/[，；。]/g, " ").replace(/\s+/g, " ").trim();
  const portionMatch = cleaned.match(/(\d+(?:\.\d+)?\s*(?:份|个|碗|盘|片|串|杯|瓶|听|ml|mL|g|kg|克|千克))/i);
  if (portionMatch) {
    const portion = portionMatch[1].replace(/\s+/g, "").toLowerCase();
    const name = cleaned.replace(portionMatch[1], "").trim() || "未命名食物";
    return { name: name.slice(0, 32), portion: portion.slice(0, 32) };
  }
  return { name: cleaned.slice(0, 32) || "未命名食物", portion: "1份" };
}

function parseTextFallback(inputText: string): ParsedItem[] {
  const raw = String(inputText || "").trim();
  if (!raw) return [];
  return raw
    .split(/\n+/)
    .flatMap((line) => line.split(/[;；]+/))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const kcal = parseKcal(line);
      const { name, portion } = parseNameAndPortion(line.replace(/\d+(?:\.\d+)?\s*(?:kcal|千卡|卡路里|大卡|卡)/gi, "").trim());
      const macros = estimateMacros(kcal);
      return normalizeItem({ name, portion, kcal, emoji: pickEmojiByName(name), ...macros });
    });
}

async function callDoubaoParse(body: any): Promise<ParsedItem[]> {
  const apiKey = Deno.env.get("DOUBAO_API_KEY") || "";
  const model = Deno.env.get("DOUBAO_MODEL") || "";
  const baseUrl = Deno.env.get("DOUBAO_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  if (!apiKey || !model) {
    throw new Error("doubao_secret_missing");
  }

  const text = String(body?.text || "").trim();
  const meal = String(body?.meal || "").trim();
  const images = Array.isArray(body?.images) ? body.images : [];

  const userContent: any[] = [
    {
      type: "text",
      text:
        "你是饮食识别助手。请从用户文字和图片中识别食物，输出严格 JSON，不要 markdown。格式: {\"items\":[{\"name\":\"\",\"portion\":\"1份\",\"kcal\":120,\"emoji\":\"🍽️\",\"carb_g\":15,\"protein_g\":8,\"fat_g\":5}]}。规则：1) 若用户文字或图片里出现明确热量数字（营养成分表/包装标签/文本指定），kcal使用该明确值；2) 若没有明确证据，给保守估算值；3) kcal可为整数，不要机械凑整到50/100；4) 无法判断的克数可返回 null。",
    },
  ];

  if (meal) {
    userContent.push({ type: "text", text: `餐别: ${meal}` });
  }
  if (text) {
    userContent.push({ type: "text", text: `用户输入: ${text}` });
  }

  for (const image of images) {
    const mime = String(image?.mimeType || "image/jpeg").trim() || "image/jpeg";
    const base64 = String(image?.base64 || "").trim();
    if (!base64) continue;
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    });
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "你擅长识别中国常见餐食并估算热量与三大营养素。" },
        { role: "user", content: userContent },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`doubao_request_failed:${data?.error?.message || data?.message || response.status}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  const parsed = extractJsonFromText(typeof content === "string" ? content : JSON.stringify(content || {}));
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items.map(normalizeItem).filter((item: ParsedItem) => item.name && item.name !== "未命名食物");
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
    const text = String(body?.text || "").slice(0, MAX_INPUT_TEXT_LENGTH);
    const images = Array.isArray(body?.images) ? body.images : [];
    if (images.length > MAX_IMAGES) {
      return new Response(JSON.stringify({ ok: false, error: "too_many_images" }), { status: 400, headers: CORS_HEADERS });
    }
    const hasOversizedImage = images.some((img: any) => String(img?.base64 || "").length > MAX_IMAGE_BASE64_LENGTH);
    if (hasOversizedImage) {
      return new Response(JSON.stringify({ ok: false, error: "image_too_large" }), { status: 400, headers: CORS_HEADERS });
    }

    let items: ParsedItem[] = [];
    try {
      items = await callDoubaoParse({ ...body, text, images });
    } catch (llmError) {
      console.error("doubao-parse-failed", llmError);
      items = parseTextFallback(text);
    }

    if (items.length === 0 && images.length > 0) {
      items = [
        {
          name: "图片食物",
          portion: "1份",
          kcal: 0,
          emoji: "📷",
          carb_g: null,
          protein_g: null,
          fat_g: null,
        },
      ];
    }

    const response: ParseFoodResponse = {
      ok: true,
      data: { items },
    };
    console.log(
      JSON.stringify({
        event: "parse_food_success",
        user_id: userId,
        text_len: text.length,
        images_count: images.length,
        items_count: items.length,
        duration_ms: Date.now() - startAt,
      })
    );

    return new Response(JSON.stringify(response), { status: 200, headers: CORS_HEADERS });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "parse_food_error",
        user_id: userId || null,
        error: error instanceof Error ? error.message : "unknown_error",
        duration_ms: Date.now() - startAt,
      })
    );
    const response: ParseFoodResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.startsWith("unauthorized")
      ? 401
      : message === "quota_exceeded"
      ? 429
      : 500;
    return new Response(JSON.stringify(response), { status, headers: CORS_HEADERS });
  }
});
