#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${COSYVOICE3_RUNTIME_DIR:-${SCRIPT_DIR}/CosyVoice}"
MODEL_DIR="${COSYVOICE3_MODEL_DIR:-${RUNTIME_DIR}/pretrained_models/Fun-CosyVoice3-0.5B}"
MODEL_ID="${COSYVOICE3_MODEL_ID:-FunAudioLLM/Fun-CosyVoice3-0.5B-2512}"
RUNTIME_REPO="${COSYVOICE3_RUNTIME_REPO:-https://github.com/QwenAudio/CosyVoice.git}"
RUNTIME_COMMIT="${COSYVOICE3_RUNTIME_COMMIT:-074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc}"
MODEL_REVISION="${COSYVOICE3_MODEL_REVISION:-29e01c4e8d000f4bcd70751be16fa94bf3d85a18}"
ALLOW_UPDATE="${COSYVOICE3_UPDATE:-0}"
PYTHON_BIN="${PYTHON:-python3.10}"
VENV_DIR="${SCRIPT_DIR}/.venv"
INSTALL_METADATA="${MODEL_DIR}/.tomoribot-cosyvoice3-install.json"

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
  echo "Cloning the pinned CosyVoice runtime revision ${RUNTIME_COMMIT}..."
  git clone --recursive "${RUNTIME_REPO}" "${RUNTIME_DIR}"
  git -C "${RUNTIME_DIR}" fetch --no-tags origin "${RUNTIME_COMMIT}"
  git -C "${RUNTIME_DIR}" checkout --detach "${RUNTIME_COMMIT}"
else
  if [[ -n "$(git -C "${RUNTIME_DIR}" status --porcelain)" ]]; then
    echo "CosyVoice runtime has local changes. Clean it before reinstalling." >&2
    exit 1
  fi
  CURRENT_COMMIT="$(git -C "${RUNTIME_DIR}" rev-parse HEAD)"
  if [[ "${CURRENT_COMMIT}" != "${RUNTIME_COMMIT}" ]]; then
    if [[ "${ALLOW_UPDATE}" != "1" ]]; then
      echo "CosyVoice runtime is at ${CURRENT_COMMIT}, expected ${RUNTIME_COMMIT}." >&2
      echo "Set COSYVOICE3_UPDATE=1 to explicitly switch the checkout to the requested revision." >&2
      exit 1
    fi
    if [[ -n "$(git -C "${RUNTIME_DIR}" status --porcelain)" ]]; then
      echo "CosyVoice runtime has local changes. Clean it before COSYVOICE3_UPDATE=1." >&2
      exit 1
    fi
    git -C "${RUNTIME_DIR}" fetch --no-tags origin "${RUNTIME_COMMIT}"
    git -C "${RUNTIME_DIR}" checkout --detach "${RUNTIME_COMMIT}"
  fi
fi
git -C "${RUNTIME_DIR}" submodule sync --recursive
git -C "${RUNTIME_DIR}" submodule update --init --recursive

if ! command -v sox >/dev/null 2>&1; then
  echo "Warning: sox was not found. Upstream recommends installing sox/libsox-dev if audio compatibility issues occur." >&2
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r "${RUNTIME_DIR}/requirements.txt"
python -m pip install -r "${SCRIPT_DIR}/requirements.txt"

python - "${MODEL_ID}" "${MODEL_DIR}" "${MODEL_REVISION}" "${INSTALL_METADATA}" "${ALLOW_UPDATE}" <<'PY'
import json
from pathlib import Path
import sys
from huggingface_hub import snapshot_download

model_id = sys.argv[1]
model_dir = Path(sys.argv[2])
revision = sys.argv[3]
metadata_path = Path(sys.argv[4])
allow_update = sys.argv[5] == "1"
model_dir.parent.mkdir(parents=True, exist_ok=True)
expected = {"model_id": model_id, "model_revision": revision}
if metadata_path.is_file():
    current = json.loads(metadata_path.read_text(encoding="utf-8"))
    if current != expected and not allow_update:
        raise SystemExit(
            f"CosyVoice model metadata is {current}, expected {expected}. "
            "Set COSYVOICE3_UPDATE=1 to explicitly refresh it."
        )
print(f"Downloading {model_id}@{revision} to {model_dir} ...")
snapshot_download(repo_id=model_id, revision=revision, local_dir=str(model_dir))
metadata_path.write_text(json.dumps(expected, sort_keys=True) + "\n", encoding="utf-8")
PY

cat <<EOF

CosyVoice 3 setup complete.

Start only the sidecar:
  ${VENV_DIR}/bin/python ${SCRIPT_DIR}/server.py

Or start it with TomoriBot from the repository root:
  bun run launch --cosyvoice3

Default endpoint: http://127.0.0.1:8017

Pinned runtime: ${RUNTIME_COMMIT}
Pinned model revision: ${MODEL_REVISION}
To explicitly update either pin, set COSYVOICE3_UPDATE=1 and override the corresponding
COSYVOICE3_RUNTIME_COMMIT or COSYVOICE3_MODEL_REVISION value before rerunning this script.
EOF
