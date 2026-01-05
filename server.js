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
const INGEST_SECRET =
  process.env.INGEST_SECRET || "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

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
    const items = [
      {
        platform: "reddit",
        topicTitle: `TrendForge test: ${nicheName || "General"}`,
        topicSummary: "If you see this, Base44 <-> Trend Service works.",
        sourceUrl: "https://reddit.com",
        queryUsed: "test",
        publishedAt: new Date().toISOString(),
        author: "trendforge",
        metrics: { upvotes: 100, comments: 10, ageHours: 1, velocity: 110 },
        trendScore: 80,
        riskScore: 10,
        clusterId: `test_${Date.now()}`,
      },
    ];

    console.log("➡️ Calling Base44 ingest:", process.env.BASE44_INGEST_URL);
    const ingestResp = await postToBase44(process.env.BASE44_INGEST_URL, {
      trendRunId,
      items,
    });
    console.log("✅ Base44 ingest response:", ingestResp);
  } catch (err) {
    console.error("❌ Scan pipeline failed:", err.message);

    try {
      console.log("➡️ Calling Base44 error:", process.env.BASE44_ERROR_URL);
      const errResp = await postToBase44(process.env.BASE44_ERROR_URL, {
        trendRunId,
        message: err.message,
      });
      console.log("✅ Base44 error response:", errResp);
    } catch (e) {
      console.error("❌ Failed to notify Base44 error endpoint:", e.message);
    }
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TrendForge Trend Service running on port ${PORT}`);
});
