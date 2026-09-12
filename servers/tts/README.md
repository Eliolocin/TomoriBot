# TomoriBot Reference TTS Servers

These scripts are optional local wrapper servers for Phase 4 speech endpoints. They expose TomoriBot's `POST /synthesize` contract and keep model weights outside the Bun app.

Each engine lives in its own subfolder with its own `.venv` to keep dependencies isolated:

| Engine | Folder | Default port |
|---|---|---|
| Chatterbox (Turbo by default, English, bracket tags) | `chatterbox/` | 8011 |
| Qwen3-TTS 12Hz 1.7B Base / VoiceDesign auto mode (10 languages, plain text) | `qwen3tts/` | 8012 |
| Irodori-TTS v4.1 (Japanese, clone + VoiceDesign, emoji tags) | `irodoritts/` | 8013 |
| Qwen3-TTS 12Hz 1.7B VoiceDesign (natural-language voice descriptions) | `qwen3tts/server.py --mode voice-design` | 8014 |
| Fish Audio S2 Pro INT8 (multilingual cloning, bracket expression tags) | `fishs2/` | 8015 |

## Prerequisites

- **Python 3.10+**
- **CUDA 12.x + drivers** *(optional)* — required for GPU acceleration; without it servers fall back to CPU (significantly slower)

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

Qwen3-TTS follows a similar venv + requirements flow. Irodori-TTS uses `uv` and backend extras instead; see `docs/en/self-hosting/local-endpoints/text-to-speech/irodoritts.md` for its current setup.

Fish S2 Pro has its own installer because the sidecar also installs the Fish Speech runtime and downloads the quantized checkpoint. See `docs/en/self-hosting/local-endpoints/text-to-speech/fishs2.md`. The default `Imagilux/fishaudio-s2-pro` checkpoint uses INT8 weight-only quantization and is intended to fit consumer GPUs with 16 GB VRAM while keeping the codec, embeddings, and layer norms in BF16. The installer pins both upstream revisions and requires an explicit override for updates.

## Registering in TomoriBot

After the server is running, register it with `/provider custom-endpoint add`:

- `capability = speech`
- `api_style = tts-clone`
- `endpoint_url = http://127.0.0.1:<port>`
- `script_markup` — select the correct option for the engine

> **ffmpeg required**: voice sample uploads are normalised to WAV via ffmpeg. Install it
> and ensure `ffmpeg` is on your PATH before adding a sample in `/config` under Models > TTS Parameters & Voices.

Chatterbox defaults to Turbo. Use `/config` under Models > TTS Parameters & Voices to disable Turbo and set standard-model `cfg_weight` and `exaggeration` values for generated voice messages.

Qwen3-TTS defaults to auto mode. One server URL can handle both clone and VoiceDesign requests: the server detects clone requests by `ref_audio`, detects VoiceDesign requests by `instruct`, and swaps the loaded model when needed. Start VoiceDesign only with `TOMORI_TTS_MODE=voice-design python servers/tts/qwen3tts/server.py` or `python servers/tts/qwen3tts/server.py --mode voice-design`. In TomoriBot, set persona prompts with `/speech voice-design set`; generated tool calls send that prompt as `instruct`.

Irodori-TTS v4.1 also supports TomoriBot's `Auto` voice source mode from one endpoint. Clone requests use `ref_audio`; VoiceDesign requests use `instruct`, which the wrapper maps to Irodori caption conditioning.

Fish S2 Pro is registered as a cloning endpoint with `Bracket Tags` markup. TomoriBot sends the stored reference WAV and transcript directly to Fish, while expression tags such as `[whisper]`, `[excited]`, and `[angry]` remain in the generated script for Fish's fine-grained delivery control.

Fish's wrapper accepts PCM WAV references up to the configured decoded-audio limit and binds to loopback by default. Configure a bearer token before exposing it on a non-loopback address.
