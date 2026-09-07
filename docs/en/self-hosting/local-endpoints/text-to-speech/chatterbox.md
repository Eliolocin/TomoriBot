---
title: "Chatterbox TTS"
aiGenerated: false
---

Use `servers/tts/chatterbox/server.py` for a fast, multilingual TTS voice cloning endpoint. It defaults to Chatterbox-Turbo, preserving bracket delivery tags and fast inference.

## Setup

Run these commands from the TomoriBot repo root, the folder where you cloned TomoriBot:

### Windows PowerShell

```powershell
python -m venv servers\tts\chatterbox\.venv
servers\tts\chatterbox\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install numpy
pip install -r servers\tts\chatterbox\requirements.txt
python servers\tts\chatterbox\server.py
```

### Linux/macOS Bash

```bash
python3 -m venv servers/tts/chatterbox/.venv
source servers/tts/chatterbox/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install numpy
python -m pip install -r servers/tts/chatterbox/requirements.txt
python servers/tts/chatterbox/server.py
```

Keep that terminal open while TomoriBot is using Chatterbox. The default endpoint URL is `http://127.0.0.1:8011`.

## Register in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and use the speech API compatibility:

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8011`

After saving the connection, select it and use its model dropdown to add a Speech model. Choose `Voice Clone`
as the Voice Source Mode and `Bracket Tags` as the Script Markup so delivery tags survive the send.

Adding the model makes the endpoint active immediately. Use `/providers` later only when switching between speech endpoints.

## Set Up a Persona Voice

1. Prepare a clean 10-20 second voice clip with one speaker and no background music.
2. Open `/config` under Models > TTS Parameters & Voices and upload the clip.
3. Open `/config` under Persona > Voice, then choose the persona and the voice sample.

Chatterbox can use bracket delivery tags such as `[laugh]` and `[sigh]` when Turbo mode is enabled.

## Optional Tuning

Use `/config` under Models > TTS Parameters & Voices to tune the Chatterbox request payload:

- `turbo` defaults to `true`. When enabled, TomoriBot keeps supported Chatterbox-Turbo event tags and strips unsupported bracket descriptors before the wrapper uses `ChatterboxTurboTTS.model.generate(...)`.
- `cfg_weight` defaults to `0.5`. Minimum is `0`; TomoriBot does not set a hard maximum. It only applies when `turbo` is `false`; lower values can help slow fast reference voices, while higher values follow the reference more strongly.
- `exaggeration` defaults to `0.5`. Minimum is `0`; TomoriBot does not set a hard maximum. It only applies when `turbo` is `false`; higher values make delivery more expressive or dramatic and may speed speech up.

Supported Turbo event tags are `[clear throat]`, `[sigh]`, `[shush]`, `[cough]`, `[groan]`, `[sniff]`, `[gasp]`, `[chuckle]`, and `[laugh]`. Unsupported descriptors such as `[stammers]`, `[blushes]`, or `[smiles]` are stripped instead of being sent to TTS.

When `turbo` is disabled, TomoriBot strips all bracket descriptors before sending text to TTS, then the wrapper lazily loads the standard `ChatterboxTTS` model and calls `model.generate(..., cfg_weight, exaggeration)`.
