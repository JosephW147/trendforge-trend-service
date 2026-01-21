import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry } from "../utils/retry.js";
import { sanitizeText, toPlainString } from "../utils/text.js";

const parser = new XMLParser({ ignoreAttributes: false });

function detectSocialHints(text) {
  const t = String(text || "").toLowerCase();
  // Deterministic keyword-based detection.
  // We do NOT scrape social platforms; we only infer "mentions" from public news/RSS text.
  const hasTikTok = /\btiktok\b/.test(t) || /\btt\b/.test(t);
  const hasInstagram = /\binstagram\b/.test(t) || /\big\b/.test(t);
  const hasReels = /\breels\b/.test(t) || /\binsta\s*reels\b/.test(t);
  const hasShorts = /\byoutube\s*shorts\b/.test(t) || /\bshorts\b/.test(t);
  return {
    tiktokMention: !!hasTikTok,
    instagramMention: !!hasInstagram,
    reelsMention: !!hasReels,
    shortsMention: !!hasShorts,
  };
}

export async function collectRss({ feeds = [], nicheName, maxPerFeed = 6 }) {
  const out = [];

  for (const feed of feeds) {
    const feedUrl = typeof feed === "string" ? feed : feed?.url;
    if (!feedUrl) continue;

    const feedRegion = typeof feed === "object" ? feed?.region : undefined;
    const feedLanguage = typeof feed === "object" ? feed?.language : undefined;
    const feedPriority = typeof feed === "object" ? feed?.priority : undefined;

    let res;
    let xml = "";
    let data;

    try {
      res = await fetchWithRetry(
        feedUrl,
        {
          method: "GET",
          headers: {
            // Many RSS hosts require a UA / Accept header to return content
            "User-Agent": "TrendForgeRSS/1.0 (+https://trendforge-trend-service.onrender.com)",
            "Accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
          },
        },
        { retries: 2, timeoutMs: 15000 }
      );
    } catch (e) {
      console.log(`⚠️ RSS feed failed (skipping): ${feedUrl} ->`, e?.message || e);
      continue;
    }

    if (!res?.ok) {
      console.log(`⚠️ RSS feed non-OK (skipping): ${feedUrl} -> ${res?.status}`);
      continue;
    }
    try {
      xml = await res.text();
      data = parser.parse(xml);
    } catch (e) {
      console.log(`⚠️ RSS parse failed (skipping): ${feedUrl} ->`, e?.message || e);
      continue;
    }

    const items =
      data?.rss?.channel?.item ??
      data?.feed?.entry ??
      [];

    const arr = Array.isArray(items) ? items : [items];

    for (const it of arr.slice(0, maxPerFeed)) {
      const titleRaw = it?.title?.["#text"] ?? it?.title ?? "";

      const link =
        it?.link?.["@_href"] ??
        it?.link?.["#text"] ??
        (typeof it?.link === "string" ? it.link : "") ??
        (typeof it?.guid === "string" ? it.guid : (it?.guid?.["#text"] ?? "")) ??
        "";

      const summaryRaw = it?.description ?? it?.summary ?? "";

      // Google News RSS sometimes has no pubDate on some entries; fall back to "now"
      const publishedAt =
        it?.pubDate ??
        it?.published ??
        it?.updated ??
        null;

      out.push({
        platform: "news",
        topicTitle: titleClean,
        topicSummary: summaryClean,
        sourceUrl: String(link).trim(),
        publishedAt: publishedAt || new Date().toISOString(),
        author: it?.author?.name ?? it?.author ?? "",
        metrics: {
          feedUrl,
          rss: true,
          socialHints,
          ...(feedRegion ? { feedRegion } : {}),
          ...(feedLanguage ? { language: feedLanguage } : {}),
          ...(feedPriority ? { sourcePriority: feedPriority } : {}),
        },
        queryUsed: nicheName,
      });
    }
  }

  return out.filter((x) => x.sourceUrl && x.topicTitle);
}
