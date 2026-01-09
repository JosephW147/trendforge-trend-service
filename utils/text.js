// utils/text.js
// Dependency-free helpers to make RSS/HTML-ish strings safe for display/storage.

// Convert unknown values into a reasonable string WITHOUT producing "[object Object]".
export function toPlainString(value) {
  if (value == null) return "";

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  // fast-xml-parser sometimes uses { "#text": "..." }
  if (typeof value === "object") {
    const v = value;

    if (typeof v["#text"] === "string") return v["#text"];
    if (typeof v.text === "string") return v.text;
    if (typeof v.value === "string") return v.value;
    if (typeof v.content === "string") return v.content;
    if (typeof v.summary === "string") return v.summary;
    if (typeof v.description === "string") return v.description;

    // Some feeds expose content as an array of strings
    if (Array.isArray(v) && v.length) {
      return v.map(toPlainString).filter(Boolean).join(" ");
    }
  }

  // Last resort
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
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
