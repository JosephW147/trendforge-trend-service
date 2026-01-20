import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry } from "../utils/retry.js";
import { sanitizeText, toPlainString } from "../utils/text.js";

const parser = new XMLParser({ ignoreAttributes: false });

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
      res = await fetchWithRetry(feedUrl, { method: "GET" }, { retries: 2 });
      if (!res?.ok) continue;

      xml = await res.text();
      data = parser.parse(xml);
    } catch (e) {
      console.error(`⚠️ RSS feed failed (skipping): ${feedUrl} ->`, e?.message || e);
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
        (typeof it?.link === "string" ? it.link : "") ??
        it?.guid ??
        "";

      const summaryRaw = it?.description ?? it?.summary ?? "";

      out.push({
        platform: "news",
        topicTitle: sanitizeText(toPlainString(titleRaw), { maxLen: 220 }),
        topicSummary: sanitizeText(toPlainString(summaryRaw), { maxLen: 700 }),
        sourceUrl: String(link).trim(),
        publishedAt: it?.pubDate ?? it?.published ?? null,
        author: it?.author?.name ?? it?.author ?? "",
        metrics: {
          feedUrl,
          rss: true,
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
