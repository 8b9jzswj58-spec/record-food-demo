const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type ParseRequest = {
  meal?: string;
  text?: string;
  images?: Array<{
    mimeType?: string;
    base64?: string;
  }>;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const apiKey = Deno.env.get("DOUBAO_API_KEY") || Deno.env.get("ARK_API_KEY") || "";
  if (!apiKey) {
    return jsonResponse({ ok: false, error: "Missing DOUBAO_API_KEY in Supabase secrets" }, 500);
  }

  let body: ParseRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const meal = String(body.meal || "未指定餐次");
  const text = String(body.text || "").trim();
  const images = Array.isArray(body.images) ? body.images : [];

  if (!text && images.length === 0) {
    return jsonResponse({ ok: false, error: "text or images is required" }, 400);
  }

  const systemPrompt = [
    "你是专业的饮食热量估算师，擅长中国饮食，熟悉各类食物的营养成分。",
    "",
    "## 估算步骤（内部思考，不要输出）",
    "1. 识别食物种类、烹饪方式（炒/蒸/煮/炸/生食等）",
    "2. 估计重量或体积（参考常见份量）",
    "3. 根据食物密度和烹饪方式计算热量",
    "4. 注意油脂：炒菜约加 100-200kcal 油，炸物热量翻倍",
    "",
    "## 常见食物热量参考（每 100g）",
    "主食：白米饭 116kcal、馒头 221kcal、面条(熟) 110kcal、饺子 240kcal",
    "肉类：猪肉(瘦) 143kcal、猪五花 395kcal、鸡胸肉 133kcal、鸡腿 181kcal、牛肉(瘦) 125kcal",
    "海鲜：虾 93kcal、鱼(草鱼) 113kcal、螃蟹 95kcal",
    "蔬菜：绿叶菜 15-30kcal、土豆 77kcal、胡萝卜 37kcal",
    "豆制品：豆腐 81kcal、豆浆 16kcal",
    "蛋奶：鸡蛋 144kcal、牛奶 66kcal",
    "常见菜肴：番茄炒蛋(1份) ~200kcal、红烧肉(100g) ~400kcal、宫保鸡丁(1份) ~350kcal",
    "饮品：全脂牛奶(250ml) 163kcal、豆浆(250ml) 40kcal、果汁(250ml) ~110kcal",
    "",
    "## 份量参考",
    "- 一碗米饭 ≈ 200g（232kcal）",
    "- 一个馒头 ≈ 100g",
    "- 一份家常炒菜 ≈ 200-300g",
    "- 一个鸡蛋 ≈ 55g",
    "- 一杯饮料 ≈ 250ml",
    "- 餐厅一份肉菜 ≈ 150-200g 肉",
    "",
    "## 输出格式",
    "只返回 JSON，不包含任何其他文字：",
    "{",
    '  "items": [',
    "    {",
    '      "name": "食物名称（简洁，不超过10字）",',
    '      "portion": "具体份量，如 200g / 1碗 / 1个",',
    '      "kcal": 232,',
    '      "confidence": 0.9,',
    '      "emoji": "🍚"',
    "    }",
    "  ],",
    '  "notes": "可选备注，如估算依据或不确定说明"',
    "}",
    "",
    "## 规则",
    "- kcal 必须是正整数，宁可高估不要低估",
    "- confidence：清晰可识别 0.85-0.95，模糊或遮挡 0.5-0.75，无法确定 0.3-0.5",
    "- 每个独立食物单独列一条，复合菜肴合并为一条",
    "- 最多 12 条",
    "- 无法识别时 items 为空数组",
    "- 【重要】如果用户输入或图片中有明确的食物名称（如品牌菜名、菜单名称、具体菜名），必须原样使用该名称，不得自行改写或泛化。例如用户说『麦辣鸡腿堡』就写『麦辣鸡腿堡』，不要写成『鸡腿汉堡』。",
  ].join("\n");

  const userContent: Array<Record<string, unknown>> = [];
  if (text) {
    userContent.push({ type: "text", text: `用户输入（餐次：${meal}）：${text}` });
  } else {
    userContent.push({ type: "text", text: `用户输入为空，仅图片识别（餐次：${meal}）` });
  }
  for (const item of images) {
    const mimeType = String(item?.mimeType || "image/jpeg");
    const base64 = String(item?.base64 || "");
    if (!base64) continue;
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });
  }

  const model = Deno.env.get("DOUBAO_MODEL") || "doubao-seed-1-6-vision-250815";
  const endpoint = Deno.env.get("DOUBAO_API_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

  const reqBody = JSON.stringify({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  let upstream!: Response;
  let rawText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    }
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: reqBody,
      });
    } catch (error) {
      if (attempt === 3) {
        return jsonResponse({ ok: false, error: `Doubao request failed: ${String(error)}` }, 502);
      }
      continue;
    }
    rawText = await upstream.text();
    if (upstream.status !== 429) break;
  }

  if (!upstream.ok) {
    return jsonResponse(
      { ok: false, error: `Doubao API error (${upstream.status})`, details: rawText.slice(0, 800) },
      502,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid Doubao response JSON", details: rawText.slice(0, 800) }, 502);
  }

  const content = String(
    (payload?.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content || "",
  );
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return jsonResponse(
      { ok: false, error: "Model did not return valid JSON object", details: content.slice(0, 800) },
      502,
    );
  }

  return jsonResponse({ ok: true, data: parsed }, 200);
});
