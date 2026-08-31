#!/usr/bin/env bash
#
# One-hour validation. Run this ON a freshly rented RunPod pod, BEFORE
# committing to a network volume — the volume is the only part of this that
# bills every month ($0.07/GB, charged even while the pod is stopped), so it
# should not be created until the two open questions are answered:
#
#   1. Does 80 GB of weights leave enough of a 96 GB card for a useful context?
#      Locally this model runs at 262144 tokens with the experts in system RAM.
#      On one card the KV cache and the weights share the same 96 GB.
#   2. Is prefill actually faster than the workstation's? That is the real
#      complaint — 42s to first token — and nobody has measured this pairing.
#
# Rent an RTX 6000 Pro pod (~$2.09/h), attach a CONTAINER disk of 200 GB (not a
# network volume), ssh in, and run this. Then run measure.py from anywhere
# against the pod's public address. Total spend: about two dollars.
#
#   HF_TOKEN=hf_... bash validate_pod.sh
#
# The download and the CUDA build run CONCURRENTLY. They are the two slow
# steps (~15 min each) and neither needs the other, so serialising them would
# double the part of the bill that buys nothing.
set -euo pipefail

REPO="${REPO:-orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF}"
QUANT="${QUANT:-IQ3_XXS}"
MODEL_DIR="${MODEL_DIR:-/workspace/models}"
LLAMA_DIR="${LLAMA_DIR:-/workspace/llama.cpp}"
PORT="${PORT:-8000}"
CUDA_ARCH="${CUDA_ARCH:-120}"   # RTX PRO 6000 is Blackwell = sm_120
LOG="${LOG:-/var/log/vllm.log}" # named for the idle backstop, which watches it
WORK="${WORK:-/workspace/validate}"

# Question 1 is answered by walking this ladder from the top and keeping the
# first rung that survives a load. 262144 is what the workstation gives us with
# the experts in system RAM; anything at or above 131072 keeps a chapter plus
# its reference chapters in context.
CTX_LADDER="${CTX_LADDER:-262144 196608 131072 98304 65536 32768}"

: "${HF_TOKEN:?set HF_TOKEN — the uncensored repo is gated (auto-approved, but a token is required)}"

mkdir -p "$WORK"
# Ubuntu 24.04 marks its Python externally-managed, so a bare pip install fails.
pip_install() { pip install -q --break-system-packages "$@" 2>/dev/null || pip install -q "$@"; }

echo "── 1/5 deps ────────────────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq cmake build-essential git curl python3-pip

# runpod/pytorch SHIPS the CUDA toolkit but does not put it on PATH — `which
# nvcc` comes back empty on a box that has /usr/local/cuda-12.8/bin/nvcc. Find
# it before concluding a toolkit install is needed (that is a 3 GB detour).
if ! command -v nvcc >/dev/null 2>&1; then
  for d in /usr/local/cuda/bin /usr/local/cuda-*/bin; do
    [ -x "$d/nvcc" ] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v nvcc >/dev/null 2>&1 \
  || { echo "FATAL: no nvcc anywhere — this image cannot build llama.cpp" >&2; exit 1; }
echo "   nvcc: $(nvcc --version | tail -2 | head -1)"

# hf_transfer is a Rust multi-connection downloader. NOTE: huggingface_hub 1.x
# dropped the [cli] extra — asking for it prints a warning and installs nothing.
pip_install --upgrade huggingface_hub hf_transfer

echo "── 2/5 weights (~79 GiB, in the background) ────────────────"
mkdir -p "$MODEL_DIR"
(
  export HF_HUB_ENABLE_HF_TRANSFER=1
  HF_TOKEN="$HF_TOKEN" hf download "$REPO" --include "*${QUANT}*" --local-dir "$MODEL_DIR"
) > "$WORK/download.log" 2>&1 &
DOWNLOAD_PID=$!
echo "   pid $DOWNLOAD_PID → $WORK/download.log"

