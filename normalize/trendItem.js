import { sanitizeText } from "../utils/text.js";

export function normalizeTrendItem(raw) {
  const platform =
    (raw.platform || raw.source || raw.provider || "").toLowerCase().trim();

  return {
    platform: platform || "unknown",  // ✅ do not default to news
    // Clean up RSS/HTML entities (e.g., &#8216; &#8217;) and any HTML tags.
    topicTitle: sanitizeText(raw.topicTitle || raw.title || raw.headline || "", { maxLen: 220 }),
    // Ensure we never store "[object Object]" (can happen when summaries arrive as objects).
    topicSummary: sanitizeText(raw.topicSummary || raw.summary || raw.description || "", { maxLen: 700 }),
    sourceUrl: raw.sourceUrl || raw.url || raw.link || "",
    publishedAt: raw.publishedAt || raw.pubDate || raw.published || null,
    author: raw.author || raw.channelTitle || raw.sourceName || "",
    metrics: raw.metrics || {},
    clusterId: raw.clusterId || null,
    riskScore: raw.riskScore ?? null,
  };
}