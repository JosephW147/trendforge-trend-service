import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===== Sanity checks for Render env vars =====
if (!process.env.BASE44_INGEST_URL) console.warn("⚠️ BASE44_INGEST_URL is missing");
if (!process.env.BASE44_ERROR_URL) console.warn("⚠️ BASE44_ERROR_URL is missing");
if (!process.env.INGEST_SECRET) console.warn("⚠️ INGEST_SECRET is missing");
if (!process.env.SERVICE_TOKEN) console.warn("⚠️ SERVICE_TOKEN is missing");

// Must match what Base44 will send to /scan
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "trendforge_service_token";

// Must match EXPECTED_SECRET in Base44 ingestTrendResults
const INGEST_SECRET = process.env.INGEST_SECRET || "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

// ===== AUTH (Base44 → Trend Service) =====
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SERVICE_TOKEN) {
    console.log("❌ Unauthorized /scan call. Got token:", token);
    return res.status(401).send("Unauthorized");
  }
  next();
}

// ===== Helper to call Base44 functions =====
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
  if (!resp.ok) {
    throw new Error(`Base44 call failed ${resp.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ===== Reddit helpers (public JSON) =====
const REDDIT_UA =
  process.env.REDDIT_USER_AGENT ||
  "TrendForge/1.0 (render; contact: you@example.com)";

const REDDIT_LIMIT = Number(process.env.REDDIT_LIMIT || 10); // keep small to avoid rate limits

function hoursSince(utcSeconds) {
  const ms = utcSeconds * 1000;
  return Math.max(0.1, (Date.now() - ms) / 36e5);
}

function computeTrendScore({ score, num_comments, created_utc }) {
  const ageHours = hoursSince(created_utc);
  const velocity = (score + 2 * num_comments) / ageHours; // simple “engagement per hour”
  // compress to 0–100-ish
  const trendScore = Math.max(0, Math.min(100, Math.round(10 * Math.log10(1 + velocity) * 10)));
  return { ageHours, velocity, trendScore };
}

async function fetchRedditSearchPosts(query) {
  const url = new URL("https://www.reddit.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "top");
  url.searchParams.set("t", "day");
  url.searchParams.set("limit", String(REDDIT_LIMIT));

  const r = await fetch(url.toString(), {
    headers: { "User-Agent": REDDIT_UA },
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Reddit search failed ${r.status}: ${text}`);
  }

  const json = await r.json();
  const children = json?.data?.children || [];
  return children.map((c) => c.data).filter(Boolean);
}

function redditToItem(post, nicheName) {
  const title = (post?.title || "").trim();
  const permalink = post?.permalink ? `https://www.reddit.com${post.permalink}` : "";
  const subreddit = post?.subreddit || "";
  const author = post?.author || "";

  const { ageHours, velocity, trendScore } = computeTrendScore({
    score: post?.score ?? 0,
    num_comments: post?.num_comments ?? 0,
    created_utc: post?.created_utc ?? Math.floor(Date.now() / 1000),
  });

  // basic “risk” placeholder (to be improved later)
  const riskScore = 10;

  return {
    platform: "reddit",
    topicTitle: title || `Reddit trend: ${nicheName}`,
    topicSummary: `r/${subreddit} • score ${post?.score ?? 0} • comments ${post?.num_comments ?? 0}`,
    sourceUrl: permalink || "https://www.reddit.com",
    queryUsed: nicheName,
    publishedAt: post?.created_utc ? new Date(post.created_utc * 1000).toISOString() : new Date().toISOString(),
    author,
    metrics: {
      subreddit,
      upvotes: post?.score ?? 0,
      comments: post?.num_comments ?? 0,
      ageHours: Number(ageHours.toFixed(2)),
      velocity: Number(velocity.toFixed(2)),
    },
    trendScore,
    riskScore,
    clusterId: `reddit_${subreddit}_${post?.id || Date.now()}`,
  };
}

// ===== MAIN ENDPOINTS =====
app.get("/", (req, res) => {
  res.status(200).send("TrendForge Trend Service is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "trendforge-trend-service" });
});

app.post("/scan", requireAuth, async (req, res) => {
  console.log("🔥 /scan HIT", new Date().toISOString());
  console.log("Body:", req.body);

  const { trendRunId, nicheName } = req.body || {};
  if (!trendRunId) return res.status(400).send("Missing trendRunId");

  // respond immediately so Base44 doesn't timeout
  res.json({ ok: true });

  try {
    let items = [];

    const p = Array.isArray(platforms) ? platforms.map(x => String(x).toLowerCase()) : ["reddit"];

    if (p.includes("reddit")) {
      const posts = await fetchRedditSearchPosts(nicheName);
      items.push(...posts.map(post => redditToItem(post, nicheName)));
    }

    // de-dupe by sourceUrl
    const seen = new Set();
    items = items.filter(it => {
      if (!it.sourceUrl) return false;
      if (seen.has(it.sourceUrl)) return false;
      seen.add(it.sourceUrl);
      return true;
    });

    if (items.length === 0) throw new Error("No items returned from Reddit");

    console.log(`✅ Built ${items.length} items. Sending to ingestTrendResults...`);

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

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TrendForge Trend Service running on port ${PORT}`));