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
| `src/utils/speech/voiceSourceCapabilities.ts` | Which request shapes the active endpoint accepts. |
| `src/utils/speech/voiceMessageSynthesis.ts` | Picks the backend for a resolved source and returns the `audio_generated` metric key with the audio. |
| `src/utils/speech/voiceSourceResolution.ts` | Pure source table: which voices an invocation may use, and in what pre-selection order. |
| `src/utils/discord/webhook/voiceMessageDelivery.ts` | Sends the native voice message and the transcript caption. |

`voiceMessageDelivery.ts` is deliberately not a generic attachment sender. Discord silently degrades rather than erroring on each of its quirks: `flags: 8192` with `waveform` and `duration_secs` has to be sent as raw multipart because `MessagePayload` drops unknown attachment fields, the bot REST path needs `passThroughBody` so the REST manager does not JSON-serialize the `FormData`, the webhook URL needs `wait=true` to return a message ID instead of a 204, and the content type has to be stripped to its bare MIME form because Discord rejects waveform metadata when it carries parameters.

### Delivery Identity

Who a voice message appears to be from follows the same main-versus-alter split `resolveResponseTarget`
makes on the chat path:

| Persona | Transport | Identity |
|---|---|---|
| Main | Bot REST | The bot's own name and avatar |
| Alter | Persona webhook | `resolvePersonaWebhookIdentity`, with `avatarDataUri` preferred over `avatarUrl` |

The main persona is the bot, so it needs no webhook and the command never asks for Manage Webhooks
on its behalf. For an alter, a webhook failure is surfaced as an error rather than posting under
the bot's identity, because the persona identity is the point of the request.

Reading `avatarUrl` alone is a live trap: a locally stored avatar (the `presets/` sprite pipeline,
and any alter outside production) resolves to `avatarDataUri` with no URL form, so an
`avatarUrl`-only read leaves the webhook posting with the bot's default picture and no error
anywhere.

The delivery target's `channel` is the channel the message belongs in, including a thread, never a
thread's webhook-hosting parent: the bot REST paths address the channel by id, so a parent here
posts the audio in the wrong place.

## Voice Source Resolution

Any invocation can see up to four candidate sources, gated by what the active endpoint accepts:

| Source | Requires |
|---|---|
| Uploaded clip (`voice_sample`) | Endpoint accepts the clone shape (`ref_audio` + `ref_text`) |
| Typed prompt (`voice_design`) | Endpoint accepts the design shape (`instruct`) |
| Persona's assigned sample | Endpoint accepts the clone shape |
| Persona's design prompt | Endpoint accepts the design shape |

"Accepts the clone shape" means `api_style === "tts-clone"` with `voice_mode` of `clone` or `auto`; "accepts the design shape" means `tts-clone` with `voice_mode` of `voice-design` or `auto`. ElevenLabs is the degenerate case and accepts neither, so its only source is the persona's stored voice id.

`resolveVoiceSourceCapabilities()` is the single implementation of that table, and both the modal and the synthesis dispatcher read it. The dispatcher refuses any source whose shape the endpoint does not accept, and it does so before reaching a backend, so a mismatch surfaces as a configuration error rather than as a request a TTS server has to reject.

Two predicates in `ttsVoiceDesignAdapter.ts` are easy to confuse, and confusing them once already disabled voice design on every `auto` deployment:

- `isVoiceDesignEndpoint()` is true only for a **dedicated** voice-design endpoint.
- `acceptsDesignShape()` is true for a dedicated voice-design endpoint **and** for `auto`.

Anywhere the question is "can this endpoint receive a design body", the answer is `acceptsDesignShape()` or the capability table, never `isVoiceDesignEndpoint()`.

Pre-selection order is upload, typed design prompt, persona sample, persona design prompt: intent expressed on this invocation outranks stored persona configuration, and between the two user-supplied sources the uploaded clip wins because clone output is the more deterministic of the two.

### `auto` Endpoint Disambiguation

An `auto` endpoint accepts both request shapes on one URL, distinguished by which fields are present.

For the chat tool, the persona sentinel `speech_voice_name === "VoiceDesign"` picks the shape: a persona on an `auto` endpoint that holds both a sample and a design prompt keeps using its sample unless its voice name is the sentinel. That sentinel is part of the tool's branch condition, not a hint, so it has to stay in whatever selects the source.

`/generate voice-message` needs no sentinel, because the user is present and can be asked: it offers every source the endpoint accepts as a modal radio option, and the choice itself selects the request shape. A manager registering an `auto` endpoint therefore does not have to set the sentinel to reach voice design manually, though the sentinel is still what lets the model pick that path mid-conversation. Both paths converge on the dispatcher, which decides purely from the resolved source shape and the capability table.

Local setup guides:

- [Text-to-Speech (local engines)](../../../self-hosting/local-endpoints/text-to-speech/)
- [Speech-to-Text (local engines)](../../../self-hosting/local-endpoints/speech-to-text/)
