import express from "express";
import cors from "cors";
import { collectYouTubeTrends } from "./youtubeCollector.js";
import { collectGdelt } from "./collectors/gdelt.js";
import { collectRss } from "./collectors/rss.js";
import { DEFAULT_RSS_FEEDS } from "./config/rssFeeds.js";
import { normalizeTrendItem } from "./normalize/trendItem.js";
import { scoreItem } from "./scoring/score.js";

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.BASE44_INGEST_URL) console.warn("⚠️ BASE44_INGEST_URL is missing");
if (!process.env.BASE44_ERROR_URL) console.warn("⚠️ BASE44_ERROR_URL is missing");
if (!process.env.INGEST_SECRET) console.warn("⚠️ INGEST_SECRET is missing");
if (!process.env.SERVICE_TOKEN) console.warn("⚠️ SERVICE_TOKEN is missing");

const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "trendforge_service_token";
const INGEST_SECRET =
  process.env.INGEST_SECRET || "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SERVICE_TOKEN) {
    console.log("❌ Unauthorized /scan call. Got token:", token);
    return res.status(401).send("Unauthorized");
  }
  next();
}

async function postToBase44(url, payload) {
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

// ✅ Normalize requested platforms (treat old ones as "news")
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

app.get("/", (req, res) => res.status(200).send("TrendForge Trend Service is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, service: "trendforge-trend-service" }));

app.post("/scan", requireAuth, async (req, res) => {
  console.log("🔥 /scan HIT", new Date().toISOString());
  console.log("Body:", req.body);

  const { trendRunId, nicheName, platforms = ["youtube"], region = "Global" } = req.body || {};
  if (!trendRunId) return res.status(400).send("Missing trendRunId");

  res.json({ ok: true });

  try {
    console.log("✅ SCAN PIPELINE v2 (YT+NEWS) running");

    const requested = normalizeRequestedPlatforms(platforms);
    console.log("✅ Requested (normalized):", requested);

    let rawItems = [];

    if (requested.includes("youtube")) {
      console.log("▶ running youtube collector");
      const ytItems = await collectYouTubeTrends({ nicheName, region, maxResults: 15 });

      console.log("🎥 ytItems raw count:", ytItems?.length ?? 0);
      console.log("🎥 ytItems sample (raw):", ytItems?.[0]);

      rawItems.push(...ytItems);
    }

    if (requested.includes("news")) {
      console.log("▶ running news collectors (GDELT + RSS)");

      const gdeltItems = await collectGdelt({ nicheName, max: 25 });
      const rssItems = await collectRss({
        feeds: DEFAULT_RSS_FEEDS,
        nicheName,
        maxPerFeed: 6,
      });

      rawItems.push(...gdeltItems, ...rssItems);
    }

    let items = rawItems
      .map((raw) => {
        // Preserve platform from the collector BEFORE normalization
        const originalPlatform =
          (raw.platform || raw.source || raw.provider || "").toLowerCase().trim();

        const normalized = normalizeTrendItem(raw);

        return {
          ...normalized,
          // If normalizeTrendItem overwrote it, restore it here
          platform: (normalized.platform || originalPlatform || "unknown").toLowerCase().trim(),
        };
      })
      .map((it) => ({
        ...it,
        // Ensure URL exists for dedupe + UI
        sourceUrl: it.sourceUrl || it.url || it.link || "",
        trendScore: scoreItem(it),
      }));
    
    console.log("🧪 normalized items count:", items.length);
    console.log("🧪 normalized sample:", items[0]);

    const platformCounts = items.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts BEFORE dedupe:", platformCounts);

    items = items.map((it) => {
      // Normalize platform label
      const platform = (it.platform || it.source || it.provider || "").toLowerCase().trim();

      // Ensure a usable URL field
      const url =
        it.sourceUrl ||
        it.url ||
        it.link ||
        (it.videoId ? `https://www.youtube.com/watch?v=${it.videoId}` : "");

      return {
        ...it,
        platform,
        sourceUrl: url,
      };
    });


    // dedupe by platform + sourceUrl
    const seen = new Set();
    items = items.filter((it) => {
      const key = `${it.platform}::${(it.sourceUrl || "").trim()}`;
      if (!it.sourceUrl || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const platformCountsAfter = items.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("📊 platformCounts AFTER dedupe:", platformCountsAfter);


    items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

    // ✅ Sanity log: what sources are winning after scoring?
    const topCounts = items.slice(0, 30).reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("🏆 platformCounts in top 30 after scoring:", topCounts);

    // ✅ Guarantee a mix in the final 20 (adjust numbers as you like)
    const YT_QUOTA = 8;
    const NEWS_QUOTA = 12;

    const youtubeTop = items.filter(i => i.platform === "youtube").slice(0, YT_QUOTA);
    const newsTop = items.filter(i => i.platform === "news").slice(0, NEWS_QUOTA);

    let picked = [...youtubeTop, ...newsTop];

    // Fill remaining slots with highest-scoring leftovers (any platform)
    if (picked.length < 20) {
      const pickedUrls = new Set(picked.map(i => i.sourceUrl));
      const leftovers = items.filter(i => !pickedUrls.has(i.sourceUrl));
      picked = [...picked, ...leftovers].slice(0, 20);
    }

    items = picked;

    // ✅ Log final mix being ingested
    const finalCounts = items.reduce((a, it) => {
      const p = (it.platform || "unknown").toLowerCase();
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("✅ FINAL platformCounts in top 20 being ingested:", finalCounts);

    // Optional: peek at the very top item
    console.log("🏆 top #1 item after scoring:", {
      platform: items[0]?.platform,
      trendScore: items[0]?.trendScore,
      sourceUrl: items[0]?.sourceUrl,
      title: items[0]?.topicTitle,
    });

    

    if (!items.length) throw new Error("No items collected from requested platforms");

    console.log("➡️ Calling Base44 ingest:", process.env.BASE44_INGEST_URL);
    const ingestResp = await postToBase44(process.env.BASE44_INGEST_URL, { trendRunId, items });
    console.log("✅ Base44 ingest response:", ingestResp);
  } catch (err) {
    console.error("❌ Scan pipeline failed:", err.message);

    try {
      console.log("➡️ Calling Base44 error:", process.env.BASE44_ERROR_URL);
      const errResp = await postToBase44(process.env.BASE44_ERROR_URL, { trendRunId, message: err.message });
      console.log("✅ Base44 error response:", errResp);
    } catch (e) {
      console.error("❌ Failed to notify Base44 error endpoint:", e.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TrendForge Trend Service running on port ${PORT}`));
