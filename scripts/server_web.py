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
import base64
import io
import ipaddress
import logging
import os
import re
import shutil
import socket
import subprocess
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

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
#: web_images: per call, per image on the wire, and the longest side kept (the editor shows ~800 px).
MAX_IMAGES_PER_CALL = 20
MAX_IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_MAX_SIDE = 1200
#: Without a resizer (Pillow or ffmpeg) an image is embedded as it came, up to this size.
MAX_RAW_IMAGE_BYTES = 1_500_000
#: The src attributes a page's images use, lazy-loading forums included.
_IMAGE_SRC_ATTRS = ("src", "data-src", "data-original", "data-lazy-src", "data-lazy", "data-url", "ess-data", "data-echo")
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


def _image_source(el, base_url: str) -> str:
    """An <img>'s address (lazy-loading attributes included), absolute, or '' when it has none worth fetching."""
    for attr in _IMAGE_SRC_ATTRS:
        raw = el.get(attr)
        if isinstance(raw, list):
            raw = raw[0] if raw else ""
        raw = (raw or "").strip()
        if not raw or raw.startswith(("data:", "blob:", "javascript:")):
            continue
        url = urljoin(base_url, raw) if base_url else raw
        if urlparse(url).scheme not in ("http", "https") or urlparse(url).path.lower().endswith(".svg"):
            continue
        return url
    return ""


def _is_tiny(el) -> bool:
    """An icon-sized image by its own attributes (a page's images with no size attributes are kept)."""
    try:
        w, h = int(str(el.get("width") or "").rstrip("px") or 0), int(str(el.get("height") or "").rstrip("px") or 0)
    except ValueError:
        return False
    return (0 < w <= 48) or (0 < h <= 48)


