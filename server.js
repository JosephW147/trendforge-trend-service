// server.js
import express from "express";
import cors from "cors";

import { collectYouTubeTrends } from "./youtubeCollector.js";
import { collectYouTubeWatchlist } from "./youtubeWatchlistCollector.js";
import { collectGdelt } from "./collectors/gdelt.js";
import { collectRss } from "./collectors/rss.js";
import { getRssFeedsForRegions } from "./config/rssFeeds.js";

import { normalizeTrendItem } from "./normalize/trendItem.js";
import { scoreItemsComparable } from "./scoring/score.js";
import { fetchGoogleTrendsSignal } from "./collectors/googleTrends.js";
import { fetchXTrends } from "./collectors/xTrends.js";
import { buildEditorial } from "./editorial/buildEditorial.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- Promise deadline guard (prevents long-hanging collectors from stalling scans) ----
function withDeadline(promise, ms, label = "deadline") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}:${ms}ms`)), ms)
    ),
  ]);
}

// Base44 function to compute topics from TrendItems already stored for a TrendRun
const BASE44_BUILD_TOPICS_URL =
  process.env.BASE44_BUILD_TOPICS_URL ||
  "https://trend-spark-485fdded.base44.app/api/apps/6953c58286976a82485fdded/functions/buildTrendTopicsFromRun";

const BASE44_INGEST_URL =
  process.env.BASE44_INGEST_URL ||
  "https://trend-spark-485fdded.base44.app/api/apps/6953c58286976a82485fdded/functions/ingestTrendResults";


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


// ---- UTF-8 safety: remove lone surrogate code units (prevents Base44/Python utf-8 errors) ----
function stripLoneSurrogates(s) {
  // Any code unit in D800–DFFF is a surrogate. If it appears alone in a JS string,
  // JSON.stringify will emit \ud83d style escapes which Python cannot encode as UTF-8.
  return String(s ?? "").replace(/[\uD800-\uDFFF]/g, "");
}

function deepCleanForUtf8(x) {
  if (x == null) return x;
  if (typeof x === "string") return stripLoneSurrogates(x);
  if (typeof x === "number" || typeof x === "boolean") return x;
  if (Array.isArray(x)) return x.map(deepCleanForUtf8);
  if (typeof x === "object") {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = deepCleanForUtf8(v);
    return out;
  }
  return x;
}
function buildGoogleNewsRssFeeds(queries, opts = {}) {
  const { hl = "en-US", gl = "US", ceid = "US:en", limit = 12 } = opts;

  const uniq = (arr) => [...new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean))];

  return uniq(queries)
    .slice(0, Math.max(5, Math.min(limit, 12)))
    .map((q) => {
      const encoded = encodeURIComponent(q);
      return `https://news.google.com/rss/search?q=${encoded}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
    });
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
    body: JSON.stringify(deepCleanForUtf8(payload)),
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
        body: JSON.stringify(deepCleanForUtf8(payload)),
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

// Strip common tracking params so we dedupe better (especially RSS)
function canonicalizeUrl(u) {
  try {
    const url = new URL(String(u || "").trim());
    // remove obvious tracking parameters
    const drop = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "utm_name",
      "utm_reader",
      "utm_referrer",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "ref_src",
      "igshid",
    ]);
    for (const k of [...url.searchParams.keys()]) {
      if (drop.has(k.toLowerCase())) url.searchParams.delete(k);
    }
    // Keep path/query but drop hash
    url.hash = "";
    return url.toString();
  } catch {
    return String(u || "").trim();
  }
}

