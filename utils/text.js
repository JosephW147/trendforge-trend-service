// utils/text.js
// Dependency-free helpers to make RSS/HTML-ish strings safe for display/storage.

// Convert unknown values into a reasonable string WITHOUT producing "[object Object]".
export function toPlainString(value) {
  if (value == null) return "";

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  // Recursively extract text from objects/arrays (fast-xml-parser mixed content)
  const seen = new Set();
  const parts = [];

  const SKIP_KEYS = new Set([
    "@_href", "@_src", "@_url", "@_type", "@_rel", "@_target", "@_id", "@_ref",
    "@_xmlns", "@_version"
  ]);

  function walk(v, keyHint = "") {
    if (v == null) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s) parts.push(s);
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
      return;
    }
    if (typeof v !== "object") return;

    if (seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }

    // Prefer #text only if it contains meaningful text
    const t = typeof v["#text"] === "string" ? v["#text"].trim() : "";
    if (t) {
      parts.push(t);
      // Don't return early; sometimes useful text exists elsewhere too
    }

    for (const [k, child] of Object.entries(v)) {
      if (k === "#text") continue;
      if (SKIP_KEYS.has(k)) continue;
      if (k.startsWith("@_")) continue; // skip attributes broadly
      walk(child, k);
    }
  }

  walk(value);

  // Join and de-dupe lightly
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined;
}

export function stripHtmlTags(input) {
  const str = toPlainString(input);
  if (!str) return "";
  return str.replace(/<[^>]*>/g, " ");
}

// Decode a small set of HTML entities, including numeric (e.g. &#8216;).
export function decodeHtmlEntities(input) {
  let str = toPlainString(input);
  if (!str) return "";

  // Named entities (minimal set that we actually see in feeds)
  const named = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#34;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };

  str = str.replace(/&(amp|lt|gt|quot|apos|nbsp);|&#34;|&#39;/g, (m) => named[m] ?? m);

  // Numeric entities: decimal and hex
  str = str.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number(dec);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });

  str = str.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });

  return str;
}

// One-stop sanitization for titles/summaries stored in Base44.
export function sanitizeText(input, { maxLen } = {}) {
  let s = decodeHtmlEntities(input);
  s = stripHtmlTags(s);
  s = s.replace(/\s+/g, " ").trim();

  // Guard against accidental object coercion
  if (s === "[object Object]") s = "";

  if (typeof maxLen === "number" && maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen - 1).trimEnd() + "…";
  }

  return s;
}
