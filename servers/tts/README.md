# TomoriBot Reference TTS Servers

These scripts are optional local wrapper servers for Phase 4 speech endpoints. They expose TomoriBot's `POST /synthesize` contract and keep model weights outside the Bun app.

Each engine lives in its own subfolder with its own `.venv` to keep dependencies isolated:

| Engine | Folder | Default port |
|---|---|---|
| Chatterbox (Turbo by default, English, bracket tags) | `chatterbox/` | 8011 |
| Qwen3-TTS 12Hz 1.7B Base / VoiceDesign auto mode (10 languages, plain text) | `qwen3tts/` | 8012 |
| Irodori-TTS v4.1 (Japanese, clone + VoiceDesign, emoji tags) | `irodoritts/` | 8013 |
| Qwen3-TTS 12Hz 1.7B VoiceDesign (natural-language voice descriptions) | `qwen3tts/server.py --mode voice-design` | 8014 |
| CosyVoice 3 0.5B (9 languages, cloning + instruct, upstream streaming) | `cosyvoice3/` | 8016 |

Port 8016 is used for CosyVoice 3 so it does not collide with the Fish S2 Pro sidecar being developed on PR #85, which uses 8015.

## Prerequisites

- **Python 3.10+** for most wrappers. CosyVoice 3 currently expects **Python 3.10** specifically.
- **CUDA 12.x + drivers** *(optional)* for GPU acceleration. CPU fallback is much slower for local TTS.

## Setup (Windows PowerShell)

Run these commands from the repo root. Swap in the folder name for the engine you want.

```powershell
# 1. Create and activate a virtual environment inside the engine folder
python -m venv servers\tts\chatterbox\.venv
servers\tts\chatterbox\.venv\Scripts\Activate.ps1

# 2. Upgrade pip
python -m pip install -U pip

# 3. Install dependencies
#    Chatterbox: install numpy first (pkuseg build-time dependency)
python -m pip install numpy
python -m pip install -r servers\tts\chatterbox\requirements.txt

# 4. (GPU only) Reinstall PyTorch with CUDA support — skip for CPU-only installs
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 5. Start the server
python servers\tts\chatterbox\server.py
```

> **CUDA version**: use `cu118` or `cu121` in the index URL above if your driver targets an older toolkit.

Qwen3-TTS follows a similar venv + requirements flow. Irodori-TTS uses `uv` and backend extras instead. CosyVoice 3 uses its own installer because its official runtime is a separate repository with recursive submodules and a larger pinned dependency set. See the individual guides under `docs/en/self-hosting/local-endpoints/text-to-speech/`.

## Registering in TomoriBot

After the server is running, register it through `/providers` as a custom Speech endpoint using API Compatibility `tts-clone`, then select the saved model through `/config` > Models > Switch Models.

- `endpoint_url = http://127.0.0.1:<port>`
- choose the Voice Source Mode required by the wrapper
- choose the correct Script Markup for the engine
- enable Supports Instruct when the wrapper accepts natural-language delivery instructions

> **ffmpeg required**: voice sample uploads are normalised to WAV via ffmpeg. Install it and ensure `ffmpeg` is on your PATH before adding a sample in `/config` under Models > TTS Parameters & Voices.

Chatterbox defaults to Turbo. Use `/config` under Models > TTS Parameters & Voices to disable Turbo and set standard-model `cfg_weight` and `exaggeration` values for generated voice messages.

Qwen3-TTS defaults to auto mode. One server URL can handle both clone and VoiceDesign requests: the server detects clone requests by `ref_audio`, detects VoiceDesign requests by `instruct`, and swaps the loaded model when needed. Start VoiceDesign only with `TOMORI_TTS_MODE=voice-design python servers/tts/qwen3tts/server.py` or `python servers/tts/qwen3tts/server.py --mode voice-design`.

Irodori-TTS v4.1 also supports TomoriBot's `Auto` voice source mode from one endpoint. Clone requests use `ref_audio`; VoiceDesign requests use `instruct`, which the wrapper maps to Irodori caption conditioning.

CosyVoice 3 uses Clone voice mode. It consumes the reference audio and transcript for standard zero-shot cloning, supports cross-lingual cloning without a transcript, and maps `instruct` or supported bracket delivery tags to CosyVoice 3's current `inference_instruct2` path. Its official runtime can stream audio chunks internally; TomoriBot still receives one complete WAV for the current Discord voice-message pipeline.
