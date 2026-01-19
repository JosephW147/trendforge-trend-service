import { fetchWithRetry } from "../utils/retry.js";

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

export async function collectGdelt({ nicheName, region = "Global", max = 25 }) {
  // GDELT supports a Lucene-like query syntax. We keep it conservative:
  // - nicheName is the main query
  // - optionally filter by sourceCountry:<ISO2>
  const base = String(nicheName || "").trim() || "General";
  const rc = String(region || "Global").trim();

  // Only apply country filter for 2-letter ISO codes.
  const countryFilter = /^[A-Z]{2}$/i.test(rc) ? ` sourceCountry:${rc.toUpperCase()}` : "";
  const query = `${base}${countryFilter}`.trim();

  const q = encodeURIComponent(query);
  const url = `${GDELT_DOC_URL}?query=${q}&mode=ArtList&format=json&maxrecords=${max}&sort=hybridrel`;

  const res = await fetchWithRetry(url, { method: "GET" }, { retries: 3 });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GDELT failed ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const articles = json?.articles || [];

  return articles
    .map(a => ({
      platform: "news",
      topicTitle: a?.title || "Untitled",
      topicSummary: a?.description || a?.snippet || "",
      sourceUrl: a?.url || "",
      publishedAt: a?.seendate || null,
      author: a?.source || "",
      metrics: {
        domain: a?.domain,
        sourceCountry: a?.sourceCountry,
        tone: a?.tone,
        gdelt: true,
      },
      queryUsed: nicheName,
    }))
    .filter(x => x.sourceUrl && x.topicTitle);
}