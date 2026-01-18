// editorial/buildEditorial.js
// Phase C: LLM ranker/editor (no topic invention)
//
// Input:
// {
//   trendRunId, projectId,
//   minPicks, maxPicks,
//   channel_profile,
//   candidate_topics: [...] (max 50)
// }
//
// Output (strict JSON object):
// {
//   model,
//   duplicate_groups: [...],
//   ranked_topics: [...],
//   final_picks: [
//     {
//       topic_id: "...",
//       trend_likelihood: 0-100,   // ✅ added deterministically in backend
//       fit_reason: "...",
//       risk_flags: [...],
//       angles: {...}
//     }
//   ]
// }

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

function clampInt(n, lo, hi) {
  const x = Number.isFinite(Number(n)) ? Number(n) : lo;
  return Math.max(lo, Math.min(hi, Math.trunc(x)));
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

function stringifyJson(obj) {
  return JSON.stringify(obj, null, 0);
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normTo01(x, max) {
  const n = Number(x);
  if (!Number.isFinite(n) || !Number.isFinite(Number(max)) || max <= 0) return 0;
  return clamp01(n / max);
}

/**
 * Deterministic score 0-100 indicating likelihood this topic continues trending soon.
 * Derived ONLY from Phase B metrics present on candidate_topics.
 *
 * Expected topic fields (if missing, treated as 0):
 * - emergingScore (0..~10)
 * - momentumScore (0..~10)
 * - freshnessScore (0..1) OR freshness01-like value
 * - sourceDiversity (0..~5)
 * - itemsCount or sourceCount (0..~20)
 */
function computeTrendLikelihood(topic) {
  // Normalize (caps are tuning knobs; keep stable once you like the output)
  const nEmerging = normTo01(topic?.emergingScore, 10);
  const nMomentum = normTo01(topic?.momentumScore, 10);

  // freshnessScore: if it’s already 0..1, keep it; if it’s >1, normalize softly
  const rawFresh = Number(topic?.freshnessScore);
  const nFreshness = Number.isFinite(rawFresh)
    ? (rawFresh <= 1 ? clamp01(rawFresh) : normTo01(rawFresh, 10))
    : 0;

  const nDiversity = normTo01(topic?.sourceDiversity, 5);

  const breadthRaw =
    topic?.itemsCount ??
    topic?.sourceCount ??
    topic?.numItems ??
    topic?.count ??
    0;
  const nBreadth = normTo01(breadthRaw, 20);

  // Weighted sum (must stay deterministic)
  const score01 =
    0.30 * nMomentum +
    0.25 * nEmerging +
    0.20 * nFreshness +
    0.15 * nDiversity +
    0.10 * nBreadth;

  return Math.round(clamp01(score01) * 100);
}

function buildSystemPrompt() {
  return (
    "You are a JSON-only ranker/editor for a trend selection pipeline. " +
    "You MUST ONLY use the provided candidate_topics and their fields. " +
    "You MUST NOT invent topics, facts, metrics, or URLs. " +
    "You MUST output VALID JSON ONLY (no markdown, no commentary). " +
    "All topic_ids in output must come from candidate_topics[].topicId. " +
    "All sources_to_cite must be chosen ONLY from that topic's topSourceUrls."
  );
}

function buildUserPrompt({ channel_profile, candidate_topics, minPicks, maxPicks }) {
  return (
    "CHANNEL_PROFILE:\n" +
    stringifyJson(channel_profile) +
    "\n\nCANDIDATE_TOPICS (max 50):\n" +
    stringifyJson(candidate_topics) +
    `\n\nTASK:\n1) Propose duplicate_groups across candidates for near-duplicates.\n` +
    `2) Produce ranked_topics across all candidates with short grounded why_trend text using ONLY provided metrics.\n` +
    `3) Choose final_picks of ${minPicks}-${maxPicks} topics that best fit the channel_profile and are safe.\n` +
    `4) For each final pick, provide angles: whats_new, why_now, hook, angle_options (2-3), suggested_titles (1-2), sources_to_cite (subset of topSourceUrls).\n\n` +
    "OUTPUT JSON SCHEMA (exact keys):\n" +
    stringifyJson({
      duplicate_groups: [
        { topic_ids: ["id1", "id2"], canonical_topic_id: "id1", reason: "..." }
      ],
      ranked_topics: [
        { topic_id: "id1", rank: 1, why_trend: "..." }
      ],
      final_picks: [
        {
          topic_id: "id1",
          fit_reason: "...",
          risk_flags: ["..."],
          angles: {
            whats_new: "...",
            why_now: "...",
            hook: "...",
            angle_options: ["...", "..."],
            suggested_titles: ["...", "..."],
            sources_to_cite: ["url1", "url2"]
          }
        }
      ]
    })
  );
}

/**
 * Extract a JSON object from a model response.
 * Handles:
 * - Raw JSON
 * - ```json fenced blocks
 * - Extra text before/after JSON (we take the outermost {...})
 */
function extractJsonObject(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // Strip common code fences
  const cleaned = t
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Quick attempt: whole string is JSON
  try {
    const obj = JSON.parse(cleaned);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    // fallthrough
  }

  // Attempt: slice outermost JSON object
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = cleaned.slice(start, end + 1);
  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function validate(out, candidate_topics, minPicks, maxPicks) {
  if (!out || typeof out !== "object") throw new Error("LLM output is not an object");

  const ids = new Set(asArray(candidate_topics).map((c) => String(c?.topicId)));

  const finalPicks = asArray(out.final_picks);
  if (finalPicks.length < minPicks || finalPicks.length > maxPicks) {
    throw new Error(`final_picks must have ${minPicks}-${maxPicks} items`);
  }

  // Map allowed URLs per topic
  const allowedUrls = new Map(
    asArray(candidate_topics).map((c) => [
      String(c?.topicId),
      new Set(asArray(c?.topSourceUrls).map(String))
    ])
  );

  for (const p of finalPicks) {
    const id = String(p?.topic_id || "");
    if (!ids.has(id)) throw new Error(`Unknown topic_id in final_picks: ${id}`);

    const cite = asArray(p?.angles?.sources_to_cite);
    const allowed = allowedUrls.get(id) || new Set();
    for (const u of cite) {
      const url = String(u);
      if (!allowed.has(url)) {
        throw new Error(`sources_to_cite contains URL not allowed for ${id}`);
      }
    }
  }

  return true;
}

async function callOpenAI({ model, system, user, temperature, forceJson = true }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set on the trend service");

  const body = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  // ✅ JSON mode: forces the assistant to return a single JSON object
  if (forceJson) {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error?.message || JSON.stringify(json);
    throw new Error(`OpenAI API error ${resp.status}: ${msg}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  return String(content || "");
}

/**
 * Attach deterministic trend_likelihood to picks and (optionally) ranked_topics.
 * This is NOT computed by the LLM.
 */
function attachTrendLikelihood(out, candidate_topics) {
  const byId = new Map(
    asArray(candidate_topics).map((t) => [String(t?.topicId), t])
  );

  // final_picks: attach trend_likelihood
  out.final_picks = asArray(out.final_picks).map((p) => {
    const id = String(p?.topic_id || "");
    const topic = byId.get(id);
    const trend_likelihood = computeTrendLikelihood(topic);
    return { ...p, trend_likelihood };
  });

  // ranked_topics: optional (nice for debugging / future UI)
  if (Array.isArray(out.ranked_topics)) {
    out.ranked_topics = out.ranked_topics.map((r) => {
      const id = String(r?.topic_id || "");
      const topic = byId.get(id);
      const trend_likelihood = computeTrendLikelihood(topic);
      return { ...r, trend_likelihood };
    });
  }

  return out;
}

export async function buildEditorial(input) {
  const candidate_topics = asArray(input?.candidate_topics).slice(0, 50);
  if (candidate_topics.length === 0) throw new Error("candidate_topics is empty");

  const minPicks = clampInt(input?.minPicks ?? 3, 1, 10);
  const maxPicks = clampInt(input?.maxPicks ?? 5, minPicks, 10);

  const channel_profile =
    input?.channel_profile && typeof input.channel_profile === "object"
      ? input.channel_profile
      : { audience: "general", video_length: "60s" };

  const model = String(input?.model || "").trim() || DEFAULT_MODEL;
  const temperature = Number.isFinite(Number(input?.temperature)) ? Number(input.temperature) : 0.2;

  const system = buildSystemPrompt();
  const user = buildUserPrompt({ channel_profile, candidate_topics, minPicks, maxPicks });

  // 1) Primary call (JSON mode on)
  const content = await callOpenAI({ model, system, user, temperature, forceJson: true });
  let out = extractJsonObject(content);

  // 2) Repair retry once if parsing failed
  if (!out) {
    const repairUser =
      "You returned invalid JSON. Return ONLY a valid JSON object that matches the schema EXACTLY. " +
      "No markdown, no commentary.\n\n" +
      "Here is your previous output to fix:\n" +
      content;

    const repaired = await callOpenAI({
      model,
      system,
      user: repairUser,
      temperature: 0.0, // make the repair deterministic
      forceJson: true
    });

    out = extractJsonObject(repaired);
    if (!out) {
      throw new Error("LLM returned non-JSON");
    }
  }

  validate(out, candidate_topics, minPicks, maxPicks);

  // ✅ Add deterministic trend_likelihood (0–100) AFTER validation
  out = attachTrendLikelihood(out, candidate_topics);

  // Attach model for transparency
  return { model, ...out };
}
