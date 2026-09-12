# TomoriBot Reference TTS Servers

These scripts are optional local wrapper servers for TomoriBot speech endpoints. They expose TomoriBot's `POST /synthesize` contract and keep model weights outside the Bun app.

Each engine lives in its own subfolder with its own `.venv` to keep dependencies isolated:

| Engine | Folder | Default port |
|---|---|---|
| Chatterbox (Turbo by default, English, bracket tags) | `chatterbox/` | 8011 |
| Qwen3-TTS 12Hz 1.7B Base / VoiceDesign auto mode (10 languages, plain text) | `qwen3tts/` | 8012 |
| Irodori-TTS v4.1 (Japanese, clone + VoiceDesign, emoji tags) | `irodoritts/` | 8013 |
| Qwen3-TTS 12Hz 1.7B VoiceDesign (natural-language voice descriptions) | `qwen3tts/server.py --mode voice-design` | 8014 |
| Fish Audio S2 Pro INT8 (multilingual cloning, bracket expression tags) | `fishs2/` | 8015 |
| VoxCPM2 2B (30 languages, clone + VoiceDesign + controllable cloning) | `voxcpm2/` | 8016 |

## Prerequisites

- **Python 3.10+**. VoxCPM2 currently requires Python 3.10-3.12.
- **CUDA-capable NVIDIA GPU** *(optional)* for fast local synthesis. CPU fallbacks are significantly slower.
- **ffmpeg** for TomoriBot voice-sample normalization.

## Setup

Each sidecar has its own setup guide under `docs/en/self-hosting/local-endpoints/text-to-speech/`. Modern sidecars include installer scripts where their upstream runtimes make that practical.

For VoxCPM2:

```powershell
# Windows PowerShell
.\servers\tts\voxcpm2\install-voxcpm2.ps1
```

```bash
# Linux / WSL
bash servers/tts/voxcpm2/install-voxcpm2.sh
```

After setup, start it directly or use the launcher:

```sh
bun run launch --voxcpm2
```

Fish S2 Pro has its own installer because the sidecar also installs the Fish Speech runtime and downloads the quantized checkpoint. See `docs/en/self-hosting/local-endpoints/text-to-speech/fishs2.md`. The default `Imagilux/fishaudio-s2-pro` checkpoint uses INT8 weight-only quantization and is intended to fit consumer GPUs with 16 GB VRAM while keeping the codec, embeddings, and layer norms in BF16. The installer pins both upstream revisions and requires an explicit override for updates.

## Registering in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and register the server as a Speech endpoint using API Compatibility `tts-clone`. Use the endpoint URL and voice-source mode documented for that engine.

Then use `/providers` to add the Speech model, and `/config` > Models > Switch Models to activate it.

For voice samples, open `/config` under Models > TTS Parameters & Voices. TomoriBot normalizes uploaded samples to WAV with ffmpeg. Assign clone samples or VoiceDesign prompts to personas under `/config` > Persona > Voice.

## Engine notes

Chatterbox defaults to Turbo. Use `/config` under Models > TTS Parameters & Voices to disable Turbo and set standard-model `cfg_weight` and `exaggeration` values for generated voice messages.

Qwen3-TTS defaults to auto mode. One server URL can handle both clone and VoiceDesign requests: the server detects clone requests by `ref_audio`, detects VoiceDesign requests by `instruct`, and swaps the loaded model when needed. Start VoiceDesign only with `TOMORI_TTS_MODE=voice-design python servers/tts/qwen3tts/server.py` or `python servers/tts/qwen3tts/server.py --mode voice-design`.

Irodori-TTS v4.1 also supports TomoriBot's `Auto` voice source mode from one endpoint. Clone requests use `ref_audio`; VoiceDesign requests use `instruct`, which the wrapper maps to Irodori caption conditioning.

Fish S2 Pro is registered as a cloning endpoint with `Bracket Tags` markup. TomoriBot sends the stored reference WAV and transcript directly to Fish, while expression tags such as `[whisper]`, `[excited]`, and `[angry]` remain in the generated script for Fish's fine-grained delivery control.

Fish's wrapper accepts PCM WAV references up to the configured decoded-audio limit and binds to loopback by default. Configure a bearer token before exposing it on a non-loopback address.
VoxCPM2 uses one official `openbmb/VoxCPM2` model for all modes. Reference audio maps to normal cloning, reference audio plus its stored transcript maps to Ultimate Cloning, and `instruct` is converted into VoxCPM2's natural-language Voice Design / controllable-cloning prefix. Register it with Voice Source Mode `Auto`, Script Markup `Plain`, and Supports Instruct `Yes`. If a clone request includes both a transcript and one-off instruction, the instruction path wins and the transcript prompt is omitted.
