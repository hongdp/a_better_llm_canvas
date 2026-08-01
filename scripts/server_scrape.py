"""URL/HTML scraping pipeline and the /api/import-url, /api/import-file endpoints.

Owns the optional `requests`/`beautifulsoup4` dependencies (HAS_SCRAPING_DEPS)
and the HTML → {paragraphs, images} extraction used by the novel-import flow.

Tests that mock network access should patch `server_scrape.http_requests`
(this module reads its own global).
"""

import base64
import ipaddress
import socket
from urllib.parse import urlparse, urljoin
from fastapi import APIRouter, Request, HTTPException

from server_auth import get_authenticated_username

try:
    import requests as http_requests
    from bs4 import BeautifulSoup
    HAS_SCRAPING_DEPS = True
except ImportError:
    HAS_SCRAPING_DEPS = False

router = APIRouter()

# TODO(security): Consider adding rate limiting to prevent abuse of the scraping endpoint.

# SSRF prevention: block private/reserved IPs
def _is_private_ip(hostname: str) -> bool:
    """Check if a hostname resolves to a private or reserved IP address."""
    try:
        resolved = socket.getaddrinfo(hostname, None)
        for family, kind, proto, canonname, sockaddr in resolved:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_reserved or ip.is_loopback or ip.is_link_local:
                return True
        return False
    except (socket.gaierror, ValueError):
        return True  # fail-closed: if we can't resolve, block it

MAX_IMAGES_DOWNLOAD = 100
MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5MB per image
SCRAPE_TIMEOUT = 30  # seconds
SCRAPE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

@router.post("/api/import-url")
async def import_url(request: Request):
    """Scrape a URL and extract text paragraphs and images for novel generation."""
    username = get_authenticated_username(request)

    if not HAS_SCRAPING_DEPS:
        raise HTTPException(
            status_code=503,
            detail="Scraping dependencies (requests, beautifulsoup4) are not installed. "
                   "Run: pip install requests beautifulsoup4"
        )

    try:
        body = await request.json()
        url = body.get("url", "").strip()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")

    # Validate URL protocol (allow only http and https)
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only HTTP and HTTPS URLs are allowed.")

    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid URL: no hostname found.")

    # SSRF prevention: block private/reserved IP ranges
    if _is_private_ip(parsed.hostname):
        raise HTTPException(status_code=403, detail="Access to private/internal network addresses is not allowed.")

    # Fetch the page
    try:
        headers = {"User-Agent": SCRAPE_USER_AGENT}
        resp = http_requests.get(url, headers=headers, timeout=SCRAPE_TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
    except http_requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Request timed out while fetching the URL.")
    except http_requests.exceptions.ConnectionError:
        raise HTTPException(status_code=502, detail="Could not connect to the target URL.")
    except http_requests.exceptions.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"HTTP error from target: {e.response.status_code if e.response else 'unknown'}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch URL: {str(e)}")

    # Detect encoding
    resp.encoding = resp.apparent_encoding or 'utf-8'
    html_content = resp.text

    try:
        data = _parse_html_to_scraped_data(html_content, url)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse scraped content: {str(e)}")

def _resize_and_convert_to_jpeg(image_bytes: bytes) -> bytes:
    """Resize image to a maximum width of 800px and convert to a static single-frame JPEG using ffmpeg."""
    import subprocess
    cmd = [
        '/usr/bin/ffmpeg',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', "scale='min(800,iw)':-1",
        '-vframes', '1',
        '-f', 'image2',
        '-y', 'pipe:1'
    ]
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        out, err = process.communicate(input=image_bytes, timeout=10)
        if len(out) > 0:
            return out
    except Exception as e:
        print(f"[API Server] ffmpeg image conversion failed: {e}")
    return image_bytes

