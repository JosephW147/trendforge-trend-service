import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== CONFIG =====
// Must match what Base44 will send
const SERVICE_TOKEN = "trendforge_service_token";

// Must match your Base44 ingestTrendResults secret
const INGEST_SECRET = "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

// 🔴 REPLACE THESE WITH YOUR REAL BASE44 ENDPOINT URLs
const BASE44_INGEST_URL = "https://app.base44.com/apps/6953c58286976a82485fdded/editor/workspace/code?filePath=functions%2FingestTrendResults";
const BASE44_ERROR_URL = "https://app.base44.com/apps/6953c58286976a82485fdded/editor/workspace/code?filePath=functions%2FmarkTrendRunError";

// ===== AUTH (Base44 → Trend Service) =====
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SERVICE_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

// ===== Helper =====
async function postToBase44(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-trendforge-secret": INGEST_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text}`);
  }
}

// ===== MAIN ENDPOINT =====
app.get("/", (req, res) => {
  res.status(200).send("TrendForge Trend Service is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "trendforge-trend-service" });
});

app.post("/scan", requireAuth, async (req, res) => {
  const { nicheName, platforms } = req.body || {};
  const p = Array.isArray(platforms) ? platforms : ["reddit"];

  // TEMP test items (we’ll replace with real Reddit next)
  const items = [
    {
      platform: "reddit",
      topicTitle: `TrendForge test: ${nicheName || "General"}`,
      topicSummary: "If you see this, Base44 <-> Node scan works.",
      sourceUrl: "https://reddit.com",
      queryUsed: "test",
      publishedAt: new Date().toISOString(),
      author: "trendforge",
      metrics: { upvotes: 100, comments: 10, ageHours: 1, velocity: 110 },
      trendScore: 80,
      riskScore: 10,
      clusterId: `test_${Date.now()}`
    }
  ];

  return res.json({ ok: true, items });
});


// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TrendForge Trend Service running on port ${PORT}`);
});