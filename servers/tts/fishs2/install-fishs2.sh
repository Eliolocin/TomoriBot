#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/fish-speech"
VENV_DIR="${SCRIPT_DIR}/.venv"
MODEL_DIR="${RUNTIME_DIR}/checkpoints/fish-speech-s2-pro-int8"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "$PYTHON_BIN is required (Python 3.10+; Python 3.12 recommended by Fish Speech)." >&2
  exit 1
fi

if [ ! -d "$RUNTIME_DIR/.git" ]; then
  git clone https://github.com/Imagilux/fish-speech.git "$RUNTIME_DIR"
else
  git -C "$RUNTIME_DIR" pull --ff-only
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install -r "$SCRIPT_DIR/requirements.txt"
"$VENV_DIR/bin/python" -m pip install -e "$RUNTIME_DIR"

if [ ! -f "$MODEL_DIR/model.pth" ] || [ ! -f "$MODEL_DIR/codec.pth" ]; then
  echo "Downloading Imagilux/fishaudio-s2-pro INT8 checkpoint..."
  echo "If Hugging Face requests authentication, accept the model license and run: hf auth login"
  "$VENV_DIR/bin/hf" download Imagilux/fishaudio-s2-pro --local-dir "$MODEL_DIR"
fi

cat <<EOF
Fish S2 Pro setup complete.
Runtime: $RUNTIME_DIR
Model:   $MODEL_DIR
Start:   $VENV_DIR/bin/python $SCRIPT_DIR/server.py
EOF
