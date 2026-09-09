---
title: "Qwen3-TTS"
aiGenerated: false
---

Use `servers/tts/qwen3tts/server.py` for both Qwen3-TTS 12Hz 1.7B modes, large but most accurate TTS amongst current TomoriBot options. By default it starts in auto mode, which chooses the Base voice-clone model or VoiceDesign model from each request shape.

## Setup

Run these commands from the TomoriBot repo root, the folder where you cloned TomoriBot:

### Using Windows PowerShell

```powershell
python -m venv servers\tts\qwen3tts\.venv
servers\tts\qwen3tts\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r servers\tts\qwen3tts\requirements.txt
python servers\tts\qwen3tts\server.py
```

### Using Linux/macOS Bash

```bash
python3 -m venv servers/tts/qwen3tts/.venv
source servers/tts/qwen3tts/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r servers/tts/qwen3tts/requirements.txt
python servers/tts/qwen3tts/server.py
```

The default auto-mode endpoint URL is `http://127.0.0.1:8012`. You can also specify auto mode explicitly:

```powershell
python servers\tts\qwen3tts\server.py --mode auto
```

Auto mode inspects each `/synthesize` request: requests with `ref_audio` use the clone model, while requests with `instruct` use the VoiceDesign model. It keeps only one model loaded at a time and swaps models when the request type changes, so the first request after a swap may be slower.

## Register in TomoriBot

For most users, register the auto-mode server so one endpoint can support both voice-clone and VoiceDesign personas.

Run `/providers`, choose **Add New Custom Endpoint**, and use the speech API compatibility:

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8012`

After saving the connection, select it and use its model dropdown to add a Speech model. The model form
asks for **Voice Source Mode** and **Script Markup**; choose `Auto` and `Plain` for the auto-mode server.

Use `/providers` for endpoint registration and model setup. Then open `/config` > Models > Switch Models to select and activate the registered endpoint.

## Set Up Persona Voices

### Voice cloning

Use this for personas that should imitate a reference clip:

1. Prepare a clean 10-20 second voice clip with one speaker and no background music.
2. Open `/config` under Models > TTS Parameters & Voices and upload the clip.
3. Open `/config` under Persona > Voice, then choose the persona and the voice sample.

### VoiceDesign

Use this for personas that should use a written voice description instead of a sample:

1. Open `/config` under Persona > Voice and choose VoiceDesign.
2. Choose the persona.
3. Enter a natural-language voice prompt, such as the speaker's age, tone, accent, and delivery.

Remove a persona's VoiceDesign prompt from Persona > Voice in `/config`. During generation, TomoriBot sends the saved prompt in the `/synthesize` JSON body as `instruct`; one-off `voice_instructions` from the tool are appended

Auto mode keeps both setups. Personas configured under Persona > Voice in `/config` use clone synthesis or VoiceDesign synthesis according to their selection.

## (Optional) VoiceDesign-Only Server

Start the same server in VoiceDesign mode when serving `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`.

Windows PowerShell:

```powershell
servers\tts\qwen3tts\.venv\Scripts\Activate.ps1
$env:TOMORI_TTS_MODE = "voice-design"
python servers\tts\qwen3tts\server.py
```

Bash:

```bash
source servers/tts/qwen3tts/.venv/bin/activate
TOMORI_TTS_MODE=voice-design python servers/tts/qwen3tts/server.py
```

You can also pass `--mode voice-design` instead of setting `TOMORI_TTS_MODE`. The default VoiceDesign-only endpoint URL is `http://127.0.0.1:8014`.

Register it the same way as auto mode, but use endpoint URL `http://127.0.0.1:8014` and choose `VoiceDesign`
as the Voice Source Mode on the Speech model.
