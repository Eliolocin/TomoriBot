#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="${1:-cu128}"

case "$BACKEND" in
  cu128|cpu|rocm|xpu) ;;
  *)
    echo "Unknown backend '$BACKEND'. Expected one of: cu128, cpu, rocm, xpu." >&2
    exit 1
    ;;
esac

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ and run this script again." >&2
  exit 1
fi

cd "$SCRIPT_DIR"
echo "Installing Irodori-TTS sidecar dependencies with backend '$BACKEND'..."
uv sync --extra "$BACKEND"
echo "Irodori-TTS sidecar installed successfully."
echo "Virtual environment: $SCRIPT_DIR/.venv"
