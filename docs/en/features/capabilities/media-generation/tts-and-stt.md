---
title: "Voice: TTS & STT"
sidebar:
  order: 3
---

TomoriBot can **speak** (text-to-speech) and **listen** (speech-to-text):

- **TTS** lets her reply with native Discord voice messages.
- **STT** turns user audio attachments into text she can use as conversation context.

Both work through the same endpoint system. The quickest path is **ElevenLabs** (cloud,
documented in full below). If you'd rather run voice on your own hardware, use a local engine
and follow the self-hosting guides.

## Text-to-Speech

### ElevenLabs (cloud, easiest)

1. Get an API key from [ElevenLabs](https://elevenlabs.io/app/settings/api-keys).
2. Run `/providers`, choose **Add New Provider**, select **ElevenLabs**, and paste the key. This flow:
   - registers the ElevenLabs **speech** endpoint (and the **transcription** endpoint too),
   - selects them as active,
   - can assign a voice to one persona on the spot.
3. Assign voices to additional personas with `/speech voice-assign`. Browse voices in the
   [ElevenLabs Voice Library](https://elevenlabs.io/app/voice-library), where you can also
   clone your own.

Select ElevenLabs in `/providers`, then choose **Edit Endpoint** anytime you need to update the key.

Notes:

- On the **free plan, only premade voices work**. Browse the
  [premade voice list](https://elevenlabs-sdk.mintlify.app/voices/premade-voices).
- Characters are counted when she generates and reads voice messages; the free tier has
  monthly limits — check your ElevenLabs dashboard.
- Voice replies are gated by `voice_message_enabled` and require the active persona to have a
  voice assigned.

In `/help`, choose **Features**, then **Speech**, for the same walkthrough in Discord.

### Local voice-cloning engines (self-hosted)

On a self-hosted instance you can run a local voice-clone server instead. The general flow is:
start the wrapper server, register its connection and model with `/providers`, select it with
`/providers`, upload a sample with `/speech voice-add`, then assign it with
`/speech voice-assign`. Any audio format is accepted (auto-converted to mono WAV); 10–20
second clips with no background music work best.

Each engine has its own setup guide:

- [Chatterbox-Turbo](/self-hosting/local-endpoints/text-to-speech/chatterbox/) — fast, English-only, supports
  bracket delivery tags like `[excited]`.
- [Qwen3-TTS](/self-hosting/local-endpoints/text-to-speech/qwen3tts/) — multilingual (10 languages), plus a
  natural-language VoiceDesign mode.
- [IrodoriTTS](/self-hosting/local-endpoints/text-to-speech/irodoritts/) — Japanese-specialized, reads emoji
  as emotion cues.

See the [Text-to-Speech](/self-hosting/local-endpoints/text-to-speech/) hub for the full list.

## Speech-to-Text

Transcription endpoints turn user audio attachments into text for background conversation
context. Whether transcripts are **visibly posted** in chat is controlled separately by
`/config` > Behavior > Notices.

### ElevenLabs (cloud)

Already covered above — adding ElevenLabs from `/providers` registers the transcription endpoint alongside
speech. Use `/providers` to pick between transcription endpoints.

### Local engines (self-hosted)

- [WhisperX](/self-hosting/local-endpoints/speech-to-text/whisperx/) — the recommended local path; ~100
  languages, GPU-accelerated, multiple model sizes.
- [KoboldCPP](/self-hosting/local-endpoints/speech-to-text/koboldcpp/) — works if your build exposes an
  OpenAI-compatible transcription endpoint.
- [whisper.cpp](/self-hosting/local-endpoints/speech-to-text/whispercpp/).

See the [Speech-to-Text](/self-hosting/local-endpoints/speech-to-text/) hub for the full list. For the
Discord summary, run `/help`, then choose **Features** and **Transcription**.
