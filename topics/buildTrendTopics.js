// topics/buildTrendTopics.js
import crypto from "crypto";

// --- very small English stopword list (extend anytime) ---
const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","else","when","while","with","without",
  "to","of","in","on","for","from","by","as","at","is","are","was","were","be","been",
  "this","that","these","those","it","its","you","your","we","our","they","their",
  "not","no","yes","new","latest","live","update","breaking","today"
]);

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function safeJsonStringify(obj) {
  try { return JSON.stringify(obj ?? {}); } catch { return "{}"; }
}

function parseDateMs(dt) {
  if (!dt) return NaN;
  const t = new Date(dt).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function freshness01FromPublishedAt(publishedAt, halfLifeHours = 24, maxHours = 72) {
  const ts = parseDateMs(publishedAt);
  if (Number.isNaN(ts)) return 0;

  const ageHrs = (Date.now() - ts) / 36e5;
  if (ageHrs <= 0) return 1;
  if (ageHrs >= maxHours) return 0;

  // exponential decay: exp(-ln2 * age/halfLife)
  const f = Math.exp(-Math.log(2) * (ageHrs / halfLifeHours));
  return clamp01(f);
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTokens(title, summary = "") {
  const txt = normalizeText(`${title} ${summary}`);
  const parts = txt.split(" ").filter(Boolean);

  // basic tokenization with stopword removal + length filter
  const tokens = parts
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 80);

  return tokens;
}

function topKeywords(tokens, k = 10) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([t]) => t);
}

