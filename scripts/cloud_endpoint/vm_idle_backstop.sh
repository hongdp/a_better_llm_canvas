#!/usr/bin/env bash
#
# Runs ON THE VM. Halts the machine if the model server has been silent for
# too long.
#
# This duplicates wake_proxy.py's idle timer on purpose. That timer runs on a
# workstation which can crash, lose power, or simply be closed — and an
# abandoned GPU VM bills by the hour whether or not anyone is watching. The
# proxy is the fast path; this is the one that has to be true.
#
# Signal: the model server writes a line to its log for every request, and the
# proxy's health poll counts as traffic. No writes for $IDLE_MINUTES means
# nothing is talking to this machine — including the proxy, which is exactly
# the case this exists for.
#
# Install (as root on the VM):
#   cp vm_idle_backstop.sh /usr/local/bin/
#   cat > /etc/systemd/system/idle-backstop.service <<'EOF'
#   [Unit]
#   Description=Halt when the model server goes quiet
#   [Service]
#   Type=oneshot
#   ExecStart=/usr/local/bin/vm_idle_backstop.sh
#   EOF
#   cat > /etc/systemd/system/idle-backstop.timer <<'EOF'
#   [Unit]
#   Description=Check for idleness every 5 minutes
#   [Timer]
#   OnBootSec=15min
#   OnUnitActiveSec=5min
#   [Install]
#   WantedBy=timers.target
#   EOF
#   systemctl enable --now idle-backstop.timer
#
# OnBootSec=15min matters: a fresh boot has an empty log, and without the delay
# the machine would shut itself down while the model is still loading.
set -euo pipefail

LOG_FILE="${VLLM_LOG:-/var/log/vllm.log}"
IDLE_MINUTES="${IDLE_MINUTES:-25}"

if [ ! -f "$LOG_FILE" ]; then
  logger -t idle-backstop "no log at $LOG_FILE yet; not halting"
  exit 0
fi

last_write=$(stat -c %Y "$LOG_FILE")
idle_seconds=$(( $(date +%s) - last_write ))

if [ "$idle_seconds" -ge $(( IDLE_MINUTES * 60 )) ]; then
  logger -t idle-backstop "silent for ${idle_seconds}s (limit $(( IDLE_MINUTES * 60 ))s) — halting"
  # Halt rather than `gcloud compute instances stop`: no credentials needed,
  # and Compute Engine reports the instance TERMINATED either way, which is
  # what the proxy polls for.
  shutdown -h now
else
  logger -t idle-backstop "active ${idle_seconds}s ago; staying up"
fi
