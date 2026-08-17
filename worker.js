/**
 * News Stack v3 (PWA) — source proxy and article extractor.
 *
 * v3 runs a Python process that fetches feeds and reduces article pages to
 * text. A browser can do neither: it cannot read a cross-origin feed that
 * sends no CORS header, and it should not be downloading megabytes of
 * publisher HTML over cellular to find a few thousand characters of prose.
 * This worker does both jobs, so the phone only ever receives feed XML and
 * plain text.
 *
 *   GET /fetch?url=<encoded feed url>     → the feed bytes, with CORS headers
 *   GET /article?url=<encoded page url>   → {text, status, chars}
 *   GET /health                           → {ok:true}
 *
 * Deploy: see DEPLOY.md
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set this to your Pages origin once you know it, e.g.
// "https://joek670.github.io". Left as "*", anyone who finds this worker can
// use it as a feed proxy. It still cannot be used as a general-purpose open
// proxy — /fetch is limited to the hosts below and /article never returns raw
// bytes — but narrowing it costs nothing.
const ALLOWED_ORIGIN = "*";

// Every host in feeds.js, and nothing else. /fetch refuses anything not here.
const FEED_HOSTS = [
  "openai.com", "blog.google", "deepmind.google", "huggingface.co",
  "bair.berkeley.edu", "news.mit.edu", "importai.substack.com",
  "export.arxiv.org",
  "feeds.arstechnica.com", "www.theverge.com", "techcrunch.com",
  "spectrum.ieee.org", "news.ycombinator.com", "feeds.bbci.co.uk",
  "krebsonsecurity.com", "www.bleepingcomputer.com", "feeds.feedburner.com",
  "www.schneier.com", "www.cisa.gov",
  "lobste.rs", "blog.rust-lang.org", "go.dev", "blog.python.org",
  "stackoverflow.blog",
  "lwn.net", "www.phoronix.com", "github.blog",
  "www.nasa.gov", "science.nasa.gov", "www.jpl.nasa.gov", "www.esa.int",
  "esahubble.org", "spacenews.com", "skyandtelescope.org", "apod.nasa.gov",
  "www.quantamagazine.org", "news.fnal.gov", "physicsworld.com",
  "www.nature.com", "www.science.org", "www.scientificamerican.com",
  "www.sciencedaily.com", "phys.org",
  "www.reddit.com", "old.reddit.com",
  "github.com",
  "feeds.npr.org",
];

// v3's USER_AGENT. Reddit rejects requests with a blank UA from datacentre IPs.
const UA = "Mozilla/5.0 (compatible; NewsStack/3.0; +https://github.com/joek670/newsstack-v3)";

const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";

const CACHE_SECONDS = 240;        // just under v3's 300s cycle
const CONTENT_MAX_BYTES = 3000000; // v3: CONTENT_MAX_BYTES
const CONTENT_MAX_CHARS = 20000;   // v3: CONTENT_MAX_CHARS
const CONTENT_MIN_CHARS = 400;     // v3: CONTENT_MIN_CHARS

// Hosts whose "article" is the feed entry itself, or that rate limit far too
// hard to be worth the page fetch.
const NO_CONTENT_HOSTS = new Set(["www.reddit.com", "reddit.com", "old.reddit.com"]);
const NON_HTML_PATH = /\.(?:pdf|zip|gz|tar|mp3|mp4|m4a|epub|png|jpe?g|gif)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Newsstack-Upstream, X-Newsstack-Type",
    Vary: "Origin",
    ...extra,
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: cors({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  });

function feedHostAllowed(host) {
  return FEED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/**
 * Reject anything that is not a public https URL.
 *
 * Article URLs arrive inside feed XML, so a compromised or hostile feed would
 * otherwise get to name any address this worker can reach. Cloudflare will not
 * route to RFC1918 space from a Worker, but literals and localhost names are
 * worth refusing outright rather than relying on that.
 */
function publicHttps(u) {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (h === "metadata.google.internal" || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] >= 224) return false;
  }
  if (h.includes(":")) return false; // IPv6 literal
  if (u.port && u.port !== "443") return false;
  return true;
}

/** Reddit sometimes 403s www but serves old.reddit.com fine, and vice versa. */
function alternates(url) {
  const out = [url];
  try {
    const u = new URL(url);
    if (u.hostname === "www.reddit.com" || u.hostname === "old.reddit.com") {
      const alt = new URL(url);
      alt.hostname = u.hostname === "www.reddit.com" ? "old.reddit.com" : "www.reddit.com";
      out.push(alt.toString());
    }
  } catch (e) { /* the caller already validated this */ }
  return out;
}

