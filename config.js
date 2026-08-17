// News Stack v3 (PWA) — configuration
//
// This file is the browser's equivalent of v3's environment variables. The
// defaults below are the same numbers app.py ships with, except where a phone
// cannot honour them; those are marked.
//
// PROXY_BASE is the ONLY thing you must change after deploying worker.js.
// Paste the URL Cloudflare gives you, no trailing slash. Example:
//   https://newsstack-v3.yourname.workers.dev
//
// Left empty, the app still starts and every feed reports `blocked`: browsers
// refuse cross-origin reads of feeds that send no CORS header, which is most
// of them. There is no client-only way around that.
//
// One exception: served from localhost, an empty PROXY_BASE means "same
// origin", so `python dev-proxy.py` works with no configuration at all. That
// only helps on the machine running it — a phone on cellular cannot reach your
// laptop, which is the whole reason worker.js exists.
window.NEWSSTACK_CONFIG = {
  PROXY_BASE: (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? location.origin
    : "",

  // v3: REFRESH_SECONDS=300. Same here, but a PWA only runs while it is on
  // screen — see README, "What a phone cannot do".
  REFRESH_SECONDS: 300,

  // v3: RETAIN_DAYS=30.
  RETAIN_DAYS: 30,

  // v3: FETCH_WORKERS=8. Kept: these are requests to your worker, not to 8
  // different origins, and Safari caps concurrent connections per host anyway.
  FETCH_WORKERS: 8,

  // v3: FETCH_TIMEOUT=25.
  FETCH_TIMEOUT: 25,

  // Article body extraction. v3: CONTENT_EXTRACT=1, CONTENT_BATCH=40,
  // CONTENT_WORKERS=4. The batch is smaller here because the phone pays for
  // every byte on cellular and the worker does the HTML reduction anyway.
  CONTENT_EXTRACT: true,
  CONTENT_BATCH: 12,
  CONTENT_WORKERS: 3,
  CONTENT_INTERVAL: 60,
  CONTENT_MAX_CHARS: 20000,
  CONTENT_MIN_CHARS: 400,

  // v3: RETRY_ERROR_AFTER / RETRY_BLOCKED_AFTER.
  RETRY_ERROR_AFTER: 3600,
  RETRY_ERROR_MAX: 3,
  RETRY_BLOCKED_AFTER: 86400,
  RETRY_BLOCKED_MAX: 2,
};
