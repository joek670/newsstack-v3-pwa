#!/usr/bin/env python3
"""News Stack v3 (PWA) — local stand-in for worker.js.

Serves the app and the same two proxy endpoints the Cloudflare Worker serves,
so you can run and test the whole thing on a laptop without a Cloudflare
account. Python standard library only, like app.py.

    python dev-proxy.py
    # then open http://127.0.0.1:8765 and set PROXY_BASE to
    # "http://127.0.0.1:8765" in config.js

Endpoints:
    GET /fetch?url=...    feed bytes with CORS headers
    GET /article?url=...  {"text":..., "status":..., "chars":...}
    GET /health           {"ok": true}
    everything else       static files from this directory

This is a development convenience. It is not the deployment target: a phone on
cellular cannot reach your laptop, which is the whole reason worker.js exists.
"""
import http.server
import ipaddress
import json
import os
import re
import socket
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.getenv("PORT", "8765"))
ROOT = os.path.dirname(os.path.abspath(__file__))

UA = "Mozilla/5.0 (compatible; NewsStack/3.0; +https://github.com/joek670/newsstack-v3)"
FEED_ACCEPT = ("application/rss+xml, application/atom+xml, application/xml;q=0.9, "
               "text/xml;q=0.9, */*;q=0.5")
HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"

CONTENT_MAX_BYTES = 3_000_000
CONTENT_MAX_CHARS = 20_000
CONTENT_MIN_CHARS = 400
TIMEOUT = 25

NO_CONTENT_HOSTS = {"www.reddit.com", "reddit.com", "old.reddit.com"}
NON_HTML_PATH = re.compile(r"\.(?:pdf|zip|gz|tar|mp3|mp4|m4a|epub|png|jpe?g|gif)$", re.I)

TAGS = re.compile(r"<[^>]*>")
SENTENCE_END = re.compile(r"[.!?\"')\]]\s*$")
JUNK_LINE = re.compile(
    r"sign up for|subscribe to|newsletter|follow us on|all rights reserved|"
    r"share this (?:article|story)|read more at|advertisement|"
    r"©|terms of (?:use|service)|privacy policy|cookie (?:policy|settings)|"
    r"click here|related stories|more from",
    re.I,
)
JUNK_LINE_MAX = 200
ARTICLE_TAG = re.compile(r"<article\b[^>]*>(.*?)</article\s*>", re.I | re.DOTALL)
MAIN_TAG = re.compile(r"<main\b[^>]*>(.*?)</main\s*>", re.I | re.DOTALL)
BODY_TAG = re.compile(r"<body\b[^>]*>(.*)", re.I | re.DOTALL)
LDJSON = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script\s*>',
    re.I | re.DOTALL,
)

SKIP_ELEMENTS = {
    "script", "style", "noscript", "svg", "canvas", "template", "iframe",
    "nav", "header", "footer", "aside", "form", "button", "select", "option",
    "figcaption", "picture", "video", "audio",
}
BLOCK_ELEMENTS = {
    "p", "div", "section", "article", "main", "li", "tr", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "td", "dd", "dt",
}
JUNK_ATTR = re.compile(
    r"(?:^|[\s_-])(?:share|social|newsletter|subscribe|promo|advert|related|"
    r"comment|cookie|banner|breadcrumb|sidebar|menu|nav|paywall|popup|modal)",
    re.I,
)

import html as html_mod
from html.parser import HTMLParser