async function fetchUpstream(url, accept, retry) {
  let lastStatus = 0;
  let lastErr = "";
  for (const candidate of alternates(url)) {
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      try {
        const res = await fetch(candidate, {
          headers: {
            "User-Agent": UA,
            Accept: accept,
            "Accept-Language": "en-US,en;q=0.9",
          },
          cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
          redirect: "follow",
        });
        if (res.ok) return { res };
        lastStatus = res.status;
        // 429 and 5xx are worth one short retry; 404 is not.
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 600));
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
  }
  return { error: lastErr || "upstream " + lastStatus, status: lastStatus };
}

// ---------------------------------------------------------------------------
// Article extraction. Port of app.py's extract_article and friends.
// ---------------------------------------------------------------------------
const SKIP_ELEMENTS = new Set([
  "script", "style", "noscript", "svg", "canvas", "template", "iframe",
  "nav", "header", "footer", "aside", "form", "button", "select", "option",
  "figcaption", "picture", "video", "audio",
]);
// Elements after which a line break belongs, so paragraphs survive as paragraphs.
const BLOCK_ELEMENTS = new Set([
  "p", "div", "section", "article", "main", "li", "tr", "blockquote", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "td", "dd", "dt",
]);
// Class/id substrings that mark furniture even inside <article>.
const JUNK_ATTR =
  /(?:^|[\s_-])(?:share|social|newsletter|subscribe|promo|advert|related|comment|cookie|banner|breadcrumb|sidebar|menu|nav|paywall|popup|modal)/i;
const ARTICLE_TAG = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi;
const MAIN_TAG = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi;
const BODY_TAG = /<body\b[^>]*>([\s\S]*)/i;
const LDJSON = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
const SENTENCE_END = /[.!?"')\]]\s*$/;
// Furniture that survives the element filters because it sits in an unmarked
// <p> inside the article. Only applied to short lines, so a sentence that
// happens to discuss a newsletter or a subscription is kept.
const JUNK_LINE =
  /sign up for|subscribe to|newsletter|follow us on|all rights reserved|share this (?:article|story)|read more at|advertisement|©|terms of (?:use|service)|privacy policy|cookie (?:policy|settings)|click here|related stories|more from/i;
const JUNK_LINE_MAX = 200;
const TAGS = /<[^>]*>/g;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”",
};
function unescapeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ref) => {
    const key = ref.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch (e) { return m; }
      }
    }
    return m;
  });
}

