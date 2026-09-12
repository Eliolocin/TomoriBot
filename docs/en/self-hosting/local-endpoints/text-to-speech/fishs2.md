---
title: "Fish Audio S2 Pro"
aiGenerated: false
---

Fish Audio S2 Pro is a multilingual 4B TTS model focused on high-fidelity voice cloning and expressive delivery. TomoriBot uses it through the local wrapper in `servers/tts/fishs2/`.

The default TomoriBot setup uses `Imagilux/fishaudio-s2-pro`, an INT8 weight-only quantization of S2 Pro intended for VRAM-constrained consumer GPUs. The transformer is reduced from roughly 10.3 GB to roughly 5.1 GB while embeddings, layer norms, and the VQ-GAN codec remain in BF16. The model card reports about 10.9 GB total VRAM on a 16 GB Radeon test system and states that the checkpoint also works on NVIDIA CUDA.

Fish S2 Pro supports bracket expression tags such as `[whisper]`, `[excited]`, and `[angry]`. Configure the endpoint with **Bracket Tags** markup so TomoriBot preserves these controls in generated voice scripts.

## License

Fish Speech code and S2 Pro model weights are distributed under the Fish Audio Research License. The default quantized checkpoint is also under that license. Research and non-commercial use are permitted under its terms; commercial use requires a separate Fish Audio license.

TomoriBot does not redistribute the model weights. Each self-hosting user downloads Fish S2 Pro directly from Hugging Face and is responsible for complying with the Fish Audio Research License. The required attribution is: **Built with Fish Audio**.

## Hardware

The official BF16 S2 Pro setup recommends at least 24 GB of VRAM. TomoriBot therefore defaults to the INT8 checkpoint instead.

Recommended starting point:

- NVIDIA or AMD GPU with **16 GB VRAM or more**
- Python 3.12 recommended
- `git`, `ffmpeg`, and the normal system audio dependencies required by Fish Speech
- Linux or WSL is the officially documented Fish Speech environment. Native Windows is best-effort.

The INT8 checkpoint is primarily maintained for the Imagilux Fish Speech fork, which also adds VRAM management and consumer-GPU fixes. This is why the TomoriBot installer uses that runtime rather than the upstream Fish Speech repository by default.

## Setup

### Linux / WSL

From the TomoriBot repository root:

```bash
bash servers/tts/fishs2/install-fishs2.sh
servers/tts/fishs2/.venv/bin/python servers/tts/fishs2/server.py
```

The installer uses a reviewed runtime commit and model revision by default. It does not update a
checkout from a moving branch during a normal reinstall. The installer:

1. clones `Imagilux/fish-speech` into `servers/tts/fishs2/fish-speech/` and checks out the pinned runtime commit;
2. creates the isolated `.venv`;
3. installs Fish Speech plus the TomoriBot wrapper dependencies; and
4. downloads the pinned `Imagilux/fishaudio-s2-pro` revision into `fish-speech/checkpoints/fish-speech-s2-pro-int8/`.

The reviewed defaults are runtime commit
`2225e924e7d35cc0a1d24dbc67cd1819e6cf429f` and model revision
`9706ff036580881d87cc09465dd10014527bc481`.

To deliberately update or test another upstream revision, set `FISH_S2_RUNTIME_REF` and
`FISH_S2_MODEL_REVISION` before running the installer. For a convenience update to upstream
`main`, set `FISH_S2_UPDATE=1`; this is an explicit opt-in and uses `FISH_S2_UPDATE_REF` and
`FISH_S2_UPDATE_MODEL_REVISION` when provided. Record any revision used for a deployment so it can
be reproduced later. An explicit update ref wins over a base ref. When no update ref is supplied,
an explicitly configured base ref remains selected; otherwise the update opt-in selects `main`.

`FISH_S2_RUNTIME_REPOSITORY` can point at a reviewed mirror when required. `FISH_S2_MODEL_ID` and
`FISH_S2_MODEL_REVISION` select the Hugging Face repository and immutable revision used by the
installer.

The Hugging Face model is gated. Accept its license on Hugging Face first. If the download asks for authentication, run:

```bash
servers/tts/fishs2/.venv/bin/hf auth login
```

Then rerun the installer.

### Windows PowerShell

Fish Audio officially documents Linux/WSL for local S2 inference, so WSL is preferred. A best-effort native Windows installer is included:

```powershell
.\servers\tts\fishs2\install-fishs2.ps1
.\servers\tts\fishs2\.venv\Scripts\python.exe servers\tts\fishs2\server.py
```

If an upstream Fish Speech dependency fails to build on native Windows, use WSL instead.

The TomoriBot wrapper listens on `http://127.0.0.1:8015` by default. Internally it starts Fish
Speech's own API server on port `8025` and translates TomoriBot's `/synthesize` request into Fish's
MessagePack API. This keeps Fish's inference implementation upstream while preserving TomoriBot's
common TTS endpoint contract.

The wrapper binds to loopback by default. If `TOMORI_TTS_HOST` is changed to a non-loopback address,
set `FISH_S2_API_KEY` and use the same value as the custom endpoint API key in TomoriBot. The
wrapper then requires `Authorization: Bearer <key>` for `/health` and `/synthesize`. An unauthenticated
remote bind is available only with the explicit `FISH_S2_ALLOW_INSECURE_REMOTE=1` opt-in and is not
recommended.

