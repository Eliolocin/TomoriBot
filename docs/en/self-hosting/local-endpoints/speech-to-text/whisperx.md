---
title: "WhisperX Transcription"
sidebar:
  order: 1
---

WhisperX is the recommended beginner-friendly local transcription path.

## Setup

Run these commands from the TomoriBot repo root, the folder where you cloned TomoriBot. The first command moves into the STT server folder:

### Windows PowerShell

```powershell
cd servers/stt
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python whisperx_server.py
```

### Linux/macOS Bash

```bash
cd servers/stt
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python whisperx_server.py
```

Keep that terminal open while TomoriBot is using WhisperX. The default endpoint URL is `http://127.0.0.1:8021`.

## Register in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and use the transcription API compatibility:

- API Compatibility: `openai-compatible-transcription`
- `endpoint_url`: `http://127.0.0.1:8021`

After saving the connection, select it and use its model dropdown to add `large-v3`, or
whatever `WHISPERX_MODEL` is set to, as a Transcription model.

Adding the model makes the endpoint active immediately. Use `/providers` later only when switching endpoints.

## Use Transcripts

After registration, TomoriBot transcribes audio attachments in the background and adds the text to chat context. Use `/config` > Behavior > Notices only if you also want transcripts posted visibly in chat.