/** schema.org articleBody — the publisher's own statement of where it starts. */
function ldjsonBody(doc) {
  LDJSON.lastIndex = 0;
  let m;
  while ((m = LDJSON.exec(doc)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (node && typeof node === "object") {
        const body = node.articleBody;
        if (typeof body === "string" && body.length >= CONTENT_MIN_CHARS) return body;
        for (const v of Object.values(node)) {
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
  }
  return "";
}

/** The markup most likely to hold the body. Largest match wins, not the first. */
function densestRegion(doc) {
  for (const pattern of [ARTICLE_TAG, MAIN_TAG]) {
    pattern.lastIndex = 0;
    let best = "";
    let m;
    while ((m = pattern.exec(doc)) !== null) if (m[1].length > best.length) best = m[1];
    if (best && best.replace(TAGS, "").length >= CONTENT_MIN_CHARS) return best;
  }
  const b = BODY_TAG.exec(doc);
  return b ? b[1] : doc;
}

/**
 * Visible text with block boundaries kept as newlines.
 * Port of _TextExtractor: skip whole subtrees for furniture elements and for
 * anything whose class/id/role names furniture.
 */
function visibleText(html) {
  const parts = [];
  let skipDepth = 0;
  let skipTag = null;
  let pos = 0;
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const text = html.slice(pos, m.index);
    if (!skipDepth && text.trim()) parts.push(text);
    pos = m.index + m[0].length;

    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    const selfClosing = m[4] === "/";

    if (skipDepth) {
      if (tag === skipTag) {
        if (closing) { skipDepth--; if (!skipDepth) skipTag = null; }
        else if (!selfClosing) skipDepth++;
      }
      continue;
    }
    if (closing) {
      if (BLOCK_ELEMENTS.has(tag)) parts.push("\n");
      continue;
    }
    if (SKIP_ELEMENTS.has(tag)) {
      if (!selfClosing) { skipTag = tag; skipDepth = 1; }
      continue;
    }
    let joined = "";
    const attrRe = /\b(class|id|role)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let a;
    while ((a = attrRe.exec(attrs)) !== null) {
      joined += " " + (a[3] || a[4] || a[5] || "");
    }
    if (joined.trim() && JUNK_ATTR.test(joined)) {
      if (!selfClosing) { skipTag = tag; skipDepth = 1; }
      continue;
    }
    if (BLOCK_ELEMENTS.has(tag)) parts.push("\n");
  }
  const tail = html.slice(pos);
  if (!skipDepth && tail.trim()) parts.push(tail);
  return unescapeEntities(parts.join(""));
}

/** Keep the lines that read like prose and drop the furniture. */
function readableLines(text) {
  const out = [];
  for (let line of text.split("\n")) {
    line = line.replace(/\s+/g, " ").trim();
    if (!line) continue;
    // Navigation, bylines and buttons are short and rarely end a sentence.
    if (line.length < 60 && !SENTENCE_END.test(line)) continue;
    if (line.length < 25) continue;
    if (line.length <= JUNK_LINE_MAX && JUNK_LINE.test(line)) continue;
    out.push(line);
  }
  return out;
}

function extractArticle(doc) {
  let lines;
  const body = ldjsonBody(doc);
  if (body) {
    lines = readableLines(unescapeEntities(body.replace(TAGS, " ")).replace(/\r/g, "\n"));
  } else {
    try { lines = readableLines(visibleText(densestRegion(doc))); }
    catch (e) { return ""; } // a malformed page costs us this article, not the worker
  }

  // De-duplicate repeated furniture while keeping the original order.
  const seen = new Set();
  const kept = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
  }

  let text = kept.join("\n\n").trim();
  if (text.length > CONTENT_MAX_CHARS) {
    // Cut on a paragraph boundary so the tail is not half a sentence.
    const cut = text.lastIndexOf("\n\n", CONTENT_MAX_CHARS);
    text = text.slice(0, cut > CONTENT_MAX_CHARS / 2 ? cut : CONTENT_MAX_CHARS);
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleFetch(target) {
  let u;
  try { u = new URL(target); } catch (e) { return json({ error: "invalid url" }, 400); }
  if (!publicHttps(u) || !feedHostAllowed(u.hostname)) {
    return json({ error: "host not allowed: " + u.hostname }, 403);
  }

  const { res, error, status } = await fetchUpstream(
    target, FEED_ACCEPT, !NO_CONTENT_HOSTS.has(u.hostname)
  );
  if (error) {
    return json({ error, upstreamStatus: status }, 502,
      { "X-Newsstack-Upstream": String(status) });
  }

  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: cors({
      "Content-Type": res.headers.get("Content-Type") || "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "X-Newsstack-Upstream": String(res.status),
      "X-Newsstack-Type": res.headers.get("Content-Type") || "",
    }),
  });
}

/** Returns {text, status, chars}. `status` uses v3's vocabulary exactly. */
async function handleArticle(target) {
  let u;
  try { u = new URL(target); } catch (e) { return json({ text: "", status: "skipped" }); }
  if (NO_CONTENT_HOSTS.has(u.hostname) || NON_HTML_PATH.test(u.pathname)) {
    return json({ text: "", status: "skipped", chars: 0 });
  }
  if (!publicHttps(u)) return json({ text: "", status: "skipped", chars: 0 });

  const { res, error, status } = await fetchUpstream(target, HTML_ACCEPT, false);
  if (error) {
    const blocked = status === 401 || status === 403 || status === 429;
    return json({ text: "", status: blocked ? "blocked" : "error", chars: 0 });
  }

  const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
  if (ctype && !ctype.includes("html") && !ctype.includes("xml")) {
    return json({ text: "", status: "skipped", chars: 0 });
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > CONTENT_MAX_BYTES) {
    return json({ text: "", status: "skipped", chars: 0 });
  }
  let doc;
  try {
    const m = /charset=["']?\s*([\w.:-]+)/i.exec(ctype);
    doc = new TextDecoder(m ? m[1] : "utf-8", { fatal: false }).decode(buf);
  } catch (e) {
    doc = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }

  const text = extractArticle(doc);
  // Short is not an error: paywalls, video posts and link-only entries all land
  // here, and the feed summary remains the best text we have.
  if (text.length < CONTENT_MIN_CHARS) return json({ text: "", status: "empty", chars: 0 });
  return json({ text, status: "ok", chars: text.length },
    200, { "Cache-Control": "public, max-age=86400" });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "newsstack-v3-proxy", feeds: FEED_HOSTS.length });
    }

    const target = url.searchParams.get("url");
    if (!target) return json({ error: "missing url parameter" }, 400);

    if (url.pathname === "/fetch") return handleFetch(target);
    if (url.pathname === "/article") return handleArticle(target);
    return json({ error: "not found" }, 404);
  },
};
