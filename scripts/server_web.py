"""The agent's view of the internet: an anonymous headless browser
(docs/features/attachments_and_web.md §2).

Configured after the download browser of x_archive_webserver:
- Chromium's own User-Agent — the real major version and platform, without
  the HeadlessChrome marker — so the UA, the client hints and the TLS
  fingerprint agree (x_archive: never dress Chromium as another browser).
  The full Chromium build in its new headless mode (`channel="chromium"`) is
  used: Playwright's default headless shell announces "HeadlessChrome" in
  Sec-CH-UA, which no UA override reaches (measured 2026-10-10 against
  httpbin.org/headers);
- `domcontentloaded` and a short settle rather than network-idle;
- `page.content()` retried while the page is still navigating
  (x_archive shared/playwright_utils.stable_content).

Anonymous: one shared browser, a fresh context per call — no cookies, no
storage, no session, no Referer. WEB_PROXY routes everything through a proxy
(e.g. a local Tor at socks5://127.0.0.1:9050). Every request a page makes is
refused when its host resolves to a private, loopback, link-local or reserved
address: the server sits on a LAN beside its own API.
"""
import asyncio
import ipaddress
import logging
import os
import re
import socket
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

from fastapi import APIRouter, HTTPException, Request

from server_auth import get_authenticated_username

logger = logging.getLogger("web_canvas.web")
router = APIRouter()

WEB_PROXY = os.getenv("WEB_PROXY") or None
NAV_TIMEOUT_MS = 25_000
SETTLE_SECONDS = 1.5
PAGE_CACHE_SECONDS = 600
PAGE_CACHE_ENTRIES = 64
MAX_PAGES_PER_USER = 2
MAX_SEARCH_RESULTS = 10
BLOCKED_RESOURCES = {"image", "media", "font"}
# DuckDuckGo's lite page: the html.duckduckgo.com page, Bing, Brave, Mojeek
# and Startpage all answered the headless browser with a challenge page
# (measured 2026-10-10); this one returned results. A challenge is never
# worked around — the search reports that it was refused.
SEARCH_URL = "https://lite.duckduckgo.com/lite/?q="
_BLOCKS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dt", "dd", "figcaption", "td"]
_DROP = ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe", "button", "select"]


class WebError(Exception):
    """A visit or a search that failed, worded for the model."""


# ── Pure parts ───────────────────────────────────────────────────────────────

def is_blocked_address(ip_text: str) -> bool:
    ip = ipaddress.ip_address(ip_text)
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


def chromium_user_agent(version: str) -> str:
    """Chromium's own UA for this version and this platform (Linux, as its client hints say), without HeadlessChrome."""
    major = (version or "").split(".")[0] or "138"
    return f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"


def readable_paragraphs(html: str) -> Tuple[str, List[str]]:
    """A page's title and readable text as paragraphs: headings marked "#", navigation, scripts and forms dropped."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    title = re.sub(r"\s+", " ", soup.title.get_text()).strip() if soup.title else ""
    for tag in soup(_DROP):
        tag.decompose()
    body = soup.body or soup
    out: List[str] = []
    for el in body.find_all(_BLOCKS):
        if el.find(_BLOCKS):  # a container of other blocks: its children speak for it
            continue
        text = re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()
        if len(text) < 2 or (out and out[-1].lstrip("# ") == text):
            continue
        out.append(f"# {text}" if re.fullmatch(r"h[1-6]", el.name or "") else text)
    if len(out) < 3:
        lines = [re.sub(r"\s+", " ", line).strip() for line in body.get_text("\n").split("\n")]
        out = [line for line in lines if len(line) >= 2]
    return title, out


def _unwrap_redirect(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        return unquote(target) if target else href
    return href


def is_challenge_page(html: str) -> bool:
    """A search engine's bot check instead of results."""
    low = (html or "").lower()
    return "anomaly-modal" in low or "please complete the following challenge" in low or "unusual traffic" in low


