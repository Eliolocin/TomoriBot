---
title: "IrodoriTTS"
aiGenerated: false
---

Irodori-TTS 500M v2 is a Japanese-focused voice-cloning TTS model. It runs via a local FastAPI wrapper server in `servers/tts/irodoritts/`.

## Setup

Run these commands from the TomoriBot repo root, the folder where you cloned TomoriBot (depending on OS):

### Using Windows PowerShell

```powershell
# 1. Create and activate a venv inside the engine folder
python -m venv servers\tts\irodoritts\.venv
servers\tts\irodoritts\.venv\Scripts\Activate.ps1

# 2. Upgrade pip
python -m pip install -U pip

# 3. Install server runtime deps (FastAPI, uvicorn, PyTorch)
pip install -r servers\tts\irodoritts\requirements.txt

# 4. (GPU only) Reinstall PyTorch with CUDA support — skip for CPU-only installs
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 5. Install irodori-tts from source via the patch script
.\servers\tts\irodoritts\install-irodori.ps1

# 6. Start the server
python servers\tts\irodoritts\server.py
```

### Using Linux/macOS Bash

```bash
# 1. Create and activate a venv inside the engine folder
python3 -m venv servers/tts/irodoritts/.venv
source servers/tts/irodoritts/.venv/bin/activate

# 2. Upgrade pip
python -m pip install -U pip

# 3. Install server runtime deps (FastAPI, uvicorn, PyTorch)
python -m pip install -r servers/tts/irodoritts/requirements.txt

# 4. (Linux GPU only) Reinstall PyTorch with CUDA support - skip for CPU-only installs
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 5. Install irodori-tts from source via the patch script
bash servers/tts/irodoritts/install-irodori.sh

# 6. Start the server
python servers/tts/irodoritts/server.py
```

> **CUDA version**: replace `cu124` with `cu118` or `cu121` if your driver targets an older toolkit.

Keep that terminal open while TomoriBot is using IrodoriTTS. The default endpoint URL is `http://127.0.0.1:8013`.

## Register in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and use the speech API compatibility:

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8013`

After saving the connection, select it and use its model dropdown to add a Speech model. Choose `Voice Clone`
as the Voice Source Mode and `Emoji` as the Script Markup, so emotion cues survive the send.

Adding the model makes the endpoint active immediately. Use `/providers` later only when switching between speech endpoints.

## Set Up a Persona Voice

1. Prepare a clean 10-20 second Japanese voice clip with one speaker and no background music.
2. Open `/config` under Models > TTS Parameters & Voices and upload the clip.
3. Run `/speech voice-assign`, then choose the persona and the voice sample.

TomoriBot strips Discord custom emoji syntax before sending text to TTS. With `script_markup: emoji`, Unicode emojis are preserved for IrodoriTTS emotion control; other speech modes remove Unicode emojis too so they are not spoken literally.

## Why the Install Script Exists

A direct `pip install git+https://github.com/Aratako/Irodori-TTS` currently fails because upstream packaging metadata is not pip-friendly and `dacvae` is not on PyPI. The install script patches the package layout and installs pinned GitHub dependencies.

Both `Irodori-TTS` and `dacvae` are installed from GitHub. The script pins both to specific commit SHAs (defined at the top of `install-irodori.ps1`) to prevent silent upstream changes from affecting installs.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRODORI_TTS_MODEL_ID` | `Aratako/Irodori-TTS-500M-v2` | HuggingFace model repo |
| `TOMORI_TTS_HOST` | `127.0.0.1` | Server bind address |
| `TOMORI_TTS_PORT` | `8013` | Server port |
| `IRODORI_MODEL_DEVICE` | `cuda` / `cpu` | Inference device |
| `IRODORI_CODEC_DEVICE` | same as model device | Codec device |
| `IRODORI_MODEL_PRECISION` | `bf16` (GPU) / `fp32` (CPU) | Model precision |
| `IRODORI_CODEC_PRECISION` | `fp32` | Codec precision |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `1000` | Per-request text length cap |
