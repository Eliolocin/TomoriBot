#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/fish-speech"
VENV_DIR="${SCRIPT_DIR}/.venv"
MODEL_DIR="${FISH_S2_MODEL_DIR:-${RUNTIME_DIR}/checkpoints/fish-speech-s2-pro-int8}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_REPOSITORY="${FISH_S2_RUNTIME_REPOSITORY:-https://github.com/Imagilux/fish-speech.git}"
RUNTIME_REF="${FISH_S2_RUNTIME_REF:-2225e924e7d35cc0a1d24dbc67cd1819e6cf429f}"
MODEL_ID="${FISH_S2_MODEL_ID:-Imagilux/fishaudio-s2-pro}"
MODEL_REVISION="${FISH_S2_MODEL_REVISION:-9706ff036580881d87cc09465dd10014527bc481}"
UPDATE_RUNTIME="${FISH_S2_UPDATE:-0}"

if [[ "${UPDATE_RUNTIME,,}" =~ ^(1|true|yes|on)$ ]]; then
  RUNTIME_REF="${FISH_S2_UPDATE_REF:-main}"
  MODEL_REVISION="${FISH_S2_UPDATE_MODEL_REVISION:-main}"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "$PYTHON_BIN is required (Python 3.10+; Python 3.12 recommended by Fish Speech)." >&2
  exit 1
fi

if [ ! -d "$RUNTIME_DIR/.git" ]; then
  git clone --no-checkout "$RUNTIME_REPOSITORY" "$RUNTIME_DIR"
fi

git -C "$RUNTIME_DIR" fetch --depth 1 origin "$RUNTIME_REF"
git -C "$RUNTIME_DIR" checkout --detach --force "$RUNTIME_REF"

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install -r "$SCRIPT_DIR/requirements.txt"
"$VENV_DIR/bin/python" -m pip install -e "$RUNTIME_DIR"

if [[ "${UPDATE_RUNTIME,,}" =~ ^(1|true|yes|on)$ ]] || [ ! -f "$MODEL_DIR/model.pth" ] || [ ! -f "$MODEL_DIR/codec.pth" ]; then
  echo "Downloading ${MODEL_ID} checkpoint at revision ${MODEL_REVISION}..."
  echo "If Hugging Face requests authentication, accept the model license and run: hf auth login"
  "$VENV_DIR/bin/hf" download "$MODEL_ID" --revision "$MODEL_REVISION" --local-dir "$MODEL_DIR"
fi

cat <<EOF
Fish S2 Pro setup complete.
Runtime: $RUNTIME_DIR
Runtime ref: $RUNTIME_REF
Model:   $MODEL_DIR
Model ref: $MODEL_REVISION
Start:   $VENV_DIR/bin/python $SCRIPT_DIR/server.py
EOF
