#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"
MODEL_ID="${VOXCPM2_MODEL_ID:-openbmb/VoxCPM2}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "$PYTHON_BIN is required (Python 3.10-3.12)." >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import sys
if not ((3, 10) <= sys.version_info[:2] < (3, 13)):
    raise SystemExit("VoxCPM2 requires Python 3.10-3.12.")
PY

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install -r "$SCRIPT_DIR/requirements.txt"

if [ "${VOXCPM2_PREFETCH:-1}" = "1" ]; then
  echo "Downloading ${MODEL_ID} into the Hugging Face cache..."
  VOXCPM2_MODEL_ID="$MODEL_ID" "$VENV_DIR/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["VOXCPM2_MODEL_ID"])
PY
fi

"$VENV_DIR/bin/python" - <<'PY'
import torch
print(f"PyTorch: {torch.__version__}")
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"CUDA device: {torch.cuda.get_device_name(0)}")
else:
    print("No CUDA device detected. VoxCPM2 will run on CPU unless VOXCPM2_DEVICE selects another supported device.")
PY

echo "VoxCPM2 setup complete."
echo "Start: $VENV_DIR/bin/python $SCRIPT_DIR/server.py"
