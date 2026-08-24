---
title: "02: Raw Chunk Generation"
---

Opens the provider's HTTP stream and yields a `RawStreamChunk` for each token delivery, with provider-specific pre-processing applied before each yield.

**Contract:** `BaseStreamAdapter.startStream` (generator body) — `src/types/stream/interfaces.ts:182`
**Canonical implementation:** `GoogleStreamAdapter.startStream` (stream loop) — `src/providers/google/googleStreamAdapter.ts:292-373`

## Mission

After context assembly (stage 01) prepares the request payload, the adapter calls the provider's
streaming SDK and enters a `for await` loop over the raw HTTP response. Each provider chunk is
transformed by pre-processing logic specific to that adapter before being wrapped in a
`RawStreamChunk` envelope and yielded to the stage 04 orchestrator loop.

Pre-processing at this stage is distinct from normalization (stage 03): it operates on the
raw provider-native chunk *before* type classification, and exists to handle provider-specific
streaming quirks that cannot be cleanly expressed as normalization rules.

Three pre-processing steps run in Google's adapter (other adapters have their own):

1. **Chunk normalisation into simplified shape** (`normalizeGoogleStreamChunk`) — extracts `text`,
   `functionCalls`, `promptFeedback`, `candidates`, `thoughtSignature`, and `thoughtSummary` into
   a flat structure, discarding raw SDK wrapper objects.

2. **Text + function-call split** (`splitChunkWithTextAndFunctionCalls`) — when a single SDK
   response contains both text content and a function call, the adapter emits them as two separate
   `RawStreamChunk` objects so the orchestrator can flush the pre-tool-call text before returning
   the function call result.

3. **Speaker boundary fallback guard** (`applySpeakerBoundaryFallbackGuard`) — when
   `llm_stop_speaker_pattern_enabled` is true and the SDK stop-string mechanism fails to catch a
   speaker label mid-stream, this rolling holdback buffer (32 chars) scans for the pattern and
   emits a truncated chunk + stop signal before the speaker label reaches Discord.

Each iteration yields a `RawStreamChunk`:

```ts
{
  data:     unknown;                    // provider-native chunk shape
  provider: string;                     // e.g. "google"
  metadata: { timestamp: number; model?: string; [key: string]: unknown };
}
```

After the generator exhausts normally (or the speaker guard returns early), any buffered
speaker-guard tail is flushed as a final `RawStreamChunk` before the generator returns.
Errors from the provider SDK are caught and yielded as error chunks via
`BaseStreamAdapter.createProviderErrorChunk()` rather than thrown, so the orchestrator's
error path (stage 04) handles them uniformly.

## Shared parameter degradation

OpenRouter and providers based on `OpenAICompatibleStreamAdapter` (NVIDIA, DeepSeek, Z.ai, and
Custom) may reject a request either as a non-successful HTTP response or as an error event after
returning `200 OK` and opening the SSE stream. Both adapter families use the pure helpers in
`src/providers/utils/paramDegradation.ts` and the same per-request degradation queue. The
OpenAI-compatible family keeps its adapter-specific fetch implementation, including the Custom
provider's SSRF-guarded remote fetch.

1. Send the default payload, then try without `stream_options`.
2. Probe single optional parameters in the shared priority order. Both families then include an
   image-stripping attempt, the tools-only fallback, and a mandatory-keys-only payload last.
3. When an error message names known parameters that are present in the failing body, insert a
   targeted retry ahead of the remaining queue. All named parameters are removed together, so a
   joint rejection such as `min_p` plus `logit_bias` does not fall through to the minimal payload.
   A message that names droppable parameters justifies the retry on its own — it does not also
   need to match one of the classifier's status/wording heuristics.
4. When an error message rejects multimodal/image input rather than a parameter (e.g. a vLLM
   backend launched without `--enable-multimodal`, surfaced as a 500), insert a targeted
   image-strip retry ahead of the remaining queue instead of walking the sampler probes, since
   every payload still carrying image blocks would fail identically. Like the parameter-naming
   rule, this signal justifies the retry on its own.

