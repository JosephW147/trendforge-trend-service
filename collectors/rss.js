import { XMLParser } from "fast-xml-parser";
import { fetchWithRetry } from "../utils/retry.js";
import { sanitizeText, toPlainString } from "../utils/text.js";

const parser = new XMLParser({ ignoreAttributes: false });

export async function collectRss({ feeds = [], nicheName, maxPerFeed = 6 }) {
  const out = [];

  for (const feedUrl of feeds) {
    const res = await fetchWithRetry(feedUrl, { method: "GET" }, { retries: 2 });
    if (!res.ok) continue;

    const xml = await res.text();
    const data = parser.parse(xml);

    const items =
      data?.rss?.channel?.item ||
      data?.feed?.entry ||
      [];

    const arr = Array.isArray(items) ? items : [items];

    for (const it of arr.slice(0, maxPerFeed)) {
      const titleRaw = it?.title?.["#text"] ?? it?.title ?? "";
      const link =
        it?.link?.["@_href"] ??
        it?.link ??
        it?.guid ??
        "";

      const summaryRaw = it?.description ?? it?.summary ?? "";

      out.push({
        platform: "news",
        // Decode entities + strip HTML (some feeds include \"&#8216;\" etc.)
        topicTitle: sanitizeText(toPlainString(titleRaw), { maxLen: 220 }),
        topicSummary: sanitizeText(toPlainString(summaryRaw), { maxLen: 700 }),
        sourceUrl: String(link).trim(),
        publishedAt: it?.pubDate ?? it?.published ?? null,
        author: it?.author?.name ?? it?.author ?? "",
        metrics: { feedUrl, rss: true },
        queryUsed: nicheName,
      });
    }
  }

  return out.filter(x => x.sourceUrl && x.topicTitle);
}