def parse_search_results(html: str, limit: int) -> List[Dict[str, str]]:
    """DuckDuckGo results — the lite page's table, or the html page's blocks: title, real URL (redirect unwrapped), snippet. Ads skipped."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    results: List[Dict[str, str]] = []

    def add(link, snippet_text: str) -> bool:
        href = _unwrap_redirect(link.get("href") or "")
        if not href.startswith(("http://", "https://")) or urlparse(href).netloc.endswith("duckduckgo.com"):
            return False
        results.append({"title": re.sub(r"\s+", " ", link.get_text(" ", strip=True)), "url": href,
                        "snippet": re.sub(r"\s+", " ", snippet_text).strip()})
        return len(results) >= limit

    for link in soup.select("a.result-link"):
        row = link.find_parent("tr")
        if row is not None and "result-sponsored" in (row.get("class") or []):
            continue
        snippet = ""
        sibling = row.find_next_sibling("tr") if row is not None else None
        while sibling is not None and not sibling.select_one("a.result-link"):
            cell = sibling.select_one("td.result-snippet")
            if cell is not None:
                snippet = cell.get_text(" ", strip=True)
                break
            sibling = sibling.find_next_sibling("tr")
        if add(link, snippet):
            return results
    for block in soup.select("div.result"):
        if "result--ad" in (block.get("class") or []):
            continue
        link = block.select_one("a.result__a")
        snippet = block.select_one(".result__snippet")
        if link is not None and add(link, snippet.get_text(" ", strip=True) if snippet else ""):
            return results
    return results


# ── The browser ──────────────────────────────────────────────────────────────

class _Browser:
    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self.user_agent: Optional[str] = None
        self._lock = asyncio.Lock()
        self._resolved: Dict[str, bool] = {}

    async def get(self):
        async with self._lock:
            if self._browser is None or not self._browser.is_connected():
                from playwright.async_api import async_playwright
                if self._playwright is None:
                    self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.launch(headless=True, channel="chromium",
                                                                       proxy={"server": WEB_PROXY} if WEB_PROXY else None)
                self.user_agent = chromium_user_agent(self._browser.version)
                logger.info("Web browser started: Chromium %s%s", self._browser.version, f", via {WEB_PROXY}" if WEB_PROXY else "")
            return self._browser

    async def host_blocked(self, host: str) -> bool:
        """Does `host` resolve to an address the agent must not reach? Fail closed; cached per host."""
        if not host:
            return True
        if host in self._resolved:
            return self._resolved[host]
        try:
            infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
            blocked = any(is_blocked_address(info[4][0]) for info in infos)
        except (socket.gaierror, ValueError, OSError):
            blocked = True
        if len(self._resolved) > 2048:
            self._resolved.clear()
        self._resolved[host] = blocked
        return blocked

    async def page_html(self, url: str) -> Tuple[str, str]:
        """Visit `url` in a fresh context; the final URL and the page's HTML."""
        browser = await self.get()
        context = await browser.new_context(user_agent=self.user_agent, locale="en-US", viewport={"width": 1280, "height": 900},
                                            accept_downloads=False, service_workers="block", java_script_enabled=True)
        try:
            async def guard(route):
                req = route.request
                parsed = urlparse(req.url)
                if parsed.scheme in ("data", "blob", "about"):
                    return await route.continue_()
                if parsed.scheme not in ("http", "https") or req.resource_type in BLOCKED_RESOURCES or await self.host_blocked(parsed.hostname or ""):
                    return await route.abort("blockedbyclient")
                await route.continue_()
            await context.route("**/*", guard)
            page = await context.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            except Exception as exc:  # noqa: BLE001 — worded for the model below
                raise WebError(f"the page could not be loaded ({str(exc).splitlines()[0][:200]})")
            await asyncio.sleep(SETTLE_SECONDS)
            return page.url, await _stable_content(page)
        finally:
            await context.close()


async def _stable_content(page, attempts: int = 3, delay: float = 0.3) -> str:
    """page.content(), tolerating a page still mid-navigation (x_archive stable_content)."""
    from playwright.async_api import Error as PlaywrightError
    for attempt in range(attempts):
        try:
            return await page.content()
        except PlaywrightError as exc:
            if "navigating and changing the content" not in str(exc) or attempt == attempts - 1:
                raise
            await asyncio.sleep(delay)
    return ""


_browser = _Browser()
_page_cache: "OrderedDict[str, Tuple[float, Dict[str, Any]]]" = OrderedDict()
_user_slots: Dict[str, asyncio.Semaphore] = {}


def available() -> bool:
    try:
        import bs4  # noqa: F401
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def _slot(username: str) -> asyncio.Semaphore:
    if username not in _user_slots:
        _user_slots[username] = asyncio.Semaphore(MAX_PAGES_PER_USER)
    return _user_slots[username]


async def _check_url(url: str) -> str:
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url if url and "://" not in url else url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise WebError("only http and https addresses can be read")
    if await _browser.host_blocked(parsed.hostname):
        raise WebError(f"{parsed.hostname} is not on the public internet (or could not be resolved)")
    return url


async def web_read(username: str, url: str) -> Dict[str, Any]:
    """A page's title, final URL and readable paragraphs; cached for ten minutes."""
    url = await _check_url(url)
    now = time.monotonic()
    hit = _page_cache.get(url)
    if hit and now - hit[0] < PAGE_CACHE_SECONDS:
        return hit[1]
    async with _slot(username):
        final_url, html = await _browser.page_html(url)
    title, paragraphs = readable_paragraphs(html)
    page = {"url": final_url, "title": title, "paragraphs": paragraphs}
    _page_cache[url] = (now, page)
    _page_cache.move_to_end(url)
    while len(_page_cache) > PAGE_CACHE_ENTRIES:
        _page_cache.popitem(last=False)
    logger.info("Web read %s: %s paragraphs", final_url, len(paragraphs))
    return page


async def web_search(username: str, query: str, max_results: int = 8) -> List[Dict[str, str]]:
    query = (query or "").strip()
    if not query:
        raise WebError("the query was empty")
    async with _slot(username):
        _, html = await _browser.page_html(SEARCH_URL + quote_plus(query))
    if is_challenge_page(html):
        raise WebError("the search engine refused this search with a bot check; try again later, or read a page you know the address of")
    results = parse_search_results(html, max(1, min(MAX_SEARCH_RESULTS, int(max_results or 8))))
    logger.info("Web search %r: %s results", query, len(results))
    return results


# ── Endpoints (tabs; server runs call the functions) ─────────────────────────

@router.get("/api/web/status")
async def status_endpoint(request: Request):
    get_authenticated_username(request)
    return {"available": available(), "proxy": bool(WEB_PROXY)}


@router.post("/api/web/search")
async def search_endpoint(request: Request):
    username = get_authenticated_username(request)
    body = await request.json()
    if not available():
        raise HTTPException(status_code=503, detail="The server has no browser for web access.")
    try:
        return {"results": await web_search(username, str(body.get("query") or ""), int(body.get("max_results") or 8))}
    except WebError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/api/web/read")
async def read_endpoint(request: Request):
    username = get_authenticated_username(request)
    body = await request.json()
    if not available():
        raise HTTPException(status_code=503, detail="The server has no browser for web access.")
    try:
        return {"page": await web_read(username, str(body.get("url") or ""))}
    except WebError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