function normalizeTextLite(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLite(s) {
  const t = normalizeTextLite(s);
  return t.split(" ").filter(Boolean);
}

function buildProbeQueriesFromItems(items, opts = {}) {
  const { limit = 10, addTikTok = true, addInstagram = true } = opts;
  const out = [];
  const seen = new Set();

  const pick = (s) => {
    const txt = String(s || "").trim();
    if (!txt) return null;
    // Keep queries short so Google News RSS works well.
    // Use the first ~7 tokens (but keep hashtags/words).
    const toks = tokenizeLite(txt).slice(0, 7);
    const q = toks.join(" ").trim();
    if (!q) return null;
    if (seen.has(q)) return null;
    seen.add(q);
    return q;
  };

  for (const it of (items || []).slice(0, limit)) {
    const base = pick(it?.topicTitle || it?.canonicalTitle || it?.title);
    if (!base) continue;
    out.push(base);
    if (addTikTok) out.push(`${base} TikTok`);
    if (addInstagram) out.push(`${base} Instagram`);
    if (out.length >= 12) break;
  }

  return out.slice(0, 12);
}

function uniqueStrings(arr = []) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseDateMsSafe(dt) {
  if (!dt) return NaN;
  const t = new Date(dt).getTime();
  return Number.isNaN(t) ? NaN : t;
}

// ---- X/Twitter (No API) lightweight state cache (in-memory) ----
// Used to compute mentions_delta / trend_rank_change between scans.
// Keyed by projectId + region + normalizedTerm.
const xPrevCache = new Map();

function normTermKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/^#+/, "#")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function extractHashtagsLite(text) {
  const t = String(text || "");
  const m = t.match(/#[A-Za-z0-9_]{2,80}/g);
  return m ? m.map((x) => x.toLowerCase()) : [];
}

function buildPrevXMap(prevSnapshot) {
  // Expected shape: { v: 1, rows: [{ region, term, rank, volume }] }
  const map = new Map();
  const rows = prevSnapshot && typeof prevSnapshot === "object" ? prevSnapshot.rows : null;
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    const region = String(r?.region || "").toUpperCase().trim() || "ALL";
    const term = normTermKey(r?.term);
    if (!term) continue;
    map.set(`${region}::${term}`, {
      rank: Number(r?.rank || 0),
      volume: Number(r?.volume || 0),
    });
  }
  return map;
}

function attachXSignalsToItems({ items, xRows, projectId, totalRegions, prevSnapshot }) {
  if (!Array.isArray(items) || !items.length) return;
  if (!Array.isArray(xRows) || !xRows.length) return;

  const prevMap = buildPrevXMap(prevSnapshot);

  // Build aggregate per term across regions.
  const agg = new Map();
  for (const r of xRows) {
    const term = normTermKey(r.term);
    if (!term) continue;
    const key = term;
    if (!agg.has(key)) {
      agg.set(key, {
        term: r.term,
        regions: new Set(),
        bestRank: Number(r.rank || 9999),
        totalVolume: Number(r.volume || 0),
        // we'll compute deltas later per region
        perRegion: new Map(),
      });
    }
    const a = agg.get(key);
    a.regions.add(String(r.region || "").toUpperCase());
    a.bestRank = Math.min(a.bestRank, Number(r.rank || 9999));
    a.totalVolume += Number(r.volume || 0);
    a.perRegion.set(String(r.region || "").toUpperCase(), { rank: Number(r.rank || 0), volume: Number(r.volume || 0) });
  }

  // Helper: find best matching X term for an item.
  function bestMatchForItem(it) {
    const title = String(it?.topicTitle || "");
    const summary = String(it?.topicSummary || "");
    const combined = normalizeTextLite(`${title} ${summary}`);
    const tags = new Set(extractHashtagsLite(`${title} ${summary}`));

    // Token set for fuzzy matching (helps when X trend term is related but not a direct substring)
    const itemTokens = new Set(combined.split(/\\s+/).filter(Boolean));

    let best = null;
    let bestScore = 0;

    for (const [k, a] of agg.entries()) {
      const bare = k.startsWith("#") ? k.slice(1) : k;
      // direct hashtag match
      if (k.startsWith("#") && tags.has(k)) {
        const score = 1.0;
        if (score > bestScore) { bestScore = score; best = a; }
        continue;
      }

      // phrase match
      if (bare && combined.includes(bare)) {
        const score = 0.85;
        if (score > bestScore) { bestScore = score; best = a; }
      } else {
        // Fuzzy token overlap: allow related terms without strict substring match.
        const termTokens = bare.split(/\\s+/).filter(Boolean);
        if (termTokens.length >= 2) {
          let hit = 0;
          for (const t of termTokens) if (itemTokens.has(t)) hit++;
          const jacc = hit / termTokens.length;
          if (jacc >= 0.6) {
            const score = 0.70;
            if (score > bestScore) { bestScore = score; best = a; }
          } else if (jacc >= 0.4) {
            const score = 0.60;
            if (score > bestScore) { bestScore = score; best = a; }
          }
        }
      }
    }

    return best;
  }

  for (const it of items) {
    const match = bestMatchForItem(it);
    if (!match) continue;

    // Compute per-term deltas using best available region row (if any)
    // If item has a known sourceCountry/feedRegion in its metrics, prefer that region.
    const m = (it.metrics && typeof it.metrics === "object") ? it.metrics : {};
    const srcRegion = String(m.sourceCountry || m.feedRegion || "").toUpperCase().trim();

    let curRank = match.bestRank;
    let curVol = match.totalVolume;
    if (srcRegion && match.perRegion.has(srcRegion)) {
      const pr = match.perRegion.get(srcRegion);
      curRank = Number(pr.rank || curRank);
      curVol = Number(pr.volume || 0);
    }

    const cacheKey = `${projectId}::${srcRegion || "ALL"}::${normTermKey(match.term)}`;

    // Prefer persisted snapshot (stable across restarts), fall back to in-memory cache.
    const prevFromSnap = prevMap.get(`${srcRegion || "ALL"}::${normTermKey(match.term)}`) || null;
    const prev = prevFromSnap || xPrevCache.get(cacheKey) || null;
    const prevRank = prev ? Number(prev.rank || 0) : 0;
    const prevVol = prev ? Number(prev.volume || 0) : 0;

    const mentions_delta = prev ? ((curVol - prevVol) / Math.max(1, prevVol)) : 0;
    const trend_rank_change = prev ? (prevRank - curRank) : 0;
    const region_presence = totalRegions > 0 ? (match.regions.size / totalRegions) : 0;

    // Persist current snapshot
    xPrevCache.set(cacheKey, { rank: curRank, volume: curVol, ts: Date.now() });

    it.metrics = m;
    it.metrics.xSignal = {
      ok: true,
      term: match.term,
      mentions_delta,
      trend_rank_change,
      region_presence,
      rank: curRank,
      volume: curVol,
      regions_count: match.regions.size,
      total_regions: totalRegions,
      source: "trends24",
    };
  }
}

