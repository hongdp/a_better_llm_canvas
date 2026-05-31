import os
import re
import json
import secrets
import hashlib
import argparse
import base64
import ipaddress
import socket
from urllib.parse import urlparse, urljoin
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

try:
    import requests as http_requests
    from bs4 import BeautifulSoup
    HAS_SCRAPING_DEPS = True
except ImportError:
    HAS_SCRAPING_DEPS = False

# Initialize FastAPI app
app = FastAPI(title="Web Canvas Backend API", version="1.0.0")

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Parse command line arguments
parser = argparse.ArgumentParser(description="Web Canvas API Server")
parser.add_argument("--storage-dir", default=os.getenv("VITE_STORAGE_DIR", "storage"), help="Path to storage folder")
parser.add_argument("--host", default="127.0.0.1", help="Host IP to listen on")
parser.add_argument("--port", type=int, default=3000, help="Port to listen on")
args, unknown = parser.parse_known_args()

STORAGE_DIR = os.path.abspath(args.storage_dir)
if not os.path.exists(STORAGE_DIR):
    os.makedirs(STORAGE_DIR, exist_ok=True)

USERS_FILE = os.path.join(STORAGE_DIR, "users.json")
SESSIONS_FILE = os.path.join(STORAGE_DIR, "sessions.json")

# Helper to read json files safely
def load_json_file(file_path: str) -> dict:
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

# Helper to write json files safely
def save_json_file(file_path: str, data: dict):
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[API Server] Error saving file {file_path}: {e}")

# Validate and secure paths to prevent directory traversal
def get_secure_storage_path(username: str, book_id: str = "default") -> str:
    # Strict alphanumeric checking
    safe_username = re.sub(r"[^a-zA-Z0-9_-]", "", os.path.basename(username))
    if not safe_username:
        raise HTTPException(status_code=400, detail="Invalid username pattern.")
    
    if not book_id or book_id == "default":
        filename = f"state_{safe_username}.json"
    else:
        safe_book_id = re.sub(r"[^a-zA-Z0-9_-]", "", os.path.basename(book_id))
        if not safe_book_id:
            raise HTTPException(status_code=400, detail="Invalid bookId pattern.")
        filename = f"state_{safe_username}_{safe_book_id}.json"
        
    db_path = os.path.abspath(os.path.join(STORAGE_DIR, filename))
    # Enforce directory boundary security check
    if not db_path.startswith(STORAGE_DIR + os.sep) and db_path != STORAGE_DIR:
         raise HTTPException(status_code=403, detail="Access denied: Directory traversal detected.")
         
    return db_path

# Custom CSRF validation middleware
@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    # Only validate state-changing POST requests
    if request.method == "POST":
        # Bypass CSRF validation for registering/logging in if they don't have sessions,
        # but in our frontend, we send CSRF tokens for all POST requests.
        csrf_header = request.headers.get("x-csrf-token")
        csrf_cookie = request.cookies.get("csrf_token")
        if not csrf_cookie or csrf_header != csrf_cookie:
            return JSONResponse(
                status_code=403,
                content={"error": "CSRF token mismatch or missing."}
            )
            
    return await call_next(request)

# Validate active sessions
def get_authenticated_username(request: Request) -> str:
    session_id = request.cookies.get("web_canvas_session")
    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required.")
        
    sessions = load_json_file(SESSIONS_FILE)
    session = sessions.get(session_id)
    if not session or "username" not in session or "expiresAt" not in session:
        raise HTTPException(status_code=401, detail="Authentication required.")
        
    try:
        expires_at = datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires_at:
            raise HTTPException(status_code=401, detail="Session expired.")
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication required.")
        
    return session["username"]

# 1. Session GET endpoint
@app.get("/api/auth/session")
async def get_session(request: Request, response: Response):
    # CSRF token check / generation
    csrf_token = request.cookies.get("csrf_token")
    if not csrf_token:
        csrf_token = secrets.token_hex(16)
        response.set_cookie(
            key="csrf_token",
            value=csrf_token,
            path="/",
            samesite="lax",
            max_age=365 * 24 * 60 * 60,
            httponly=False,  # Must be readable by client JS
            secure=True
        )
        
    session_id = request.cookies.get("web_canvas_session")
    sessions = load_json_file(SESSIONS_FILE)
    session = sessions.get(session_id) if session_id else None
    
    if session and "username" in session and "expiresAt" in session:
        try:
            expires_at = datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00"))
            if datetime.now(timezone.utc) <= expires_at:
                return {"loggedIn": True, "username": session["username"], "csrfToken": csrf_token}
        except Exception:
            pass
            
    return {"loggedIn": False, "csrfToken": csrf_token}

# 2. Register endpoint
@app.post("/api/auth/register")
async def register_user(request: Request):
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
        
    if not username or not re.match(r"^[a-zA-Z0-9_-]{3,30}$", username):
        raise HTTPException(status_code=400, detail="Username must be alphanumeric, between 3 and 30 characters.")
        
    if not password or len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long.")
        
    users = load_json_file(USERS_FILE)
    if username in users:
        raise HTTPException(status_code=400, detail="Username is already taken.")
        
    # Generate unique salt and derive scrypt hash compatible with Node's crypto.scryptSync
    salt_bytes = secrets.token_bytes(16)
    salt_hex = salt_bytes.hex()
    
    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_bytes,
        n=16384,
        r=8,
        p=1,
        dklen=64
    )
    hash_hex = dk.hex()
    
    users[username] = {
        "username": username,
        "salt": salt_hex,
        "hash": hash_hex
    }
    save_json_file(USERS_FILE, users)
    
    return {"success": True}

