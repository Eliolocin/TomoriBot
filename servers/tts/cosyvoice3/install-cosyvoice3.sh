#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${COSYVOICE3_RUNTIME_DIR:-${SCRIPT_DIR}/CosyVoice}"
MODEL_DIR="${COSYVOICE3_MODEL_DIR:-${RUNTIME_DIR}/pretrained_models/Fun-CosyVoice3-0.5B}"
MODEL_ID="${COSYVOICE3_MODEL_ID:-FunAudioLLM/Fun-CosyVoice3-0.5B-2512}"
PYTHON_BIN="${PYTHON:-python3.10}"
VENV_DIR="${SCRIPT_DIR}/.venv"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "${PYTHON_BIN} was not found. CosyVoice currently recommends Python 3.10." >&2
  exit 1
fi

"${PYTHON_BIN}" - <<'PY'
import sys
if sys.version_info[:2] != (3, 10):
    raise SystemExit(f"Python 3.10 is required by the current CosyVoice setup; found {sys.version.split()[0]}")
PY

if [[ ! -d "${RUNTIME_DIR}/.git" ]]; then
  echo "Cloning the official CosyVoice runtime..."
  git clone --recursive https://github.com/QwenAudio/CosyVoice.git "${RUNTIME_DIR}"
else
  echo "CosyVoice runtime already exists; refreshing submodules..."
  git -C "${RUNTIME_DIR}" submodule update --init --recursive
fi

if ! command -v sox >/dev/null 2>&1; then
  echo "Warning: sox was not found. Upstream recommends installing sox/libsox-dev if audio compatibility issues occur." >&2
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r "${RUNTIME_DIR}/requirements.txt"
python -m pip install -r "${SCRIPT_DIR}/requirements.txt"

python - "${MODEL_ID}" "${MODEL_DIR}" <<'PY'
from pathlib import Path
import sys
from huggingface_hub import snapshot_download

model_id = sys.argv[1]
model_dir = Path(sys.argv[2])
model_dir.parent.mkdir(parents=True, exist_ok=True)
print(f"Downloading {model_id} to {model_dir} ...")
snapshot_download(repo_id=model_id, local_dir=str(model_dir))
PY

cat <<EOF

CosyVoice 3 setup complete.

Start only the sidecar:
  ${VENV_DIR}/bin/python ${SCRIPT_DIR}/server.py

Or start it with TomoriBot from the repository root:
  bun run launch --cosyvoice3

Default endpoint: http://127.0.0.1:8016
EOF