echo "── 3/5 llama.cpp (CUDA sm_${CUDA_ARCH}), concurrently ──────"
# From source, not a release binary: qwen4exp is recent, and a prebuilt CUDA
# package may not carry Blackwell kernels. ~15 minutes.
if [ ! -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  [ -d "$LLAMA_DIR/.git" ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
  # Fail before the build, not after the download: an arch this new may simply
  # not be in the tree we just cloned.
  grep -q "qwen4exp" "$LLAMA_DIR/src/llama-arch.cpp" \
    || { echo "FATAL: this llama.cpp has no qwen4exp support" >&2; kill $DOWNLOAD_PID 2>/dev/null; exit 1; }
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" \
    -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" -DLLAMA_CURL=OFF > "$WORK/cmake.log" 2>&1
  cmake --build "$LLAMA_DIR/build" --target llama-server -j "$(nproc)" >> "$WORK/cmake.log" 2>&1 \
    || { echo "FATAL: build failed — tail of $WORK/cmake.log:" >&2; tail -30 "$WORK/cmake.log" >&2; exit 1; }
fi
echo "   built: $($LLAMA_DIR/build/bin/llama-server --version 2>&1 | head -1)"

echo "── 4/5 waiting for the download ────────────────────────────"
wait "$DOWNLOAD_PID" || { echo "FATAL: download failed" >&2; tail -20 "$WORK/download.log" >&2; exit 1; }
SHARD1=$(find "$MODEL_DIR" -name "*${QUANT}*00001-of-*.gguf" | head -1)
[ -n "$SHARD1" ] || { echo "FATAL: no ${QUANT} shard found in $MODEL_DIR" >&2; ls -la "$MODEL_DIR" >&2; exit 1; }
du -sh "$MODEL_DIR" | sed 's/^/   /'

echo "── 5/5 serve — largest context that survives a load ────────"
export LD_LIBRARY_PATH="$LLAMA_DIR/build/bin:${LD_LIBRARY_PATH:-}"

serve_at() {
  local ctx="$1" attempt_log="$WORK/serve-${1}.log"
  # Everything on the GPU: the whole point of renting a 96 GB card is that no
  # expert has to live in system RAM, which is what caps the workstation.
  nohup "$LLAMA_DIR/build/bin/llama-server" \
    -m "$SHARD1" \
    -ngl 99 \
    -c "$ctx" \
    --parallel 1 \
    -fa on \
    --cache-type-k q8_0 \
    --cache-type-v q8_0 \
    --host 0.0.0.0 \
    --port "$PORT" \
    --reasoning-format deepseek \
    --reasoning off \
    --alias qwen3.8-flash-next \
    > "$attempt_log" 2>&1 &
  local pid=$!
  disown
  for _ in $(seq 1 200); do
    if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
      echo "$pid"; return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1   # died — almost always the KV alloc
    sleep 3
  done
  kill "$pid" 2>/dev/null; return 1
}

# A rung that timed out leaves a process still holding VRAM, and the next rung
# would then fail for the wrong reason and understate the answer.
settle() {
  pkill -f "llama-server .*--port $PORT" 2>/dev/null || true
  for _ in $(seq 1 30); do
    pgrep -f "llama-server .*--port $PORT" >/dev/null || break
    sleep 1
  done
  sleep 2
}

SERVED_CTX=""
for ctx in $CTX_LADDER; do
  echo "   trying -c $ctx ..."
  if PID=$(serve_at "$ctx"); then
    SERVED_CTX="$ctx"
    break
  fi
  echo "     failed — $(grep -iEm1 'out of memory|failed to allocate|error' "$WORK/serve-${ctx}.log" || echo 'see log')"
  settle
done

[ -n "$SERVED_CTX" ] || { echo "FATAL: would not load at any context in the ladder" >&2; exit 1; }
cp "$WORK/serve-${SERVED_CTX}.log" "$LOG" 2>/dev/null || true

echo
echo "READY on port $PORT at -c $SERVED_CTX"
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | sed 's/^/  VRAM: /'
grep -iE 'KV self size|kv_cache|load_tensors:.*buffer size|n_ctx *=' "$WORK/serve-${SERVED_CTX}.log" \
  | head -12 | sed 's/^/  /'
curl -s "http://127.0.0.1:$PORT/v1/models" \
  | python3 -c "import json,sys; m=json.load(sys.stdin)['data'][0]; print('  n_ctx served:', m.get('meta',{}).get('n_ctx'))"
echo
echo "Now, from anywhere:  python3 measure.py http://<pod-ip>:<public-port>/v1"
