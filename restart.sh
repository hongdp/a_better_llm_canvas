#!/usr/bin/env bash
# restart.sh — kill and restart the web_canvas dev server in the background
cd "$(dirname "$0")"

echo "[restart] Stopping existing processes..."
fuser -k 5173/tcp 3000/tcp 2>/dev/null
pkill -9 -f "vite|api_server" 2>/dev/null
sleep 2

echo "[restart] Starting dev server (nohup, detached)..."
nohup npm run dev > dev-server.log 2>&1 &
echo "[restart] PID: $!"

sleep 5
echo "[restart] Log tail:"
tail -15 dev-server.log