## Register in TomoriBot

In `/providers`, choose **Add New Custom Endpoint** and configure:

- Capability: `Speech`
- API Compatibility: `tts-clone`
- Endpoint URL: `http://127.0.0.1:8015`
- Voice Source Mode: `Clone`
- Script Markup: `Bracket Tags`
- API key: leave empty for the default loopback setup. If bearer auth is enabled, enter the exact `FISH_S2_API_KEY` value.

Then add the endpoint's model entry and activate it through `/config` under Models > Switch Models.

## Add persona voices

1. Prepare a clean reference clip with one speaker and little or no background noise.
2. In `/config`, open Models > TTS Parameters & Voices and upload the voice sample.
3. Provide the transcript of the reference clip when possible.
4. In `/config`, open Persona > Voice and assign the sample to the persona.
5. Generate a voice message with `/generate voice-message` or let TomoriBot generate one through its voice-message tool.

The reference transcript matters for Fish cloning quality. TomoriBot already stores it with each voice sample, and the Fish sidecar forwards both the reference WAV and `ref_text` to S2 Pro.

## Expression controls

Fish S2 Pro can vary delivery within one utterance using bracket tags. For example:

```text
[whisper] Keep your voice down. [excited] Wait, you actually found it?
```

Because the endpoint uses `Bracket Tags` markup, TomoriBot preserves these tags instead of stripping them before synthesis.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FISH_SPEECH_DIR` | `servers/tts/fishs2/fish-speech` | Fish Speech runtime directory |
| `FISH_S2_MODEL_DIR` | `fish-speech/checkpoints/fish-speech-s2-pro-int8` | S2 Pro checkpoint directory |
| `FISH_S2_MODEL_ID` | `Imagilux/fishaudio-s2-pro` | Model repository and health metadata label for the configured checkpoint |
| `TOMORI_TTS_HOST` | `127.0.0.1` | TomoriBot wrapper bind address |
| `FISH_S2_PORT` | `8015` | Fish wrapper port; falls back to `TOMORI_TTS_PORT` when unset |
| `TOMORI_TTS_PORT` | unset | Backward-compatible shared port override |
| `FISH_S2_API_KEY` | unset | Optional bearer token, also required for authenticated remote binds |
| `TOMORI_TTS_API_KEY` | unset | Shared bearer-token fallback when `FISH_S2_API_KEY` is unset |
| `FISH_S2_ALLOW_INSECURE_REMOTE` | `0` | Explicitly allow a non-loopback bind without a bearer token |
| `FISH_S2_MAX_REF_AUDIO_BYTES` | `10485760` | Maximum decoded reference WAV size |
| `TOMORI_TTS_MAX_REF_AUDIO_BYTES` | unset | Shared decoded reference-audio limit fallback |
| `FISH_S2_UPSTREAM_HOST` | `127.0.0.1` | Internal Fish API bind address |
| `FISH_S2_UPSTREAM_PORT` | `8025` | Internal Fish API port |
| `FISH_S2_COMPILE` | `0` | Enable Fish Speech `torch.compile`; upstream notes that compile is not supported on native Windows/macOS without additional setup |
| `FISH_S2_HALF` | `0` | Request FP16 runtime mode; leave disabled for the default INT8 checkpoint unless you have tested it |
| `FISH_S2_CHUNK_LENGTH` | `200` | Fish iterative prompt chunk length |
| `FISH_S2_TOP_P` | `0.8` | Sampling top-p |
| `FISH_S2_TEMPERATURE` | `0.8` | Sampling temperature |
| `FISH_S2_REPETITION_PENALTY` | `1.1` | Repetition penalty |
| `FISH_S2_MAX_NEW_TOKENS` | `1024` | Maximum semantic tokens generated per request |
| `FISH_S2_USE_MEMORY_CACHE` | `on` | Cache encoded reference voices in the Fish runtime |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `2000` | Maximum script length accepted by the wrapper |
| `FISH_S2_STARTUP_TIMEOUT_SECONDS` | `180` | Maximum time to wait for the nested Fish API |
| `FISH_S2_SYNTHESIS_TIMEOUT_SECONDS` | `240` | Maximum time to wait for one upstream synthesis request |
| `FISH_S2_LAUNCH_TIMEOUT_MS` | `240000` | Launcher JSON health readiness timeout |

Reference audio must be a non-empty, uncompressed PCM RIFF/WAVE file. The decoded size limit is
checked before inference to prevent an oversized base64 request from consuming unbounded memory.

## Use another S2 Pro checkpoint

Set `FISH_S2_MODEL_DIR` and `FISH_S2_MODEL_ID` before starting the wrapper. For example, a 24 GB+
GPU can use the official BF16 checkpoint downloaded from `fishaudio/s2-pro`. The health response
reports the configured model ID and directory rather than claiming that every checkpoint is the
default INT8 model.

The checkpoint directory must contain the Fish model files and `codec.pth` expected by the selected Fish Speech runtime.

## Why INT8 is the default

The goal is to keep the high-quality S2 Pro voice model usable on common 16 GB GPUs without making a more aggressive 4-bit quantization the default. The Imagilux model card reports only a very small WER difference from BF16 and keeps several quality-sensitive components in BF16, so INT8 is the current TomoriBot default for this sidecar.