def _parse_html_to_scraped_data(html_content: str, url: str = None) -> dict:
    soup = BeautifulSoup(html_content, "html.parser")

    title_tag = soup.find("title")
    page_title = title_tag.get_text(strip=True) if title_tag else "Untitled"

    for tag in soup.find_all(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        tag.decompose()

    paragraphs = []
    images = []

    body_tag = soup.find("body") or soup

    for element in body_tag.descendants:
        if element.name in ("p", "div", "td", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "span", "article", "section"):
            text = element.get_text(strip=True)
            if text and len(text) > 5:
                if not paragraphs or paragraphs[-1]["text"] != text:
                    paragraphs.append({
                        "index": len(paragraphs),
                        "text": text,
                        "tag": element.name
                    })
        elif element.name == "img":
            attrs_to_check = [
                element.get("ess-data"),
                element.get("file"),
                element.get("data-src"),
                element.get("data-original"),
                element.get("data-lazy-src"),
                element.get("data-original-src"),
                element.get("src")
            ]
            attrs = [a.strip() for a in attrs_to_check if a and a.strip()]

            src = ""
            for attr in attrs:
                if attr.startswith("data:"):
                    lower = attr.lower()
                    if "image/svg+xml" in lower:
                        continue
                    if "image/gif" in lower and len(attr) < 200:
                        continue
                    src = attr
                    break

            if not src:
                for attr in attrs:
                    if attr and not attr.startswith("data:"):
                        src = attr
                        break

            alt = element.get("alt", "")
            if src and len(images) < 500:
                abs_src = urljoin(url, src) if url else src
                abs_parsed = urlparse(abs_src)
                if abs_parsed.scheme in ("http", "https"):
                    images.append({
                        "url": abs_src,
                        "alt": alt or "",
                        "position": len(paragraphs),
                        "base64": None
                    })
                elif abs_src.startswith("data:image/"):
                    is_gif = abs_src.startswith("data:image/gif")
                    limit_bytes = 50 * 1024 * 1024 if is_gif else MAX_IMAGE_SIZE_BYTES
                    if len(abs_src) <= limit_bytes * 1.37:
                        try:
                            parts = abs_src.split(";base64,", 1)
                            if len(parts) == 2:
                                header, b64_data = parts
                                raw_bytes = base64.b64decode(b64_data)
                                if is_gif or len(raw_bytes) > 1 * 1024 * 1024:
                                    converted_bytes = _resize_and_convert_to_jpeg(raw_bytes)
                                    converted_b64 = base64.b64encode(converted_bytes).decode("ascii")
                                    abs_src = f"data:image/jpeg;base64,{converted_b64}"
                        except Exception as e:
                            print(f"[API Server] Failed to convert inline base64 image: {e}")
                        images.append({
                            "alt": alt or "",
                            "position": len(paragraphs),
                            "base64": abs_src
                        })

    from concurrent.futures import ThreadPoolExecutor

    def download_image(img):
        if img.get("base64") is not None:
            return
        try:
            img_resp = http_requests.get(
                img["url"],
                headers={"User-Agent": SCRAPE_USER_AGENT},
                timeout=5,
                stream=True
            )
            img_resp.raise_for_status()

            content_type = img_resp.headers.get("Content-Type", "image/jpeg")
            if not content_type.startswith("image/"):
                parsed_url = urlparse(img.get("url", ""))
                path = parsed_url.path.lower()
                if not any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif")):
                    return
                if path.endswith(".png"):
                    content_type = "image/png"
                elif path.endswith(".webp"):
                    content_type = "image/webp"
                elif path.endswith(".gif"):
                    content_type = "image/gif"
                else:
                    content_type = "image/jpeg"

            is_gif = (content_type == "image/gif")
            limit_bytes = 50 * 1024 * 1024 if is_gif else MAX_IMAGE_SIZE_BYTES

            content = b""
            is_first = True
            is_html = False
            for chunk in img_resp.iter_content(chunk_size=8192):
                if is_first:
                    is_first = False
                    trimmed = chunk.lstrip()
                    if trimmed.startswith(b"<!doctype") or trimmed.startswith(b"<html") or trimmed.startswith(b"<!DOCTYPE") or trimmed.startswith(b"<HTML"):
                        is_html = True
                        break
                content += chunk
                if len(content) > limit_bytes:
                    content = None
                    break

            if is_html:
                print(f"[Import URL] Image {img.get('url')} returned HTML instead of binary image data. Skipping.")
                return

            if content:
                if is_gif or len(content) > 1 * 1024 * 1024:
                    converted_content = _resize_and_convert_to_jpeg(content)
                    b64 = base64.b64encode(converted_content).decode("ascii")
                    img["base64"] = f"data:image/jpeg;base64,{b64}"
                else:
                    b64 = base64.b64encode(content).decode("ascii")
                    img["base64"] = f"data:{content_type};base64,{b64}"
        except Exception as e:
            print(f"[Import URL] Failed to download image {img.get('url')}: {e}")

    downloadable_images = [img for img in images if img.get("base64") is None and img.get("url")]
    successful_images = [img for img in images if img.get("base64") is not None]

    batch_size = 50
    i = 0
    while len(successful_images) < MAX_IMAGES_DOWNLOAD and i < len(downloadable_images):
        batch = downloadable_images[i:i+batch_size]
        i += batch_size

        with ThreadPoolExecutor(max_workers=10) as executor:
            executor.map(download_image, batch)

        for img in batch:
            if img.get("base64"):
                successful_images.append(img)
                if len(successful_images) >= MAX_IMAGES_DOWNLOAD:
                    break

    successful_images.sort(key=lambda x: x["position"])
    successful_images = successful_images[:MAX_IMAGES_DOWNLOAD]

    for index, img in enumerate(successful_images):
        img["index"] = index
        if "url" in img:
            del img["url"]

    return {
        "title": page_title,
        "paragraphs": paragraphs,
        "images": successful_images,
        "totalParagraphs": len(paragraphs),
        "totalImages": len(successful_images)
    }

@router.post("/api/import-file")
async def import_file(request: Request):
    """Parse an uploaded HTML file content to extract text paragraphs and images."""
    username = get_authenticated_username(request)

    if not HAS_SCRAPING_DEPS:
        raise HTTPException(
            status_code=503,
            detail="Scraping dependencies (requests, beautifulsoup4) are not installed."
        )

    try:
        html_bytes = await request.body()
        html_text = html_bytes.decode("utf-8", errors="ignore")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file payload: {str(e)}")

    if not html_text:
        raise HTTPException(status_code=400, detail="HTML content is empty.")

    try:
        data = _parse_html_to_scraped_data(html_text)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse HTML file: {str(e)}")
