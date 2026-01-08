// server.js
import express from "express";
import cors from "cors";

import { collectYouTubeTrends } from "./youtubeCollector.js";
import { collectYouTubeWatchlist } from "./youtubeWatchlistCollector.js";
import { collectGdelt } from "./collectors/gdelt.js";
import { collectRss } from "./collectors/rss.js";
import { DEFAULT_RSS_FEEDS } from "./config/rssFeeds.js";

import { normalizeTrendItem } from "./normalize/trendItem.js";
import { scoreItemsComparable } from "./scoring/score.js";
import { fetchGoogleTrendsSignal } from "./collectors/googleTrends.js";

const app = express();
app.use(cors());
app.use(express.json());

// Base44 function to compute topics from TrendItems already stored for a TrendRun
const BASE44_BUILD_TOPICS_URL =
  process.env.BASE44_BUILD_TOPICS_URL ||
  "https://trend-spark-485fdded.base44.app/api/apps/6953c58286976a82485fdded/functions/buildTrendTopicsFromRun";

// ---- Env sanity ----
if (!process.env.BASE44_INGEST_URL) console.warn("⚠️ BASE44_INGEST_URL is missing");
if (!process.env.BASE44_ERROR_URL) console.warn("⚠️ BASE44_ERROR_URL is missing");
if (!process.env.INGEST_SECRET) console.warn("⚠️ INGEST_SECRET is missing");
if (!process.env.SERVICE_TOKEN) console.warn("⚠️ SERVICE_TOKEN is missing");

const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "trendforge_service_token";
const INGEST_SECRET =
  process.env.INGEST_SECRET || "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SERVICE_TOKEN) {
    console.log("❌ Unauthorized /scan call. Got token:", token);
    return res.status(401).send("Unauthorized");
  }
  next();
}

// ---- Base44 POST helper ----
async function postToBase44(url, payload) {
  if (!url) throw new Error("postToBase44: missing url");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-trendforge-secret": INGEST_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Base44 call failed ${resp.status}: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
// ---- Base44 POST helper with backoff -----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry ONLY when Base44 says rate-limited
async function postToBase44WithBackoff(url, payload, opts = {}) {
  const {
    retries = 7,
    baseDelayMs = 800,
    maxDelayMs = 12_000,
  } = opts;

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-trendforge-secret": INGEST_SECRET,
        },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();

      const isRateLimited =
        resp.status === 429 ||
        text.toLowerCase().includes("rate limit");

      if (resp.ok) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      if (isRateLimited && attempt < retries) {
        const jitter = Math.floor(Math.random() * 250);
        const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt)) + jitter;
        console.log(`⏳ Base44 rate-limited. Retry in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }

      // Non-rate-limit error or out of retries
      throw new Error(`Base44 call failed ${resp.status}: ${text}`);
    } catch (e) {
      lastErr = e;
      // Retry network errors too (rare)
      if (attempt < retries) {
        const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
        console.log(`⏳ Base44 network/error retry in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw lastErr || new Error("Base44 call failed (unknown)");
}

// ✅ Normalize requested platforms (treat legacy socials as "news" if they appear)
function normalizeRequestedPlatforms(input = []) {
  const set = new Set((input || []).map((p) => String(p).toLowerCase().trim()));
  const supported = new Set();

  if (set.has("youtube")) supported.add("youtube");

  const legacyToNews = [
    "news",
    "reddit",
    "tiktok",
    "instagram",
    "facebook",
    "x",
    "quora",
    "pinterest",
    "truthsocial",
  ];
  if (legacyToNews.some((p) => set.has(p))) supported.add("news");

  if (supported.size === 0) supported.add("youtube");
  return [...supported];
}

function safePlatform(raw) {
  return String(raw || "unknown").toLowerCase().trim();
}

function safeUrlFrom(raw, normalized) {
  return (
    normalized.sourceUrl ||
    normalized.url ||
    normalized.link ||
    raw.sourceUrl ||
    raw.url ||
    raw.link ||
    (raw.videoId ? `https://www.youtube.com/watch?v=${raw.videoId}` : "")
  );
}

