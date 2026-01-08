// youtubeWatchlistCollector.js
// Collects recent videos for a user-defined watchlist (channels + keywords)
// using the YouTube Data API v3.

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

function isoHoursAgo(hours) {
  const d = new Date(Date.now() - hours * 60 * 60 * 1000);
  return d.toISOString();
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function computeVelocity01({ views, ageHours }) {
  // Simple views/hour scaled with log so huge channels don't always dominate.
  const vph = views / Math.max(1, ageHours);
  return clamp01(Math.log10(vph + 1) / 6); // ~1 at ~1,000,000 vph
}

function computeEngagement01({ likes, comments, views }) {
  const denom = Math.max(1, views);
  const likeRate = likes / denom;
  const commentRate = comments / denom;
  // Typical like rates are < 0.1; comment rates are much smaller.
  return clamp01((likeRate * 4 + commentRate * 20));
}

function computeTrendScore({ views, likes, comments, ageHours }) {
  // A more stable heuristic than the default one: focus on velocity + engagement.
  const v01 = computeVelocity01({ views, ageHours });
  const e01 = computeEngagement01({ likes, comments, views });
  const recency = clamp01(1 - ageHours / 72); // 0 after 72h
  return Math.round((v01 * 60 + e01 * 30 + recency * 10) * 100) / 100;
}

async function ytSearch(params, apiKey) {
  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const resp = await fetch(`${YT_SEARCH_URL}?${searchParams.toString()}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`YouTube search failed ${resp.status}: ${text}`);
  return JSON.parse(text);
}

async function ytVideos(ids, apiKey) {
  if (!ids.length) return { items: [] };
  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key: apiKey,
  });
  const resp = await fetch(`${YT_VIDEOS_URL}?${videosParams.toString()}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`YouTube videos.list failed ${resp.status}: ${text}`);
  return JSON.parse(text);
}

function normalizeWatchlist(watchlist) {
  const wl = watchlist || {};
  const freqFilter = (wl.frequency || "").toLowerCase().trim();

  const channels = Array.isArray(wl.channels) ? wl.channels : [];
  const keywords = Array.isArray(wl.keywords) ? wl.keywords : [];

  const ch = channels
    .filter((c) => c && typeof c.channelId === "string" && c.channelId.trim())
    .filter((c) => c.enabled !== false)
    .filter((c) => !freqFilter || String(c.frequency || "").toLowerCase() === freqFilter);

  const kw = keywords
    .filter((k) => k && typeof k.query === "string" && k.query.trim())
    .filter((k) => k.enabled !== false)
    .filter((k) => !freqFilter || String(k.frequency || "").toLowerCase() === freqFilter);

  return { channels: ch, keywords: kw, frequency: freqFilter || null };
}

function mapVideoToTrendItem(v, meta) {
  const now = Date.now();
  const snippet = v.snippet || {};
  const stats = v.statistics || {};

  const publishedMs = snippet.publishedAt ? new Date(snippet.publishedAt).getTime() : now;
  const ageHours = Math.max(1, (now - publishedMs) / 36e5);

  const views = safeNum(stats.viewCount);
  const likes = safeNum(stats.likeCount);
  const comments = safeNum(stats.commentCount);

  const trendScore = computeTrendScore({ views, likes, comments, ageHours });

  return {
    platform: "youtube",
    topicTitle: snippet.title || "Untitled",
    topicSummary: snippet.description || "",
    sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
    queryUsed: meta.queryUsed || "",
    publishedAt: snippet.publishedAt || new Date().toISOString(),
    author: snippet.channelTitle || "",
    // Keep raw metrics so your comparable scorer can do better later.
    metrics: {
      views,
      likes,
      comments,
      ageHours: Math.round(ageHours),
      viewsPerHour: Math.round((views / Math.max(1, ageHours)) * 100) / 100,
      likeRate: Math.round((likes / Math.max(1, views)) * 1e6) / 1e6,
      commentRate: Math.round((comments / Math.max(1, views)) * 1e6) / 1e6,
      sourceType: meta.sourceType, // watchlist_channel | watchlist_keyword
      sourceLabel: meta.sourceLabel || "",
      region: meta.region || "Global",
    },
    // This is a per-source score; scoreItemsComparable will compute final trendScore.
    trendScore,
    riskScore: 5,
    clusterId: `yt_${v.id}`,
  };
}

export async function collectYouTubeWatchlist({
  watchlist,
  region = "Global",
  regionCode = "", // ISO 3166-1 alpha-2 if you want region filtering
  relevanceLanguage = "", // e.g., en
  windowHours = 72,
  maxPerChannel = 10,
  maxPerKeyword = 10,
}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is missing in env");

  const wl = normalizeWatchlist(watchlist);
  if (!wl.channels.length && !wl.keywords.length) return [];

  const publishedAfter = isoHoursAgo(windowHours);

  // --- 1) Gather candidate IDs ---
  const ids = new Set();
  const idMeta = new Map(); // videoId -> meta

  // A) channel uploads
  for (const c of wl.channels) {
    const res = await ytSearch(
      {
        part: "snippet",
        type: "video",
        channelId: c.channelId.trim(),
        order: "date",
        maxResults: String(Math.min(maxPerChannel, 25)),
        publishedAfter,
        ...(regionCode ? { regionCode } : {}),
        ...(relevanceLanguage ? { relevanceLanguage } : {}),
      },
      apiKey
    );

    for (const it of res.items || []) {
      const vid = it?.id?.videoId;
      if (!vid) continue;
      if (!ids.has(vid)) ids.add(vid);
      if (!idMeta.has(vid)) {
        idMeta.set(vid, {
          sourceType: "watchlist_channel",
          sourceLabel: c.label || c.channelId,
          queryUsed: `channel:${c.channelId}`,
          region,
        });
      }
    }
  }

  // B) keyword searches
  for (const k of wl.keywords) {
    const res = await ytSearch(
      {
        part: "snippet",
        type: "video",
        q: k.query.trim(),
        order: "date",
        maxResults: String(Math.min(maxPerKeyword, 25)),
        publishedAfter,
        ...(regionCode ? { regionCode } : {}),
        ...(relevanceLanguage ? { relevanceLanguage } : {}),
      },
      apiKey
    );

    for (const it of res.items || []) {
      const vid = it?.id?.videoId;
      if (!vid) continue;
      if (!ids.has(vid)) ids.add(vid);
      // Prefer channel meta if already set; otherwise keyword meta.
      if (!idMeta.has(vid)) {
        idMeta.set(vid, {
          sourceType: "watchlist_keyword",
          sourceLabel: k.label || k.query,
          queryUsed: k.query,
          region,
        });
      }
    }
  }

  const idList = [...ids];
  if (!idList.length) return [];

  // --- 2) Fetch stats in chunks (YouTube allows up to 50 IDs per call) ---
  const out = [];
  for (let i = 0; i < idList.length; i += 50) {
    const chunk = idList.slice(i, i + 50);
    const vids = await ytVideos(chunk, apiKey);
    for (const v of vids.items || []) {
      const meta = idMeta.get(v.id) || {
        sourceType: "watchlist_unknown",
        sourceLabel: "watchlist",
        queryUsed: "",
        region,
      };
      out.push(mapVideoToTrendItem(v, meta));
    }
  }

  // Sort best first.
  out.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  return out;
}