function buildProjectGate({ niches, newsQueries, watchlist, regions, windowHours }) {
  const positives = uniqueStrings([
    ...(Array.isArray(niches) ? niches : []),
    ...(Array.isArray(newsQueries) ? newsQueries : []),
    ...((watchlist?.keywords || []).map((k) => k?.query).filter(Boolean)),
  ]);

  // optional negatives (safe to ignore if not present)
  const negatives = uniqueStrings([
    ...((watchlist?.negativeKeywords || watchlist?.blockedKeywords || []) || []),
  ]);

  const regionCodes = uniqueStrings((regions || []).map((r) => String(r || "").trim()))
    .filter((r) => /^[A-Z]{2}$/i.test(r))
    .map((r) => r.toUpperCase());

  const windowMs = Math.max(1, Number(windowHours || 24)) * 36e5;

  return function gateItem(item) {
    const reasons = [];
    const title = String(item?.topicTitle || "");
    const summary = String(item?.topicSummary || "");
    const author = String(item?.author || "");
    const text = normalizeTextLite(`${title} ${summary} ${author}`);

    // 1) Freshness hard gate for NEWS/RSS
    const p = safePlatform(item?.platform);
    if (p === "news") {
      const ts = parseDateMsSafe(item?.publishedAt);
      if (Number.isNaN(ts)) {
        return { pass: false, score: 0, reasons: ["missing_or_invalid_publishedAt"] };
      }
      const ageMs = Date.now() - ts;
      if (ageMs > windowMs) {
        return { pass: false, score: 0, reasons: ["stale_over_windowHours"] };
      }
    }

    // 2) Region hard gate (only when user provided ISO2 codes)
    if (p === "news" && regionCodes.length) {
      const m = item?.metrics && typeof item.metrics === "object" ? item.metrics : {};
      const srcC = String(m?.sourceCountry || "").toUpperCase().trim();
      const feedRegion = String(m?.feedRegion || "").toUpperCase().trim();
      if (srcC || feedRegion) {
        const ok =
          (srcC && regionCodes.includes(srcC)) ||
          (feedRegion && regionCodes.includes(feedRegion));
      if (!ok) {
        return { pass: false, score: 0, reasons: ["region_mismatch"] };
      }
      }
    }
    // 3) Negative keyword block (hard)
    for (const neg of negatives) {
      const n = normalizeTextLite(neg);
      if (n && text.includes(n)) {
        return { pass: false, score: 0, reasons: ["blocked_keyword"] };
      }
    }

    // 4) Positive matching (watchlist/niche/newsQueries)
    if (!positives.length) {
      // If there are no positive constraints, don't block (acts like global scan)
      return { pass: true, score: 0.25, reasons: ["no_positive_constraints"] };
    }

    let best = 0;
    const matched = [];

    const tokens = new Set(tokenizeLite(text));

    for (const q of positives) {
      const qn = normalizeTextLite(q);
      if (!qn) continue;

      // phrase match (strong)
      if (text.includes(qn)) {
        best = Math.max(best, 1);
        matched.push(q);
        continue;
      }

      // token overlap (medium): require 2+ tokens overlap when query has multiple tokens
      const qTokens = tokenizeLite(qn);
      if (!qTokens.length) continue;
      let hit = 0;
      for (const t of qTokens) if (tokens.has(t)) hit++;

      if (qTokens.length === 1 && hit === 1) {
        best = Math.max(best, 0.55);
        matched.push(q);
      } else if (hit >= 2) {
        const ratio = hit / qTokens.length;
        best = Math.max(best, Math.min(0.9, 0.5 + 0.4 * ratio));
        matched.push(q);
      }
    }

    if (best <= 0) {
      return { pass: false, score: 0, reasons: ["no_watchlist_or_niche_match"] };
    }

    reasons.push("matched_positive_terms");
    return { pass: true, score: best, reasons, matched };
  };
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
    const u = canonicalizeUrl(String(it.sourceUrl || "").trim());
    if (!u) return false;
    const key = `${p}::${u}`;
    if (seen.has(key)) return false;
    seen.add(key);
    it.sourceUrl = u;
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

// ---- Phase C: editorial (LLM ranker/editor) ----
// Receives compact candidate topics from Base44 Function and returns strict JSON.
// Auth: same Bearer token as /scan
app.post("/editorial", requireAuth, async (req, res) => {
  try {
    const out = await buildEditorial(req.body || {});
    res.status(200).json(out);
  } catch (e) {
    console.error("❌ /editorial failed:", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---- Scan ----
app.post("/scan", requireAuth, async (req, res) => {
  console.log("🔥🔥🔥 /scan HIT (TOP)", new Date().toISOString());
  console.log("X-Trace-Id:", req.headers["x-trace-id"]);
  console.log("CF-RAY:", req.headers["cf-ray"]);
  console.log("rndr-id header will be added by Render (response)");
  console.log("Body keys:", Object.keys(req.body || {}));
 
  const {
    trendRunId,
    projectId,
    nicheName,
    niches,
    platforms = ["youtube"],
    region = "Global",
    regions,
    // Optional: richer hints for news collectors (project keywords + niches)
    newsQueries,
    // Optional watchlist:
    // {
    //   channels: [{ label, channelId, enabled, frequency }],
    //   keywords: [{ label, query, enabled, frequency }],
    //   frequency: "hourly" | "daily" (filter which to run)
    // }
    watchlist,
    // Optional: persisted X snapshot from previous run (Base44 TrendRuns.runNotes)
    xPrevSnapshot,
  } = req.body || {};

  // Multi-select support (Base44 can send niches/regions arrays)
  const nicheList = Array.isArray(niches)
    ? niches
    : String(nicheName || "").includes(",")
    ? String(nicheName || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [String(nicheName || "General").trim() || "General"];

  const regionList = Array.isArray(regions)
    ? regions
    : String(region || "").includes(",")
    ? String(region || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [String(region || "Global").trim() || "Global"];

  const uniq = (arr) => {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
      const s = String(v || "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  const NICHES = uniq(nicheList);
  const REGIONS = uniq(regionList);
  
  function sanitizeGdeltQuery(q) {
    const toks = String(q || "")
      .trim()
      .split(/\s+/)
      // Drop tiny tokens like "AI" that trigger GDELT "keyword too short"
      .filter((t) => t.length >= 3);
    return toks.join(" ").trim();
  }

  const NEWS_QUERIES = uniq(Array.isArray(newsQueries) ? newsQueries : NICHES)
    .map((q) => sanitizeGdeltQuery(q))
    .filter((q) => q.length >= 4);


  const regionCodeFrom = (r) => {
    const s = String(r || "").trim();
    if (/^[A-Z]{2}$/i.test(s)) return s.toUpperCase();
    return "";
  };
  
    // 🔍 DEBUG WATCHLIST CONTENT
  console.log("📋 watchlist received:", !!watchlist);
  console.log("watchlist.channels count:", watchlist?.channels?.length || 0);
  console.log("watchlist.keywords count:", watchlist?.keywords?.length || 0);

  if (!trendRunId) return res.status(400).send("Missing trendRunId");
  if (!projectId) return res.status(400).send("Missing projectId");

  // ✅ Decide scan mode EARLY (so collectors can use it safely)
  const hasWatchlist = !!(
    watchlist &&
    ((watchlist.channels?.length || 0) + (watchlist.keywords?.length || 0) > 0)
  );

  // ✅ Explicit scan mode from Base44 (preferred)
  const scanModeRaw = String(req.body?.scanMode || "").trim().toUpperCase();
  const forceGlobalDiscovery = scanModeRaw === "GLOBAL_DISCOVERY";
  const forceProjectStrict = scanModeRaw === "PROJECT_STRICT";

  // ✅ Robust Global project detection (ignore watchlist presence)
  const isGlobalByHeuristic =
    NICHES.length === 1 &&
    String(NICHES[0] || "").trim().toLowerCase() === "global" &&
    REGIONS.length === 1 &&
    String(REGIONS[0] || "").trim().toLowerCase() === "global";

  const isGlobalByEnv =
    String(process.env.GLOBAL_PROJECT_ID || "").trim() &&
    String(process.env.GLOBAL_PROJECT_ID).trim() === String(projectId);

  const isGlobalProject = forceGlobalDiscovery || isGlobalByEnv || isGlobalByHeuristic;

  // Global project => discovery mode (even if watchlist exists).
  // Non-global projects => strict mode by default.
  const STRICT_PROJECT_SCAN = forceProjectStrict ? true : !isGlobalProject;
  if (isGlobalProject && !STRICT_PROJECT_SCAN) {
    console.log("🌍 Global project detected -> GLOBAL_DISCOVERY mode", { scanModeRaw, hasWatchlist });
  }

  // ✅ Clamp scan window: allow up to 72h (TrendForge horizon) for discovery + watchlists
  const windowHours = Math.max(1, Math.min(72, Number(watchlist?.windowHours || 24)));

  res.json({ ok: true });

  try {
    console.log("✅ SCAN PIPELINE (YT + NEWS) running");
    console.log("🧭 scanMode:", STRICT_PROJECT_SCAN ? "PROJECT_STRICT" : "GLOBAL_DISCOVERY", {
      windowHours,
      hasWatchlist,
    });


    const requested = normalizeRequestedPlatforms(platforms);
    console.log("✅ Requested (normalized):", requested);

    // 1) Collect
    let rawItems = [];

    if (requested.includes("youtube")) {
      try {
        console.log("▶ running youtube collector (multi-niche/region)");

        // Safety caps to protect quota: keep total combos reasonable.
        const MAX_COMBOS = 8;
        const combos = [];
        for (const n of NICHES) {
          for (const r of REGIONS) {
            combos.push({ n, r });
          }
        }

        const slicedCombos = combos.slice(0, MAX_COMBOS);
        if (combos.length > slicedCombos.length) {
          console.log(
            `⚠️ too many niche/region combos (${combos.length}); capping to ${slicedCombos.length} for quota safety`
          );
        }

        for (const { n, r } of slicedCombos) {
          const regionCode = /^[A-Z]{2}$/i.test(r) ? r.toUpperCase() : "";
          const ytItems = await collectYouTubeTrends({
            nicheName: n,
            region: r,
            regionCode,
            maxResults: 10, // 🔽 reduce to save quota
          });
          console.log("🎥 ytItems raw count:", ytItems?.length ?? 0, { niche: n, region: r });
          rawItems.push(...(ytItems || []));
        }

        if (watchlist && (watchlist.channels?.length || watchlist.keywords?.length)) {
          try {
            console.log("▶ running youtube watchlist collector");
            // Watchlist runs per-region (keywords/channels are user-defined).
            // Keep it capped for quota safety.
            const wlRegions = REGIONS.slice(0, 4);
            for (const r of wlRegions) {
              const regionCode = /^[A-Z]{2}$/i.test(r) ? r.toUpperCase() : "";
              const wlItems = await collectYouTubeWatchlist({
                watchlist,
                region: r,
                regionCode,
              windowHours,
              maxPerChannel: Math.min(watchlist?.maxPerChannel || 10, 5), // 🔽 reduce
              maxPerKeyword: Math.min(watchlist?.maxPerKeyword || 10, 5), // 🔽 reduce
              });
              console.log("📌 watchlist items raw count:", wlItems?.length ?? 0, { region: r });
              rawItems.push(...(wlItems || []));
            }
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
      // Pull GDELT per-niche and per-region so regional filters apply.
      const gdeltItems = [];
      const MAX_GDELT_COMBOS = 12;
      const combos = [];
      for (const n of NEWS_QUERIES) for (const r of REGIONS) combos.push({ n, r });
      for (const { n, r } of combos.slice(0, MAX_GDELT_COMBOS)) {
        try {
          const part = await withDeadline(
            collectGdelt({ nicheName: n, region: r, max: 25 }),
            12_000,
            'gdelt:${n}:${r}'
          );
          gdeltItems.push(...(part || []));
        } catch (e) {
          // GDELT occasionally replies with 200 + plain text (non-JSON) or a throttling message.
          // We treat that as best-effort and keep the scan running so RSS still works.
          const msg = e?.message || String(e);
          console.error(`⚠️ GDELT failed (continuing): niche="${n}" region="${r}" ->`, msg.slice(0, 240));
        }
      }
            let rssItems = [];
      try {
        const queryFeeds = NEWS_QUERIES.length
          ? buildGoogleNewsRssFeeds(NEWS_QUERIES, { hl: "en-US", gl: "US", ceid: "US:en", limit: 12 })
          : [];

        const regionFeeds = getRssFeedsForRegions(REGIONS);

        // ✅ Always respect app/newsQueries when provided (Global + Project). Add regional feeds as backup.
        const rssFeeds = queryFeeds.length ? [...queryFeeds, ...regionFeeds] : regionFeeds;

        if (queryFeeds.length) {
          console.log(
            `📰 Using Google News RSS query feeds (${STRICT_PROJECT_SCAN ? "Project Scan" : "Global Scan"}):`,
            queryFeeds.length
          );
        }

        rssItems = await withDeadline(
          collectRss({
            feeds: rssFeeds.slice(0, 8),     // hard cap feeds
            nicheName: NEWS_QUERIES.join(" OR ") || nicheName,
            maxPerFeed: 4,                   // smaller per-feed pull
          }),
          15_000,
          "rss"
        );
      } catch (e) {
        console.error("⚠️ RSS collector failed (continuing):", e?.message || e);
        rssItems = [];
      }

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

    if (STRICT_PROJECT_SCAN) {
      const gateItem = buildProjectGate({
        niches: NICHES,
        newsQueries: NEWS_QUERIES,
        watchlist,
        regions: REGIONS,
        windowHours,
      });

      const before = items.length;
      let droppedStale = 0;
      let droppedNoMatch = 0;
      let droppedRegion = 0;

      items = items.filter((it) => {
        const verdict = gateItem(it);
        // attach for downstream topic gating/debug (persisted via metricsJson)
        it.metrics = (it.metrics && typeof it.metrics === "object") ? it.metrics : {};
        it.metrics.projectMatch = {
          strict: true,
          pass: !!verdict.pass,
          score: Number(verdict.score || 0),
          reasons: verdict.reasons || [],
          matched: verdict.matched || [],
        };

        if (!verdict.pass) {
          const rs = verdict.reasons || [];
          if (rs.includes("missing_or_invalid_publishedAt") || rs.includes("stale_over_windowHours")) droppedStale++;
          else if (rs.includes("region_mismatch_or_unknown")) droppedRegion++;
          else droppedNoMatch++;
        }
        return !!verdict.pass;
      });

      console.log(
        "🧹 STRICT project gate applied:",
        { before, after: items.length, droppedStale, droppedRegion, droppedNoMatch, windowHours }
      );
    } else {
      // discovery/global scan: still persist a light marker for transparency
      for (const it of items) {
        it.metrics = (it.metrics && typeof it.metrics === "object") ? it.metrics : {};
        it.metrics.projectMatch = { strict: false, pass: true, score: 0.25, reasons: ["global_scan"], matched: [] };
      }
    }

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

      const regionIso2 = uniq(REGIONS.map(regionCodeFrom)).filter(Boolean);
      const trendGeos = STRICT_PROJECT_SCAN ? regionIso2.slice(0, 3) : [];

      await Promise.allSettled(
        candidates.map(async (it) => {
          const query = pickTrendsQuery(it);
          if (!query) return;

          // Global signal (worldwide)
          const gt = await fetchGoogleTrendsSignal({
            query,
            geo: "",
            timeRange: "now 7-d",
          });

          // Optional geo spread: how many selected regions show notable interest
          let geoSpreadCount = 0;
          let perGeoLatest = {};
          if (gt?.ok && trendGeos.length) {
            const settled = await Promise.allSettled(
              trendGeos.map(async (geo) => {
                const g = await fetchGoogleTrendsSignal({ query, geo, timeRange: "now 7-d" });
                return { geo, g };
              })
            );
            for (const s of settled) {
              if (s.status !== "fulfilled") continue;
              const { geo, g } = s.value;
              if (g?.ok) {
                perGeoLatest[geo] = Number(g.latest || 0);
                if (Number(g.latest || 0) >= 10) geoSpreadCount += 1;
              }
            }
          }

          it.metrics = (it.metrics && typeof it.metrics === "object") ? it.metrics : {};
          it.metrics.googleTrends = {
            ok: !!gt?.ok,
            query,
            latest: Number(gt?.latest || 0),
            delta1: Number(gt?.delta1 || 0), // lightweight interestDelta24h proxy
            score01: Number(gt?.score01 || 0),
            geoSpreadCount,
            perGeoLatest,
          };

          it.googleTrends = gt; // kept for backward compatibility (not persisted)
        })
      );
    }

    // 4B) Optional: X/Twitter (No API) signal
    // - Project scans only (STRICT_PROJECT_SCAN)
    // - Read-only, cached, low frequency
    // - Injects xSignal into item.metrics (affects momentumScore only in Base44)
    const X_ENABLED = process.env.X_TRENDS_ENABLED !== "false";
    let xSignalSnapshot = null;
    if (X_ENABLED && (STRICT_PROJECT_SCAN || isGlobalProject || forceGlobalDiscovery)) {
      const regionIso2 = uniq(REGIONS.map(regionCodeFrom)).filter(Boolean);

// If we can't derive ISO2 regions (e.g. region="Global"), fall back to a small safe spread.
// This avoids skipping X signals entirely on Global scans.
const fallbackIso2 = ["US", "GB", "CA", "AU", "IN", "NG"];
const xRegions = (regionIso2.length ? regionIso2 : fallbackIso2).slice(0, 6); // cap regions for safety

      if (xRegions.length) {
        try {
          const xRows = await fetchXTrends({
            regions: xRegions,
            limitPerRegion: 25,
            ttlMs: 10 * 60 * 1000,
            concurrency: 2,
          });

          // Build a compact snapshot for persistence across restarts.
          // We keep only region+term+rank+volume (already capped by limitPerRegion).
          xSignalSnapshot = {
            v: 1,
            ts: new Date().toISOString(),
            source: "trends24",
            regions: xRegions,
            rows: xRows.map((r) => ({
              region: String(r?.region || "").toUpperCase(),
              term: String(r?.term || "").trim(),
              rank: Number(r?.rank || 0),
              volume: Number(r?.volume || 0),
            })),
          };

          // attach lightweight xSignal to matching items (momentum-only)
          attachXSignalsToItems({
            items,
            xRows,
            projectId,
            totalRegions: xRegions.length,
            prevSnapshot: xPrevSnapshot,
          });

          console.log("🐦 X trends attached:", {
            regions: xRegions,
            rows: xRows.length,
            itemsWithX: items.filter((it) => it?.metrics?.xSignal?.ok).length,
          });
        } catch (e) {
          console.log("⚠️ X trends fetch/attach failed:", e?.message || e);
        }
      }
    }

    // 5) Comparable scoring (cross-platform)
    scoreItemsComparable(items);
    
    // 🔗 INDIRECT SOCIAL PLATFORM CONFIRMATION
    // Promote RSS socialHints + X matches into platform diversity signals
    for (const it of items) {
      it.metrics = it.metrics || {};

      const social = it.metrics.socialHints || {};
      const hasX = !!it.metrics.xSignal?.ok;

      // Virtual platform confirmations (NO scraping, NO APIs)
      it.metrics.indirectPlatforms = {
        tiktok: !!social.tiktokMention,
        instagram: !!social.instagramMention,
        reels: !!social.reelsMention,
        shorts: !!social.shortsMention,
        x: hasX,
      };

      // Used later by Base44 topic aggregation
      it.metrics.platformConfirmations = Object.values(it.metrics.indirectPlatforms)
        .filter(Boolean).length;
    }

    // 6) Sort by comparable score
    items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

    const topCounts = items.slice(0, 20).reduce((a, it) => {
      const p = safePlatform(it.platform);
      a[p] = (a[p] || 0) + 1;
      return a;
    }, {});
    console.log("🏆 platformCounts in top 20 after scoring:", topCounts);

    // 6B) News enrichment pass (NO scraping, no API keys)
    // If strict gating leaves you with mostly YouTube (common when RSS feeds block/403),
    // we pull additional *fresh* Google News RSS search feeds seeded from the top items.
    // This increases source diversity without loosening the niche/watchlist gate.
    const newsCountAfter = Number(platformCountsAfter?.news || 0);
    const ytCountAfter = Number(platformCountsAfter?.youtube || 0);
    const SHOULD_ENRICH_NEWS = requested.includes("news") && ytCountAfter > 0 && newsCountAfter < 4;

    if (SHOULD_ENRICH_NEWS) {
      try {
        const seeds = items.filter((it) => safePlatform(it.platform) === "youtube").slice(0, 10);
        const probeQueries = buildProbeQueriesFromItems(seeds, { limit: 10, addTikTok: true, addInstagram: true });
        if (probeQueries.length) {
          const probeFeeds = buildGoogleNewsRssFeeds(probeQueries, { hl: "en-US", gl: "US", ceid: "US:en", limit: 12 });
          console.log("🧲 Enriching news via Google News RSS (seeded):", { probes: probeQueries.length, feeds: probeFeeds.length });

          const extraRss = await collectRss({
            feeds: probeFeeds,
            nicheName: probeQueries.join(" OR "),
            maxPerFeed: 5,
          });

          const extraNormalized = (extraRss || []).map((raw) => {
            const normalized = normalizeTrendItem(raw);
            const platform = safePlatform(normalized.platform || raw.platform || "news");
            const sourceUrl = safeUrlFrom(raw, normalized);
            return { ...normalized, platform, sourceUrl };
          });

          if (extraNormalized.length) {
            const beforeAdd = items.length;
            items.push(...extraNormalized);
            items = dedupeByPlatformAndUrl(items);

            // Re-apply strict project gate so we don't pollute topics.
            if (STRICT_PROJECT_SCAN) {
              const gateItem = buildProjectGate({
                niches: NICHES,
                newsQueries: NEWS_QUERIES,
                watchlist,
                regions: REGIONS,
                windowHours,
              });
              items = items.filter((it) => {
                const verdict = gateItem(it);
                it.metrics = (it.metrics && typeof it.metrics === "object") ? it.metrics : {};
                it.metrics.projectMatch = {
                  strict: true,
                  pass: !!verdict.pass,
                  score: Number(verdict.score || 0),
                  reasons: verdict.reasons || [],
                  matched: verdict.matched || [],
                };
                return !!verdict.pass;
              });
            }

            // Re-score + resort after enrichment.
            scoreItemsComparable(items);
            items.sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0));

            const countsNow = items.reduce((a, it) => {
              const p = safePlatform(it.platform);
              a[p] = (a[p] || 0) + 1;
              return a;
            }, {});
            console.log("🧲 News enrichment complete:", { beforeAdd, after: items.length, countsNow });
          }
        }
      } catch (e) {
        console.log("⚠️ News enrichment failed (continuing):", e?.message || e);
      }
    }

    // Balanced store pool (prevents one platform dominating the 60 stored items)
// Strategy:
// - First pass: take up to cap per platform (in overall score order)
// - Second pass: fill remaining slots with best remaining items
function selectStorePool(sortedItems, maxTotal, capsByPlatform) {
  const selected = [];
  const seen = new Set();
  const counts = {};
  const cap = (p) => (capsByPlatform && capsByPlatform[p] != null) ? capsByPlatform[p] : maxTotal;

  for (const it of sortedItems) {
    if (selected.length >= maxTotal) break;
    const id = String(it?.id || it?._id || it?.clusterId || it?.sourceUrl || Math.random());
    if (seen.has(id)) continue;
    const p = String(it?.platform || "unknown").toLowerCase().trim();
    const n = counts[p] || 0;
    if (n >= cap(p)) continue;
    selected.push(it);
    seen.add(id);
    counts[p] = n + 1;
  }

  if (selected.length < maxTotal) {
    for (const it of sortedItems) {
      if (selected.length >= maxTotal) break;
      const id = String(it?.id || it?._id || it?.clusterId || it?.sourceUrl || Math.random());
      if (seen.has(id)) continue;
      selected.push(it);
      seen.add(id);
      const p = String(it?.platform || "unknown").toLowerCase().trim();
      counts[p] = (counts[p] || 0) + 1;
    }
  }

  return { selected, counts };
}

    // 7) STORE pool (important for Base44 topic building)
    const MAX_STORE = 60;
    const STORE_PLATFORM_CAPS = { youtube: 30, news: 30 };
    const { selected: storeItems, counts: storeCounts } = selectStorePool(items, MAX_STORE, STORE_PLATFORM_CAPS);

    console.log("📦 STORE platformCounts:", storeCounts);

    console.log("✅ STORE TrendItems count:", storeItems.length);

    // 8) Ingest TrendItems (STORE pool)
    console.log("➡️ Calling Base44 TrendItems ingest:", process.env.BASE44_INGEST_URL);

    let ingestResp;
    try {
      ingestResp = await postToBase44WithBackoff(
        process.env.BASE44_INGEST_URL,
        {
          trendRunId,
          projectId,
          items: storeItems,
          ...(xSignalSnapshot ? { xSignalSnapshot } : {}),
        },
        { retries: 8, baseDelayMs: 900, maxDelayMs: 15_000 }
      );
      console.log("✅ Base44 TrendItems ingest response:", ingestResp);

      // Give Base44 a brief breather after a large ingest to reduce throttling
      await sleep(1200);
    } catch (e) {
      // If Base44 is down/flaky, fail gracefully and mark the run error
      throw new Error(`Base44 ingestTrendResults failed: ${e?.message || e}`);
    }
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`TrendForge Trend Service running on port ${PORT}`);
});
