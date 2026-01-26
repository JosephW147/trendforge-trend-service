import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry } from "../utils/retry.js";
import { sanitizeText, toPlainString } from "../utils/text.js";

const parser = new XMLParser({ ignoreAttributes: false });

function titleClean(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s#@'"’\-:.,!?()/&]/gu, "")
    .trim();
}

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

export async function collectRss({
  feeds = [],
  nicheName,
  maxPerFeed = 6,
  // Some major feeds (CNN/NPR/etc.) can be slow or transiently blocked.
  // Keep timeout generous to reduce AbortController-triggered failures.
  timeoutMs = 30000,
}) {
  const out = [];

  for (const feed of feeds) {
    const feedUrl = typeof feed === "string" ? feed : feed?.url;
    if (!feedUrl) continue;

    const feedRegion = typeof feed === "object" ? feed?.region : undefined;
    const feedLanguage = typeof feed === "object" ? feed?.language : undefined;
    const feedPriority = typeof feed === "object" ? feed?.priority : undefined;

    let xml = "";
    let data;

    try {
      // hard timeout per feed so scans don't stall for minutes
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchWithRetry(feedUrl, {
          // A few feeds reject empty/default UAs or require browser-like headers.
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TrendForgeBot/1.0; +https://trendforge.app)",
            "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
          },
          signal: controller.signal,
        });
        xml = await res.text();
      } finally {
        clearTimeout(t);
      }

      data = parser.parse(xml);
    } catch (e) {
      console.error("⚠️ RSS feed failed (skipping):", feedUrl, "->", e?.message || e);
      continue;
    }

    // Pull items out of either rss/channel/item or feed/entry shapes
    const rssItems =
      data?.rss?.channel?.item ||
      data?.channel?.item ||
      data?.feed?.entry ||
      [];

    const items = Array.isArray(rssItems) ? rssItems : [rssItems];

    for (const it of items.slice(0, maxPerFeed)) {
      // IMPORTANT: define these OUTSIDE try so they always exist
      let titleClean = "";
      let summaryClean = "";

      try {
        const link =
          it?.link?.["@_href"] ||
          it?.link?.href ||
          it?.link ||
          it?.guid ||
          "";

        const titleRaw = it?.title ?? "";
        const summaryRaw =
          it?.description ??
          it?.summary ??
          it?.content ??
          it?.["content:encoded"] ??
          it?.["media:description"] ??
          it?.["media:content"] ??
          "";


        titleClean = sanitizeText(toPlainString(titleRaw), { maxLen: 220 });
        summaryClean = sanitizeText(toPlainString(summaryRaw), { maxLen: 700 });

        if (!link || !titleClean) continue;

        const socialHints = detectSocialHints(`${titleClean} ${summaryClean}`);

        out.push({
          platform: "news",
          topicTitle: titleClean,
          topicSummary: summaryClean,
          sourceUrl: String(link).trim(),
          publishedAt: it?.pubDate ?? it?.published ?? it?.updated ?? null,
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
      } catch (e) {
        // never reference undeclared vars here again
        console.error(
          "⚠️ RSS item parse failed (skipping):",
          feedUrl,
          "title=",
          titleClean || "(unavailable)",
          "->",
          e?.message || e
        );
        continue;
      }
    }
  }

  return out.filter((x) => x.sourceUrl && x.topicTitle);
}
