---
title: "IrodoriTTS"
aiGenerated: false
---

Irodori-TTS v4.1 is a Japanese-focused TTS model with voice cloning and caption-based VoiceDesign in one checkpoint. TomoriBot runs it through the local FastAPI wrapper in `servers/tts/irodoritts/`.

The default model is `Aratako/Irodori-TTS-v4.1-Small`. Compatible Hugging Face checkpoints can be selected with `IRODORI_TTS_MODEL_ID`, including community fine-tunes such as `phasefield-audio/Irodori-TTS-v4.1-Anime`.

## Setup

Irodori now uses `uv` for dependency and PyTorch backend management. Install `uv` first, then run the setup script from the TomoriBot repo root.

### Windows PowerShell (NVIDIA)

```powershell
.\servers\tts\irodoritts\install-irodori.ps1 cu128
.\servers\tts\irodoritts\.venv\Scripts\python.exe servers\tts\irodoritts\server.py
```

### Linux Bash (NVIDIA)

```bash
bash servers/tts/irodoritts/install-irodori.sh cu128
servers/tts/irodoritts/.venv/bin/python servers/tts/irodoritts/server.py
```

The setup scripts create `servers/tts/irodoritts/.venv`, so `bun run launch --irodoritts` continues to work after installation.

Available backends are:

- `cu128` — NVIDIA CUDA 12.8 on Windows/Linux
- `cpu` — CPU-only, or macOS CPU/MPS through PyPI
- `rocm` — AMD ROCm on Linux/WSL
- `xpu` — Intel XPU on Windows/Linux

The default endpoint URL is `http://127.0.0.1:8013`.

## Using a Different Checkpoint

The default model is `Aratako/Irodori-TTS-v4.1-Small`. Compatible Hugging Face repositories, community fine-tunes (such as `phasefield-audio/Irodori-TTS-v4.1-Anime`), or local checkpoint files can be configured via environment variables.

When starting the sidecar (directly with Python or via `bun run launch --irodoritts`), the server automatically reads the repository root `.env` (or a local `.env` in `servers/tts/irodoritts/`) and logs the active model ID on startup.

### Via `.env` (Persistent)

Add to your `.env` in the TomoriBot root:

```env
IRODORI_TTS_MODEL_ID="phasefield-audio/Irodori-TTS-v4.1-Anime"
```

### Via Environment Variable per Session

In Windows PowerShell:

```powershell
$env:IRODORI_TTS_MODEL_ID = "phasefield-audio/Irodori-TTS-v4.1-Anime"
.\servers\tts\irodoritts\.venv\Scripts\python.exe servers\tts\irodoritts\server.py
```

On Linux Bash:

```bash
IRODORI_TTS_MODEL_ID=phasefield-audio/Irodori-TTS-v4.1-Anime \
  servers/tts/irodoritts/.venv/bin/python servers/tts/irodoritts/server.py
```

### Using a Local Checkpoint File

If you have downloaded a checkpoint file (`.pt` or `.safetensors`) locally, set `IRODORI_TTS_CHECKPOINT` to its path:

```env
IRODORI_TTS_CHECKPOINT="/path/to/custom_checkpoint.pt"
```

Current Irodori downloads the checkpoint together with any tokenizer assets bundled in the Hugging Face repo. Hugging Face subfolder variants are also supported by `IRODORI_TTS_MODEL_ID` when the model repo provides them.

