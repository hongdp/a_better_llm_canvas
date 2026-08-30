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
# Rent an RTX 6000 Pro pod (~$2.09/h), attach a CONTAINER disk of 150 GB (not a
# network volume), ssh in, and run this. Then run measure.py from anywhere
# against the pod's public address. Total spend: about two dollars.
#
#   HF_TOKEN=hf_... CTX=131072 bash validate_pod.sh
set -euo pipefail

REPO="${REPO:-orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF}"
QUANT="${QUANT:-IQ3_XXS}"
MODEL_DIR="${MODEL_DIR:-/workspace/models}"
LLAMA_DIR="${LLAMA_DIR:-/workspace/llama.cpp}"
CTX="${CTX:-131072}"
PORT="${PORT:-8000}"
CUDA_ARCH="${CUDA_ARCH:-120}"   # RTX PRO 6000 is Blackwell = sm_120
LOG="${LOG:-/var/log/vllm.log}" # named for the idle backstop, which watches it

: "${HF_TOKEN:?set HF_TOKEN — the uncensored repo is gated (auto-approved, but a token is required)}"

echo "── 1/4 deps ────────────────────────────────────────────────"
apt-get update -qq && apt-get install -y -qq cmake build-essential git curl python3-pip
pip install -q --upgrade "huggingface_hub[cli]"

echo "── 2/4 llama.cpp (CUDA sm_${CUDA_ARCH}) ────────────────────"
# From source, not a release binary: qwen4exp is recent, and a prebuilt CUDA
# package may not carry Blackwell kernels. ~10 minutes on 48 vCPU.
if [ ! -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" \
    -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" -DLLAMA_CURL=OFF
  cmake --build "$LLAMA_DIR/build" --target llama-server -j "$(nproc)"
fi
# Fail loudly here rather than after a 79 GB download.
grep -q "qwen4exp" "$LLAMA_DIR/src/llama-arch.cpp" \
  || { echo "FATAL: this llama.cpp has no qwen4exp support" >&2; exit 1; }

echo "── 3/4 weights (~79 GiB) ───────────────────────────────────"
mkdir -p "$MODEL_DIR"
HF_TOKEN="$HF_TOKEN" hf download "$REPO" \
  --include "*${QUANT}*" --local-dir "$MODEL_DIR"
SHARD1=$(find "$MODEL_DIR" -name "*${QUANT}*00001-of-*.gguf" | head -1)
[ -n "$SHARD1" ] || { echo "FATAL: no ${QUANT} shard found in $MODEL_DIR" >&2; exit 1; }

echo "── 4/4 serve ───────────────────────────────────────────────"
export LD_LIBRARY_PATH="$LLAMA_DIR/build/bin:${LD_LIBRARY_PATH:-}"
# Everything on the GPU: the whole point of renting a 96 GB card is that no
# expert has to live in system RAM, which is what caps the workstation.
nohup "$LLAMA_DIR/build/bin/llama-server" \
  -m "$SHARD1" \
  -ngl 99 \
  -c "$CTX" \
  --parallel 1 \
  -fa on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --host 0.0.0.0 \
  --port "$PORT" \
  --reasoning-format deepseek \
  --reasoning off \
  --alias qwen3.8-flash-next \
  > "$LOG" 2>&1 &
disown

for _ in $(seq 1 200); do
  if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    echo
    echo "READY on port $PORT"
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | sed 's/^/  VRAM: /'
    curl -s "http://127.0.0.1:$PORT/v1/models" \
      | python3 -c "import json,sys; m=json.load(sys.stdin)['data'][0]; print('  n_ctx:', m.get('meta',{}).get('n_ctx'))"
    echo
    echo "Now, from anywhere:  python3 measure.py http://<pod-ip>:<public-port>/v1"
    exit 0
  fi
  sleep 3
done

echo "did not come up in 600s — check $LOG" >&2
tail -20 "$LOG" >&2
exit 1