Image stripping is notice-injecting, not silent: `stripImageBlocksWithNotice()` replaces each
message's removed image blocks with one `[System: ...]` text notice so the model stays aware an
image was attached and does not hallucinate or ignore it. Capability flags remain the correct
steady state — a model whose endpoint is known to reject images should carry `sees_images = false`
so context build routes attachments through the vision-tool/notice path with media IDs and no
wasted first request; the degradation rung is the safety net for wrong or stale flags.

Targeted retries are deduplicated by serialized request body and capped at three per request. The
result is not cached: routing or backend capabilities can differ on the next request, so degradation
applies only to the current stream.

A 502 is treated as a degradation signal only by OpenRouter (`degradeOn502`): its router may have
selected a backend that rejects the parameter combination, so retrying with fewer parameters can
land on a working configuration. For direct OpenAI-compatible providers a 502 is a genuine outage
that degradation cannot fix, so those adapters fail fast and let key rotation and model fallback
(chat pipeline stage 06) take over instead of walking the ladder against a dead endpoint.

An opt-in `degradeOnOpaque5xx` covers the inverse case: a backend that reports "I do not support
this input" as an internal server error rather than a parameter rejection. It fires only when the
status is 5xx **and** the message carries no diagnostic content of its own (empty, `error`,
`internal server error`), so a descriptive outage still fails fast. NVIDIA enables it because NIM
on the vLLM V2 model runner answers an unsupported request key with a bare
`Internal server error`, and when streaming it does so mid-SSE after a `200 OK`.

Adapters that inject request keys of their own (via `mutateRequestBody`) declare them in
`degradationPriorityKeys`. The ladder otherwise cannot tell an injected key from junk and sorts it
into the unknown tail, so a backend dropping support for one is never probed. Declared keys are
probed **before** the user's own samplers: each rung drops one key from the same baseline and the
ladder stops at the first success, so ordering is pure latency and the winning rung ships the same
payload either way. Reaching an injected key first cuts NVIDIA's recovery from eight round trips to
three, and a key the user never asked for is the better first hypothesis.

Declare only keys that are safe to drop. A key that changes the shape of the reply belongs in
`mandatoryBodyKeys` instead, because probing it early would find a "working" request that silently
lost a capability. NVIDIA declares `reasoning_budget` as droppable and keeps `chat_template_kwargs`
mandatory, since the latter is what enables thinking.

An SSE error can restart transparently only before the attempt commits. The commitment point is the
first meaningful chunk yielded to the consumer: visible text, reasoning, a tool-call delta, or usage.
Keepalives and empty chunks do not commit. On a degradable pre-commit error, the adapter cancels and
aborts that response, resets all per-attempt accumulators and output guards, and starts the next
degraded attempt without yielding the error. Once committed, errors are yielded normally; restarting
then could duplicate output or tool activity already observed by the consumer.

Degradation and recovery are operator-visible through structured terminal logs only. They do not add
thought-log entries or user-facing Discord notices. Three logs exist specifically so an incident
does not require a live bisect to reproduce: the raw SSE error event (including the provider's
`error.type`) whenever one arrives before commitment, the raw `responseErrorText` on a terminal
HTTP failure before `createOpenAICompatibleHttpError` collapses it to a message, and the usual
retry/recovery lines.

Error classification is shared between transports. `classifyOpenAICompatibleStatus()` maps a status
code and message onto a `ProviderError` type for both the thrown-fetch path and the SSE path, so a
mid-stream 500 is `provider_overloaded` with `retryable: true` exactly as the HTTP path reports it.
An SSE error event's `type` (e.g. `internal_server_error`) is carried into the `ProviderError`
message when it is not already there, because an opaque message is the common case for this path.

## Input

Continuation from stage 01. The HTTP streaming connection is already open. No new inputs.

## Output

Async generator of `RawStreamChunk` objects. Each chunk carries:

