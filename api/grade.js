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

function extractOutputText(openaiResponsesJson) {
  // OpenAI Responses API: data.output[].content[] có type output_text
  for (const item of openaiResponsesJson.output || []) {
    if (item.type === "message") {
      const part = (item.content || []).find(x => x.type === "output_text");
      if (part?.text) return part.text;
    }
  }
  return "";
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
      "Trả về JSON đúng schema. Không viết thêm chữ ngoài JSON."
    ].join("\n");

    const jsonSchema = {
      name: "grade_batch_result",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                qid: { type: "number" },
                score: { type: "number", minimum: 0 },
                feedback: { type: "string" },
                key_points_hit: { type: "array", items: { type: "string" } }
              },
              required: ["qid", "score", "feedback", "key_points_hit"]
            }
          }
        },
        required: ["results"]
      }
    };

    // 3) Gọi OpenAI Responses API
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ submissions }) }
        ],
        text: { format: { type: "json_schema", json_schema: jsonSchema } }
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: "OpenAI error", status: r.status, detail: raw });
    }

    const data = JSON.parse(raw);
    const outText = extractOutputText(data);
    if (!outText) {
      return res.status(502).json({ error: "OpenAI returned no output_text", detail: data });
    }

    const result = JSON.parse(outText);

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
