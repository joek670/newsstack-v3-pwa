# News Stack v3 — installable

News Stack v3, as an app you add to your iPhone home screen from Safari. Same
70 feeds, same cross-source clustering, same trend and corroboration ranking,
same full-text search over article bodies, same saved list and read checklist,
same per-source health board. No server to keep running, no computer to be at
home.

The original is a Python process listening on `localhost:8765`. That is a good
place for it to be, right up to the moment you are not at your desk. This is
the same application with the server removed: the ranking, clustering and topic
rules run in the browser, the archive lives in IndexedDB, and a small Cloudflare
Worker does the two jobs a browser is not allowed to do.

**Setup is in [DEPLOY.md](DEPLOY.md).** It will not work until you deploy the
worker — that is a browser restriction, not a missing feature.

## Install

Open the deployed page in Safari on iOS → **Share** → **Add to Home Screen**.
It launches full screen, keeps its own archive, and opens with no network.
Android and desktop Chrome offer their own install prompt on the same page.

## What is here

| File | Purpose |
|---|---|
| `index.html` | App shell. v3's dashboard markup and CSS, unchanged. |
| `feeds.js` | The 70 feeds, the topic vocabulary, the merge and scoring constants. |
| `engine.js` | v3's data layer: fetch, parse, cluster, rank, search, marks, health. |
| `app.js` | v3's dashboard script, calling `engine.js` where it called `/api/*`. |
| `config.js` | **`PROXY_BASE` goes here.** Also v3's tunables. |
| `worker.js` | Cloudflare Worker: feed proxy and article-text extractor. |
| `wrangler.toml` | Worker config, so `wrangler deploy` needs no arguments. |
| `dev-proxy.py` | Local stand-in for the worker, for running this on a laptop. |
| `sw.js` | Service worker. App shell only. |
| `manifest.webmanifest`, `icon*` | Install metadata and icons. |

## Included

Everything v3's own README lists:

- 70 RSS/Atom feeds across 12 categories
- Cross-source clustering: the same story from BBC and r/worldnews becomes one
  entry with a "5 sources" tag and the other reports folded underneath
- Ranking by `new`, `old`, `trend` or `corroboration`, with source diversity
  applied to trend so Reddit does not take 16 of the top 20
- Content-derived topics, so a SpaceX story from TechCrunch also answers to
  ASTRONOMY, and tapping a topic tag pivots the list to it
- Full-text search over titles, summaries **and** extracted article bodies,
  with the whole-word-plus-trailing-prefix behaviour FTS5 gives v3
- Saved list and read checklist, hide-read, mark-page-read
- Per-source health with v3's exact status vocabulary — `online`, `idle`,
  `throttled`, `blocked`, `delayed`, `error`, `pending` — and real error text
- 30-day retention, with saved bookmarks outliving the archive they point into
- OPML export, plus a JSON export of the whole archive
- No account, no API key, no paid services

## What a phone cannot do

Three things differ from v3, all of them because of where this runs. None is
something you can configure away.

**It refreshes while it is open, not around the clock.** v3 runs a thread every
five minutes forever. iOS gives a home screen web app no guaranteed background
execution, so this refreshes on launch, every five minutes while on screen, and
again when you bring it to the foreground. Come back after a day and the first
few seconds are it catching up; the Sources tab says so rather than showing you
70 broken feeds. Only a native app with background fetch changes this.

**Reading state is per-device.** v3 keeps marks in SQLite on the server, so your
laptop and your phone see one list. Here they are in the phone's IndexedDB.
"Export archive" on the Sources tab is the way to get them off the device. Making
them sync would mean running a server, which is the thing this build removes.

**Feeds and article pages are fetched through the worker.** Not a preference —
a browser cannot read a cross-origin feed that sends no CORS header, and 46 of
these hosts do not send one. The worker also reduces article HTML to text before
it reaches you, which is the difference between downloading a few thousand
characters and a few megabytes per story on cellular.

## Departures from `app.py`

Two, both forced by IndexedDB not being SQLite, and both verified to behave the
same way from the outside:

**Search is a scanned index, not FTS5.** There is no FTS5 in a browser. The
`search` object store holds each story's normalised title, summary and body
text, and a query scans it: every term must match on a token boundary, the last
term may be a prefix so "quant" finds quantum while you type, and a match on the
source name counts on its own. That is what v3's `fts_match` plus its
`LOWER(source) LIKE` produce. `GET /api/stats` reported `fts5` or `like`; this
reports `index`.

**Text lives outside the story record.** IndexedDB cannot select columns, so a
scan that touched article bodies would deserialise them all. Bodies go in their
own stores and the ranking scan reads only the small fields — the same reason v3
ranks on six columns and hydrates the returned page afterwards. Browsing the
whole archive measured 41 ms; searching it, 50 ms.

Everything else is a port rather than a reinterpretation. `MERGE_JACCARD` is
still 0.30 over a 7-day window with dates stripped from the comparison. Blocking
still indexes the first eight tokens and skips buckets over 60. `trend_score` is
still `base + 3(corroboration-1) + 1.5(categories-1) + 8e^(-age/36)`, and
`diversify` still decays by 0.72 per repeat from a source. Reddit is still one
subreddit per cycle. JPL's `<content:encoded<![CDATA[` is still repaired by
rebuilding the element. The topic and scoring functions were diffed against
`app.py`'s own output over a sample of headlines and agree on every field.

## Verified

Against a live archive of 1,535 stories from 70 feeds:

- 58 online, 1 idle, 2 blocked, 0 failing; the 9 pending are Reddit's rotation
- 11 corroborated clusters, the largest being six sources on one solar eclipse
- Article extraction: 34 bodies, 182 KB, and a word 8,968 characters into a
  19,949-character body is findable by search
- Search semantics: `black hol` matches (prefix on the last term), `hol black`
  does not (a non-final term must match whole) — FTS5's rule
- Marks: saving, reading, bulk mark, unsave-keeps-read, and a mark that ends up
  neither saved nor read is deleted rather than kept at zero
- The three XML repairs, against fixtures: broken CDATA element, bare
  ampersand plus control characters, truncated CDATA
- No horizontal overflow at 375 px

The one thing not verified end to end is the Cloudflare Worker itself, which
needs your account to deploy. Its feed and article logic was exercised through
`dev-proxy.py`, which implements the same two endpoints against the same rules.

## Credits

A port of [newsstack-v3](https://github.com/joek670/newsstack-v3). The comments
explaining why a threshold is the number it is were kept from the original,
because they are the reason not to change it later.