- `data` — provider-native streaming response object (e.g., `GoogleStreamChunk`, OpenAI SSE delta).
- `provider` — string identifying the adapter (e.g., `"google"`, `"openrouter"`).
- `metadata.timestamp` — milliseconds since epoch at yield time.
- `metadata.model` — model codename (where available from the provider's response headers/body).

The generator return value is `void`; the orchestrator drives termination by consuming the
generator until it returns.

## Side effects

- **Per yielded chunk:** `BaseStreamAdapter.onRawChunk()` is called (no-op in the base class;
  subclasses may override for logging or metrics).
- **Speaker guard:** Mutates adapter instance state (`speakerGuardPendingTail`,
  `streamedTextTail`) across chunk boundaries — these fields are reset at the start of each
  `startStream()` call so they are scoped to a single stream lifetime.
- **Error chunks:** `BaseStreamAdapter.onProviderError()` is called when an error is caught. The
  base implementation records the `provider_error` stat counter (`{provider}:{code}`), which is the
  only aggregate record of provider failures that exists, so a subclass override must call `super`.
  OpenRouter and OpenAI-compatible adapters suppress only degradable SSE errors received before
  commitment while transparently retrying the current request.

## Invariants

After each `yield`:

- The yielded `RawStreamChunk.data` is in the provider-specific format that `processChunk`
  (stage 03) knows how to parse — no cross-adapter chunk shapes are ever mixed.
- If the speaker guard triggered, the chunk yielded before return has `text` truncated to the
  boundary and the generator returns without further yields.
- Terminal SDK/provider errors are yielded as error chunks, never thrown through the generator
  boundary. A degradable OpenRouter or OpenAI-compatible error before commitment is consumed by the
  bounded retry loop.

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `BaseStreamAdapter.startStream()` generator body | **A new provider's adapter implements the full generator.** Pre-processing logic (dedup, guard, split) is adapter-local — it does not need to match other adapters' approaches. |
| `BaseStreamAdapter.onRawChunk(chunk)` | Override hook for instrumentation (e.g., logging raw chunk payloads). Internal — no behavioral contract; the orchestrator never sees override output. |
| `BaseStreamAdapter.onProviderError(error)` | Override hook for per-provider error telemetry. Internal — same caveat as `onRawChunk`. |
| Speaker boundary guard (`truncateBeforeGenericSpeakerLine`) | `src/utils/text/processors/llmOutputProcessor.ts`. Internal — coupled to TomoriBot's persona-name speaker-label convention; the `llm_stop_speaker_pattern_enabled` DB flag is the configuration surface. |
| Text deduplication (`deduplicateChunkTextAgainstRecentStream` / `getTextDelta`) | Internal — a workaround for Gemini SDK repeating the last few tokens in overlapping chunks; not a general extension seam. |

## Configuration

| Source | Key / Env var | Default | Purpose |
|---|---|---|---|
| `TomoriState.config` | `llm_stop_speaker_pattern_enabled` | `false` | Activates the holdback-based speaker guard in the generator loop |
| `StreamAdapter` constant | `SPEAKER_GUARD_HOLDBACK_CHARS` | `32` | Characters held back at the tail before pattern matching (Google adapter) |
| `StreamAdapter` constant | `STREAM_TEXT_TAIL_CHARS` | `4096` | Rolling dedup window size in characters (Google adapter) |
| `StreamAdapter` constant | `STREAM_TEXT_MIN_DEDUP_CHARS` | `8` | Minimum chunk length before dedup logic runs (Google adapter) |

## Related docs

- Stage 01 (request construction that precedes this): → [`01-context-assembly.md`](01-context-assembly.md)
- Stage 03 (chunk normalization that follows each yield): → [`03-chunk-normalization.md`](03-chunk-normalization.md)
- Stage 04 (orchestrator that consumes this generator): → [`04-orchestrator-state-machine.md`](04-orchestrator-state-machine.md)
- `RawStreamChunk` type definition: `src/types/stream/interfaces.ts:155`
- Speaker guard text processor: `src/utils/text/processors/llmOutputProcessor.ts`
