import os
import re
import json
import secrets
import hashlib
import argparse
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

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
            httponly=False  # Must be readable by client JS
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
        max_age=7 * 24 * 60 * 60  # 7 days
    )
    
    # Refresh CSRF cookie
    csrf_token = request.cookies.get("csrf_token") or secrets.token_hex(16)
    response.set_cookie(
        key="csrf_token",
        value=csrf_token,
        path="/",
        samesite="lax",
        max_age=365 * 24 * 60 * 60,
        httponly=False
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

if __name__ == "__main__":
    import uvicorn
    print(f"[Storage Server] Listening on http://{args.host}:{args.port}")
    print(f"[Storage Server] Storage directory: {STORAGE_DIR}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
