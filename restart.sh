#!/usr/bin/env bash
# restart.sh — restart both web-canvas services via systemd
echo "[restart] Restarting services..."
systemctl --user restart web-canvas-api web-canvas-vite
sleep 4
echo ""
systemctl --user status web-canvas-api web-canvas-vite --no-pager | grep -E "Active|Main PID"
echo ""
echo "URLs:"
echo "  https://192.168.0.110:5173/"
echo "  https://100.124.63.62:5173/"
