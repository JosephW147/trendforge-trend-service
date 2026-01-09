// youtubeWatchlistCollector.js
// Collects recent videos for a user-defined watchlist (channels + keywords)
// using the YouTube Data API v3.

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

// ----------------------
// In-memory cache (per Render instance)
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

// TTLs (tune later)
const TTL_SEARCH_MS = 15 * 60 * 1000; // 15 min
const TTL_VIDEOS_MS = 15 * 60 * 1000; // 15 min

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
  return clamp01(likeRate * 4 + commentRate * 20);
}

function computeTrendScore({ views, likes, comments, ageHours }) {
  // A more stable heuristic than the default one: focus on velocity + engagement.
  const v01 = computeVelocity01({ views, ageHours });
  const e01 = computeEngagement01({ likes, comments, views });
  const recency = clamp01(1 - ageHours / 72); // 0 after 72h
  return Math.round((v01 * 60 + e01 * 30 + recency * 10) * 100) / 100;
}

// ----------------------
// Quota detection helpers
// ----------------------
function looksLikeQuotaExceeded(status, text) {
  if (status !== 403) return false;
  const s = String(text || "").toLowerCase();
  // YouTube often includes "quotaExceeded" reason and/or "exceeded your quota"
  return s.includes("quota") && (s.includes("quotaexceeded") || s.includes("exceeded your"));
}

async function fetchText(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  return { resp, text };
}

// ----------------------
// API calls (with caching + quota handling)
// ----------------------
async function ytSearch(params, apiKey, cacheKey) {
  const cached = cacheGet(cacheKey);
  if (cached) {
    // Optional log; comment out if too chatty
    // console.log("🧠 [YT cache hit] search.list", cacheKey);
    return cached;
  }

  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const { resp, text } = await fetchText(`${YT_SEARCH_URL}?${searchParams.toString()}`);

  if (!resp.ok) {
    if (looksLikeQuotaExceeded(resp.status, text)) {
      const err = new Error(`YT_QUOTA_EXCEEDED: search.list ${resp.status}`);
      err.code = "YT_QUOTA_EXCEEDED";
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    throw new Error(`YouTube search failed ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  cacheSet(cacheKey, json, TTL_SEARCH_MS);
  return json;
}

async function ytVideos(ids, apiKey, cacheKey) {
  if (!ids.length) return { items: [] };

  const cached = cacheGet(cacheKey);
  if (cached) {
    // Optional log; comment out if too chatty
    // console.log("🧠 [YT cache hit] videos.list", cacheKey);
    return cached;
  }

  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key: apiKey,
  });

  const { resp, text } = await fetchText(`${YT_VIDEOS_URL}?${videosParams.toString()}`);

  if (!resp.ok) {
    if (looksLikeQuotaExceeded(resp.status, text)) {
      const err = new Error(`YT_QUOTA_EXCEEDED: videos.list ${resp.status}`);
      err.code = "YT_QUOTA_EXCEEDED";
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    throw new Error(`YouTube videos.list failed ${resp.status}: ${text}`);
  }

  const json = JSON.parse(text);
  cacheSet(cacheKey, json, TTL_VIDEOS_MS);
  return json;
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
    .filter((k) => {
      // support both {query} and {queryText} in case some rows use your seed format
      const q = typeof k?.query === "string" ? k.query : (typeof k?.queryText === "string" ? k.queryText : "");
      return q && q.trim();
    })
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
      sourceType: meta.sourceType, // watchlist_channel | watchlist_keyword
      sourceLabel: meta.sourceLabel || "",
      region: meta.region || "Global",
    },
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

  let quotaTripped = false;

  // A) channel uploads
  for (const c of wl.channels) {
    if (quotaTripped) break;

    const channelId = c.channelId.trim();
    const maxResults = Math.min(maxPerChannel, 25);

    const params = {
      part: "snippet",
      type: "video",
      channelId,
      order: "date",
      maxResults: String(maxResults),
      publishedAfter,
      ...(regionCode ? { regionCode } : {}),
      ...(relevanceLanguage ? { relevanceLanguage } : {}),
    };

    const cacheKey = `yt:wl:search:channel:${channelId}:max=${maxResults}:after=${publishedAfter}:rc=${regionCode || "-"}:lang=${relevanceLanguage || "-"}`;

    try {
      const res = await ytSearch(params, apiKey, cacheKey);

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
    } catch (e) {
      if (e?.code === "YT_QUOTA_EXCEEDED") {
        quotaTripped = true;
        console.warn("⚠️ YouTube quota exceeded during watchlist channel search. Returning partial results.");
        break;
      }
      throw e;
    }
  }

  // B) keyword searches
  for (const k of wl.keywords) {
    if (quotaTripped) break;

    // support both {query} and {queryText}
    const q = (typeof k?.query === "string" ? k.query : (typeof k?.queryText === "string" ? k.queryText : "")).trim();
    if (!q) continue;

    const maxResults = Math.min(maxPerKeyword, 25);

    const params = {
      part: "snippet",
      type: "video",
      q,
      order: "date",
      maxResults: String(maxResults),
      publishedAfter,
      ...(regionCode ? { regionCode } : {}),
      ...(relevanceLanguage ? { relevanceLanguage } : {}),
    };

    const cacheKey = `yt:wl:search:keyword:${encodeURIComponent(q)}:max=${maxResults}:after=${publishedAfter}:rc=${regionCode || "-"}:lang=${relevanceLanguage || "-"}`;

    try {
      const res = await ytSearch(params, apiKey, cacheKey);

      for (const it of res.items || []) {
        const vid = it?.id?.videoId;
        if (!vid) continue;
        if (!ids.has(vid)) ids.add(vid);
        if (!idMeta.has(vid)) {
          idMeta.set(vid, {
            sourceType: "watchlist_keyword",
            sourceLabel: k.label || q,
            queryUsed: q,
            region,
          });
        }
      }
    } catch (e) {
      if (e?.code === "YT_QUOTA_EXCEEDED") {
        quotaTripped = true;
        console.warn("⚠️ YouTube quota exceeded during watchlist keyword search. Returning partial results.");
        break;
      }
      throw e;
    }
  }

  const idList = [...ids];
  if (!idList.length) return [];

  // --- 2) Fetch stats in chunks (YouTube allows up to 50 IDs per call) ---
  const out = [];
  for (let i = 0; i < idList.length; i += 50) {
    if (quotaTripped) break;

    const chunk = idList.slice(i, i + 50);
    const cacheKey = `yt:wl:videos:${chunk.join(",")}`;

    try {
      const vids = await ytVideos(chunk, apiKey, cacheKey);

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
    } catch (e) {
      if (e?.code === "YT_QUOTA_EXCEEDED") {
        quotaTripped = true;
        console.warn("⚠️ YouTube quota exceeded during watchlist videos.list. Returning partial results.");
        break;
      }
      throw e;
    }
  }

  // Sort best first.
  out.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

  // IMPORTANT: If quota tripped, still return what we have (don’t crash scan)
  if (quotaTripped) {
    console.warn("⚠️ Watchlist collector returned partial results due to quota. items:", out.length);
  }

  return out;
}
