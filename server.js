import express from "express";
import cors from "cors";
import { createClient } from "@base44/sdk";

const app = express();
app.use(cors());
app.use(express.json());


// ===== CONFIG =====
// Must match what Base44 will send
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "trendforge_service_token";

// Must match your Base44 ingestTrendResults secret
const INGEST_SECRET = process.env.INGEST_SECRET || "tf_ingest_6f5d4b9b9f7c44f6b8a0c2d9d3e1a7f1";

// Base44 config
const BASE44_APP_ID = process.env.BASE44_APP_ID || "6953c58286976a82485fdded";
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN; // <-- set this in Render env vars
const BASE44_SERVER_URL = process.env.BASE44_SERVER_URL || "https://base44.app";

if (!BASE44_SERVICE_TOKEN) {
  console.warn("⚠️ BASE44_SERVICE_TOKEN is not set. Set it in environment variables.");
}

const base44 = createClient({
  serverUrl: BASE44_SERVER_URL,
  appId: BASE44_APP_ID,
  serviceToken: BASE44_SERVICE_TOKEN,
});

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
      "x-trendforge-secret": process.env.INGEST_SECRET, // must exist in Render env
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Base44 call failed ${resp.status}: ${text}`);
  }

  // optional: return parsed json if you want
  try { return JSON.parse(text); } catch { return text; }
}

// ===== MAIN ENDPOINT =====
app.get("/", (req, res) => {
  res.status(200).send("TrendForge Trend Service is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "trendforge-trend-service" });
});

app.post("/scan", requireAuth, async (req, res) => {
  console.log("🔥 /scan HIT", new Date().toISOString());
  console.log("Headers:", req.headers);
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
      clusterId: `test_${Date.now()}`
    }
  ];

  console.log("➡️ Calling Base44 ingest:", process.env.BASE44_INGEST_URL);

  await postToBase44(process.env.BASE44_INGEST_URL, { trendRunId, items });

  console.log("✅ Sent items to Base44 ingest successfully.");
} catch (err) {
  console.error("❌ Scan pipeline failed:", err.message);
  console.log("➡️ Calling Base44 error:", process.env.BASE44_ERROR_URL);

  try {
    await postToBase44(process.env.BASE44_ERROR_URL, { trendRunId, message: err.message });
  } catch (e) {
    console.error("❌ Failed to notify Base44 error endpoint:", e.message);
  }
}

// ✅ IMPORTANT: call Base44 ingest function
    await fetch(process.env.BASE44_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trendforge-secret": process.env.INGEST_SECRET
      },
      body: JSON.stringify({ trendRunId, items })
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Ingest failed ${r.status}: ${await r.text()}`);
    });

    console.log("✅ Sent items to Base44 ingest successfully.");
  } catch (err) {
    console.error("❌ Scan pipeline failed:", err.message);

    // ✅ call Base44 error function
    try {
      await fetch(process.env.BASE44_ERROR_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-trendforge-secret": process.env.INGEST_SECRET
        },
        body: JSON.stringify({ trendRunId, message: err.message })
      });
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