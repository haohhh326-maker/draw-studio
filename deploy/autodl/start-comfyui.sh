#!/usr/bin/env bash
set -euo pipefail

# Optional deployment settings; do not bake credentials into the image.
if [[ -f /etc/infinite-canvas.env ]]; then
  set -a
  source /etc/infinite-canvas.env
  set +a
fi
COMFY_ROOT="${COMFY_ROOT:-/root/ComfyUI}"
COMFY_PYTHON="${COMFY_PYTHON:-/root/miniconda3/bin/python}"
COMFY_PORT="${COMFY_PORT:-6006}"
COMFY_LISTEN="${COMFY_LISTEN:-127.0.0.1}"
# '*' accepts different localhost ports and deployed web origins.
# A single exact origin can also be configured; comma-separated origins are not supported by stock ComfyUI.
COMFY_CORS_ORIGIN="${COMFY_CORS_ORIGIN:-*}"
# Host RAM reported by psutil may exceed the AutoDL container's memory limit.
# Avoid retaining outputs/models from every previous workflow by default.
case "${COMFY_CACHE_MODE:-none}" in
  none) cache_args=(--cache-none) ;;
  ram) cache_args=(--cache-ram) ;;
  *) echo "COMFY_CACHE_MODE must be none or ram" >&2; exit 1 ;;
esac
export PATH="$(dirname "$COMFY_PYTHON"):$PATH"
cd "$COMFY_ROOT"
test -f main.py || { echo "Missing ComfyUI main.py" >&2; exit 1; }
exec "$COMFY_PYTHON" main.py --port "$COMFY_PORT" --listen "$COMFY_LISTEN" \
  "${cache_args[@]}" --enable-cors-header "$COMFY_CORS_ORIGIN" "$@"