function pickTrendsQuery(item) {
  // simple heuristic: title trimmed
  const t = String(item.topicTitle || "").trim();
  if (!t) return "";
  return t.length > 80 ? t.slice(0, 80) : t;
}

function dedupeByPlatformAndUrl(items) {
  const seen = new Set();
  return items.filter((it) => {
    const p = safePlatform(it.platform);
    const u = String(it.sourceUrl || "").trim();
    if (!u) return false;
    const key = `${p}::${u}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Health ----
app.get("/", (req, res) =>
  res.status(200).send("TrendForge Trend Service is running ✅")
);
app.get("/health", (req, res) =>
  res.status(200).json({ ok: true, service: "trendforge-trend-service" })
);

// ---- Scan ----
app.post("/scan", requireAuth, async (req, res) => {
  console.log("🔥 /scan HIT", new Date().toISOString());
  console.log("Body:", req.body);

  const {
    trendRunId,
    projectId,
    nicheName,
    platforms = ["youtube"],
    region = "Global",
    // Optional watchlist:
    // {
    //   channels: [{ label, channelId, enabled, frequency }],
    //   keywords: [{ label, query, enabled, frequency }],
    //   frequency: "hourly" | "daily" (filter which to run)
    // }
    watchlist,
  } = req.body || {};
  
  // 🔍 DEBUG WATCHLIST CONTENT
  console.log("📋 watchlist received:", !!watchlist);
  console.log("watchlist.channels count:", watchlist?.channels?.length || 0);
  console.log("watchlist.keywords count:", watchlist?.keywords?.length || 0);


  if (!trendRunId) return res.status(400).send("Missing trendRunId");
  if (!projectId) return res.status(400).send("Missing projectId");

  // Respond immediately (async job style)
  res.json({ ok: true });

  try {
    console.log("✅ SCAN PIPELINE (YT + NEWS) running");

    const requested = normalizeRequestedPlatforms(platforms);
    console.log("✅ Requested (normalized):", requested);

    // 1) Collect
    let rawItems = [];

    if (requested.includes("youtube")) {
      try {
        console.log("▶ running youtube collector");
        const ytItems = await collectYouTubeTrends({
          nicheName,
          region,
          maxResults: 10, // 🔽 reduce to save quota
        });
        console.log("🎥 ytItems raw count:", ytItems?.length ?? 0);
        rawItems.push(...(ytItems || []));

        if (watchlist && (watchlist.channels?.length || watchlist.keywords?.length)) {
          try {
            console.log("▶ running youtube watchlist collector");
            const wlItems = await collectYouTubeWatchlist({
              watchlist,
              region,
              windowHours: watchlist?.windowHours || 72,
              maxPerChannel: Math.min(watchlist?.maxPerChannel || 10, 5), // 🔽 reduce
              maxPerKeyword: Math.min(watchlist?.maxPerKeyword || 10, 5), // 🔽 reduce
            });
            console.log("📌 watchlist items raw count:", wlItems?.length ?? 0);
            rawItems.push(...(wlItems || []));
          } catch (e) {
            console.error("⚠️ YouTube watchlist collector failed (continuing):", e?.message || e);
          }
        }
      } catch (e) {
        console.error("⚠️ YouTube collector failed (continuing with other platforms):", e?.message || e);
      }
    }

    if (requested.includes("news")) {
      console.log("▶ running news collectors (GDELT + RSS)");
      const gdeltItems = await collectGdelt({ nicheName, max: 25 });
      const rssItems = await collectRss({
        feeds: DEFAULT_RSS_FEEDS,
        nicheName,
        maxPerFeed: 6,
      });
      rawItems.push(...(gdeltItems || []), ...(rssItems || []));
    }

    // 2) Normalize (NO scoring yet)
    let items = rawItems.map((raw) => {
      const originalPlatform = safePlatform(raw.platform || raw.source || raw.provider);
      const normalized = normalizeTrendItem(raw);

      const platform = safePlatform(normalized.platform || originalPlatform || "unknown");
      const sourceUrl = safeUrlFrom(raw, normalized);

      return { ...normalized, platform, sourceUrl };
    });

    console.log("🧪 normalized items count:", items.length);
    console.log("🧪 normalized sample:", items[0]);

    const platformCountsBefore = items.reduce((a, it) => {
      const p = safePlatform(it.platform);
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts BEFORE dedupe:", platformCountsBefore);

    // 3) Dedupe BEFORE scoring/trends
    items = dedupeByPlatformAndUrl(items);

    const platformCountsAfter = items.reduce((a, it) => {
      const p = safePlatform(it.platform);
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts AFTER dedupe:", platformCountsAfter);

    // 4) Optional: Google Trends on a small subset.
    // IMPORTANT: pick candidates deterministically.
    // Since we don’t have comparable trendScore yet, use recency as a rough prefilter:
    // scoreItemsComparable will later incorporate googleTrends.score01.
    const TRENDS_ENABLED = process.env.GOOGLE_TRENDS_ENABLED === "true";
    if (TRENDS_ENABLED) {
      // pre-pick the newest items (fast + more relevant)
      const candidates = items
        .slice()
        .sort((a, b) => {
          const ta = new Date(a.publishedAt || 0).getTime();
          const tb = new Date(b.publishedAt || 0).getTime();
          return (tb || 0) - (ta || 0);
        })
        .slice(0, 10);

      await Promise.allSettled(
        candidates.map(async (it) => {
          const query = pickTrendsQuery(it);
          if (!query) return;
          const gt = await fetchGoogleTrendsSignal({
            query,
            geo: "",
            timeRange: "now 7-d",
          });
          it.googleTrends = gt;
        })
      );
    }

    // 5) Comparable scoring (cross-platform)
    scoreItemsComparable(items);

    // 6) Sort by comparable score
    items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

    const topCounts = items.slice(0, 20).reduce((a, it) => {
      const p = safePlatform(it.platform);
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("🏆 platformCounts in top 20 after scoring:", topCounts);

    // 7) STORE pool (important for Base44 topic building)
    const MAX_STORE = 120;
    const storeItems = items.slice(0, MAX_STORE);

    console.log("✅ STORE TrendItems count:", storeItems.length);

    // 8) Ingest TrendItems (STORE pool)
    console.log("➡️ Calling Base44 TrendItems ingest:", process.env.BASE44_INGEST_URL);
    const ingestResp = await postToBase44(process.env.BASE44_INGEST_URL, {
      trendRunId,
      projectId,
      items: storeItems,
    });
    console.log("✅ Base44 TrendItems ingest response:", ingestResp);
    // Give Base44 a brief breather after a large ingest to reduce throttling
    await sleep(1200);


    const storeCounts = storeItems.reduce((a, it) => {
      const p = safePlatform(it.platform);
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📦 STORE platformCounts:", storeCounts);

    // 9) Build TrendTopics in Base44 from stored TrendItems
    console.log("TOPICS build URL:", BASE44_BUILD_TOPICS_URL);
try {
  const topicsResp = await postToBase44WithBackoff(
    BASE44_BUILD_TOPICS_URL,
    { trendRunId, projectId }, // include projectId (harmless if ignored)
    { retries: 7, baseDelayMs: 900, maxDelayMs: 12_000 }
  );
  console.log("✅ Base44 buildTrendTopicsFromRun response:", topicsResp);
} catch (e) {
  console.error("❌ Base44 buildTrendTopicsFromRun failed (after retries):", e?.message || e);

  // Optional: mark a warning somewhere (do not fail entire run)
  // You could call BASE44_ERROR_URL with a non-fatal warning if you want
}
 } catch (err) {
    console.error("❌ Scan pipeline failed:", err?.message || err);

    // Best-effort error callback to Base44
    try {
      if (process.env.BASE44_ERROR_URL) {
        console.log("➡️ Calling Base44 error:", process.env.BASE44_ERROR_URL);
        const errResp = await postToBase44(process.env.BASE44_ERROR_URL, {
          trendRunId,
          projectId,
          message: err?.message || String(err),
        });
        console.log("✅ Base44 error response:", errResp);
      } else {
        console.warn("⚠️ BASE44_ERROR_URL not set; cannot notify Base44 of errors.");
      }
    } catch (e) {
      console.error("❌ Failed to notify Base44 error endpoint:", e?.message || e);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`TrendForge Trend Service running on port ${PORT}`)
);