function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function hashTopicId(keywords) {
  const key = keywords.slice().sort().join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

// Extract platform metrics (works with items that have metrics object OR metricsJson)
function getMetrics(item) {
  // If your pipeline keeps `metrics` as an object before ingest, use it
  if (item.metrics && typeof item.metrics === "object") return item.metrics;

  // else fall back to metricsJson if present
  if (item.metricsJson && typeof item.metricsJson === "string") {
    try { return JSON.parse(item.metricsJson); } catch { return {}; }
  }
  return {};
}

function platformKey(p) {
  return String(p || "unknown").toLowerCase().trim();
}

/**
 * Build TrendTopics from normalized TrendItems.
 *
 * @param {Object} params
 * @param {string} params.trendRunId
 * @param {string} params.projectId
 * @param {Array<Object>} params.items  // normalized, deduped TrendItems (objects)
 * @param {Object} [params.options]
 * @param {number} [params.options.similarityThreshold] // clustering threshold
 * @param {number} [params.options.maxTopics]           // how many TrendTopics to return
 * @param {number} [params.options.freshnessHalfLifeHours]
 * @param {number} [params.options.freshnessMaxHours]
 *
 * @returns {Array<Object>} TrendTopics records matching your schema
 */
export function buildTrendTopics({
  trendRunId,
  projectId,
  items,
  options = {}
}) {
  const {
    similarityThreshold = 0.55,
    maxTopics = 30,
    freshnessHalfLifeHours = 24,
    freshnessMaxHours = 72
  } = options;

  if (!trendRunId) throw new Error("buildTrendTopics: missing trendRunId");
  if (!projectId) throw new Error("buildTrendTopics: missing projectId");
  if (!Array.isArray(items)) throw new Error("buildTrendTopics: items must be an array");

  // 1) Prepare item signatures
  const prepared = items.map((it) => {
    const tokens = extractTokens(it.topicTitle, it.topicSummary);
    const kw = topKeywords(tokens, 12);
    return {
      ...it,
      _tokens: new Set(kw),   // signature set
      _keywords: kw
    };
  });

  // 2) Cluster by Jaccard similarity of keyword signature
  const clusters = [];
  for (const it of prepared) {
    let bestIdx = -1;
    let bestSim = 0;

    for (let i = 0; i < clusters.length; i++) {
      const sim = jaccard(it._tokens, clusters[i].signature);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= similarityThreshold) {
      clusters[bestIdx].items.push(it);

      // update signature union (keeps cluster “flexible”)
      for (const t of it._tokens) clusters[bestIdx].signature.add(t);
    } else {
      clusters.push({
        items: [it],
        signature: new Set(it._tokens)
      });
    }
  }

  // 3) Compute topic-level metrics + score
  const topicRecords = clusters.map((c) => {
    const clusterItems = c.items;

    // platform counts + source diversity
    const platformCounts = {};
    const sourceSet = new Set();

    let newestPublishedAtMs = -Infinity;
    let bestItem = null;

    // Aggregate YouTube signals (optional)
    let ytVelocitySum = 0;
    let ytViewsSum = 0;
    let ytEngagementSum = 0; // likes + comments

    // Aggregate News signals (optional)
    let newsCount = 0;
    const newsSourceSet = new Set();

    for (const it of clusterItems) {
      const p = platformKey(it.platform);
      platformCounts[p] = (platformCounts[p] || 0) + 1;

      if (it.author) sourceSet.add(String(it.author).trim().toLowerCase());

      const t = parseDateMs(it.publishedAt);
      if (!Number.isNaN(t) && t > newestPublishedAtMs) newestPublishedAtMs = t;

      if (!bestItem || (it.trendScore ?? 0) > (bestItem.trendScore ?? 0)) bestItem = it;

      const m = getMetrics(it);

      if (p === "youtube") {
        ytVelocitySum += Number(m.velocity || 0);
        ytViewsSum += Number(m.views || 0);
        ytEngagementSum += Number(m.likes || 0) + Number(m.comments || 0);
      }

      if (p === "news") {
        newsCount += 1;
        if (it.author) newsSourceSet.add(String(it.author).trim().toLowerCase());
      }
    }

    const clusterSize = clusterItems.length;
    const sourceDiversity = sourceSet.size;

    // Freshness: based on newest item (topic is as fresh as its freshest evidence)
    const freshnessScore = newestPublishedAtMs === -Infinity
      ? 0
      : freshness01FromPublishedAt(new Date(newestPublishedAtMs).toISOString(), freshnessHalfLifeHours, freshnessMaxHours);

    // Saturation proxy (Phase 1): within-run saturation.
    // Later we’ll replace with 48h historical cluster counts.
    const saturation48h = clusterSize;

    // Saturation penalty: grows slowly; clamp to 0..1
    // Example: 1 item => ~0, 5 items => ~0.25, 12 items => ~0.6, 20+ => ~0.8-1
    const saturationPenalty = clamp01(Math.log1p(saturation48h - 1) / Math.log1p(20));

    // Strength signals normalized (simple Phase-1 approach)
    // Use logs to prevent outliers dominating.
    const youtubeStrength = clamp01(
      (Math.log1p(ytVelocitySum) / Math.log1p(50000)) * 0.6 +
      (Math.log1p(ytEngagementSum) / Math.log1p(200000)) * 0.4
    );

    const newsStrength = clamp01(
      (Math.log1p(newsCount) / Math.log1p(30)) * 0.6 +
      (Math.log1p(newsSourceSet.size || 1) / Math.log1p(12)) * 0.4
    );

    // Confirmation score (Phase 1): cross-source confirmation
    // later: add Google Trends slope/level
    const hasYt = (platformCounts.youtube || 0) > 0;
    const hasNews = (platformCounts.news || 0) > 0;
    const confirmationScore = clamp01((hasYt ? 0.5 : 0) + (hasNews ? 0.5 : 0)); // 0, 0.5, or 1

    // Final topicScore (0..1000)
    // Transparent: strong + fresh + confirmed - saturated
    const final01 =
      0.40 * youtubeStrength +
      0.25 * newsStrength +
      0.20 * freshnessScore +
      0.15 * confirmationScore -
      0.25 * saturationPenalty;

    const topicScore = Math.round(1000 * clamp01(final01));

    const keywords = topKeywords([...c.signature], 12);
    const topicId = hashTopicId(keywords);

    const topSourceUrls = clusterItems
      .slice()
      .sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0))
      .slice(0, 8)
      .map(x => x.sourceUrl)
      .filter(Boolean);

    const canonicalTitle =
      bestItem?.topicTitle ||
      clusterItems[0]?.topicTitle ||
      "Untitled topic";

    const summary =
      bestItem?.topicSummary ||
      clusterItems.find(x => x.topicSummary)?.topicSummary ||
      "";

    return {
      trendRunId,
      projectId,
      topicId,
      canonicalTitle,
      summary,

      keywordsJson: safeJsonStringify(keywords),
      topSourceUrlsJson: safeJsonStringify(topSourceUrls),
      platformCountsJson: safeJsonStringify(platformCounts),

      sourceDiversity,
      clusterSize,
      freshnessScore,

      saturation48h,
      saturationPenalty,

      youtubeSignalsJson: safeJsonStringify({
        velocitySum: ytVelocitySum,
        viewsSum: ytViewsSum,
        engagementSum: ytEngagementSum
      }),
      newsSignalsJson: safeJsonStringify({
        articleCount: newsCount,
        sourceCount: newsSourceSet.size
      }),

      googleTrendsJson: safeJsonStringify({}), // filled later
      confirmationScore,

      topicScore,

      scoreBreakdownJson: safeJsonStringify({
        youtubeStrength,
        newsStrength,
        freshnessScore,
        confirmationScore,
        saturationPenalty,
        final01
      }),

      status: "CANDIDATE",
      selectedBy: "SYSTEM",
      llmNotes: ""
    };
  });

  // 4) Return top N topics
  topicRecords.sort((a, b) => (b.topicScore ?? 0) - (a.topicScore ?? 0));
  return topicRecords.slice(0, maxTopics);
}