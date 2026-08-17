# Deploy

Two pieces: the app goes on GitHub Pages, the proxy goes on Cloudflare Workers.
Both free. Fifteen minutes end to end, most of it waiting for Pages.

Do them in this order. The app runs without the worker but every source reports
`blocked`, so there is nothing to look at until step 2 is done.

---

## 1. Put the app on GitHub Pages

Create a repository and push these files to it:

```bash
git init
git add .
git commit -m "News Stack v3 as an installable PWA"
git branch -M main
gh repo create newsstack-v3-pwa --public --source=. --push
```

Then turn Pages on:

```bash
gh api -X POST repos/:owner/newsstack-v3-pwa/pages --field "source[branch]=main" --field "source[path]=/"
```

Or in the browser: **Settings → Pages → Source: Deploy from a branch → main → / (root) → Save.**

Your URL is `https://<your-username>.github.io/newsstack-v3-pwa/`. The first
build takes a minute or two. Open it — the app loads and tells you the proxy is
missing. That is step 2.

HTTPS matters here and Pages gives it to you: a service worker will not register
over plain HTTP, and without one there is no offline launch and no install.

---

## 2. Deploy the proxy

The worker is what makes the sources work. Browsers refuse to read a
cross-origin feed that sends no `Access-Control-Allow-Origin` header, and almost
none of these 70 feeds send one. There is no way to fix that from the browser
side — a proxy is not an optimisation here, it is the only route.

Install wrangler if you have not got it:

```bash
npm install -g wrangler
```

Log in and deploy:

```bash
wrangler login
wrangler deploy
```

`wrangler.toml` is already in this directory, so `deploy` picks up `worker.js`
with no further arguments. It prints a URL like:

```
https://newsstack-v3-proxy.<your-subdomain>.workers.dev
```

Check it:

```bash
curl https://newsstack-v3-proxy.<your-subdomain>.workers.dev/health
```

You want `{"ok":true,"service":"newsstack-v3-proxy","feeds":47}` — the 46 hosts
the 70 feeds live on, plus `old.reddit.com` as a fallback for the one that 403s
unpredictably.

---

## 3. Point the app at the proxy

Edit `config.js`, one line:

```js
PROXY_BASE: "https://newsstack-v3-proxy.<your-subdomain>.workers.dev",
```

No trailing slash. Replace the whole `(location.hostname === "localhost" ...)`
expression with the string — the localhost branch only exists for `dev-proxy.py`.

Commit and push. Pages redeploys in about a minute.

Then lock the worker to your own origin. In `worker.js`:

```js
const ALLOWED_ORIGIN = "https://<your-username>.github.io";
```

and `wrangler deploy` again. Without this, anyone who finds the worker URL can
use it as a feed proxy on your account's quota.

---

## 4. Install it on the phone

Open your Pages URL in **Safari** on the iPhone. Not Chrome, not an in-app
browser — on iOS only Safari can add a real home screen app.

1. Tap the **Share** button (the square with the arrow).
2. Scroll to **Add to Home Screen**.
3. Tap **Add**.

You get a News Stack icon. Opening it launches full screen with no Safari
chrome, its own archive, and its own storage. The first launch fetches all 70
feeds, which takes about ten seconds on a decent connection.

Android and desktop Chrome will offer an install prompt on their own; the same
page handles both.

---

## Checking it worked

Open the **Sources** tab. You want most of the 70 rows `online`, a few `idle`,
and the KPI strip reading something like 58 online / 1 idle.

Expected states that are not faults:

| What you see | Why |
|---|---|
| 9 `pending` on first run | Reddit is polled one subreddit per cycle. All ten arrive within 50 minutes. |
| `idle` on arXiv feeds | The feed answered correctly and published nothing. Normal at weekends. |
| `throttled` on Reddit | 429. Stored stories are still current; it recovers on its own. |
| `blocked` on one or two | The server answered but sent no feed. Bot mitigation at their end. |

If **every** source is `blocked`, `PROXY_BASE` is wrong or the worker is not
deployed. Check `/health` and check for a trailing slash.

If every source is `error`, open the browser console. A CORS message means
`ALLOWED_ORIGIN` in the worker does not match the origin you are loading from.

---

## Running it on a laptop instead

You do not need Cloudflare to try it:

```bash
python dev-proxy.py
```

Then open <http://127.0.0.1:8765>. `dev-proxy.py` serves the app and implements
the same two endpoints the worker does, and `config.js` detects localhost, so
there is nothing to configure. Python standard library only, like `app.py`.

This is for development. A phone on cellular cannot reach your laptop, which is
why `worker.js` exists.

One difference worth knowing: the CISA feed fingerprints TLS rather than
headers, so it 403s from Windows Python and works from Cloudflare. If CISA shows
`blocked` locally and `online` in production, that is this, not a bug — v3 has
the same note about running `app.py` outside Docker.

---

## Updating

Push to `main`. Pages rebuilds, and the service worker is network-first on the
app shell, so the next launch picks up the new files. No cache-busting needed.

Changing `worker.js` needs its own `wrangler deploy`.

## Costs

Nothing, at this size. Pages is free for public repositories. Workers' free
plan is 100,000 requests a day; one refresh cycle is about 61 requests and the
app refreshes every 5 minutes while open, so a heavy day of reading is a few
thousand. Article extraction adds one request per story it has not seen.
