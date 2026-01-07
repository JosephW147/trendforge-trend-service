export function normalizeTrendItem(raw) {
  const platform =
    (raw.platform || raw.source || raw.provider || "").toLowerCase().trim();

  return {
    platform: platform || "unknown",  // ✅ do not default to news
    topicTitle: raw.topicTitle || raw.title || raw.headline || "",
    topicSummary: raw.topicSummary || raw.summary || raw.description || "",
    sourceUrl: raw.sourceUrl || raw.url || raw.link || "",
    publishedAt: raw.publishedAt || raw.pubDate || raw.published || null,
    author: raw.author || raw.channelTitle || raw.sourceName || "",
    metrics: raw.metrics || {},
    clusterId: raw.clusterId || null,
    riskScore: raw.riskScore ?? null,
  };
}