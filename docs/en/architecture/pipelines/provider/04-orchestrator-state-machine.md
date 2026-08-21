---
title: "04: Orchestrator State Machine"
---

Drives the provider generator as a state machine, routing each `ProcessedChunk` and resolving stop signals, timeouts, and stream completion into a `StreamResult`.

**File:** `src/utils/discord/stream/stateMachine.ts:119-485`

## Mission

`StreamOrchestrator.executeStream()` is the central coordinator of the Discord-side pipeline.
It owns the `for await` loop over the stage 02 generator and makes the per-chunk decisions that
determine the shape of the final `StreamResult`. Three concerns are woven through the loop:

1. **Stop / interrupt resolution** — the stop registry is checked both before processing each
   chunk and again immediately after it is written out. A user stop (`/kill`) flushes the pending
   buffer and returns `{ status: "stopped_by_user" }`. A follow-up interrupt discards the buffer
   and returns `{ status: "follow_up_interrupt" }` so the chat pipeline can restart for the new
   message. The post-write check exists because delivery-side stops (the send and flush limits in
   stage 07) are raised *during* the write; resolving them there cancels the upstream response one
   chunk sooner than waiting for the next loop iteration would.

2. **Chunk routing** — after stop checks, the `ProcessedChunk.type` determines the path:
   - `"text"` → stage 05 (`StreamBufferFlusher.processTextChunk`)
   - `"function_call"` → flush the pending buffer → return `{ status: "function_call", data: functionCall }`
   - `"error"` → flush the pending buffer → display an error embed if not suppressed →
     return `{ status: "error", data: error }`
   - `"done"` → record `terminalDoneMetadata` (finish reason); continue the loop (generator will
     exhaust on the next `await`)
   - **Token usage** — on *any* chunk (not just `"done"`), if `metadata.usage` is present it is
     normalized (`normalizeProviderUsage`) into `state.usage`, latest-wins. This captures providers
     that emit usage on a trailing empty-choices chunk (OpenAI `include_usage`) or that clobber the
     terminal `done` metadata (Anthropic `message_stop`). `state.usage` is drained into
     `StreamResult.usage` on the `function_call` and `completed` results.

3. **Inactivity timeout** — a rolling `setTimeout` resets on every chunk (`resetInactivityTimer`).
   If no chunk arrives for `config.inactivityTimeoutMs`, `state.timedOut = true`. The loop detects
   this flag on the next iteration (or at generator exhaust) and returns `{ status: "timeout" }`.

After the generator exhausts normally, `completeStreamAfterProviderEnd()` runs the final flush
path (stage 05 `flushFinalBuffer`), checks for timeout, and assembles the completed `StreamResult`.

The outer `streamToDiscord()` method (the public entry point) calls `executeStream()` and then
does one additional check: if the result is `"completed"` but `wasEmptyStreamResponse()` is true
(no text and no function call were emitted), it returns `{ status: "empty_response" }` instead,
so the tool-loop pipeline's retry logic can handle it.

## Input

- `provider: StreamProvider` — the stage 02/03 adapter (generator + `processChunk`).
- `config: StreamConfig` — timing and buffer size configuration.
- `context: StreamContext` — full Discord and application state (channel, tomoriState, etc.).

`StreamMetrics` and `StreamState` objects are created fresh at the start of `executeStream()`.

## Output

`StreamResult` — defined at `src/types/provider/interfaces.ts:88`:

```ts
interface StreamResult {
  status:
    | "completed"        // generator exhausted; text was sent
    | "function_call"    // provider requested a tool; tool-loop handles it
    | "error"            // provider or Discord error
    | "timeout"          // inactivity timer expired
    | "stopped_by_user"  // user /kill command
    | "empty_response"   // completed but no text or function call
    | "follow_up_interrupt"; // new user message arrived during generation
  data?: unknown | Error;
  accumulatedText?: string;    // all text sent to Discord (for STM write)
  detailsContent?: string;     // <details> block body (for STM write)
  stopReason?: StreamStopReason;
  thoughtLog?: ThoughtLogPayload;
  naiContinuationPrefill?: string; // NAI-specific trailing fragment for retry
  spritesShown?: SpriteShownEntry[]; // { name, isIdentity } per delivered sprite (sprite_shown + sprite_emotion attribution)
  usage?: TokenUsage;              // real provider token usage, normalized (when surfaced)
}
```

`usage` carries the provider's real `{ inputTokens, outputTokens }` for this segment when the
provider reports it (OpenRouter, OpenAI-compatible, Anthropic, Gemini). The post-turn stat
recorder (`recordUsageStats`) sums it across the turn's segments — each tool-loop request is
billed separately, so the sum is billing-accurate — and falls back to the character estimate
(`@/utils/text/tokenEstimate`) only when no segment surfaced usage.

