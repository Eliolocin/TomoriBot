---
title: "Video Generation"
---

This document summarizes the current video generation stack.

## Command Surface

- User-facing generation entrypoint: `src/commands/generate/video.ts`
- Admin model selection: `src/commands/model/video.ts`
- Admin quota controls:
  - `src/commands/moderation.ts`
  - `src/commands/server/quota/reset.ts`
- Capability/help exposure:
  - `src/commands/help/features.ts`
  - `src/tools/functionCalls/reviewCapabilities.ts`

## Runtime Flow

`/generate video` follows this sequence:

1. Load `TomoriState`.
2. Validate `videogen_enabled`.
3. Validate provider support for `nativeVideoGeneration`.
4. Validate configured API key and `video_model_id`.
5. Check video quota with `utils/quota/videoQuotaManager.ts`.
6. Show a modal for prompt, aspect ratio, required duration, optional FPS, and optional reference image.
7. Poll the provider asynchronously until the generated MP4 is ready.
8. Send the final file back to Discord.
9. Increment quota only after a successful delivery path.

This mirrors the image-generation architecture, but all provider implementations are asynchronous and return binary MP4 output rather than base64 images.

The user-facing `video_generation` tool notice now mirrors the image notice format: it includes the active video model codename, a trimmed copy of the raw tool-call prompt, optional reference-image usage, and a separate timing line. System-added prompt material is not shown.

The delivered video message also mirrors the image delivery format. `GenerateVideoTool.sendGeneratedVideo` wraps the MP4 in a Components V2 payload (`utils/discord/generatedVideoMessage.ts` → `buildGeneratedVideoComponentsV2Payload`): a `MediaGallery` item holds the `attachment://` video so Discord renders its inline player, and a `TextDisplay` footer shows a localized "Generated in Xs" line (`tools.video.generated_after_seconds_line`) below it. The timer is measured from `execute()` start to the send call. Each send path (persona webhook, then bot message) falls back to a plain attachment-only message if Components V2 is rejected; that fallback keeps the native inline player but drops the timing footer. Media Gallery is used rather than a plain `content` caption because message content always renders *above* attachments, whereas the footer should sit below the video to match generated images.

## Providers

Provider routing is resolved through `utils/provider/providerInfoRegistry.ts`.

Current native video implementations live in:

- `src/providers/google/googleVideoGeneration.ts`
- `src/providers/openrouter/openrouterVideoGeneration.ts`
- `src/providers/zai/zaiVideoGeneration.ts`

### OpenRouter: stable asynchronous API

OpenRouter video generation uses the stable `POST /api/v1/videos` endpoint. TomoriBot follows the
returned `polling_url` until the job reaches a terminal state, then downloads the first item in
`unsigned_urls` (or falls back to `/api/v1/videos/{jobId}/content?index=0`). Relative polling URLs
are resolved against `https://openrouter.ai`, and authenticated polling is restricted to that
origin so a response cannot redirect the API key to another host.

`utils/cache/openrouterVideoModelCache.ts` loads `GET /api/v1/videos/models` at startup and on
cache misses. The adapter uses the advertised durations, resolutions, aspect ratios, and frame
support to normalize requests. Scoped OpenRouter video registrations are accepted only when the
model appears in this dedicated catalog.

OpenRouter image-to-video requests use `frame_images` with `frame_type: "first_frame"`; they do
not use `input_references`, which OpenRouter defines as loose subject/style guidance. The
`generate_video` tool's explicit loop option adds the same image as `last_frame` when the model
advertises that capability. Unsupported first/last-frame requests fail before a paid job is
submitted and return a localized explanation.

### OpenRouter: external HTTP backends (TLS/HTTP fingerprint bypass)

OpenRouter's API sits behind Cloudflare, which uses TLS fingerprinting (JA3/JA4) and HTTP/2 fingerprinting (SETTINGS frames, ALPN negotiation) to identify HTTP clients. Bun's BoringSSL stack produces a non-standard fingerprint that Cloudflare serves a cached HTML page to (HTTP 200 with HTML body) instead of routing to the API origin. Both `fetch()` and Bun's `node:https` compatibility shim share this same fingerprint.