class _TextExtractor(HTMLParser):
    """Collect visible text, keeping block boundaries as newlines."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip_depth = 0
        self._skip_tag = None

    def handle_starttag(self, tag, attrs):
        if self._skip_depth:
            if tag == self._skip_tag:
                self._skip_depth += 1
            return
        if tag in SKIP_ELEMENTS:
            self._skip_tag = tag
            self._skip_depth = 1
            return
        joined = " ".join(v or "" for k, v in attrs if k in ("class", "id", "role"))
        if joined and JUNK_ATTR.search(joined):
            self._skip_tag = tag
            self._skip_depth = 1
            return
        if tag in BLOCK_ELEMENTS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self._skip_depth:
            if tag == self._skip_tag:
                self._skip_depth -= 1
                if not self._skip_depth:
                    self._skip_tag = None
            return
        if tag in BLOCK_ELEMENTS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip_depth and data.strip():
            self.parts.append(data)

    def text(self):
        return "".join(self.parts)


def public_url(url):
    parts = urllib.parse.urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
    return True


def fetch(url, accept, max_bytes):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read(max_bytes), resp.headers.get("Content-Type", "")


def ldjson_body(doc):
    for blob in LDJSON.findall(doc):
        try:
            data = json.loads(blob.strip())
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                body = node.get("articleBody")
                if isinstance(body, str) and len(body) >= CONTENT_MIN_CHARS:
                    return body
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
    return ""


def densest_region(doc):
    for pattern in (ARTICLE_TAG, MAIN_TAG):
        matches = pattern.findall(doc)
        if matches:
            best = max(matches, key=len)
            if len(TAGS.sub("", best)) >= CONTENT_MIN_CHARS:
                return best
    m = BODY_TAG.search(doc)
    return m.group(1) if m else doc


def readable_lines(text):
    out = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        if len(line) < 60 and not SENTENCE_END.search(line):
            continue
        if len(line) < 25:
            continue
        if len(line) <= JUNK_LINE_MAX and JUNK_LINE.search(line):
            continue
        out.append(line)
    return out


def extract_article(raw, ctype):
    m = re.search(rb'charset=["\']?\s*([A-Za-z0-9_.:-]+)', raw[:4096], re.I)
    enc = (m.group(1).decode("ascii", "replace") if m else None)
    if not enc and "charset=" in ctype:
        enc = ctype.split("charset=")[-1].strip().strip('"\'')
    try:
        doc = raw.decode(enc or "utf-8", "replace")
    except (LookupError, TypeError):
        doc = raw.decode("utf-8", "replace")

    body = ldjson_body(doc)
    if body:
        lines = readable_lines(html_mod.unescape(TAGS.sub(" ", body)).replace("\r", "\n"))
    else:
        parser = _TextExtractor()
        try:
            parser.feed(densest_region(doc))
            parser.close()
        except Exception:
            return ""
        lines = readable_lines(parser.text())

    seen, kept = set(), []
    for line in lines:
        if line in seen:
            continue
        seen.add(line)
        kept.append(line)
    text = "\n\n".join(kept).strip()
    if len(text) > CONTENT_MAX_CHARS:
        cut = text.rfind("\n\n", 0, CONTENT_MAX_CHARS)
        text = text[: cut if cut > CONTENT_MAX_CHARS // 2 else CONTENT_MAX_CHARS]
    return text.strip()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers",
                         "X-Newsstack-Upstream, X-Newsstack-Type")
        super().end_headers()

    def _json(self, code, payload, extra=None):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self._json(200, {"ok": True, "service": "newsstack-dev-proxy"})
        if parsed.path in ("/fetch", "/article"):
            qs = urllib.parse.parse_qs(parsed.query)
            target = (qs.get("url") or [""])[0]
            if not target:
                return self._json(400, {"error": "missing url parameter"})
            if not public_url(target):
                return self._json(403, {"error": "host not allowed"})
            if parsed.path == "/fetch":
                return self._fetch(target)
            return self._article(target)
        return super().do_GET()

    def _fetch(self, target):
        try:
            raw, ctype = fetch(target, FEED_ACCEPT, 16_000_000)
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": "HTTP %d" % e.code, "upstreamStatus": e.code},
                              {"X-Newsstack-Upstream": str(e.code)})
        except Exception as e:
            return self._json(502, {"error": "%s: %s" % (type(e).__name__, e),
                                    "upstreamStatus": 0})
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Newsstack-Upstream", "200")
        self.send_header("X-Newsstack-Type", ctype or "")
        self.end_headers()
        self.wfile.write(raw)

    def _article(self, target):
        host = (urllib.parse.urlparse(target).hostname or "").lower()
        path = urllib.parse.urlparse(target).path or ""
        if host in NO_CONTENT_HOSTS or NON_HTML_PATH.search(path):
            return self._json(200, {"text": "", "status": "skipped", "chars": 0})
        try:
            raw, ctype = fetch(target, HTML_ACCEPT, CONTENT_MAX_BYTES)
        except urllib.error.HTTPError as e:
            status = "blocked" if e.code in (401, 403, 429) else "error"
            return self._json(200, {"text": "", "status": status, "chars": 0})
        except Exception:
            return self._json(200, {"text": "", "status": "error", "chars": 0})
        low = (ctype or "").lower()
        if low and "html" not in low and "xml" not in low:
            return self._json(200, {"text": "", "status": "skipped", "chars": 0})
        text = extract_article(raw, low)
        if len(text) < CONTENT_MIN_CHARS:
            return self._json(200, {"text": "", "status": "empty", "chars": 0})
        return self._json(200, {"text": text, "status": "ok", "chars": len(text)})

    def log_message(self, format, *args):  # noqa: A002 - signature fixed by base class
        sys.stderr.write("%s\n" % (format % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("News Stack v3 dev proxy on http://127.0.0.1:%d" % PORT)
        print("Set PROXY_BASE to \"http://127.0.0.1:%d\" in config.js" % PORT)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
