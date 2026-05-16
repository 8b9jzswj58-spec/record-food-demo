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

function parseKcal(text: string): number {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|大卡|卡)/i);
  if (!m) return 0;
  return Math.max(0, Math.round(Number(m[1]) || 0));
}

function cleanLine(text: string): string {
  return String(text || "")
    .replace(/[，；。]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNameAndPortion(line: string): { name: string; portion: string } {
  const cleaned = cleanLine(line);
  const portionMatch = cleaned.match(/(\d+(?:\.\d+)?\s*(?:份|个|碗|盘|片|串|杯|瓶|听|ml|mL|g|kg|克|千克))/i);
  if (portionMatch) {
    const portion = portionMatch[1].replace(/\s+/g, "").toLowerCase();
    const name = cleaned.replace(portionMatch[1], "").trim() || "未命名食物";
    return { name: name.slice(0, 32), portion: portion.slice(0, 32) };
  }

  const countMatch = cleaned.match(/(.+?)\s*(\d+(?:\.\d+)?)\s*份$/);
  if (countMatch) {
    return {
      name: String(countMatch[1] || "未命名食物").trim().slice(0, 32),
      portion: `${countMatch[2]}份`.slice(0, 32),
    };
  }

  return { name: cleaned.slice(0, 32) || "未命名食物", portion: "1份" };
}

function parseTextItems(inputText: string): ParsedItem[] {
  const raw = String(inputText || "").trim();
  if (!raw) return [];

  const lines = raw
    .split(/\n+/)
    .flatMap((line) => line.split(/[;；]+/))
    .map((line) => line.trim())
    .filter(Boolean);

  const items = lines.map((line) => {
    const kcal = parseKcal(line);
    const { name, portion } = parseNameAndPortion(
      line
        .replace(/\d+(?:\.\d+)?\s*(?:kcal|千卡|卡路里|大卡|卡)/gi, "")
        .trim()
    );
    const macros = estimateMacros(kcal);
    return {
      name,
      portion,
      kcal,
      emoji: pickEmojiByName(name),
      carb_g: clampIntOrNull(macros.carb_g),
      protein_g: clampIntOrNull(macros.protein_g),
      fat_g: clampIntOrNull(macros.fat_g),
    } satisfies ParsedItem;
  });

  return items.filter((item) => item.name && item.name !== "未命名食物" || item.kcal > 0);
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
    }

    const body = await req.json().catch(() => ({}));
    const text = String(body?.text || "");
    const images = Array.isArray(body?.images) ? body.images : [];

    let items = parseTextItems(text);

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

    return new Response(JSON.stringify(response), { status: 200, headers: CORS_HEADERS });
  } catch (error) {
    const response: ParseFoodResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
    return new Response(JSON.stringify(response), { status: 500, headers: CORS_HEADERS });
  }
});