# 3. Login endpoint
@app.post("/api/auth/login")
async def login_user(request: Request, response: Response):
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request.")
        
    users = load_json_file(USERS_FILE)
    user = users.get(username)
    if not user or "salt" not in user or "hash" not in user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
        
    salt_bytes = bytes.fromhex(user["salt"])
    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_bytes,
        n=16384,
        r=8,
        p=1,
        dklen=64
    )
    check_hash_hex = dk.hex()
    
    if check_hash_hex != user["hash"]:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
        
    # Create new session ID
    session_id = secrets.token_hex(32)
    sessions = load_json_file(SESSIONS_FILE)
    
    # Invalidate all other active sessions globally (Single-session policy)
    sessions = {k: v for k, v in sessions.items() if v.get("username") != username}
    
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    sessions[session_id] = {
        "username": username,
        "expiresAt": expires_at.isoformat().replace("+00:00", "Z")
    }
    save_json_file(SESSIONS_FILE, sessions)
    
    # Session cookie configuration
    response.set_cookie(
        key="web_canvas_session",
        value=session_id,
        httponly=True,
        path="/",
        samesite="lax",
        max_age=7 * 24 * 60 * 60,  # 7 days
        secure=True
    )
    
    # Refresh CSRF cookie
    csrf_token = request.cookies.get("csrf_token") or secrets.token_hex(16)
    response.set_cookie(
        key="csrf_token",
        value=csrf_token,
        path="/",
        samesite="lax",
        max_age=365 * 24 * 60 * 60,
        httponly=False,
        secure=True
    )
    
    return {"success": True, "username": username, "csrfToken": csrf_token}

# 4. Logout endpoint
@app.post("/api/auth/logout")
async def logout_user(request: Request, response: Response):
    session_id = request.cookies.get("web_canvas_session")
    if session_id:
        sessions = load_json_file(SESSIONS_FILE)
        if session_id in sessions:
            del sessions[session_id]
            save_json_file(SESSIONS_FILE, sessions)
            
    response.delete_cookie(key="web_canvas_session", path="/")
    return {"success": True}

# 5. User-Isolated Storage Endpoint
@app.get("/api/storage")
async def get_storage(request: Request, bookId: str = "default"):
    username = get_authenticated_username(request)
    file_path = get_secure_storage_path(username, bookId)
    
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

@app.post("/api/storage")
async def save_storage(request: Request, bookId: str = "default"):
    username = get_authenticated_username(request)
    file_path = get_secure_storage_path(username, bookId)
    
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")
        
    save_json_file(file_path, body)
    return {"success": True}

# 6. List books endpoint
@app.get("/api/books")
async def list_books(request: Request):
    username = get_authenticated_username(request)
    safe_username = re.sub(r"[^a-zA-Z0-9_-]", "", os.path.basename(username))
    
    books = []
    try:
        files = os.listdir(STORAGE_DIR)
        
        # A. Check legacy/default book state file
        default_file = f"state_{safe_username}.json"
        default_path = os.path.join(STORAGE_DIR, default_file)
        if os.path.exists(default_path):
            try:
                content = load_json_file(default_path)
                mtime = os.path.getmtime(default_path)
                updated_at = content.get("updatedAt", datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"))
                books.append({
                    "id": "default",
                    "title": content.get("bookTitle", "Untitled Book"),
                    "updatedAt": updated_at
                })
            except Exception:
                pass
                
        # B. Check other books matching state_${username}_*.json pattern
        prefix = f"state_{safe_username}_"
        for file in files:
            if file.startswith(prefix) and file.endswith(".json"):
                book_id = file[len(prefix):-5]
                file_path = os.path.join(STORAGE_DIR, file)
                try:
                    content = load_json_file(file_path)
                    mtime = os.path.getmtime(file_path)
                    updated_at = content.get("updatedAt", datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"))
                    books.append({
                        "id": book_id,
                        "title": content.get("bookTitle", "Untitled Book"),
                        "updatedAt": updated_at
                    })
                except Exception:
                    pass
                    
        # Sort desc by updatedAt
        books.sort(key=lambda x: x["updatedAt"], reverse=True)
    except Exception as e:
        print(f"[API Server] Error listing books: {e}")
        
    return books

# 7. Delete book endpoint
@app.post("/api/books/delete")
async def delete_book(request: Request):
    username = get_authenticated_username(request)
    try:
        body = await request.json()
        book_id = body.get("bookId")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid payload.")
        
    if not book_id:
        raise HTTPException(status_code=400, detail="Missing bookId.")
        
    file_path = get_secure_storage_path(username, book_id)
    if os.path.exists(file_path):
        try:
            os.remove(file_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")
            
    return {"success": True}

# ============================================================
# 8. URL Import / Scraping endpoint
# ============================================================

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

@app.post("/api/import-url")
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
                src = (
                    element.get("file") or 
                    element.get("data-src") or 
                    element.get("data-original") or 
                    element.get("data-lazy-src") or 
                    element.get("data-original-src") or 
                    element.get("src") or 
                    ""
                ).strip()

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
                    if len(abs_src) <= MAX_IMAGE_SIZE_BYTES * 1.37:
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
                timeout=15,
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
                if len(content) > MAX_IMAGE_SIZE_BYTES:
                    content = None
                    break
            
            if is_html:
                print(f"[Import URL] Image {img.get('url')} returned HTML instead of binary image data. Skipping.")
                return
            
            if content:
                b64 = base64.b64encode(content).decode("ascii")
                safe_type = content_type.split(";")[0].strip()
                img["base64"] = f"data:{safe_type};base64,{b64}"
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

@app.post("/api/import-file")
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

if __name__ == "__main__":
    import uvicorn
    print(f"[Storage Server] Listening on http://{args.host}:{args.port}")
    print(f"[Storage Server] Storage directory: {STORAGE_DIR}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")