## Register in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and use the speech API compatibility:

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8013`

After saving the connection, select it and use its model dropdown to add a Speech model. For v4.1, the
recommended settings are:

- `Voice Source Mode`: `Auto`
- `Script Markup Style`: `Emoji`

`Auto` lets the same Irodori endpoint support both TomoriBot voice modes, so emotion cues survive the send:

- Personas with a voice sample assigned under Persona > Voice send a stored reference clip for voice cloning.
- Personas with a VoiceDesign prompt set under Persona > Voice send the saved natural-language prompt as
  Irodori caption conditioning.

You can still choose `Voice Clone` as the Voice Source Mode if you only want reference-audio voice cloning.

Use `/providers` for endpoint registration and model setup. Then open `/config` > Models > Switch Models to
select and activate the registered endpoint.

## Set up persona voices

### Voice cloning

1. Prepare a clean 10-20 second Japanese voice clip with one speaker and no background music.
2. Open `/config` under Models > TTS Parameters & Voices and upload the clip.
3. Open `/config` under Persona > Voice, then choose the persona and the voice sample.

Irodori v4.1 supports longer reference conditioning than the old v2 model, but clean source audio remains more important than raw duration.

### VoiceDesign

1. Open `/config` under Persona > Voice.
2. Choose the persona.
3. Enter a natural-language description of the desired voice and delivery.

TomoriBot sends this prompt as `instruct`; the Irodori wrapper maps it to the v4.1 `caption` condition. VoiceDesign requests do not require a stored reference clip.

TomoriBot strips Discord custom emoji syntax before sending text to TTS. With `script_markup: emoji`, Unicode emojis are preserved for Irodori's text conditioning.

## Faster inference with Sway Sampling

The default remains Irodori's higher-quality 40-step linear sampling. For lower latency, try Sway Sampling with fewer steps:

```powershell
$env:IRODORI_NUM_STEPS = "6"
$env:IRODORI_T_SCHEDULE_MODE = "sway"
$env:IRODORI_SWAY_COEFF = "-1.0"
```

This is an inference quality/speed tradeoff, so test it with your chosen checkpoint and voices before making it permanent.

## Why the install scripts are simpler now

The previous TomoriBot installer cloned and patched Irodori's `pyproject.toml`, manually installed `dacvae`, and pinned an old v2-era Irodori commit. Those workarounds were necessary for the older upstream package layout but are no longer appropriate for current Irodori.

The sidecar now has its own `pyproject.toml` and follows upstream's `uv` backend setup. Irodori and `dacvae` remain pinned to known commits there for reproducible installs, but TomoriBot no longer modifies upstream source code during installation.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRODORI_TTS_MODEL_ID` | `Aratako/Irodori-TTS-v4.1-Small` | Hugging Face model repo or supported repo/subfolder source |
| `IRODORI_TTS_CHECKPOINT` | unset | Optional local `.pt` or `.safetensors` checkpoint; overrides the Hugging Face model |
| `TOMORI_TTS_HOST` | `127.0.0.1` | Server bind address |
| `TOMORI_TTS_PORT` | `8013` | Server port |
| `IRODORI_MODEL_DEVICE` | `auto` | Model device (`auto`, `cuda`, `cpu`, `mps`, `xpu`) |
| `IRODORI_CODEC_DEVICE` | `auto` | Codec device |
| `IRODORI_MODEL_PRECISION` | `bf16` on CUDA, otherwise `fp32` | Model precision |
| `IRODORI_CODEC_PRECISION` | `fp32` | Codec precision |
| `IRODORI_COMPILE_MODEL` | `false` | Enable `torch.compile` for the Irodori model |
| `IRODORI_COMPILE_DYNAMIC` | `false` | Enable dynamic shapes when compiling |
| `IRODORI_NUM_STEPS` | `40` | Euler sampling steps |
| `IRODORI_T_SCHEDULE_MODE` | `linear` | Sampling schedule (`linear` or `sway`) |
| `IRODORI_SWAY_COEFF` | `-1.0` | Sway coefficient when using the `sway` schedule |
| `IRODORI_CFG_SCALE_TEXT` | `3.0` | Text guidance scale |
| `IRODORI_CFG_SCALE_CAPTION` | `3.0` | Caption / VoiceDesign guidance scale |
| `IRODORI_CFG_SCALE_SPEAKER` | `5.0` | Reference-speaker guidance scale |
| `IRODORI_MAX_REF_SECONDS` | checkpoint default | Optional cap on reference audio duration |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `1000` | Per-request text length cap |
