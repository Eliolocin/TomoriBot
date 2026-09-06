---
title: "Voice System"
sidebar:
  label: "Overview"
  groupLabel: "Voice"
---

TomoriBot has a bidirectional voice pipeline:

- inbound STT: user audio attachments become text for conversation context
- outbound TTS: personas can send native Discord voice messages

Phase 4 routes both through custom endpoint capabilities:

- `speech` for TTS
- `transcription` for STT

## Commands

- `/providers` connects ElevenLabs speech and transcription in one flow.
- `/providers` registers local `tts-clone` and `openai-compatible-transcription` endpoints.
- `/providers` switches the active TTS endpoint.
- `/providers` switches the active STT endpoint.
- `/config` > Models > TTS Parameters & Voices uploads the one server-local reference sample supported in Phase 4. You can upload any audio format; it is automatically converted to mono WAV and stored in S3/CloudFront in production or under `data/voice-samples/` in non-production. A 10-20 second clip with no background music is recommended.
- `/speech voice-assign` assigns either the local sample or an ElevenLabs voice to a persona.
- `/config` > Engine > Notices controls visible transcript posting in chat. It does not enable or disable background STT.

The compatibility `/speech` commands require Manage Server in a guild and remain available to the owner in a DM-backed workspace.

## Runtime Behavior

The `generate_voice_message` tool appears only when the active persona has a voice assignment compatible with the active speech endpoint.

Audio attachments are transcribed only when a `transcription` endpoint is configured. There is no legacy optional-key fallback after Phase 4.4.

Local setup guides:

- [Text-to-Speech (local engines)](../../../self-hosting/local-endpoints/text-to-speech/)
- [Speech-to-Text (local engines)](../../../self-hosting/local-endpoints/speech-to-text/)
