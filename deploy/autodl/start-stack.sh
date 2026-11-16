#!/usr/bin/env bash
set -euo pipefail

CANVAS_ROOT="${CANVAS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export CANVAS_ROOT
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export PATH="/usr/local/bin:/root/miniconda3/bin:$PATH"

COMFY_ROOT="${COMFY_ROOT:-/root/ComfyUI}"
COMFY_PYTHON="${COMFY_PYTHON:-/root/miniconda3/bin/python}"
export DRAW_STUDIO_OPTIMIZER_ALLOWED_MODEL_ROOTS="/.autodl-model/data"
export DRAW_STUDIO_OPTIMIZER_TOKEN_FILE="$CANVAS_ROOT/.optimizer-token"
"$COMFY_PYTHON" "$CANVAS_ROOT/deploy/autodl/ensure-canvas.py"
cd "$COMFY_ROOT"
COMFY_STDCXX_PRELOAD="${COMFY_STDCXX_PRELOAD:-/usr/lib/x86_64-linux-gnu/libstdc++.so.6}"
if [[ -f "$COMFY_STDCXX_PRELOAD" ]]; then
  export LD_PRELOAD="$COMFY_STDCXX_PRELOAD${LD_PRELOAD:+:$LD_PRELOAD}"
fi
exec "$COMFY_PYTHON" main.py --port 6006 --listen 127.0.0.1 --enable-cors-header "*" "$@"
