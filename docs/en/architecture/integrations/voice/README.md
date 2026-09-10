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
- `/config` > Persona > Voice assigns either the local sample or an ElevenLabs voice to a persona.
- `/config` > Engine > Notices controls visible transcript posting in chat. It does not enable or disable background STT.
- `/generate voice-message` drives the active endpoint directly, without a model call, so a clone sample or a design prompt can be auditioned in isolation.

`/config` > Persona > Voice requires Manage Server in a guild and remains available to the owner in a DM-backed workspace.

## Runtime Behavior

The `generate_voice_message` tool appears only when the active persona has a voice assignment compatible with the active speech endpoint.

Audio attachments are transcribed only when a `transcription` endpoint is configured. There is no legacy optional-key fallback after Phase 4.4.

## Shared Synthesis And Delivery

The tool and `/generate voice-message` converge on the same three modules, so a Discord quirk fixed once is fixed for both:

| Module | Responsibility |
|---|---|
| `src/utils/speech/voiceMessageSynthesis.ts` | Picks the backend for a resolved source and returns the `audio_generated` metric key with the audio. |
| `src/utils/speech/voiceSourceResolution.ts` | Pure source table: which voices an invocation may use, and in what pre-selection order. |
| `src/utils/discord/webhook/voiceMessageDelivery.ts` | Sends the native voice message and the transcript caption. |

`voiceMessageDelivery.ts` is deliberately not a generic attachment sender. Discord silently degrades rather than erroring on each of its quirks: `flags: 8192` with `waveform` and `duration_secs` has to be sent as raw multipart because `MessagePayload` drops unknown attachment fields, the bot REST path needs `passThroughBody` so the REST manager does not JSON-serialize the `FormData`, the webhook URL needs `wait=true` to return a message ID instead of a 204, and the content type has to be stripped to its bare MIME form because Discord rejects waveform metadata when it carries parameters.

## Voice Source Resolution

Any invocation can see up to four candidate sources, gated by what the active endpoint accepts:

| Source | Requires |
|---|---|
| Uploaded clip (`voice_sample`) | Endpoint accepts the clone shape (`ref_audio` + `ref_text`) |
| Typed prompt (`voice_design`) | Endpoint accepts the design shape (`instruct`) |
| Persona's assigned sample | Endpoint accepts the clone shape |
| Persona's design prompt | Endpoint accepts the design shape |

"Accepts the clone shape" means `api_style === "tts-clone"` with `voice_mode` of `clone` or `auto`; "accepts the design shape" means `tts-clone` with `voice_mode` of `voice-design` or `auto`. ElevenLabs is the degenerate case and accepts neither, so its only source is the persona's stored voice id.

Pre-selection order is upload, typed design prompt, persona sample, persona design prompt: intent expressed on this invocation outranks stored persona configuration, and between the two user-supplied sources the uploaded clip wins because clone output is the more deterministic of the two.

### `auto` Endpoint Disambiguation

An `auto` endpoint accepts both request shapes on one URL, distinguished by which fields are present. The chat tool has no user to ask, so it relies on the persona sentinel `speech_voice_name === "VoiceDesign"` to decide whether a persona's design prompt should be sent as `instruct`. `/generate voice-message` does not need the sentinel at all: it offers every source the endpoint accepts as a modal radio option, and the choice itself selects the request shape. A manager who registers an `auto` endpoint therefore does not have to set the sentinel for manual invocations to reach voice design, though the sentinel is still what lets the model pick that path mid-conversation.

Local setup guides:

- [Text-to-Speech (local engines)](../../../self-hosting/local-endpoints/text-to-speech/)
- [Speech-to-Text (local engines)](../../../self-hosting/local-endpoints/speech-to-text/)
