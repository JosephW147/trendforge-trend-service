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

  // GDELT occasionally returns a 200 response containing non-JSON (e.g., a plain-text
  // rate-limit / search-limit message). If we call res.json() directly, Node will throw:
  // "Unexpected token ... is not valid JSON" and the whole scan fails.
  //
  // We defensively parse and treat "non-JSON" as a transient failure so the pipeline can
  // continue (RSS still provides news coverage).
  const res = await fetchWithRetry(
    url,
    {
      method: "GET",
      headers: {
        // Some edge networks behave better with an explicit UA.
        "user-agent": "TrendForgeBot/1.0 (+https://trendforge.local)",
        accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      },
    },
    { retries: 3 }
  );

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`GDELT failed ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    const snippet = bodyText.replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`GDELT returned non-JSON body: ${snippet}`);
    err.code = "GDELT_NON_JSON";
    throw err;
  }
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