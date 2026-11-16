#!/usr/bin/env bash
set -euo pipefail
CANVAS_ROOT="${CANVAS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
if [[ -f "${CANVAS_ENV_FILE:-$CANVAS_ROOT/canvas.env}" ]]; then
  set -a
  source "${CANVAS_ENV_FILE:-$CANVAS_ROOT/canvas.env}"
  set +a
fi
export CANVAS_ROOT
export CANVAS_LISTEN="${CANVAS_LISTEN:-127.0.0.1}"
export CANVAS_PORT="${CANVAS_PORT:-6008}"
export CANVAS_BASE_PATH="${CANVAS_BASE_PATH:-/canvas/}"
export CANVAS_DIST="${CANVAS_DIST:-$CANVAS_ROOT/dist}"
export CANVAS_WORKFLOW_LIBRARY="${CANVAS_WORKFLOW_LIBRARY:-$CANVAS_ROOT/workflows/library}"
CANVAS_BUNDLE="${CANVAS_BUNDLE:-$CANVAS_ROOT/server.mjs}"
CANVAS_NODE="${CANVAS_NODE:-node}"
test -f "$CANVAS_BUNDLE" || { echo "Missing canvas server bundle" >&2; exit 1; }
test -f "$CANVAS_DIST/index.html" || { echo "Missing canvas dist/index.html" >&2; exit 1; }
test -d "$CANVAS_WORKFLOW_LIBRARY" || { echo "Missing canvas workflow library" >&2; exit 1; }
cd "$CANVAS_ROOT"
exec "$CANVAS_NODE" "$CANVAS_BUNDLE"
