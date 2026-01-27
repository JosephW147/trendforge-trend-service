// signals/buildTrendSignals.js
// Builds UI-optimized TrendSignal rows from TrendTopics + TrendItems for a given run.
// Assumes the Base44 entity "TrendSignal" exists (create it in Base44 using your schema).

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function safeJsonStringify(obj, fallback = "[]") {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

function parseJson(maybeJson, fallback) {
  if (!maybeJson) return fallback;
  if (typeof maybeJson === "object") return maybeJson;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

function saturationLevelFromPenalty(p) {
  const x = Number(p) || 0;
  if (x >= 0.75) return "oversaturated";
  if (x >= 0.5) return "high";
  if (x >= 0.25) return "medium";
  return "low";
}

function engagementRate01({ viewsSum = 0, engagementSum = 0 } = {}) {
  const v = Number(viewsSum) || 0;
  const e = Number(engagementSum) || 0;
  if (v <= 0) return 0;
  return clamp01(e / v);
}

function pickPrimaryPlatform(platformCounts = {}) {
  const yt = Number(platformCounts.youtube || 0);
  const news = Number(platformCounts.news || 0);
  if (yt > 0 && news > 0) return "mixed";
  if (yt > 0) return "youtube";
  if (news > 0) return "news";
  return "mixed";
}

function scoreComposite01({ topicScore = 0, momentumScore = 0, freshnessScore = 0, saturationPenalty = 0, sourceDiversity = 0, platformDiversity = 1 }) {
  // topicScore is usually 0..1000. Normalize.
  const topic01 = clamp01((Number(topicScore) || 0) / 1000);
  const mom01 = clamp01((Number(momentumScore) || 0) / 100);
  const fresh01 = clamp01(Number(freshnessScore) || 0);
  const sat01 = clamp01(Number(saturationPenalty) || 0);
  const breadth01 = clamp01(Math.log1p(Number(sourceDiversity) || 0) / Math.log1p(12));
  const plat01 = clamp01(((Number(platformDiversity) || 1) - 1) / 2);

  const v = 0.40 * topic01 + 0.25 * mom01 + 0.20 * fresh01 + 0.10 * breadth01 + 0.05 * plat01 - 0.20 * sat01;
  return clamp01(v);
}

function scoreEmerging01({ freshnessScore = 0, growth24h = 0, saturationPenalty = 0, sourceDiversity = 0 }) {
  const fresh01 = clamp01(Number(freshnessScore) || 0);
  const growth01 = clamp01(Math.log1p(Math.max(0, Number(growth24h) || 0)) / Math.log1p(12));
  const sat01 = clamp01(Number(saturationPenalty) || 0);
  const breadth01 = clamp01(Math.log1p(Number(sourceDiversity) || 0) / Math.log1p(12));
  return clamp01(0.50 * fresh01 + 0.30 * growth01 + 0.15 * breadth01 - 0.20 * sat01);
}

function scoreMomentum01({ momentumScore = 0, accel24h = 0, growth24h = 0, saturationPenalty = 0, platformDiversity = 1 }) {
  const mom01 = clamp01((Number(momentumScore) || 0) / 100);
  const accel01 = clamp01(((Number(accel24h) || 0) + 2) / 6);
  const growth01 = clamp01(Math.log1p(Math.max(0, Number(growth24h) || 0)) / Math.log1p(12));
  const sat01 = clamp01(Number(saturationPenalty) || 0);
  const plat01 = clamp01(((Number(platformDiversity) || 1) - 1) / 2);
  return clamp01(0.50 * mom01 + 0.20 * accel01 + 0.15 * growth01 + 0.10 * plat01 - 0.20 * sat01);
}

function buildBadges({ primaryPlatform, saturationLevel, momentumScore, freshnessScore, youtubeMetrics, newsMetrics }) {
  const badges = [];
  if (primaryPlatform === "mixed") badges.push("mixed");
  if (primaryPlatform === "youtube") badges.push("youtube");
  if (primaryPlatform === "news") badges.push("news");
  if (saturationLevel) badges.push(`${saturationLevel} saturation`);

  const mom = Number(momentumScore) || 0;
  if (mom >= 70) badges.push("high momentum");
  else if (mom >= 50) badges.push("steady momentum");

  const fresh = Number(freshnessScore) || 0;
  if (fresh >= 0.75) badges.push("very fresh");

  const vel = Number(youtubeMetrics?.velocitySum || 0);
  if (vel > 0) badges.push("yt velocity");

  const articles = Number(newsMetrics?.articleCount || 0);
  if (articles >= 5) badges.push("news coverage");
  return badges.slice(0, 8);
}

function topEvidenceByPlatform(trendItems = [], platform, limit = 3) {
  const p = String(platform || "").toLowerCase();
  const rows = trendItems
    .filter((it) => String(it.platform || "").toLowerCase() === p)
    .sort((a, b) => Number(b.trendScore || 0) - Number(a.trendScore || 0))
    .slice(0, limit)
    .map((it) => ({
      title: it.topicTitle || it.title || it.canonicalTitle || "",
      url: it.sourceUrl || it.url || "",
      publishedAt: it.publishedAt || it.published_date || it.createdAt || it.created_date || "",
      source: it.author || it.source || "",
      platform: String(it.platform || "").toLowerCase(),
      trendScore: Number(it.trendScore || 0),
    }));
  return rows;
}

/**
 * Build TrendSignal rows for a run.
 *
 * @param {object} params
 * @param {import('@base44/sdk').Base44Client} params.base44
 * @param {string} params.trendRunId
 * @param {string} params.projectId
 */
export async function buildTrendSignalsForRun({ base44, trendRunId, projectId }) {
  const topicsRes = await base44.asServiceRole.entities.TrendTopics.filter(
    { trendRunId, projectId },
    "-created_date",
    500
  );
  const topics = topicsRes?.items ?? topicsRes ?? [];

  const itemsRes = await base44.asServiceRole.entities.TrendItems.filter(
    { trendRunId, projectId },
    "-created_date",
    500
  );
  const items = itemsRes?.items ?? itemsRes ?? [];

  const byTopicId = new Map();
  for (const it of items) {
    const tid = String(it.topicId || "");
    if (!tid) continue;
    if (!byTopicId.has(tid)) byTopicId.set(tid, []);
    byTopicId.get(tid).push(it);
  }

  const nowIso = new Date().toISOString();
  const signals = topics.map((t) => {
    const platformCounts = parseJson(t.platformCountsJson, {}) || {};
    const platforms = Object.keys(platformCounts).filter((k) => Number(platformCounts[k] || 0) > 0);

    const youtubeSignals = parseJson(t.youtubeSignalsJson, {}) || {};
    const newsSignals = parseJson(t.newsSignalsJson, {}) || {};

    const youtubeMetrics = {
      velocitySum: Number(youtubeSignals.velocitySum || youtubeSignals.velocity || 0),
      viewsSum: Number(youtubeSignals.viewsSum || youtubeSignals.views || 0),
      engagementSum: Number(youtubeSignals.engagementSum || youtubeSignals.engagement || 0),
    };
    youtubeMetrics.engagementRate = engagementRate01({
      viewsSum: youtubeMetrics.viewsSum,
      engagementSum: youtubeMetrics.engagementSum,
    });
    youtubeMetrics.relatedVideosCount = Number(platformCounts.youtube || 0);

    const newsMetrics = {
      articleCount: Number(newsSignals.articleCount || 0),
      sourceCount: Number(newsSignals.sourceCount || 0),
      relatedArticlesCount: Number(platformCounts.news || 0),
      socialHintsCounts: {
        tiktok: Number(newsSignals.tiktokMentionCount || 0),
        instagram: Number(newsSignals.instagramMentionCount || 0),
        reels: Number(newsSignals.reelsMentionCount || 0),
        shorts: Number(newsSignals.shortsMentionCount || 0),
      },
    };

    const platformDiversity = platforms.length || 1;
    const primaryPlatform = pickPrimaryPlatform(platformCounts);
    const saturationLevel = saturationLevelFromPenalty(t.saturationPenalty);

    const composite01 = scoreComposite01({
      topicScore: t.topicScore,
      momentumScore: t.momentumScore,
      freshnessScore: t.freshnessScore,
      saturationPenalty: t.saturationPenalty,
      sourceDiversity: t.sourceDiversity,
      platformDiversity,
    });
    const emerging01 = scoreEmerging01({
      freshnessScore: t.freshnessScore,
      growth24h: t.growth24h,
      saturationPenalty: t.saturationPenalty,
      sourceDiversity: t.sourceDiversity,
    });
    const momentum01 = scoreMomentum01({
      momentumScore: t.momentumScore,
      accel24h: t.accel24h,
      growth24h: t.growth24h,
      saturationPenalty: t.saturationPenalty,
      platformDiversity,
    });

    const evidenceItems = byTopicId.get(String(t.topicId)) || [];
    const evidence = {
      youtubeTop: topEvidenceByPlatform(evidenceItems, "youtube", 3),
      newsTop: topEvidenceByPlatform(evidenceItems, "news", 3),
    };

    const topUrls = [];
    for (const r of [...evidence.youtubeTop, ...evidence.newsTop]) {
      if (r?.url) topUrls.push(r.url);
    }

    const badges = buildBadges({
      primaryPlatform,
      saturationLevel,
      momentumScore: t.momentumScore,
      freshnessScore: t.freshnessScore,
      youtubeMetrics,
      newsMetrics,
    });

    return {
      trendRunId,
      projectId,
      topicId: String(t.topicId),
      topicKey: String(t.topicKey || ""),
      canonicalTitle: String(t.canonicalTitle || t.title || ""),
      summary: String(t.summary || ""),
      primaryPlatform,
      platformsJson: safeJsonStringify(platforms, "[]"),
      platformCountsJson: safeJsonStringify(platformCounts, "{}"),
      scoreComposite: Math.round(100 * composite01),
      scoreEmerging: Math.round(100 * emerging01),
      scoreMomentum: Math.round(100 * momentum01),
      topicScore: Number(t.topicScore || 0),
      momentumScore: Number(t.momentumScore || 0),
      freshnessScore: Number(t.freshnessScore || 0),
      growth24h: Number(t.growth24h || 0),
      accel24h: Number(t.accel24h || 0),
      saturationLevel,
      saturation48h: Number(t.saturation48h || 0),
      saturationPenalty: Number(t.saturationPenalty || 0),
      clusterSize: Number(t.clusterSize || 0),
      sourceDiversity: Number(t.sourceDiversity || 0),
      keywordsJson: String(t.keywordsJson || "[]"),
      topSourceUrlsJson: safeJsonStringify(topUrls.slice(0, 8), "[]"),
      evidenceJson: safeJsonStringify(evidence, "{}"),
      youtubeMetricsJson: safeJsonStringify(youtubeMetrics, "{}"),
      newsMetricsJson: safeJsonStringify(newsMetrics, "{}"),
      llmAnglesJson: t.llmAnglesJson || "[]",
      llmAnglesStatus: t.llmAnglesStatus || "empty",
      cardBadgesJson: safeJsonStringify(badges, "[]"),
      status: "ACTIVE",
      createdAt: t.createdAt || t.created_date || nowIso,
      updatedAt: nowIso,
    };
  });

  return { signals, topicsCount: topics.length, itemsCount: items.length };
}
