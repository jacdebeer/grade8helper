import economy from "../kb/economy.js";
import financialLiteracy from "../kb/financial-literacy.js";
import entrepreneurship from "../kb/entrepreneurship.js";

const MODEL = "gemini-flash-latest";
const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY_TURNS = 6;

// Abuse limits. A whole classroom can share one school IP, so the
// per-IP limit is set for a class, not for one learner.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 20;
const RATE_TABLE_MAX = 5000;

// Each module has its own course text, bundled with the function.
const MODULES = {
  "economy": { title: "The Economy", lessons: economy },
  "financial-literacy": { title: "Financial Literacy", lessons: financialLiteracy },
  "entrepreneurship": { title: "Entrepreneurship", lessons: entrepreneurship },
};

function buildPrompt(mod) {
  const kbText = mod.lessons
    .map((l) => `### [${l.section}] ${l.title} (lesson ${l.lessonId}, ${l.type})\n${l.text}`)
    .join("\n\n");
  return `You are a study helper for the Grade 8 Economic and Management Sciences course module "${mod.title}" (CAPS aligned, South Africa).

Rules:
1. Answer only from the course text below. If the question is outside this module, say so in one sentence and do not suggest any lesson. If it is on the topic but not covered, say the course does not cover it and name the closest lesson. Do not guess.
2. Explain in simple English for a Grade 8 learner. Short sentences.
3. Use a worked example with South African context when it helps. Use only figures from the course text, or clearly invented example figures labelled as an example. Never present invented figures as real statistics.
4. Real-life data: you have no live data access. Do not quote current statistics. Say where the learner can check current figures (National Treasury, SARS, Stats SA) without making up numbers.
5. For quiz questions, guide the learner with a hint first. Give the answer only if they ask for it.
6. Stay on the course topic. Politely decline unrelated requests and do not collect personal information.
7. Plain text only. No markdown, no asterisks, no em dashes, no semicolons.

COURSE TEXT:
${kbText}`;
}

const PROMPTS = Object.fromEntries(
  Object.entries(MODULES).map(([key, mod]) => [key, buildPrompt(mod)])
);

// Per-IP fixed-window counter. Lives in the function instance, so it is
// a second line of defence behind the Vercel Firewall rate limit rule.
const hits = new Map();

function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return real.trim();
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

function rateLimited(ip, now = Date.now()) {
  if (hits.size > RATE_TABLE_MAX) {
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
    if (hits.size > RATE_TABLE_MAX) hits.clear();
  }
  const entry = hits.get(ip);
  if (!entry || entry.reset <= now) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return { limited: false };
  }
  entry.count += 1;
  if (entry.count > RATE_MAX_PER_WINDOW) {
    return { limited: true, retryAfter: Math.ceil((entry.reset - now) / 1000) };
  }
  return { limited: false };
}

// The helper page calls /api/chat from its own origin. Browsers always send
// Origin on a POST, so a missing or foreign Origin means a script or another
// site. Scripts can fake this header, which is why the rate limit and the
// Gemini spend cap still matter.
function sameOrigin(req) {
  const origin = req.headers["origin"];
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST." });
  }

  if (!sameOrigin(req)) {
    return sendJson(res, 403, { error: "Open the helper from the course page." });
  }

  const ip = clientIp(req);
  const limit = rateLimited(ip);
  if (limit.limited) {
    console.warn("Rate limited", ip);
    res.setHeader("Retry-After", String(limit.retryAfter));
    return sendJson(res, 429, { error: "Too many questions at once. Wait a minute and try again." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: "Server is not configured." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON." });
    }
  }

  const moduleKey = String(body?.module ?? "economy");
  if (!PROMPTS[moduleKey]) {
    return sendJson(res, 400, { error: "Unknown module." });
  }

  const question = String(body?.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) {
    return sendJson(res, 400, { error: "Ask a question first." });
  }

  // Keep only the last few turns from the page so cost stays bounded.
  const history = Array.isArray(body?.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
  const contents = history
    .filter((t) => t && (t.role === "user" || t.role === "model") && typeof t.text === "string")
    .map((t) => ({ role: t.role, parts: [{ text: t.text.slice(0, 2000) }] }));
  contents.push({ role: "user", parts: [{ text: question }] });

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPTS[moduleKey] }] },
          contents,
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("Gemini error", upstream.status);
      if (upstream.status === 429) {
        return sendJson(res, 503, { error: "The helper has reached its usage limit. Try again later." });
      }
      return sendJson(res, 502, { error: "The helper is busy. Try again in a moment." });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      console.error("Answer cut at token limit");
    }
    if (!answer) {
      return sendJson(res, 502, { error: "No answer returned. Try rephrasing." });
    }
    return sendJson(res, 200, { answer });
  } catch (err) {
    console.error("Chat failure", err?.message);
    return sendJson(res, 502, { error: "Could not reach the helper. Try again." });
  }
}
