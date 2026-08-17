/* News Stack v3 (PWA) — the engine.
 *
 * This is app.py's data layer with SQLite swapped for IndexedDB and urllib
 * swapped for fetch-through-a-worker. The ranking, clustering, topic and
 * health rules are ports, not reinterpretations: same constants, same
 * thresholds, same status vocabulary.
 *
 * It exposes an `API` object whose methods answer with the same payloads v3's
 * HTTP endpoints do, so app.js reads like the dashboard script it came from.
 */
(function () {
  "use strict";

  const CFG = window.NEWSSTACK_CONFIG;
  const F = window.NEWSSTACK_FEEDS;
  const {
    FEEDS, DISCOVERY, HOST_INTERVAL, DEFAULT_HOST_INTERVAL, ROTATION,
    CI_TAG_PREFIXES, MERGE_JACCARD, MERGE_WINDOW_S, MERGE_MONTHS, MERGE_DATE,
    KEYWORDS, STOPWORDS, topicsFor,
  } = F;

  const INTERVAL = CFG.REFRESH_SECONDS;
  const RETAIN_DAYS = CFG.RETAIN_DAYS;
  const CANDIDATE_CAP = 4000;
  const MAX_RELATED = 12;
  const MARK_URLS_MAX = 500;
  const now = () => Date.now() / 1000;

  // ------------------------------------------------------------------
  // Store
  //
  // v3's four tables, plus two stores that exist because IndexedDB has no
  // column projection and no FTS5:
  //
  //   search  {id, t, b}  the normalised searchable text — title and summary in
  //                       `t`, the article body in `b`. This is the FTS5 index:
  //                       a query scans here and nowhere else.
  //   bodies  {id, text}  the article body as stored, for export.
  //
  // Keeping text out of `stories` is what makes the ranking scan cheap, for the
  // same reason v3 ranks on six small columns and fetches the text afterwards.
  // ------------------------------------------------------------------
  const DB_NAME = "newsstack-v3";
  const DB_VERSION = 1;
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("stories")) {
          const s = db.createObjectStore("stories", { keyPath: "id", autoIncrement: true });
          s.createIndex("url", "url", { unique: true });
          s.createIndex("ts", "ts");
          s.createIndex("cluster_id", "cluster_id");
          s.createIndex("content_status", "content_status");
        }
        if (!db.objectStoreNames.contains("search")) {
          db.createObjectStore("search", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("bodies")) {
          db.createObjectStore("bodies", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("feeds")) {
          db.createObjectStore("feeds", { keyPath: "url" });
        }
        if (!db.objectStoreNames.contains("marks")) {
          const m = db.createObjectStore("marks", { keyPath: "url" });
          m.createIndex("saved_ts", "saved_ts");
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode) {
    return openDB().then((db) => db.transaction(stores, mode));
  }

  const done = (t) => new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

  const wrap = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  /** Walk an index and hand each record to `fn`; return false from fn to stop. */
  function scan(store, indexName, direction, fn) {
    return new Promise((res, rej) => {
      const src = indexName ? store.index(indexName) : store;
      const req = src.openCursor(null, direction);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return res();
        let keep = true;
        try { keep = fn(cur.value); } catch (e) { return rej(e); }
        if (keep === false) return res();
        cur.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }

  async function metaGet(key, dflt) {
    const t = await tx(["meta"], "readonly");
    const row = await wrap(t.objectStore("meta").get(key));
    return row ? row.value : dflt;
  }

  async function metaSet(key, value) {
    const t = await tx(["meta"], "readwrite");
    t.objectStore("meta").put({ key, value });
    await done(t);
  }

  // ------------------------------------------------------------------
  // Fetching. Everything goes through the worker: a browser cannot read a
  // cross-origin feed that sends no CORS header, which is nearly all of them.
  // ------------------------------------------------------------------
  const lastHit = {};

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ""; }
  }

  /** Space requests to a host the way v3's _wait_for_host does. */
  async function waitForHost(host) {
    const gap = HOST_INTERVAL[host] !== undefined ? HOST_INTERVAL[host] : DEFAULT_HOST_INTERVAL;
    const last = lastHit[host] || 0;
    const wait = last + gap - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
    lastHit[host] = now();
  }

  class FetchError extends Error {
    constructor(kind, detail) { super(detail); this.kind = kind; this.name = "FetchError"; }
  }

  function proxied(url, path) {
    const base = (CFG.PROXY_BASE || "").replace(/\/+$/, "");
    if (!base) throw new FetchError("blocked", "PROXY_BASE is not set — see DEPLOY.md");
    return base + (path || "/fetch") + "?url=" + encodeURIComponent(url);
  }

  /** Fetch one feed. Returns {text, latency}. Throws FetchError. */
  async function fetchFeed(url) {
    await waitForHost(hostOf(url));
    const started = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.FETCH_TIMEOUT * 1000);
    let res;
    try {
      res = await fetch(proxied(url), { signal: ctl.signal, cache: "no-store" });
    } catch (e) {
      throw new FetchError("error", e.name === "AbortError" ? "timeout" : String(e.message || e));
    } finally {
      clearTimeout(timer);
    }
    const latency = Math.round(performance.now() - started);

    if (!res.ok) {
      let upstream = Number(res.headers.get("X-Newsstack-Upstream") || 0);
      let detail = "proxy " + res.status;
      try {
        const j = await res.json();
        if (j && j.error) detail = String(j.error);
        if (j && j.upstreamStatus) upstream = Number(j.upstreamStatus);
      } catch (e) { /* body was not JSON */ }
      // A source that is alive and refusing us is a different problem from a
      // dead or malformed feed. Name which one it is.
      let kind = "error";
      if (upstream === 429) kind = "throttled";
      else if (upstream === 401 || upstream === 403) kind = "blocked";
      throw new FetchError(kind, detail);
    }

    const ctype = (res.headers.get("X-Newsstack-Type") || res.headers.get("Content-Type") || "").toLowerCase();
    const text = await res.text();
    // 200 with a consent wall or a bot-check page instead of the feed. v3
    // raises BlockedResponse here; this is the same test.
    if (ctype.includes("html") && !/<(?:rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) {
      throw new FetchError("blocked", "server returned HTML, not a feed");
    }
    return { text, latency };
  }

  // ------------------------------------------------------------------
  // Feed parsing. Ports parse_xml / extract / clean / parse_time.
  // ------------------------------------------------------------------
  const NS_ATOM = "http://www.w3.org/2005/Atom";
  const NS_DC = "http://purl.org/dc/elements/1.1/";
  const NS_CONTENT = "http://purl.org/rss/1.0/modules/content/";
  const NS_RSS1 = "http://purl.org/rss/1.0/";

  const XML_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  const BARE_AMP = /&(?!#?\w+;)/g;
  // JPL emits `<content:encoded<![CDATA[ ... ]]>` - an open tag missing its `>`
  // and no closing tag at all. Rebuild the whole element rather than just the
  // bracket, or every repaired open tag runs on into the next </item>.
  const BROKEN_CDATA_EL = /<([A-Za-z_][\w:.-]*)<!\[CDATA\[([\s\S]*?)\]\]>/g;
  const TAGS = /<[^>]*>/g;
  const WS = /\s+/g;
  const WORD = /[a-z0-9][a-z0-9'+.-]*/g;

  function parseXML(raw) {
    const p = new DOMParser();
    let doc = p.parseFromString(raw, "application/xml");
    if (!doc.querySelector("parsererror")) return doc;

    // Repair the damage real feeds ship with, in v3's order.
    let text = raw;
    if ((text.match(/<!\[CDATA\[/g) || []).length > (text.match(/\]\]>/g) || []).length) {
      text = text.slice(0, text.lastIndexOf("<![CDATA["));
      for (const closer of ["</item>", "</entry>"]) {
        const cut = text.lastIndexOf(closer);
        if (cut !== -1) { text = text.slice(0, cut + closer.length); break; }
      }
    }
    text = text
      .replace(XML_CTRL, "")
      .replace(BROKEN_CDATA_EL, "<$1><![CDATA[$2]]></$1>")
      .replace(BARE_AMP, "&amp;");
    doc = p.parseFromString(text, "application/xml");
    if (!doc.querySelector("parsererror")) return doc;

    // Last resort: close whatever the root element is and reparse.
    const m = /^\s*(?:<\?xml[^>]*\?>\s*)?<([A-Za-z_][\w:.-]*)/.exec(text);
    if (!m) throw new FetchError("error", "unparseable feed");
    for (const closer of ["</item>", "</entry>"]) {
      const cut = text.lastIndexOf(closer);
      if (cut !== -1) { text = text.slice(0, cut + closer.length); break; }
    }
    const depthClose = text.includes("<channel") ? "</channel>" : "";
    doc = p.parseFromString(text + depthClose + "</" + m[1] + ">", "application/xml");
    if (doc.querySelector("parsererror")) throw new FetchError("error", "unparseable feed");
    return doc;
  }

  const decoder = document.createElement("textarea");
  function unescapeEntities(s) {
    if (!s || s.indexOf("&") === -1) return s;
    decoder.innerHTML = s;
    return decoder.value;
  }

  function clean(value) {
    if (!value) return "";
    return unescapeEntities(String(value).replace(TAGS, " ")).replace(WS, " ").trim();
  }

  function firstText(el, names) {
    for (const [ns, name] of names) {
      const found = ns ? el.getElementsByTagNameNS(ns, name) : el.getElementsByTagName(name);
      for (const node of found) {
        if (node.parentNode !== el) continue;
        if ((node.textContent || "").trim()) return node.textContent;
      }
    }
    return "";
  }

  /** Epoch seconds from an RFC 822 or ISO 8601 timestamp, or null. */
  function parseTime(value) {
    if (!value) return null;
    const v = String(value).trim();
    let t = Date.parse(v);
    if (!isNaN(t)) return t / 1000;
    const iso = v.replace("Z", "+00:00");
    for (const candidate of [iso, iso.slice(0, 19), iso.slice(0, 10)]) {
      t = Date.parse(candidate);
      if (!isNaN(t)) return t / 1000;
    }
    return null;
  }

  /** Item objects from RSS 2.0, RSS 1.0/RDF or Atom. */
  function extractItems(doc) {
    const items = [];
    let nodes = [...doc.getElementsByTagName("item")];
    if (!nodes.length) nodes = [...doc.getElementsByTagNameNS(NS_RSS1, "item")];

    for (const el of nodes) {
      const link = firstText(el, [[null, "link"], [NS_RSS1, "link"]]) ||
                   firstText(el, [[null, "guid"]]);
      items.push({
        title: clean(firstText(el, [[null, "title"], [NS_RSS1, "title"]])),
        url: clean(link),
        summary: clean(firstText(el, [
          [null, "description"], [NS_RSS1, "description"], [NS_CONTENT, "encoded"],
        ])),
        published: clean(firstText(el, [[null, "pubDate"], [NS_DC, "date"], [null, "date"]])),
      });
    }

    if (!items.length) {
      for (const el of doc.getElementsByTagNameNS(NS_ATOM, "entry")) {
        let href = "";
        for (const linkEl of el.getElementsByTagNameNS(NS_ATOM, "link")) {
          if (linkEl.parentNode !== el) continue;
          const rel = linkEl.getAttribute("rel") || "alternate";
          if (rel === "alternate" && linkEl.getAttribute("href")) {
            href = linkEl.getAttribute("href");
            break;
          }
          if (!href) href = linkEl.getAttribute("href") || "";
        }
        items.push({
          title: clean(firstText(el, [[NS_ATOM, "title"]])),
          url: clean(href || firstText(el, [[NS_ATOM, "id"]])),
          summary: clean(firstText(el, [[NS_ATOM, "summary"], [NS_ATOM, "content"]])),
          published: clean(firstText(el, [[NS_ATOM, "published"], [NS_ATOM, "updated"]])),
        });
      }
    }

    const out = [];
    const seen = new Set();
    for (const it of items) {
      if (!it.url || !it.title) continue;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      it.summary = it.summary.slice(0, 1200);
      out.push(it);
    }
    return out.slice(0, 80);
  }

  // ------------------------------------------------------------------
  // Scoring, clustering, topics
  // ------------------------------------------------------------------
  function keepItem(category, item) {
    // releases.atom for large repos also lists internal CI tags.
    if (category === "GITHUB") {
      const head = item.title.split("/", 1)[0].trim().toLowerCase();
      if (CI_TAG_PREFIXES.has(head)) return false;
    }
    return true;
  }

  function tokensOf(title) {
    const out = new Set();
    for (const w of String(title).toLowerCase().match(WORD) || []) {
      if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
    }
    return out;
  }

  function baseScore(title, summary, category) {
    const blob = (title + " " + summary).toLowerCase();
    let hits = 0;
    for (const k of KEYWORDS) if (blob.includes(k)) hits++;
    return hits + (DISCOVERY[category] || 0);
  }

  /** Tokens used to decide whether two stories are the same story. */
  function mergeTokens(title) {
    const out = new Set();
    for (const t of tokensOf(title)) {
      if (!MERGE_MONTHS.has(t) && !MERGE_DATE.test(t)) out.add(t);
    }
    return out;
  }

  function signature(title) {
    return [...tokensOf(title)].sort().slice(0, 12).join(" ");
  }

  class UnionFind {
    constructor() { this.parent = new Map(); }
    find(x) {
      if (!this.parent.has(x)) this.parent.set(x, x);
      while (this.parent.get(x) !== x) {
        this.parent.set(x, this.parent.get(this.parent.get(x)));
        x = this.parent.get(x);
      }
      return x;
    }
    union(a, b) {
      const ra = this.find(a), rb = this.find(b);
      if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
    }
  }

  /** Group near-duplicate stories across sources into clusters. */
  async function recluster(windowDays = 10, cap = 6000) {
    const cutoff = now() - windowDays * 86400;
    const rows = [];
    let t = await tx(["stories"], "readonly");
    await scan(t.objectStore("stories"), "ts", "prev", (r) => {
      if (r.ts <= cutoff || rows.length >= cap) return false;
      rows.push({ id: r.id, title: r.title, ts: r.ts });
      return true;
    });
    await done(t).catch(() => {});

    const toks = new Map();
    const when = new Map();
    const index = new Map();
    for (const r of rows) {
      const tk = mergeTokens(r.title);
      toks.set(r.id, tk);
      when.set(r.id, r.ts || 0);
      // Blocking key: only stories sharing a token are ever compared, which
      // keeps this near-linear. Eight is a cap, not a selection.
      for (const tok of [...tk].sort().slice(0, 8)) {
        if (!index.has(tok)) index.set(tok, []);
        index.get(tok).push(r.id);
      }
    }

    const uf = new UnionFind();
    for (const r of rows) uf.find(r.id);

    const checked = new Set();
    for (const bucket of index.values()) {
      if (bucket.length > 60) continue; // a token this common carries no signal
      for (let i = 0; i < bucket.length; i++) {
        const a = bucket[i];
        const ta = toks.get(a);
        if (ta.size < 3) continue;
        for (let j = i + 1; j < bucket.length; j++) {
          const b = bucket[j];
          const pair = a < b ? a + ":" + b : b + ":" + a;
          if (checked.has(pair)) continue;
          checked.add(pair);
          const tb = toks.get(b);
          if (tb.size < 3) continue;
          let shared = 0;
          for (const x of ta) if (tb.has(x)) shared++;
          if (shared < 3) continue;
          // A recurring column reuses its own wording indefinitely, so a high
          // token overlap across months is a series, not a story.
          if (Math.abs(when.get(a) - when.get(b)) > MERGE_WINDOW_S) continue;
          const union = ta.size + tb.size - shared;
          if (shared / union >= MERGE_JACCARD) uf.union(a, b);
        }
      }
    }

    t = await tx(["stories"], "readwrite");
    const store = t.objectStore("stories");
    for (const r of rows) {
      const cid = uf.find(r.id);
      const rec = await wrap(store.get(r.id));
      if (rec && rec.cluster_id !== cid) { rec.cluster_id = cid; store.put(rec); }
    }
    await done(t);
    return rows.length;
  }

  function trendScore(base, corroboration, distinctCategories, ageHours) {
    const recency = Math.exp(-Math.max(ageHours, 0) / 36.0);
    return base + 3.0 * (corroboration - 1) + 1.5 * (distinctCategories - 1) + 8.0 * recency;
  }

  /** Stop one high-volume source owning the whole front page. */
  function diversify(ranked, decay = 0.72) {
    const seen = new Map();
    const adjusted = ranked.map((story) => {
      const n = seen.get(story.source) || 0;
      seen.set(story.source, n + 1);
      return Object.assign({}, story, {
        trend: Math.round(story.trend * Math.pow(decay, n) * 100) / 100,
      });
    });
    adjusted.sort((a, b) => b.trend - a.trend);
    return adjusted;
  }

  // ------------------------------------------------------------------
  // Refresh cycle
  // ------------------------------------------------------------------
  const STATE = {
    last_refresh: null,
    last_duration: 0,
    new_stories: 0,
    updated_stories: 0,
    errors: 0,
    running: false,
    refresh_count: 0,
    started_at: now(),
    content_count: 0,
    mark_count: 0,
  };
  let cycleGate = false;

  /** Feeds to fetch this cycle as [name, url, category, expected_interval]. */
  async function buildJobs() {
    const jobs = [];
    for (const [cat, feeds] of Object.entries(FEEDS)) {
      const sliceSize = ROTATION[cat];
      if (!sliceSize || sliceSize >= feeds.length) {
        for (const [n, u] of feeds) jobs.push([n, u, cat, INTERVAL]);
        continue;
      }
      const offset = (await metaGet("rot:" + cat, 0)) % feeds.length;
      const picked = [];
      for (let i = 0; i < sliceSize; i++) picked.push(feeds[(offset + i) % feeds.length]);
      await metaSet("rot:" + cat, (offset + sliceSize) % feeds.length);
      const cycles = Math.ceil(feeds.length / sliceSize);
      for (const [n, u] of picked) jobs.push([n, u, cat, INTERVAL * cycles]);
    }
    return jobs;
  }

  /**
   * Searchable text, tokenised the way FTS5 would tokenise it.
   *
   * Every run of non-alphanumerics collapses to a single space and the result
   * is space-padded, so a term can be tested for with a plain
   * `includes(" term ")` and land on token boundaries rather than inside
   * another word. Without this, searching "art" matches "start" and
   * "particle", which FTS5 never does.
   */
  function normalize(s) {
    const body = String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return body ? " " + body + " " : " ";
  }

  async function writeFeedStatus(rec) {
    const t = await tx(["feeds"], "readwrite");
    const store = t.objectStore("feeds");
    const prev = (await wrap(store.get(rec.url))) || {
      total_items: 0, fail_streak: 0, last_ok: null,
    };
    store.put(Object.assign({}, prev, rec, {
      total_items: rec.ok ? (prev.total_items || 0) + rec.item_count : prev.total_items || 0,
      fail_streak: rec.ok ? 0 : (prev.fail_streak || 0) + 1,
      last_ok: rec.ok ? rec.last_check : prev.last_ok,
    }));
    await done(t);
  }

  /** Fetch and store one feed. Never throws. */
  async function refreshOne(name, url, category, expectS) {
    const at = now();
    let items, latency;
    try {
      const got = await fetchFeed(url);
      latency = got.latency;
      items = extractItems(parseXML(got.text)).filter((i) => keepItem(category, i));
    } catch (e) {
      const kind = e instanceof FetchError ? e.kind : "error";
      await writeFeedStatus({
        url, name, category, status: kind, last_check: at,
        last_error: String((e && e.message) || e).slice(0, 300),
        item_count: 0, latency_ms: 0, expect_s: expectS, ok: false,
      });
      return { new: 0, updated: 0, status: kind };
    }

    let fresh = 0, updated = 0;
    const t = await tx(["stories", "search"], "readwrite");
    const store = t.objectStore("stories");
    const searchStore = t.objectStore("search");
    const byUrl = store.index("url");
    for (const it of items) {
      const existing = await wrap(byUrl.get(it.url));
      let ts = parseTime(it.published);
      // Newest-first is the default order, so one feed with a clock skew or a
      // scheduled future date would sit permanently at the top.
      if (ts && ts > at + 3600) ts = at;
      const score = baseScore(it.title, it.summary, category);
      const rec = {
        url: it.url,
        title: it.title,
        summary: it.summary,
        source: name,
        category,
        published: it.published,
        published_ts: existing ? (existing.published_ts || ts) : ts,
        first_seen: existing ? existing.first_seen : at,
        last_seen: at,
        base_score: score,
        sig: signature(it.title),
        topics: topicsFor(it.title, it.summary, category),
        cluster_id: existing ? existing.cluster_id : null,
        content_status: existing ? existing.content_status : "pending",
        content_chars: existing ? existing.content_chars || 0 : 0,
        content_ts: existing ? existing.content_ts || null : null,
        content_attempts: existing ? existing.content_attempts || 0 : 0,
      };
      rec.ts = rec.published_ts || rec.first_seen;
      if (existing) { rec.id = existing.id; updated++; } else { fresh++; }
      const id = await wrap(store.put(rec));
      // Most items in a cycle are the same headline seen again. Only rewrite the
      // index when the text it is built from actually changed, and leave the
      // body half of it alone — extraction owns that.
      if (!existing || existing.title !== it.title || existing.summary !== it.summary) {
        const prev = existing ? await wrap(searchStore.get(id)) : null;
        searchStore.put({
          id,
          t: normalize(it.title + " " + (it.summary || "")),
          b: prev ? prev.b : " ",
        });
      }
    }
    // A well-formed feed with zero items is idle, not broken (arXiv at weekends).
    const status = items.length ? "online" : "idle";
    await done(t);
    await writeFeedStatus({
      url, name, category, status, last_check: at, last_error: "",
      item_count: items.length, latency_ms: latency, expect_s: expectS, ok: true,
    });
    return { new: fresh, updated, status };
  }

  async function prune() {
    const cutoff = now() - RETAIN_DAYS * 86400;
    const doomed = [];
    let t = await tx(["stories"], "readonly");
    await scan(t.objectStore("stories"), "ts", "next", (r) => {
      if (r.ts >= cutoff) return false;
      if (r.last_seen < cutoff) doomed.push({ id: r.id, url: r.url });
      return true;
    });
    await done(t).catch(() => {});
    if (doomed.length) {
      t = await tx(["stories", "search", "bodies"], "readwrite");
      for (const d of doomed) {
        t.objectStore("stories").delete(d.id);
        t.objectStore("search").delete(d.id);
        t.objectStore("bodies").delete(d.id);
      }
      await done(t);
    }

    // A read-but-not-saved mark is only useful while its story is still on the
    // page. Saved marks are never pruned — outliving the archive is the point.
    const gone = new Set(doomed.map((d) => d.url));
    t = await tx(["stories", "marks"], "readwrite");
    const stories = t.objectStore("stories").index("url");
    const marks = t.objectStore("marks");
    const kill = [];
    await scan(marks, null, "next", (m) => {
      if (!m.saved && (m.read_ts || 0) < cutoff) kill.push(m.url);
      return true;
    });
    for (const url of kill) {
      if (gone.has(url)) { marks.delete(url); continue; }
      const still = await wrap(stories.getKey(url));
      if (still === undefined) marks.delete(url);
    }
    await done(t);
  }

  async function runCycle() {
    const started = now();
    STATE.running = true;
    let fresh = 0, updated = 0, errors = 0;
    try {
      const jobs = await buildJobs();
      const queue = jobs.slice();
      const worker = async () => {
        for (;;) {
          const job = queue.shift();
          if (!job) return;
          const r = await refreshOne(job[0], job[1], job[2], job[3]);
          fresh += r.new;
          updated += r.updated;
          if (r.status !== "online" && r.status !== "idle") errors++;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CFG.FETCH_WORKERS, queue.length) }, worker)
      );
      await recluster();
      await prune();
    } finally {
      STATE.running = false;
      STATE.last_refresh = now();
      STATE.last_duration = Math.round((now() - started) * 10) / 10;
      STATE.new_stories = fresh;
      STATE.updated_stories = updated;
      STATE.errors = errors;
      STATE.refresh_count++;
      cacheClear();
    }
  }

  /** One full cycle. Serialized; concurrent callers no-op, as v3's gate does. */
  async function refreshAll() {
    if (cycleGate) return false;
    cycleGate = true;
    try { await runCycle(); return true; }
    finally { cycleGate = false; }
  }

  // ------------------------------------------------------------------
  // Article body extraction. The worker reduces the page to text; the phone
  // only ever receives prose. Ports content_batch's retry policy.
  // ------------------------------------------------------------------
  async function contentBatch() {
    if (!CFG.CONTENT_EXTRACT || !CFG.PROXY_BASE) return 0;
    const at = now();
    const queue = [];
    const t = await tx(["stories"], "readonly");
    await scan(t.objectStore("stories"), "ts", "prev", (r) => {
      if (queue.length >= CFG.CONTENT_BATCH) return false;
      const s = r.content_status || "pending";
      if (s === "pending") queue.push({ id: r.id, url: r.url });
      else if (s === "error" && (r.content_attempts || 0) < CFG.RETRY_ERROR_MAX &&
               at - (r.content_ts || 0) > CFG.RETRY_ERROR_AFTER) queue.push({ id: r.id, url: r.url });
      else if (s === "blocked" && (r.content_attempts || 0) < CFG.RETRY_BLOCKED_MAX &&
               at - (r.content_ts || 0) > CFG.RETRY_BLOCKED_AFTER) queue.push({ id: r.id, url: r.url });
      return true;
    });
    await done(t).catch(() => {});
    if (!queue.length) return 0;

    const results = [];
    const pending = queue.slice();
    const worker = async () => {
      for (;;) {
        const job = pending.shift();
        if (!job) return;
        try {
          const res = await fetch(proxied(job.url, "/article"), { cache: "no-store" });
          const j = await res.json();
          results.push({ id: job.id, text: j.text || "", status: j.status || "error" });
        } catch (e) {
          results.push({ id: job.id, text: "", status: "error" });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CFG.CONTENT_WORKERS, pending.length) }, worker)
    );

    const w = await tx(["stories", "search", "bodies"], "readwrite");
    const store = w.objectStore("stories");
    const searchStore = w.objectStore("search");
    for (const r of results) {
      const rec = await wrap(store.get(r.id));
      if (!rec) continue;
      rec.content_status = r.status;
      rec.content_ts = now();
      rec.content_attempts = (rec.content_attempts || 0) + 1;
      rec.content_chars = r.text.length;
      store.put(rec);
      const prev = await wrap(searchStore.get(r.id));
      searchStore.put({
        id: r.id,
        t: prev ? prev.t : normalize(rec.title + " " + (rec.summary || "")),
        b: normalize(r.text),
      });
      if (r.text) w.objectStore("bodies").put({ id: r.id, url: rec.url, text: r.text });
    }
    await done(w);
    STATE.content_count += results.length;
    cacheClear();
    return results.length;
  }

  // ------------------------------------------------------------------
  // Query. Ports query_stories, hydrate, attach_marks, diversify.
  // ------------------------------------------------------------------
  const _cache = new Map();
  const CACHE_MAX = 64;
  const cacheClear = () => _cache.clear();
  function cachePut(key, value) {
    if (_cache.size >= CACHE_MAX) _cache.clear();
    _cache.set(key, value);
  }

  /**
   * Split a search box into terms.
   *
   * v3 hands this to FTS5 as quoted phrases ANDed together with a prefix `*`
   * on the last word. There is no FTS5 here, so the same shape is enforced
   * directly: every term must appear, and the last one may be a prefix, so
   * "quant" still finds quantum while you are typing.
   */
  function searchTerms(query) {
    const raw = (String(query).toLowerCase().match(/[\w'+.-]+/g) || [])
      .map((w) => w.replace(/^['+.-]+|['+.-]+$/g, ""))
      .filter(Boolean);
    // "zero-day" is one word here and a two-token phrase in FTS5. Normalising
    // it to "zero day" and matching that against the normalised blob keeps the
    // same behaviour: it finds "zero-day" and "zero day", not "zeroday".
    const terms = raw.map((w) => normalize(w).trim()).filter(Boolean);
    return { terms, needle: String(query).toLowerCase() };
  }

  /** Does one index row satisfy every term? */
  function indexHit(row, terms) {
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      // The last term is a prefix match, so "quant" still finds quantum while
      // you are typing. Every other term has to match whole.
      const needle = i === terms.length - 1 ? " " + t : " " + t + " ";
      // Title/summary and body are separate columns, as they are in v3's index;
      // a term matching in either is a hit, and a phrase never spans the two.
      if (!row.t.includes(needle) && !row.b.includes(needle)) return false;
    }
    return true;
  }

  /**
   * Story ids matching a query — the equivalent of v3's
   * `id IN (SELECT rowid FROM stories_fts WHERE stories_fts MATCH ?)`.
   */
  async function searchIds(terms) {
    const ids = new Set();
    const t = await tx(["search"], "readonly");
    await scan(t.objectStore("search"), null, "next", (row) => {
      if (indexHit(row, terms)) ids.add(row.id);
      return true;
    });
    await done(t).catch(() => {});
    return ids;
  }

  async function queryStories(opts) {
    const o = Object.assign({
      category: null, query: null, sort: "new", limit: 200, hours: null, offset: 0,
    }, opts || {});
    const key = JSON.stringify([STATE.refresh_count, STATE.mark_count, o]);
    const hit = _cache.get(key);
    if (hit) return hit;

    const at = now();
    const q = o.query ? searchTerms(o.query) : null;
    const catNeedle = o.category ? "|" + o.category + "|" : null;
    const cutoff = o.hours ? at - o.hours * 3600 : null;
    // The index is consulted once per query, not once per candidate.
    const hits = q && q.terms.length ? await searchIds(q.terms) : null;

    async function candidates(useWindow) {
      const rows = [];
      const t = await tx(["stories"], "readonly");
      // The candidate cap has to take candidates from the end being asked for:
      // ordering DESC and reversing would show the oldest of the newest 4000.
      await scan(t.objectStore("stories"), "ts", o.sort === "old" ? "next" : "prev", (r) => {
        if (rows.length >= CANDIDATE_CAP) return false;
        if (useWindow && cutoff && r.ts <= cutoff) {
          // The index is ordered by ts, so descending scans can stop here.
          return o.sort === "old" ? true : false;
        }
        if (catNeedle && r.category !== o.category && !(r.topics || "").includes(catNeedle)) return true;
        // source is a feed label rather than prose, so it is not in the index and
        // keeps the substring match v3's `LOWER(source) LIKE ?` gives it. Either
        // side satisfying the query is the `OR` v3 puts around the FTS clause.
        if (q && !(hits && hits.has(r.id)) && !r.source.toLowerCase().includes(q.needle)) return true;
        rows.push(r);
        return true;
      });
      await done(t).catch(() => {});
      return rows;
    }

    let rows = await candidates(true);
    let widened = false;
    // A search that matches nothing inside `hours` retries against the whole
    // archive; browsing without a query never widens.
    if (!rows.length && q && q.terms.length && cutoff) {
      rows = await candidates(false);
      widened = rows.length > 0;
    }

    const clusters = new Map();
    for (const r of rows) {
      const cid = r.cluster_id === null || r.cluster_id === undefined ? r.id : r.cluster_id;
      if (!clusters.has(cid)) clusters.set(cid, []);
      clusters.get(cid).push(r);
    }

    let out = [];
    for (const [cid, members] of clusters) {
      const sources = new Set(members.map((m) => m.source));
      const cats = new Set(members.map((m) => m.category));
      const topicSet = new Set();
      for (const m of members) {
        for (const t of (m.topics || "").split("|")) if (t) topicSet.add(t);
      }
      members.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      let head = members[0];
      for (const m of members) {
        if ((m.base_score || 0) > (head.base_score || 0) ||
            ((m.base_score || 0) === (head.base_score || 0) && (m.ts || 0) > (head.ts || 0))) head = m;
      }
      const ts = head.ts || at;
      const ageHours = Math.max(0, (at - ts) / 3600);
      const trend = Math.round(
        trendScore(head.base_score || 0, sources.size, cats.size, ageHours) * 100
      ) / 100;
      out.push({
        id: head.id,
        cluster_id: cid,
        url: head.url,
        title: head.title,
        summary: head.summary || "",
        published: head.published || "",
        source: head.source,
        category: head.category,
        published_ts: ts,
        age_hours: Math.round(Math.max(0, (at - ts) / 3600) * 10) / 10,
        corroboration: sources.size,
        categories: [...cats].sort(),
        topics: [...topicSet].sort(),
        trend,
        base: Math.round((head.base_score || 0) * 100) / 100,
        related: members
          .filter((m) => m.id !== head.id)
          .slice(0, MAX_RELATED)
          .map((m) => ({ source: m.source, category: m.category, title: m.title, url: m.url })),
      });
    }

    if (o.sort === "new") out.sort((a, b) => b.published_ts - a.published_ts);
    else if (o.sort === "old") out.sort((a, b) => a.published_ts - b.published_ts);
    else if (o.sort === "corroboration") {
      out.sort((a, b) => (b.corroboration - a.corroboration) || (b.trend - a.trend));
    } else {
      out.sort((a, b) => b.trend - a.trend);
      out = diversify(out);
    }

    const page = await attachMarks(out.slice(o.offset, o.offset + o.limit));
    const result = { items: page, widened, count: page.length };
    cachePut(key, result);
    return result;
  }

  /** Overlay saved/read flags onto a page of stories. */
  async function attachMarks(page) {
    if (!page.length) return page;
    const t = await tx(["marks"], "readonly");
    const store = t.objectStore("marks");
    const out = [];
    for (const s of page) {
      const m = await wrap(store.get(s.url));
      out.push(Object.assign({}, s, { saved: !!(m && m.saved), read: !!(m && m.read) }));
    }
    await done(t).catch(() => {});
    return out;
  }

  /**
   * Set the saved and/or read flag on one or more story URLs.
   *
   * A row that ends up neither saved nor read is deleted rather than kept at
   * zero, so `marks` stays a list of things the reader has actually touched.
   * The mark holds its own copy of the headline: a bookmark has to outlive the
   * archive it points into.
   */
  async function setMarks(urls, saved, read) {
    const list = urls.slice(0, MARK_URLS_MAX);
    const at = now();
    const t = await tx(["stories", "marks"], "readwrite");
    const byUrl = t.objectStore("stories").index("url");
    const marks = t.objectStore("marks");
    let changed = 0;
    for (const url of list) {
      const prev = (await wrap(marks.get(url))) || {
        url, saved: 0, read: 0, saved_ts: 0, read_ts: 0,
        title: "", source: "", category: "", published: "", published_ts: 0,
      };
      const story = await wrap(byUrl.get(url));
      if (story) {
        prev.title = story.title;
        prev.source = story.source;
        prev.category = story.category;
        prev.published = story.published || "";
        prev.published_ts = story.published_ts || story.ts || 0;
      }
      if (saved !== undefined && saved !== null) {
        if (saved && !prev.saved) prev.saved_ts = at;
        prev.saved = saved ? 1 : 0;
      }
      if (read !== undefined && read !== null) {
        if (read && !prev.read) prev.read_ts = at;
        prev.read = read ? 1 : 0;
      }
      if (!prev.saved && !prev.read) marks.delete(url);
      else marks.put(prev);
      changed++;
    }
    await done(t);
    STATE.mark_count++;
    cacheClear();
    return changed;
  }

  /** Every bookmark, newest saved first. */
  async function savedStories(limit = 500) {
    const t = await tx(["stories", "marks"], "readonly");
    const byUrl = t.objectStore("stories").index("url");
    const rows = [];
    await scan(t.objectStore("marks"), "saved_ts", "prev", (m) => {
      if (rows.length >= limit) return false;
      if (m.saved) rows.push(m);
      return true;
    });
    const out = [];
    for (const m of rows) {
      // `in_archive` false means the story has been pruned and this row is all
      // that is left of it, which is what the copied columns exist for.
      const story = await wrap(byUrl.get(m.url));
      out.push({
        url: m.url,
        title: m.title || m.url,
        source: m.source || "",
        category: m.category || "",
        published: m.published || "",
        published_ts: m.published_ts || 0,
        saved_ts: m.saved_ts || 0,
        read: !!m.read,
        summary: story ? (story.summary || "").slice(0, 320) : "",
        topics: story ? (story.topics || "").split("|").filter(Boolean) : [],
        in_archive: !!story,
      });
    }
    await done(t).catch(() => {});
    return { items: out, count: out.length };
  }

  // ------------------------------------------------------------------
  // Health and stats
  // ------------------------------------------------------------------
  async function feedHealth() {
    const t = await tx(["feeds"], "readonly");
    const rows = [];
    await scan(t.objectStore("feeds"), null, "next", (r) => { rows.push(r); return true; });
    await done(t).catch(() => {});

    const at = now();
    const out = rows.map((r) => {
      let status = r.status || "unknown";
      // Rotated feeds are only due every few cycles; judge them on their own clock.
      const staleAfter = (r.expect_s || INTERVAL) * 3;
      if (!["error", "throttled", "blocked"].includes(status) && r.last_ok &&
          at - r.last_ok > staleAfter) {
        status = "delayed";
      }
      return {
        name: r.name, url: r.url, category: r.category, status,
        last_check: r.last_check || null, last_ok: r.last_ok || null,
        error: r.last_error || "", items: r.item_count || 0,
        total_items: r.total_items || 0, latency_ms: r.latency_ms || 0,
        fail_streak: r.fail_streak || 0, expect_s: r.expect_s || INTERVAL,
      };
    });

    // Feeds that have never been reached at all are not yet in the table.
    const known = new Set(out.map((f) => f.url));
    for (const [cat, feeds] of Object.entries(FEEDS)) {
      for (const [name, url] of feeds) {
        if (!known.has(url)) {
          out.push({
            name, url, category: cat, status: "pending", last_check: null,
            last_ok: null, error: "", items: 0, total_items: 0, latency_ms: 0,
            fail_streak: 0, expect_s: INTERVAL,
          });
        }
      }
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return out;
  }

  async function stats() {
    const at = now();
    let total = 0, day = 0, chars = 0;
    const byCat = {};
    const content = {};
    const clusterSources = new Map();
    const t = await tx(["stories", "marks"], "readonly");
    await scan(t.objectStore("stories"), null, "next", (r) => {
      total++;
      if (r.ts > at - 86400) day++;
      byCat[r.category] = (byCat[r.category] || 0) + 1;
      const st = r.content_status || "pending";
      content[st] = (content[st] || 0) + 1;
      chars += r.content_chars || 0;
      const cid = r.cluster_id === null || r.cluster_id === undefined ? r.id : r.cluster_id;
      if (!clusterSources.has(cid)) clusterSources.set(cid, new Set());
      clusterSources.get(cid).add(r.source);
      return true;
    });
    let saved = 0, read = 0;
    await scan(t.objectStore("marks"), null, "next", (m) => {
      if (m.saved) saved++;
      if (m.read) read++;
      return true;
    });
    await done(t).catch(() => {});

    let multi = 0;
    for (const s of clusterSources.values()) if (s.size > 1) multi++;

    const state = Object.assign({}, STATE);
    state.uptime_seconds = Math.round(at - STATE.started_at);
    state.interval_seconds = INTERVAL;
    state.next_refresh_in = STATE.last_refresh
      ? Math.max(0, Math.round(STATE.last_refresh + INTERVAL - at)) : 0;

    return {
      stories: total,
      stories_24h: day,
      clusters: clusterSources.size,
      corroborated_clusters: multi,
      by_category: Object.fromEntries(
        Object.entries(byCat).sort((a, b) => b[1] - a[1])
      ),
      feeds_total: Object.values(FEEDS).reduce((n, v) => n + v.length, 0),
      content: { by_status: content, total_chars: chars },
      marks: { saved, read },
      // v3 answers "fts5" or "like" here. Neither exists in a browser: this is
      // a scan over the `search` store with the same all-terms-must-match rule
      // and the same prefix on the last term.
      search: "index",
      state,
    };
  }

  function opml() {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      "<head><title>News Stack v3</title>",
      "<dateCreated>" + new Date().toUTCString() + "</dateCreated>",
      "</head><body>",
    ];
    const esc = (s) => String(s).replace(/[&<>"]/g,
      (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
    for (const [cat, feeds] of Object.entries(FEEDS)) {
      parts.push('<outline text="' + esc(cat) + '">');
      for (const [name, url] of feeds) {
        parts.push('<outline type="rss" text="' + esc(name) + '" xmlUrl="' + esc(url) + '"/>');
      }
      parts.push("</outline>");
    }
    parts.push("</body></opml>");
    return parts.join("\n");
  }

  /** Everything stored, as one JSON file — the phone's answer to a data dir. */
  async function exportAll() {
    const t = await tx(["stories", "bodies", "marks", "feeds"], "readonly");
    const dump = { version: 3, exported_at: now(), stories: [], marks: [], feeds: [] };
    const bodies = new Map();
    await scan(t.objectStore("bodies"), null, "next", (b) => { bodies.set(b.id, b.text); return true; });
    await scan(t.objectStore("stories"), null, "next", (r) => {
      dump.stories.push(Object.assign({}, r, { content: bodies.get(r.id) || "" }));
      return true;
    });
    await scan(t.objectStore("marks"), null, "next", (m) => { dump.marks.push(m); return true; });
    await scan(t.objectStore("feeds"), null, "next", (f) => { dump.feeds.push(f); return true; });
    await done(t).catch(() => {});
    return dump;
  }

  // ------------------------------------------------------------------
  // The surface app.js talks to. Same payload shapes as v3's endpoints.
  // ------------------------------------------------------------------
  window.NEWSSTACK = {
    stories: (params) => queryStories(params),
    saved: (limit) => savedStories(limit),
    mark: (body) => setMarks(
      body.urls || [body.url], body.saved, body.read
    ).then(() => true).catch(() => false),
    feeds: async () => ({ feeds: await feedHealth(), stats: await stats() }),
    stats,
    refresh: refreshAll,
    contentBatch,
    opml,
    exportAll,
    state: STATE,
    ready: openDB,
    _internal: {
      tokensOf, mergeTokens, signature, baseScore, trendScore, diversify,
      topicsFor, parseTime, extractItems, parseXML, recluster, searchTerms,
    },
  };
})();
