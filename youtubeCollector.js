// youtubeCollector.js
const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

// ----------------------
// Simple in-memory cache (per Render instance)
// ----------------------
const _cache = new Map();
/**
 * cacheGet(key) -> value | null
 */
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
/**
 * cacheSet(key, value, ttlMs)
 */
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

// Simple scoring heuristic (tune later)
function computeTrendScore({ views, likes, comments, ageHours }) {
  const engagement = likes + comments * 2;
  const recencyBoost = Math.max(0.2, 48 / Math.max(1, ageHours));
  return Math.round(
    (Math.log10(views + 1) * 20 + Math.log10(engagement + 1) * 30) * recencyBoost
  );
}

// ----------------------
// Quota detection helpers
// ----------------------
function looksLikeQuotaExceeded(status, text) {
  if (status !== 403) return false;
  const s = String(text || "").toLowerCase();
  // Typical signals: "quotaExceeded" reason and/or "exceeded your quota"
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

// Shorten cache keys so they don’t explode on long niche strings
function shortKeyPart(s, maxLen = 80) {
  const x = String(s ?? "");
  if (x.length <= maxLen) return x;
  return x.slice(0, maxLen) + `…len${x.length}`;
}

export async function collectYouTubeTrends({ nicheName, region = "Global", maxResults = 15 }) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is missing in Render env");

  const q = (nicheName || "trending").trim() || "trending";
  const publishedAfter = isoHoursAgo(48);
  const cappedMax = Math.min(maxResults, 25);

  // ----------------------
  // 1) search.list (cached)
  // ----------------------
  const searchKey = `yt:search:q=${encodeURIComponent(shortKeyPart(q))}:max=${cappedMax}:after=${publishedAfter}:region=${encodeURIComponent(
    shortKeyPart(region)
  )}`;

  let videoIds = [];
  const cachedSearch = cacheGet(searchKey);

  if (cachedSearch) {
    console.log("🧠 [YT cache hit] search.list", { q, cappedMax, region });
    videoIds = cachedSearch;
  } else {
    // search.list: quota cost is high (100 units), so keep maxResults small.
    const searchParams = new URLSearchParams({
      part: "snippet",
      type: "video",
      q,
      order: "viewCount",
      maxResults: String(cappedMax),
      publishedAfter,
      key: apiKey,
    });

    const { resp: searchResp, text: searchText } = await fetchText(
      `${YT_SEARCH_URL}?${searchParams.toString()}`
    );

    if (!searchResp.ok) {
      if (looksLikeQuotaExceeded(searchResp.status, searchText)) {
        console.warn(
          "⚠️ [YT quota exceeded] search.list — returning [] (no YouTube trends this run)"
        );
        return [];
      }
      throw new Error(`YouTube search failed ${searchResp.status}: ${searchText}`);
    }

    const searchJson = JSON.parse(searchText);
    videoIds = (searchJson.items || [])
      .map((it) => it?.id?.videoId)
      .filter(Boolean);

    cacheSet(searchKey, videoIds, TTL_SEARCH_MS);
  }

  if (!videoIds.length) return [];

  // ----------------------
  // 2) videos.list (cached, batched)
  // ----------------------
  const now = Date.now();
  const items = [];

  // YouTube videos.list supports up to 50 ids per request
  const idBatches = chunkArray(videoIds, 50);

  for (const ids of idBatches) {
    const vidsKey = `yt:videos:ids=${ids.join(",")}`;
    const cachedVids = cacheGet(vidsKey);

    let vidsJson = null;

    if (cachedVids) {
      console.log("🧠 [YT cache hit] videos.list", { count: ids.length });
      vidsJson = cachedVids;
    } else {
      const videosParams = new URLSearchParams({
        part: "snippet,statistics,contentDetails",
        id: ids.join(","),
        key: apiKey,
      });

      const { resp: vidsResp, text: vidsText } = await fetchText(
        `${YT_VIDEOS_URL}?${videosParams.toString()}`
      );

      if (!vidsResp.ok) {
        if (looksLikeQuotaExceeded(vidsResp.status, vidsText)) {
          console.warn(
            "⚠️ [YT quota exceeded] videos.list — returning partial YouTube results from earlier batches"
          );
          break; // keep what we already have
        }
        throw new Error(`YouTube videos.list failed ${vidsResp.status}: ${vidsText}`);
      }

      vidsJson = JSON.parse(vidsText);
      cacheSet(vidsKey, vidsJson, TTL_VIDEOS_MS);
    }

    for (const v of vidsJson.items || []) {
      const snippet = v.snippet || {};
      const stats = v.statistics || {};

      const publishedMs = snippet.publishedAt ? new Date(snippet.publishedAt).getTime() : now;
      const ageHours = Math.max(1, (now - publishedMs) / 36e5);

      const views = safeNum(stats.viewCount);
      const likes = safeNum(stats.likeCount);
      const comments = safeNum(stats.commentCount);

      const trendScore = computeTrendScore({ views, likes, comments, ageHours });

      items.push({
        platform: "youtube",
        topicTitle: snippet.title || "Untitled",
        topicSummary: snippet.description || "",
        sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
        queryUsed: q,
        publishedAt: snippet.publishedAt || new Date().toISOString(),
        author: snippet.channelTitle || "",
        metrics: {
          views,
          likes,
          comments,
          ageHours: Math.round(ageHours),
          velocity: likes + comments, // placeholder
          region,
        },
        trendScore,
        riskScore: 5,
        clusterId: `yt_${v.id}`,
      });
    }
  }

  items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  return items;
}
