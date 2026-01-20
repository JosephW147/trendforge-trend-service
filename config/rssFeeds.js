// config/rssFeeds.js

// Regions are stored in the Projects entity as human-friendly bucket names.
// Keep these strings stable because they are used by the UI and stored in Base44.
export const REGION_BUCKETS = {
  GLOBAL: "Global",
  AFRICA: "Africa (Sub-Saharan)",
  MENA: "Middle East & North Africa (MENA)",
  EUROPE: "Europe (EU & Non-EU)",
  APAC: "Asia-Pacific (APAC)",
  LATAM: "Latin America & Caribbean (LATAM)",
  NORAM: "North America (NORAM)",
  CAC: "Central Asia & Caucasus",
  OTHER: "Other",
};

/**
 * Feed object schema:
 * {
 *   url: string,
 *   region: one of REGION_BUCKETS values,
 *   language: "en",
 *   priority: 1 | 2 | 3  (1 = highest)
 * }
 */
export const RSS_FEEDS = [
  // -----------------
  // Global
  // -----------------
  { url: "https://www.reuters.com/rssFeed/worldNews", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 1 },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 1 },
  { url: "https://rss.cnn.com/rss/edition_world.rss", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 2 },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 2 },
  { url: "https://apnews.com/rss/apf-topnews", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 2 },
  { url: "https://feeds.skynews.com/feeds/rss/world.xml", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 3 },
  { url: "https://www.npr.org/rss/rss.php?id=1004", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 3 },
  { url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", region: REGION_BUCKETS.GLOBAL, language: "en", priority: 2 },

  // -----------------
  // Africa (Sub-Saharan)
  // -----------------
  { url: "https://www.africanews.com/feed/rss", region: REGION_BUCKETS.AFRICA, language: "en", priority: 2 },
  { url: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", region: REGION_BUCKETS.AFRICA, language: "en", priority: 2 },
  { url: "https://reliefweb.int/updates/rss.xml", region: REGION_BUCKETS.AFRICA, language: "en", priority: 2 },
  { url: "https://www.premiumtimesng.com/feed", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://guardian.ng/feed", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://punchng.com/feed", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://www.news24.com/rss", region: REGION_BUCKETS.AFRICA, language: "en", priority: 2 },
  { url: "https://www.timeslive.co.za/rss/", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://www.iol.co.za/cmlink/1.640", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://www.standardmedia.co.ke/rss", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://nation.africa/rss", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://www.graphic.com.gh/rss", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://citinewsroom.com/feed/", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://www.thereporterethiopia.com/feed", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },
  { url: "https://addisfortune.news/feed/", region: REGION_BUCKETS.AFRICA, language: "en", priority: 3 },

  // -----------------
  // MENA
  // -----------------
  { url: "https://www.al-monitor.com/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 2 },
  { url: "https://english.alarabiya.net/tools/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 2 },
  { url: "https://www.middleeasteye.net/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 2 },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", region: REGION_BUCKETS.MENA, language: "en", priority: 2 },
  { url: "https://arabnews.com/rss.xml", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://gulfnews.com/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://www.timesofisrael.com/feed/", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://www.ynetnews.com/category/3082", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://www.tehrantimes.com/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://www.dailysabah.com/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },
  { url: "https://www.hurriyetdailynews.com/rss", region: REGION_BUCKETS.MENA, language: "en", priority: 3 },

  // -----------------
  // Europe
  // -----------------
  { url: "https://www.euronews.com/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://www.politico.eu/feed/", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://feeds.bbci.co.uk/news/uk/rss.xml", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://www.theguardian.com/uk/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://www.france24.com/en/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://www.dw.com/en/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 2 },
  { url: "https://www.spiegel.de/international/index.rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },
  { url: "https://www.thelocal.se/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },
  { url: "https://www.thelocal.no/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },
  { url: "https://yle.fi/uutiset/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },
  { url: "https://www.themoscowtimes.com/rss", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },
  { url: "https://www.bne.eu/rss/", region: REGION_BUCKETS.EUROPE, language: "en", priority: 3 },

  // -----------------
  // APAC
  // -----------------
  { url: "https://www.scmp.com/rss", region: REGION_BUCKETS.APAC, language: "en", priority: 2 },
  { url: "https://english.news.cn/rss", region: REGION_BUCKETS.APAC, language: "en", priority: 2 },
  { url: "https://www.japantimes.co.jp/feed/", region: REGION_BUCKETS.APAC, language: "en", priority: 2 },
  { url: "https://www3.nhk.or.jp/rss/news/cat0.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://en.yna.co.kr/rss/all", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://www.koreatimes.co.kr/www/rss/rss.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://www.channelnewsasia.com/rssfeeds/8395884", region: REGION_BUCKETS.APAC, language: "en", priority: 2 },
  { url: "https://www.bangkokpost.com/rss/data/topstories.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://www.vietnamnews.vn/rss", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://www.abc.net.au/news/feed/51120/rss.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 2 },
  { url: "https://www.smh.com.au/rss/feed.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },
  { url: "https://www.rnz.co.nz/rss/world.xml", region: REGION_BUCKETS.APAC, language: "en", priority: 3 },

  // -----------------
  // LATAM
  // -----------------
  { url: "https://latinamericanewsdispatch.com/feed/", region: REGION_BUCKETS.LATAM, language: "en", priority: 3 },
  { url: "https://www.telesurenglish.net/rss/index.xml", region: REGION_BUCKETS.LATAM, language: "en", priority: 3 },
  { url: "https://jamaica-gleaner.com/feed", region: REGION_BUCKETS.LATAM, language: "en", priority: 3 },
  { url: "https://jamaicaobserver.com/feed", region: REGION_BUCKETS.LATAM, language: "en", priority: 3 },
  { url: "https://loopnews.com/rss", region: REGION_BUCKETS.LATAM, language: "en", priority: 3 },

  // -----------------
  // NORAM
  // -----------------
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", region: REGION_BUCKETS.NORAM, language: "en", priority: 2 },
  { url: "https://feeds.washingtonpost.com/rss/world", region: REGION_BUCKETS.NORAM, language: "en", priority: 2 },
  { url: "https://www.latimes.com/rss2.0.xml", region: REGION_BUCKETS.NORAM, language: "en", priority: 3 },
  { url: "https://feeds.npr.org/1001/rss.xml", region: REGION_BUCKETS.NORAM, language: "en", priority: 3 },
  { url: "https://www.politico.com/rss/politics08.xml", region: REGION_BUCKETS.NORAM, language: "en", priority: 3 },
  { url: "https://www.cbc.ca/rss", region: REGION_BUCKETS.NORAM, language: "en", priority: 3 },
  { url: "https://www.theglobeandmail.com/rss/", region: REGION_BUCKETS.NORAM, language: "en", priority: 3 },

  // -----------------
  // Central Asia & Caucasus
  // -----------------
  { url: "https://eurasianet.org/feed", region: REGION_BUCKETS.CAC, language: "en", priority: 2 },
  { url: "https://www.rferl.org/rss", region: REGION_BUCKETS.CAC, language: "en", priority: 2 },
  { url: "https://astanatimes.com/feed/", region: REGION_BUCKETS.CAC, language: "en", priority: 3 },
  { url: "https://oc-media.org/feed/", region: REGION_BUCKETS.CAC, language: "en", priority: 3 },

  // -----------------
  // Other (Economy, Science, Humanitarian, ...)
  // -----------------
  { url: "https://www.worldbank.org/en/rss", region: REGION_BUCKETS.OTHER, language: "en", priority: 2 },
  { url: "https://www.imf.org/en/rss", region: REGION_BUCKETS.OTHER, language: "en", priority: 2 },
  { url: "https://climate.nasa.gov/rss", region: REGION_BUCKETS.OTHER, language: "en", priority: 2 },
  { url: "https://www.sciencedaily.com/rss/top.xml", region: REGION_BUCKETS.OTHER, language: "en", priority: 3 },
  { url: "https://www.acleddata.com/feed/", region: REGION_BUCKETS.OTHER, language: "en", priority: 3 },
  { url: "https://reliefweb.int/updates/rss.xml", region: REGION_BUCKETS.OTHER, language: "en", priority: 2 },
];

export function normalizeRegionBucket(input) {
  const s = String(input || "").trim();
  if (!s) return REGION_BUCKETS.GLOBAL;
  const vals = Object.values(REGION_BUCKETS);
  const hit = vals.find((v) => v.toLowerCase() === s.toLowerCase());
  return hit || s;
}

export function getRssFeedsForRegions(regions) {
  const selected = (Array.isArray(regions) ? regions : [regions])
    .map(normalizeRegionBucket)
    .filter(Boolean);

  const set = new Set(selected);
  // If user didn't choose anything, default to global.
  if (set.size === 0) set.add(REGION_BUCKETS.GLOBAL);

  const feeds = RSS_FEEDS.filter((f) => set.has(f.region));

  // De-dup by URL and keep the best priority (lowest number)
  const best = new Map();
  for (const f of feeds) {
    const cur = best.get(f.url);
    if (!cur || Number(f.priority) < Number(cur.priority)) best.set(f.url, f);
  }

  return Array.from(best.values()).sort((a, b) => Number(a.priority) - Number(b.priority));
}