To work around this, `openrouterVideoGeneration.ts` uses `externalHttpRequest()` — a platform-aware dispatcher that spawns an external process for HTTP requests:

- **Windows (development)**: PowerShell 7 (`pwsh`) with `Invoke-WebRequest`. Uses .NET's Schannel TLS with proper HTTP/2 negotiation. Request data is piped via stdin as JSON; response body is base64-encoded for binary safety. Windows system curl lacks HTTP/2 support, so it cannot be used.
- **Linux / Docker (production)**: `curl` with HTTP/2 via `nghttp2` (standard on Alpine/Debian). Response headers and body are parsed from curl's `-i` output. Key flags: `--proto =https` (protocol restriction), `--data-raw` (no `@filename` expansion), `-H "Expect:"` (suppresses 100-Continue).

**Deployment requirements**:
- Windows: `pwsh` (PowerShell 7+) on `PATH`
- Linux/Docker: `curl` with HTTP/2 support on `PATH` (already in the Dockerfile via `apk add curl`)

The Google and Z.ai providers use Bun's native `fetch()` directly since their APIs are not affected by TLS fingerprinting.

The command supports:

- Text-to-video
- Image-to-video through an optional uploaded reference image
- Aspect ratio selection
- `duration` in seconds (required modal field, prefilled with the default)
- `fps` (optional modal field)

The built-in `generate_video` tool also supports:

- `duration` in seconds
- `resolution` as `480p`, `720p`, or `1080p`
- optional first-frame image-to-video through `media_id`
- optional looping through first/last-frame control

Tool defaults are:

- `duration = 5`
- `resolution = 720p`

`fps` is an optional, provider-dependent hint. Hosted providers (Google Veo, OpenRouter, Z.ai) do
not expose an FPS control and silently ignore it. Custom ComfyUI workflows can consume it via the
`TOMORI_VIDEO_FPS` / `TOMORI_FPS` placeholders; when the user leaves FPS blank, the
`COMFYUI_VIDEO_FPS` default (16) is substituted so workflow nodes stay valid.

Modal input bounds are env-configurable: `VIDEO_GEN_DEFAULT_DURATION_SECONDS` (default 5),
`VIDEO_GEN_MAX_DURATION_SECONDS` (default 20), and `VIDEO_GEN_MAX_FPS` (default 60). These are
UI-level guardrails only.

Provider adapters normalize unsupported values to the nearest supported provider/model combination instead of blindly passing invalid values through.

## Configuration and State

Video generation uses these server-scoped config fields:

- `server_capabilities_configs.videogen_enabled`
- `server_model_configs.video_model_id`

Provider snapshots also preserve `saved_provider_configs.video_model_id` for bookkeeping and cleanup, but Phase 1 `/config provider switch` does not automatically restore video model slots.

## Quotas

Video quotas are separate from image and text quotas because video generation is more expensive.

Tables:

- `video_quota_configs`
- `video_quotas`
- `video_serverwide_quotas`

Defaults:

- `daily_user_quota = 3`
- `serverwide_quota = 0` (`0` means unlimited)
- `serverwide_quota_resets_in = 365`

Management commands:

- `/moderation` (Quotas page)
- `/server quota reset`

Reset behavior supports both:

- per-user daily usage reset
- server-wide pool reset

## Discord Delivery Constraints

The command currently enforces Discord's standard upload ceiling and rejects oversized results before attempting to send them.

- current limit: `25 MB`
- file type: `mp4`

## Related Files

- `src/utils/quota/videoQuotaManager.ts`
- `src/types/db/schema.ts`
- `src/db/schema.sql`
- `src/utils/db/repositories/LlmRepository.ts`
- `src/utils/db/repositories/index.ts`
