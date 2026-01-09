// youtubeWatchlistCollector.js
// Collects recent videos for a user-defined watchlist (channels + keywords)
// using the YouTube Data API v3.

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

// ----------------------
// Simple in-memory cache (per Render instance)
// ----------------------
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Cache TTLs (tune later)
const TTL_SEARCH_MS = 10 * 60 * 1000; // 10 min
const TTL_VIDEOS_MS = 10 * 60 * 1000; // 10 min

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
  const vph = views / Math.max(1, ageHours);
  return clamp01(Math.log10(vph + 1) / 6);
}

function computeEngagement01({ likes, comments, views }) {
  const denom = Math.max(1, views);
  const likeRate = likes / denom;
  const commentRate = comments / denom;
  return clamp01(likeRate * 4 + commentRate * 20);
}

function computeTrendScore({ views, likes, comments, ageHours }) {
  const v01 = computeVelocity01({ views, ageHours });
  const e01 = computeEngagement01({ likes, comments, views });
  const recency = clamp01(1 - ageHours / 72);
  return Math.round((v01 * 60 + e01 * 30 + recency * 10) * 100) / 100;
}

// ----------------------
// Quota detection helpers
// ----------------------
function looksLikeQuotaExceeded(status, text) {
  if (status !== 403) return false;
  const s = String(text || "").toLowerCase();
  return s.includes("quota") && (s.includes("quotaexceeded") || s.includes("exceeded your"));
}

async function fetchText(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  return { resp, text };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function shortKeyPart(s, maxLen = 80) {
  const x = String(s ?? "");
  if (x.length <= maxLen) return x;
  return x.slice(0, maxLen) + `…len${x.length}`;
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
    metrics: {
      views,
      likes,
      comments,
      ageHours: Math.round(ageHours),
      viewsPerHour: Math.round((views / Math.max(1, ageHours)) * 100) / 100,
      likeRate: Math.round((likes / Math.max(1, views)) * 1e6) / 1e6,
      commentRate: Math.round((comments / Math.max(1, views)) * 1e6) / 1e6,
      sourceType: meta.sourceType,
      sourceLabel: meta.sourceLabel || "",
      region: meta.region || "Global",
    },
    trendScore,
    riskScore: 5,
    clusterId: `yt_${v.id}`,
  };
}

async function ytSearchCached(params, apiKey, cacheKey, onQuota) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log("🧠 [YT cache hit] search.list", { key: cacheKey });
    return cached;
  }

  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const url = `${YT_SEARCH_URL}?${searchParams.toString()}`;
  const { resp, text } = await fetchText(url);

  if (!resp.ok) {
    if (looksLikeQuotaExceeded(resp.status, text)) {
      if (typeof onQuota === "function") onQuota();
      return null; // caller decides how to proceed
    }
    throw new Error(`YouTube search failed ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  cacheSet(cacheKey, json, TTL_SEARCH_MS);
  return json;
}

async function ytVideosCached(ids, apiKey, cacheKey, onQuota) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log("🧠 [YT cache hit] videos.list", { count: ids.length });
    return cached;
  }

  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key: apiKey,
  });

  const url = `${YT_VIDEOS_URL}?${videosParams.toString()}`;
  const { resp, text } = await fetchText(url);

  if (!resp.ok) {
    if (looksLikeQuotaExceeded(resp.status, text)) {
      if (typeof onQuota === "function") onQuota();
      return null;
    }
    throw new Error(`YouTube videos.list failed ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  cacheSet(cacheKey, json, TTL_VIDEOS_MS);
  return json;
}

export async function collectYouTubeWatchlist({
  watchlist,
  region = "Global",
  regionCode = "",
  relevanceLanguage = "",
  windowHours = 72,
  maxPerChannel = 10,
  maxPerKeyword = 10,
}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is missing in env");

  const wl = normalizeWatchlist(watchlist);
  if (!wl.channels.length && !wl.keywords.length) return [];

  const publishedAfter = isoHoursAgo(windowHours);

  const ids = new Set();
  const idMeta = new Map();

  // ----------------------
  // A) channel uploads
  // ----------------------
  for (const c of wl.channels) {
    const channelId = c.channelId.trim();
    const cap = Math.min(maxPerChannel, 25);

    const cacheKey = `yt:wl:search:channel=${channelId}:cap=${cap}:after=${publishedAfter}:rc=${shortKeyPart(
      regionCode
    )}:lang=${shortKeyPart(relevanceLanguage)}`;

    const res = await ytSearchCached(
      {
        part: "snippet",
        type: "video",
        channelId,
        order: "date",
        maxResults: String(cap),
        publishedAfter,
        ...(regionCode ? { regionCode } : {}),
        ...(relevanceLanguage ? { relevanceLanguage } : {}),
      },
      apiKey,
      cacheKey,
      () => console.warn(`⚠️ [YT quota exceeded] search.list (watchlist channel ${channelId}) — skipping channel`)
    );

    if (!res) continue;

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

  // ----------------------
  // B) keyword searches
  // ----------------------
  for (const k of wl.keywords) {
    const q = k.query.trim();
    const cap = Math.min(maxPerKeyword, 25);

    const cacheKey = `yt:wl:search:q=${encodeURIComponent(shortKeyPart(q))}:cap=${cap}:after=${publishedAfter}:rc=${shortKeyPart(
      regionCode
    )}:lang=${shortKeyPart(relevanceLanguage)}`;

    const res = await ytSearchCached(
      {
        part: "snippet",
        type: "video",
        q,
        order: "date",
        maxResults: String(cap),
        publishedAfter,
        ...(regionCode ? { regionCode } : {}),
        ...(relevanceLanguage ? { relevanceLanguage } : {}),
      },
      apiKey,
      cacheKey,
      () => console.warn(`⚠️ [YT quota exceeded] search.list (watchlist keyword "${q}") — skipping keyword`)
    );

    if (!res) continue;

    for (const it of res.items || []) {
      const vid = it?.id?.videoId;
      if (!vid) continue;
      if (!ids.has(vid)) ids.add(vid);
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

  // ----------------------
  // 2) Fetch stats in chunks (up to 50 IDs per call)
  // ----------------------
  const out = [];

  for (const chunk of chunkArray(idList, 50)) {
    const vidsKey = `yt:wl:videos:ids=${chunk.join(",")}`;

    const vids = await ytVideosCached(
      chunk,
      apiKey,
      vidsKey,
      () => console.warn("⚠️ [YT quota exceeded] videos.list (watchlist) — returning partial results")
    );

    if (!vids) break;

    for (const v of vids.items || []) {
      const meta =
        idMeta.get(v.id) || {
          sourceType: "watchlist_unknown",
          sourceLabel: "watchlist",
          queryUsed: "",
          region,
        };
      out.push(mapVideoToTrendItem(v, meta));
    }
  }

  out.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  return out;
}
