export function normalizeTrendItem(x) {
  const platform = String(x?.platform || "").toLowerCase().trim();
  const topicTitle = String(x?.topicTitle || "").trim();
  const sourceUrl = String(x?.sourceUrl || "").trim();

  return {
    platform: "news",
    topicTitle,
    topicSummary: String(x?.topicSummary || ""),
    queryUsed: String(x?.queryUsed || ""),
    sourceUrl,
    publishedAt: x?.publishedAt || null,
    author: String(x?.author || ""),
    metrics: x?.metrics || {},
    clusterId: x?.clusterId || null,
    trendScore: Number(x?.trendScore ?? 0),
    riskScore: Number(x?.riskScore ?? 0),
  };
}