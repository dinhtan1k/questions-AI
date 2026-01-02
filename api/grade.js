export const config = { runtime: "nodejs" };

async function verifyTurnstile(secret, token, ip) {
  const form = new URLSearchParams();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return await r.json();
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allow = new Set([
    "https://dayhocsangtao.com",
    "https://www.dayhocsangtao.com"
  ]);

  if (allow.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Gemini hay trả về text (có thể kèm ```json ...```), ta bóc JSON ra chắc chắn
function extractJsonFromText(text) {
  if (!text) return "";
  let t = String(text).trim();

  // Loại BOM nếu có
  t = t.replace(/^\uFEFF/, "");

  // Nếu có ```json ... ```
  const mJson = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (mJson?.[1]) return mJson[1].trim();

  // Nếu có ``` ... ```
  const mAny = t.match(/```\s*([\s\S]*?)\s*```/);
  if (mAny?.[1]) return mAny[1].trim();

  // Cắt từ dấu { đầu tiên tới dấu } cuối cùng
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return t.slice(first, last + 1).trim();
  }

  // fallback
  return t;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const { turnstileToken, submissions } = req.body || {};
    if (!turnstileToken) return res.status(403).json({ error: "Missing Turnstile token" });
    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({ error: "Missing submissions" });
    }

    // 0) Check env
    if (!process.env.TURNSTILE_SECRET) {
      return res.status(500).json({ error: "Missing env TURNSTILE_SECRET" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing env GEMINI_API_KEY" });
    }

    // 1) Verify Turnstile (1 lần cho cả batch)
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ts = await verifyTurnstile(process.env.TURNSTILE_SECRET, turnstileToken, ip);
    if (!ts.success) {
      return res.status(403).json({ error: "Turnstile not passed", verify: ts });
    }

    // 2) Prompt chấm Toán THPT
    const system = [
      "Bạn là giám khảo Toán THPT Việt Nam.",
      "Chấm phần LỜI GIẢI theo thang điểm tối đa = points của từng submission. KHÔNG chấm đáp số.",
      "Dựa vào: prompt (đề), solutionKey (lời giải chuẩn), rubric (các ý).",
      "YÊU CẦU: Chỉ trả về JSON THUẦN (không markdown, không ```).",
      "Schema JSON bắt buộc:",
      "{",
      '  "results": [',
      '    { "qid": number, "score": number, "feedback": string, "key_points_hit": string[] }',
      "  ]",
      "}",
      "Không được thêm bất kỳ chữ nào ngoài JSON."
    ].join("\n");

    // 3) Gọi Gemini (batch 1 lần)
const model = "gemini-2.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const payload = {
  contents: [
    {
      role: "user",
      parts: [
        { text: system },
        { text: "\n\nDỮ LIỆU:\n" + JSON.stringify({ submissions }) }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 2048
  }
};

const r = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": process.env.GEMINI_API_KEY
  },
  body: JSON.stringify(payload)
});



    const raw = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: "Gemini error", status: r.status, detail: raw });
    }

    const data = JSON.parse(raw);
    const text =
      data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";

    const jsonText = extractJsonFromText(text);
    let result;
    try {
      result = JSON.parse(jsonText);
    } catch (e) {
      return res.status(502).json({
        error: "Gemini returned non-JSON",
        detail: { text, jsonText, parseError: e.message }
      });
    }

    // 4) Clamp score theo points
    const maxById = new Map(submissions.map(s => [Number(s.qid), Number(s.points)]));
    for (const rr of (result.results || [])) {
      const max = maxById.get(Number(rr.qid));
      if (Number.isFinite(max)) {
        const sc = Number(rr.score) || 0;
        rr.score = Math.max(0, Math.min(max, sc));
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: "Server error", message: e.message });
  }
}