## Side effects

- **Inactivity timer** — a `setTimeout` is set on entry and cleared in `finally`. The timer runs
  against `NodeJS.Timeout` — it is always cleared before the method returns.
- **Stop-request mutation** — `clearStopRequest(channelId)` is called on exit paths that consumed
  a stop. The stop registry is a shared module-level map in `stopRequests.ts`.
- **Error embed** — when `chunk.type === "error"` and `!context.suppressUserErrors`, calls
  `StreamErrorUi.handleProviderError()` which sends a Discord embed to the channel. The embed is
  composed centrally: a provider's localized headline (`createErrorDescription`) followed by the
  **raw provider detail** for every error type, extracted via `getProviderErrorDetail` and
  truncated to Discord's embed description limit. This means providers that map known codes to
  hardcoded locale strings (e.g. OpenRouter) no longer hide the actual provider message; the detail
  is de-duped so a provider that already appended it is not echoed twice. Recognized `model_error`
  failures additionally get a dedicated "Model Configuration Error" title. This is the **sole**
  embed send path for `ProviderError` types — the downstream response sink (`emitStreamResult` in
  `responseEmitter.ts`) deliberately skips the generic fallback embed when `result.data` is a
  `ProviderError`, to avoid double-sending.
- **Timeout embed** — when the inactivity timer fires and user errors are not suppressed, sends
  a timeout embed via `sendStandardEmbed()`.
- **Progress callback** — calls `context.onStreamProgress?.()` on each chunk to reset the
  rolling timeout in the stage 01 caller (`streamOnce` in the tool-loop pipeline).
- **`currentTurnModelParts` accumulation** — stage 05 (`processTextChunk`) pushes text parts into
  `context.currentTurnModelParts` as a side effect; the orchestrator does not do this directly.

## Invariants

After this stage:

- Exactly one `StreamResult` is returned; the method never throws to its caller
  (`streamToDiscord` catches all errors and converts them to `{ status: "error" }`).
- The inactivity timer has been cleared unconditionally (via `finally`).
- If `status === "function_call"`, `result.data` is a `FunctionCall` and
  `result.accumulatedText` contains all text sent to Discord before the tool call.
- If `status === "completed"`, all buffered text has been flushed (including final `<think>`
  and `<details>` block captures).
- `clearStopRequest` has been called for any stop that was consumed during this stream.

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `StreamOrchestrator.streamToDiscord()` public method | The universal Discord streaming entry point — `src/types/stream/interfaces.ts:313`. All providers delegate here. Internal — the orchestrator is not designed to be replaced; new providers plug in via the `StreamProvider` adapter contract. |
| Stop registry (`requestStop`, `hasStopRequest`, `clearStopRequest`) | `src/utils/discord/stream/stopRequests.ts`. The stop registry is a shared per-channel state map. A plugin that wants to interrupt streaming (e.g., a moderation system) would call `StreamOrchestrator.requestStop(channelId, requesterId)`. → plugin plan candidate |
| `context.onStreamProgress` callback | Set by the tool-loop pipeline (`streamOnce`) before calling `streamToDiscord`. The orchestrator calls it on each chunk. Internal — the callback is an operational heartbeat, not a plugin seam. |
| `StreamResult` status union | Consumed by the tool-loop pipeline's outer switch. Adding a new status requires changes in both the orchestrator and the tool-loop consumer. Internal until the tool-loop plugin contract is defined. |
| `context.suppressUserErrors` | When `true`, error and timeout embeds are not sent to Discord (used during retries in `runGenerationTurn`). Internal — set by the chat pipeline's key-rotation loop. |

## Configuration

| Source | Key / Env var | Default | Purpose |
|---|---|---|---|
| `StreamConfig` / env var | `INACTIVITY_TIMEOUT_MS` | `120 000` ms | Time with no chunk before stream is considered stalled |
| `TomoriState.config` | `send_message_limit` | `0` (no limit) | Maximum Discord messages per stream; enforced in stage 07 |

## Related docs

- Stop signal registry: `src/utils/discord/stream/stopRequests.ts`
- Error embed rendering: `src/utils/discord/stream/errorUi.ts`
- Empty-response detection: `wasEmptyStreamResponse` in `src/utils/discord/stream/thoughtLog.ts`
- Stage 05 (text path from this stage): → [`05-buffer-management.md`](05-buffer-management.md)
- Tool-loop consumer of `StreamResult`: → [tool-loop pipeline — Stage 01](../tool-loop/01-stream-once)
- `StreamResult` type: `src/types/provider/interfaces.ts:88`