def readable_paragraphs(html: str, base_url: str = "") -> Tuple[str, List[str], List[Dict[str, Any]]]:
    """A page's title, readable text as paragraphs, and its images.

    Headings marked "#"; navigation, scripts and forms dropped. An image is a
    paragraph of its own where it sits — "[image 3]" or "[image 3: alt]" — and
    an entry {n, url, alt} in the image list, which web_images fetches by number.
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    title = re.sub(r"\s+", " ", soup.title.get_text()).strip() if soup.title else ""
    for tag in soup(_DROP):
        tag.decompose()
    body = soup.body or soup
    out: List[str] = []
    images: List[Dict[str, Any]] = []
    seen_urls: Dict[str, int] = {}
    markers = 0
    for el in body.find_all(_BLOCKS + ["img"]):
        if el.name == "img":
            url = _image_source(el, base_url)
            if not url or _is_tiny(el) or url in seen_urls:
                continue
            alt = re.sub(r"\s+", " ", str(el.get("alt") or el.get("title") or "")).strip()[:120]
            images.append({"n": len(images) + 1, "url": url, "alt": alt})
            seen_urls[url] = len(images)
            out.append(f"[image {len(images)}: {alt}]" if alt else f"[image {len(images)}]")
            markers += 1
            continue
        if el.find(_BLOCKS):  # a container of other blocks: its children speak for it
            continue
        text = re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()
        if len(text) < 2 or (out and out[-1].lstrip("# ") == text):
            continue
        out.append(f"# {text}" if re.fullmatch(r"h[1-6]", el.name or "") else text)
    if len(out) - markers < 3:
        lines = [re.sub(r"\s+", " ", line).strip() for line in body.get_text("\n").split("\n")]
        out = [line for line in lines if len(line) >= 2] + [p for p in out if p.startswith("[image ")]
    return title, out, images


def shrink_image(data: bytes, content_type: str, max_side: int = IMAGE_MAX_SIDE) -> Tuple[bytes, str]:
    """An image small enough to live inline in a chapter: at most `max_side` (IMAGE_MAX_SIDE) on its longest side, as JPEG.

    Pillow when installed; else ffmpeg when present; else the bytes as they came,
    under MAX_RAW_IMAGE_BYTES. Returns (bytes, mime type).
    """
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            if getattr(im, "n_frames", 1) > 1:
                im.seek(0)
            im.thumbnail((max_side, max_side))
            if im.mode in ("RGBA", "LA", "P"):
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
                im = flat
            elif im.mode != "RGB":
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85, optimize=True)
            return buf.getvalue(), "image/jpeg"
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001 — not an image Pillow reads; the fallbacks may still
        logger.info("Pillow could not read an image (%s); trying ffmpeg", exc)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        try:
            proc = subprocess.run([ffmpeg, "-loglevel", "error", "-i", "pipe:0", "-vf", f"scale='min({max_side},iw)':-2",
                                   "-vframes", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "-y", "pipe:1"],
                                  input=data, capture_output=True, timeout=20)
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout, "image/jpeg"
        except Exception as exc:  # noqa: BLE001
            logger.info("ffmpeg could not convert an image: %s", exc)
    if len(data) > MAX_RAW_IMAGE_BYTES:
        raise WebError(f"the image is {len(data) // 1024} KB and the server has no image resizer (install Pillow)")
    return data, content_type if content_type.startswith("image/") else "image/jpeg"


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
    title, paragraphs, images = readable_paragraphs(html, final_url)
    page = {"url": final_url, "title": title, "paragraphs": paragraphs, "images": images}
    _page_cache[url] = (now, page)
    _page_cache.move_to_end(url)
    while len(_page_cache) > PAGE_CACHE_ENTRIES:
        _page_cache.popitem(last=False)
    logger.info("Web read %s: %s paragraphs", final_url, len(paragraphs))
    return page


async def _fetch_image(context, url: str, referer: str) -> Tuple[bytes, str]:
    """The bytes of one image through the browser's own request channel (its headers, its proxy; no cookies),
    following at most 5 redirects, each hop checked like a page's requests."""
    for _ in range(6):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or await _browser.host_blocked(parsed.hostname or ""):
            raise WebError("the image's address is not on the public internet")
        resp = await context.request.get(url, headers={"Referer": referer, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"},
                                         max_redirects=0, timeout=NAV_TIMEOUT_MS)
        if resp.status in (301, 302, 303, 307, 308) and resp.headers.get("location"):
            url = urljoin(url, resp.headers["location"])
            continue
        if resp.status >= 400:
            raise WebError(f"the image could not be fetched (HTTP {resp.status})")
        ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        data = await resp.body()
        if len(data) > MAX_IMAGE_BYTES:
            raise WebError(f"the image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        if not ctype.startswith("image/") and data[:4] not in (b"\xff\xd8\xff\xe0", b"\xff\xd8\xff\xe1", b"\x89PNG", b"GIF8", b"RIFF"):
            raise WebError(f"the address did not return an image ({ctype or 'no content type'})")
        return data, ctype
    raise WebError("the image's address redirects too many times")


async def web_images(username: str, url: str, numbers: List[int]) -> List[Dict[str, Any]]:
    """Images of a page by their number in its web_read, fetched and shrunk, as data URLs: one entry per number asked."""
    page = await web_read(username, url)
    by_n = {img["n"]: img for img in page.get("images") or []}
    out: List[Dict[str, Any]] = []
    async with _slot(username):
        browser = await _browser.get()
        context = await browser.new_context(user_agent=_browser.user_agent, locale="en-US", accept_downloads=False)
        try:
            for n in numbers[:MAX_IMAGES_PER_CALL]:
                img = by_n.get(n)
                if img is None:
                    out.append({"n": n, "error": f"the page has no image {n} (it has {len(by_n)})"})
                    continue
                try:
                    data, ctype = await _fetch_image(context, img["url"], page["url"])
                    small, mime = await asyncio.to_thread(shrink_image, data, ctype)
                    out.append({"n": n, "alt": img.get("alt") or "", "dataUrl": f"data:{mime};base64,{base64.b64encode(small).decode()}",
                                "bytes": len(small)})
                except WebError as exc:
                    out.append({"n": n, "error": str(exc)})
                except Exception as exc:  # noqa: BLE001 — a network failure on one image is that image's to report
                    out.append({"n": n, "error": f"the image could not be fetched ({str(exc).splitlines()[0][:120]})"})
        finally:
            await context.close()
    logger.info("Web images %s: %d of %d fetched", page["url"], sum(1 for o in out if "dataUrl" in o), len(out))
    return out


#: The longest side of an image shown to a model (view_images): ~800-1,400 tokens on the vision APIs, against
#: ~2,000 at the chapter size, and the text in a photo stays legible.
VIEW_IMAGE_MAX_SIDE = 1024
_DATA_URL_RE = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,(.+)$", re.I | re.S)


async def view_images(username: str, srcs: List[str]) -> List[Dict[str, Any]]:
    """A chapter's images as the model will see them (wc_agent view_images): one entry per src, a JPEG data URL
    at most VIEW_IMAGE_MAX_SIDE on its longest side, or the reason it could not be shown.

    An image the chapter holds inline (a data URL) is shrunk here; one it links to is fetched through the
    browser's request channel like a page's images — public addresses only, its own origin as the referrer.
    """
    out: List[Optional[Dict[str, Any]]] = [None] * len(srcs)
    remote: List[int] = []
    for i, src in enumerate(srcs):
        m = _DATA_URL_RE.match(src or "")
        if m:
            try:
                small, mime = await asyncio.to_thread(shrink_image, base64.b64decode(m.group(2)), m.group(1).lower(), VIEW_IMAGE_MAX_SIDE)
                out[i] = {"dataUrl": f"data:{mime};base64,{base64.b64encode(small).decode()}", "bytes": len(small)}
            except Exception as exc:  # noqa: BLE001 — a broken inline image is that image's to report
                out[i] = {"error": f"the image could not be read ({str(exc).splitlines()[0][:120] if str(exc) else type(exc).__name__})"}
        elif urlparse(src or "").scheme in ("http", "https"):
            remote.append(i)
        else:
            out[i] = {"error": "the image has no address the server can fetch"}
    if remote:
        if not available():
            for i in remote:
                out[i] = {"error": "the image is on the web and the server has no browser to fetch it"}
        else:
            async with _slot(username):
                browser = await _browser.get()
                context = await browser.new_context(user_agent=_browser.user_agent, locale="en-US", accept_downloads=False)
                try:
                    for i in remote:
                        parsed = urlparse(srcs[i])
                        try:
                            data, ctype = await _fetch_image(context, srcs[i], f"{parsed.scheme}://{parsed.netloc}/")
                            small, mime = await asyncio.to_thread(shrink_image, data, ctype, VIEW_IMAGE_MAX_SIDE)
                            out[i] = {"dataUrl": f"data:{mime};base64,{base64.b64encode(small).decode()}", "bytes": len(small)}
                        except WebError as exc:
                            out[i] = {"error": str(exc)}
                        except Exception as exc:  # noqa: BLE001 — a network failure on one image is that image's to report
                            out[i] = {"error": f"the image could not be fetched ({str(exc).splitlines()[0][:120]})"}
                finally:
                    await context.close()
    logger.info("View images: %d of %d shown", sum(1 for o in out if o and "dataUrl" in o), len(srcs))
    return [o or {"error": "not fetched"} for o in out]


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


@router.post("/api/web/images")
async def images_endpoint(request: Request):
    username = get_authenticated_username(request)
    body = await request.json()
    if not available():
        raise HTTPException(status_code=503, detail="The server has no browser for web access.")
    numbers = [int(n) for n in (body.get("images") or []) if isinstance(n, (int, float)) and not isinstance(n, bool)]
    try:
        return {"images": await web_images(username, str(body.get("url") or ""), numbers)}
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
