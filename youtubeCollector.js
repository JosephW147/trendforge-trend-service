// youtubeCollector.js
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

// Simple scoring heuristic (tune later)
function computeTrendScore({ views, likes, comments, ageHours }) {
  // Favor high engagement + recency
  const engagement = likes + comments * 2;
  const recencyBoost = Math.max(0.2, 48 / Math.max(1, ageHours)); // stronger for fresh videos
  return Math.round((Math.log10(views + 1) * 20 + Math.log10(engagement + 1) * 30) * recencyBoost);
}

export async function collectYouTubeTrends({ nicheName, region = "Global", maxResults = 15 }) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is missing in Render env");

  // 1) Search candidates
  // search.list: quota cost is high (100 units), so keep maxResults small. :contentReference[oaicite:2]{index=2}
  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    q: nicheName || "trending",
    order: "viewCount",
    maxResults: String(Math.min(maxResults, 25)),
    publishedAfter: isoHoursAgo(48),
    key: apiKey,
  });

  // Optional: if you have a specific region, you can pass regionCode (US, etc.)
  // searchParams.set("regionCode", "US"); // must be ISO 3166-1 alpha-2 :contentReference[oaicite:3]{index=3}

  const searchResp = await fetch(`${YT_SEARCH_URL}?${searchParams.toString()}`);
  const searchText = await searchResp.text();
  if (!searchResp.ok) {
    throw new Error(`YouTube search failed ${searchResp.status}: ${searchText}`);
  }

  const searchJson = JSON.parse(searchText);
  const videoIds = (searchJson.items || [])
    .map((it) => it?.id?.videoId)
    .filter(Boolean);

  if (!videoIds.length) return [];

  // 2) Fetch stats for those IDs (videos.list) :contentReference[oaicite:4]{index=4}
  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
    key: apiKey,
  });

  const vidsResp = await fetch(`${YT_VIDEOS_URL}?${videosParams.toString()}`);
  const vidsText = await vidsResp.text();
  if (!vidsResp.ok) {
    throw new Error(`YouTube videos.list failed ${vidsResp.status}: ${vidsText}`);
  }

  const vidsJson = JSON.parse(vidsText);
  const now = Date.now();

  // 3) Map into TrendItems-ish objects
  const items = (vidsJson.items || []).map((v) => {
    const snippet = v.snippet || {};
    const stats = v.statistics || {};

    const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt).getTime() : now;
    const ageHours = Math.max(1, (now - publishedAt) / (1000 * 60 * 60));

    const views = safeNum(stats.viewCount);
    const likes = safeNum(stats.likeCount);
    const comments = safeNum(stats.commentCount);

    const trendScore = computeTrendScore({ views, likes, comments, ageHours });

    return {
      platform: "youtube",
      topicTitle: snippet.title || "Untitled",
      topicSummary: snippet.description || "",
      sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
      queryUsed: nicheName || "",
      publishedAt: snippet.publishedAt || new Date().toISOString(),
      author: snippet.channelTitle || "",
      metrics: {
        views,
        likes,
        comments,
        ageHours: Math.round(ageHours),
        velocity: likes + comments, // simple placeholder; refine later
        region,
      },
      trendScore,
      riskScore: 5, // placeholder (we'll build a real risk model later)
      clusterId: `yt_${v.id}`,
    };
  });

  // Optional: sort strongest first
  items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));
  return items;
}
