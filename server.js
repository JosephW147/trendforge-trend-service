// server.js
import express from "express";
import cors from "cors";

import { collectYouTubeTrends } from "./youtubeCollector.js";
import { collectGdelt } from "./collectors/gdelt.js";
import { collectRss } from "./collectors/rss.js";
import { DEFAULT_RSS_FEEDS } from "./config/rssFeeds.js";

import { normalizeTrendItem } from "./normalize/trendItem.js";
import { scoreItem } from "./scoring/score.js";
import { buildTrendTopics } from "./topics/buildTrendTopics.js";

const app = express();
app.use(cors());
app.use(express.json());

const BASE44_BUILD_TOPICS_URL =
  process.env.BASE44_BUILD_TOPICS_URL ||
  "https://trend-spark-485fdded.base44.app/api/apps/6953c58286976a82485fdded/functions/buildTrendTopicsFromRun";

// ---- Env sanity ----
if (!process.env.BASE44_INGEST_URL) console.warn("⚠️ BASE44_INGEST_URL is missing");
if (!process.env.BASE44_TOPICS_INGEST_URL) console.warn("⚠️ BASE44_TOPICS_INGEST_URL is missing");
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

  // default
  if (supported.size === 0) supported.add("youtube");
  return [...supported];
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
  } = req.body || {};

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
      console.log("▶ running youtube collector");
      const ytItems = await collectYouTubeTrends({
        nicheName,
        region,
        maxResults: 15,
      });

      console.log("🎥 ytItems raw count:", ytItems?.length ?? 0);
      console.log("🎥 ytItems sample (raw):", ytItems?.[0]);
      rawItems.push(...(ytItems || []));
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

    // 2) Normalize + score (do NOT slice yet)
    let items = rawItems
      .map((raw) => {
        const originalPlatform =
          (raw.platform || raw.source || raw.provider || "").toLowerCase().trim();

        const normalized = normalizeTrendItem(raw);

        // Keep collector platform if normalization loses it
        const platform = (normalized.platform || originalPlatform || "unknown")
          .toLowerCase()
          .trim();

        // Ensure a usable URL
        const sourceUrl =
          normalized.sourceUrl ||
          normalized.url ||
          normalized.link ||
          raw.sourceUrl ||
          raw.url ||
          raw.link ||
          (raw.videoId ? `https://www.youtube.com/watch?v=${raw.videoId}` : "");

        return {
          ...normalized,
          platform,
          sourceUrl,
        };
      })
      .map((it) => ({
        ...it,
        // scoreItem expects item fields incl publishedAt/platform/metrics possibly
        trendScore: scoreItem(it),
      }));

    console.log("🧪 normalized items count:", items.length);
    console.log("🧪 normalized sample:", items[0]);

    const platformCountsBefore = items.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts BEFORE dedupe:", platformCountsBefore);

    // 3) Dedupe by platform + sourceUrl
    const seen = new Set();
    items = items.filter((it) => {
      const p = (it.platform || "unknown").toLowerCase().trim();
      const u = (it.sourceUrl || "").trim();
      if (!u) return false;

      const key = `${p}::${u}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const platformCountsAfter = items.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts AFTER dedupe:", platformCountsAfter);

    // 4) Sort by score (still no slicing)
    items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

    const topCounts = items.slice(0, 20).reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("🏆 platformCounts in top 20 after scoring:", topCounts);

    // 5) Build TrendTopics from ALL deduped items (best practice)
    const topics = buildTrendTopics({
      trendRunId,
      projectId,
      items,
      options: {
        similarityThreshold: 0.55,
        maxTopics: 30,
        freshnessHalfLifeHours: 24,
        freshnessMaxHours: 72,
      },
    });

    console.log("🧩 TrendTopics built:", topics.length);
    console.log("🧩 Top topic sample:", topics[0]);

    // 6) Choose what to STORE vs what to SHOW
    // STORE: keep a big pool so Base44 clustering works
    const MAX_STORE = 120;

    // Always sort first (you already did)
    const storeItems = items.slice(0, MAX_STORE);

    // Optional: small "variety" selection for UI (still 20) — TEMP only
    // Best long-term is driving dashboard from TrendTopics instead of TrendItems.
    const FINAL_LIMIT = 20;
    const YT_QUOTA = 8;
    const NEWS_QUOTA = 12;

    const youtubeTop = storeItems.filter((i) => i.platform === "youtube").slice(0, YT_QUOTA);
    const newsTop = storeItems.filter((i) => i.platform === "news").slice(0, NEWS_QUOTA);

    let finalItems = [...youtubeTop, ...newsTop];

    // Fill remaining slots from best leftovers
    if (finalItems.length < FINAL_LIMIT) {
      const pickedUrls = new Set(finalItems.map((i) => i.sourceUrl));
      const leftovers = storeItems.filter((i) => !pickedUrls.has(i.sourceUrl));
      finalItems = [...finalItems, ...leftovers].slice(0, FINAL_LIMIT);
    } else {
      finalItems = finalItems.slice(0, FINAL_LIMIT);
    }

    console.log("✅ STORE TrendItems count:", storeItems.length);
    console.log("✅ SHOW TrendItems count:", finalItems.length);

    // 7) Ingest TrendItems
    console.log("➡️ Calling Base44 TrendItems ingest:", process.env.BASE44_INGEST_URL);
    const ingestResp = await postToBase44(process.env.BASE44_INGEST_URL, {
      trendRunId,
      projectId,
      items: storeItems,
    });
    console.log("✅ Base44 TrendItems ingest response:", ingestResp);
    const storeCounts = storeItems.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📦 STORE platformCounts:", storeCounts);

    // 8) Ingest TrendTopics (if configured)
    console.log("TOPICS ingest URL:", process.env.BASE44_TOPICS_INGEST_URL || "(missing)");
    console.log("TOPICS count about to ingest:", topics?.length ?? 0);
    if (process.env.BASE44_TOPICS_INGEST_URL) {
      console.log("➡️ Calling Base44 TrendTopics ingest:", process.env.BASE44_TOPICS_INGEST_URL);
      const topicsResp = await postToBase44(process.env.BASE44_TOPICS_INGEST_URL, {
        trendRunId,
        projectId,
      });
      console.log("✅ Base44 TrendTopics ingest response:", topicsResp);
    } else {
      console.warn("⚠️ Skipping TrendTopics ingest: BASE44_TOPICS_INGEST_URL not set");
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
app.listen(PORT, () => console.log(`TrendForge Trend Service running on port ${PORT}`));
