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

  const apiKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (!apiKey) {
    return jsonResponse({ ok: false, error: "Missing GEMINI_API_KEY in Supabase secrets" }, 500);
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
    "你是饮食热量估算助手。",
    "请只返回 JSON，不要返回任何额外文字。",
    "JSON 结构必须是：",
    "{",
    '  "items": [',
    "    {",
    '      "name": "食物名称",',
    '      "portion": "份量描述",',
    '      "kcal": 123,',
    '      "confidence": 0.86,',
    '      "emoji": "🍽️"',
    "    }",
    "  ],",
    '  "notes": "可选简短说明"',
    "}",
    "要求：",
    "1) kcal 必须是整数。",
    "2) confidence 在 0 到 1 之间。",
    "3) item 最多返回 12 条。",
    "4) 无法识别时 items 返回空数组，并在 notes 写原因。",
  ].join("\n");

  // Build Gemini content parts
  const parts: Array<Record<string, unknown>> = [];

  if (text) {
    parts.push({ text: `用户输入（餐次：${meal}）：${text}` });
  } else {
    parts.push({ text: `用户输入为空，仅图片识别（餐次：${meal}）` });
  }

  for (const item of images) {
    const mimeType = String(item?.mimeType || "image/jpeg");
    const base64 = String(item?.base64 || "");
    if (!base64) continue;
    // Strip data URL prefix if present
    const data = base64.replace(/^data:[^;]+;base64,/, "");
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }

  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }],
        generation_config: {
          temperature: 0.2,
          response_mime_type: "application/json",
        },
      }),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: `Gemini request failed: ${String(error)}` }, 502);
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse(
      { ok: false, error: `Gemini API error (${upstream.status})`, details: rawText.slice(0, 800) },
      502,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid Gemini response JSON", details: rawText.slice(0, 800) }, 502);
  }

  // Extract text from Gemini response: candidates[0].content.parts[0].text
  type GeminiCandidate = { content?: { parts?: Array<{ text?: string }> } };
  const content = String(
    (payload?.candidates as GeminiCandidate[] | undefined)?.[0]?.content?.parts?.[0]?.text || "",
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
