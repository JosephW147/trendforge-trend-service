export async function fetchWithRetry(url, options = {}, cfg = {}) {
  const {
    retries = 3,
    baseDelayMs = 800,
    maxDelayMs = 8000,
    timeoutMs = 15000,
  } = cfg;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });

      // Retry 429/5xx
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, delay));
    } finally {
      clearTimeout(t);
    }
  }
}
