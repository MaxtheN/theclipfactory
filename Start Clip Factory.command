#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
if [[ ! -x "$ROOT/.venv/bin/clip-factory" || ! -f "$ROOT/frontend/dist/index.html" ]]; then
  /bin/bash "$ROOT/scripts/setup-mac.sh"
fi
exec "$ROOT/.venv/bin/clip-factory" "$@"
