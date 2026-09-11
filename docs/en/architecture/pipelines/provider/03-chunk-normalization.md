---
title: "03: Chunk Normalization"
---

Converts a provider-native `RawStreamChunk` into the uniform `ProcessedChunk` shape the orchestrator routes.

**Contract:** `BaseStreamAdapter.processChunk` — `src/types/stream/interfaces.ts:247`
**Canonical implementation:** `GoogleStreamAdapter.processChunk` — `src/providers/google/googleStreamAdapter.ts:649-760`

## Mission

Each `RawStreamChunk` yielded by stage 02 is immediately passed to `processChunk()` inside the
stage 04 orchestrator loop. This method is the boundary at which all provider-specific chunk
formats collapse into the single `ProcessedChunk` union that the orchestrator understands:

```ts
interface ProcessedChunk {
  type: "text" | "function_call" | "error" | "done";
  content?: string;           // type="text"
  functionCall?: FunctionCall; // type="function_call"
  error?: ProviderError;       // type="error"
  thoughts?: ThoughtLogEntry[]; // any type — thought log capture
  metadata?: Record<string, unknown>; // terminal metadata (finish reason, thought signature)
}
```

The method also handles three additional responsibilities:

- **Error normalisation** — raw SDK errors (HTTP status codes, provider-specific error objects)
  are converted to the shared `ProviderError` shape via `handleProviderError()`. This includes
  classifying the error type (`api_error`, `rate_limit`, `content_blocked`, `timeout`,
  `provider_overloaded`, `model_error`) and setting `retryable` so the stage 04 orchestrator and
  the upstream key-rotation logic in `runGenerationTurn` can make retry decisions without
  inspecting provider-specific error objects. `model_error` is reserved for model-selection or
  model-availability failures such as "unsupported model" or "model not found"; the stream UI
  surfaces the provider's raw supported-model details instead of hiding them behind a generic 400.

- **Thought log extraction** — for providers that emit reasoning fields, thought summaries, or
  thought signatures (for example Google/Gemini `part.thought`, `thoughtSummary`, and
  `thoughtSignature` fields), these are extracted into `ThoughtLogEntry[]` on the returned chunk
  so the orchestrator can accumulate them into `state.thoughtSummarySegments` /
  `state.thoughtRawSegments` independently of visible text. For OpenRouter, the upstream serving
  backend (the chunk-level `provider` field, e.g. `minimax-cn`) is also carried on
  `ProcessedChunk.servingProvider`, recorded into `state.servingProvider` (first non-empty wins), and
  rendered in the thought-log footer as `Provider: openrouter via <backend>` — so a backend that
  bleeds reasoning into content can be identified and pinned/avoided.

- **Leaked reasoning-tag guardrails** — the clean path is the provider (or OpenRouter) returning
  reasoning in a dedicated field. When a backend instead leaks reasoning into `delta.content`,
  OpenAI-compatible adapters (`openrouter`, `openaiCompatible`) run two worst-case guards over the
  text delta: `ThinkBlockContentStripper` (reroutes `<think>…</think>` blocks — including stray
  closers split across chunks — into `delta.reasoning`) and `ReasoningContentSpillGuard` (catches a
  *tagless* reasoning tail glued to the first visible delta — e.g. `must do.Hello!`). The spill guard
  only fires on the first visible content after reasoning, when that content starts lowercase and a
  sentence boundary is **glued** (no following whitespace). It strips when EITHER the text after the
  boundary looks like an answer start (uppercase / caseless letter, emoji, or quote/bracket — catches
  `wait.Actually`) OR the fragment before the boundary is a multi-word clause (catches a casual
  lowercase reply glued onto a reasoning tail, e.g. `g it out.hey master 👋`, where capitalization is
  blind because the real reply is also lowercase). A *spaced* boundary is treated as the model's own
  prose and emitted untouched; the missing space is the fingerprint of a backend concatenating its
  reasoning buffer onto content with no separator (so `wait. Actually` is two real sentences, but
  `wait.Actually` is a seam). A single-word fragment glued to a lowercase continuation is left alone.
  Dotted code
  identifiers are protected by an inline-code guard: a boundary preceded by an odd number of
  backticks (inside a `` `obj.Method` `` span, or a still-open one mid-stream) is left intact, as is
  code at the very start of content (a leading backtick is not lowercase). Bare, non-backticked
  identifiers in prose are accepted collateral of the aggressiveness. The **shape** of a think tag is
  defined once in
  `src/providers/utils/reasoningTags.ts` and is namespace-aware (`<think>`, `<mm:think>`,
  `<ns:think>`); the stripper, the Discord-layer `bufferManager`, and the final `cleanLLMOutput`
  sweep all consume it. Adding a new vendor namespace is a one-line change there. Note: API stop
  strings (`stopStrings.ts`) are matched literally by the provider, so namespaced close tags must be
  added per model rule explicitly rather than via the shared pattern.

- **Custom verbatim tool-call fallback** — when
  `server_capabilities_configs.verbatim_tool_calling_enabled` is true, the active Custom text model
  has tools, and the request includes OpenAI-compatible tool schemas, `CustomStreamAdapter` runs
  `VerbatimToolCallParser` over visible `delta.content` after existing Custom/Gemma cleanup. It scans
  the stream for an anchor `<knownToolName>(` — only names from the exposed tool set trigger — then
  accumulates from that name until the parentheses balance (quote-aware, so a `)` inside a JSON string
  does not close early) and parses the `name(...)` body. The call may be **bare** or wrapped in an
  inline code span / fenced block, and **prose before it is allowed** (chat models narrate before they
  act): leading narration is emitted as normal text and the call is recovered after it, e.g.
  `` Fine. `generate_image({"prompt":"a cat","mode":"txt2img"})` `` or the same call with no backticks.
  The parse step is the false-positive guard — a tool name merely *mentioned* in prose
  (`generate_image (it makes art)`) fails JSON/arity validation and is released as text. Successful
  parses are emitted as `type: "function_call"` before the literal text reaches Discord; rejected or
  incomplete text is released normally. Because the stream adapter drops `visibleText` whenever a
  `functionCall` is present, the parser emits any preceding prose first (call unresolved) and resolves
  the call on a later chunk or at stream flush.

- **Truncated tool-call recovery**: an OpenAI-compatible endpoint streams tool arguments as
  text deltas, so a proxy timeout, a socket reset, or one dropped delta can end the payload
  mid-token. `JSON.parse` rejects such a payload whole, which would discard every argument key
  the model had already emitted in full. `openaiCompatibleStreamAdapter` therefore falls back to
  `tryRepairIncompleteJson` (`src/utils/text/jsonRepair.ts`) when the parse throws. The repair
  is structural: it removes the one incomplete trailing fragment (an unterminated string, a
  half-written keyword, a dangling key) and closes the containers still open, then proves the
  result with its own `JSON.parse` probe. It never fabricates a value, never edits a complete
  string, and refuses a payload that is malformed rather than truncated, so a caller keeps the
  original failure path. A repaired call is marked `FunctionCall.argumentsTruncated`, because
  the recovered keys are a subset of what the model was writing rather than the call it
  intended. The tool loop refuses to dispatch such a call (see
  [tool-loop stage 02](../tool-loop/02-execute-tool-call.md)).

## Input

`chunk: RawStreamChunk` — the provider-native envelope yielded by stage 02.

## Output

`ProcessedChunk` — one of four variants:

| `type` | Carries | Orchestrator action |
|---|---|---|
| `"text"` | `content: string` | Route to stage 05 buffer flusher |
| `"function_call"` | `functionCall: FunctionCall` | Flush pending buffer → return `{ status: "function_call" }` |
| `"error"` | `error: ProviderError` | Flush pending buffer → show error embed → return `{ status: "error" }` |
| `"done"` | `metadata?: { finishReason }` | Record terminal metadata; continue loop (generator will exhaust next) |

Any variant may additionally carry `thoughts?: ThoughtLogEntry[]` when the provider emits
reasoning content in-band.

## Side effects

- None. `processChunk` is a pure transformation — it does not mutate `StreamState`, call Discord
  APIs, or trigger any timer. All side effects are owned by the orchestrator and downstream stages.

## Invariants

After this stage:

- The returned chunk's `type` is one of exactly `"text"`, `"function_call"`, `"error"`, `"done"`.
- If `type === "error"`, `chunk.error` is a fully-formed `ProviderError` with `type`, `message`,
  `retryable`, and `code` set. `originalError` preserves the raw SDK error for logging.
- If `type === "function_call"`, `chunk.functionCall` is a provider-agnostic `FunctionCall`
  `{ name, args, thoughtSignature? }`.
- `chunk.functionCall.argumentsTruncated` is true only when the provider delivered an
  incomplete argument payload and the repair recovered part of it. The flag is never set for a
  payload that parsed directly, so its absence means `args` is exactly what the model produced.
- Content-blocked responses (e.g., Gemini `promptFeedback.blockReason`, safety
  `finishReason`) are normalised to `type: "error"` with `error.type === "content_blocked"` and
  `retryable: false`.

## Message-based classifiers

HTTP status codes are too coarse to pick the right advice, so `utils/provider/providerErrorClassification.ts`
re-classifies a normalized `ProviderError` by matching its message text (and `originalError` payload).
`errorUi.ts` consults these before falling back to `ProviderError.type`:

| Classifier | Recognizes | Why it is separate |
|---|---|---|
| `isProviderModelError` | unsupported / unknown / deprecated model IDs | Steer to model selection, not to the key |
| `isAccountBalanceExhaustedError` | zero spendable balance (DeepSeek 402 `Insufficient Balance`, Z.ai `no resource package`) | No request of any size can succeed, so trimming tips are useless |
| `isCreditAffordabilityError` | affordability ceiling (OpenRouter 402 `can only afford N`) | A smaller `max_tokens` still fits the remaining credit |
| `isContextLengthError` | hard context-window overflow | Trimming history genuinely resolves it |

The two credit classifiers must stay mutually exclusive. They map to opposite advice: an exhausted
balance needs a top-up, an affordability ceiling needs fewer output tokens. Ordering in
`resolveProviderErrorPresentation()` runs exhausted-balance first because it is the stricter
condition. Both are checked before the generic `api_error` default, whose `verify_api_key` tip
misdiagnoses a billing failure as a bad credential.

A provider that reports billing denial under a non-402 status (Z.ai uses 429) is re-coded in its
error formatter so it does not present as a rate limit.

## Credential-scoped recovery tips

Which classifier fires decides *what* to advise; `StreamContext.textCredentialSource` decides
*which commands* the advice names. It is the resolved credential policy of the turn
(`"server" | "personal"`), threaded from `ChatTurn` through `StreamingContext` and
`buildStreamContext()`. Scope is never inferred from the provider or model name, because both
scopes can run the same provider with the same model.

`resolveProviderErrorPresentation()` resolves every command-bearing tip through a `scoped()`
helper that appends `_personal` to the locale key when the failing request used a personal key,
so `genai.tips.model_fallback` becomes `genai.tips.model_fallback_personal`. Two rules fall out
of that and are easy to regress:

- **`genai.tips.api_key_rotation` is suppressed entirely on personal failures.** Rotation pools
  are a server-scoped, manager-only feature, so the tip would point a normal member at a command
  they cannot run and that could not repair their own key anyway.
- **`modelFallbackTip` gates on `!isPersonal`.** A personal text override reads the *user's*
  fallback chain, so `tomoriState.fallback_chain` says nothing about whether that request had a
  fallback available.

Personal text failures additionally get `genai.tips.disable_personal_text_override`, which offers
the fastest recovery (hand the turn back to the server default) and carries the User BYOK caveat,
since a server in that mode rejects server fallback and will still require a personal provider.

Non-chat provider calls may leave `textCredentialSource` unset; the tips then resolve to their
server-scoped form, which is the correct default for configuration a member does not own.

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `BaseStreamAdapter.processChunk()` abstract method | **A new provider adapter implements this to map its SDK chunk shapes to `ProcessedChunk`.** The contract is at `src/types/stream/interfaces.ts:184`. The implementation must be synchronous. |
| `BaseStreamAdapter.handleProviderError()` abstract method | **A new provider adapter implements this to classify its SDK errors.** The `ProviderError.retryable` flag is consumed by the key-rotation loop in `runGenerationTurn`; the `type` field drives user-facing error embed formatting. Model-name and model-availability failures should become `model_error` or carry a message that the shared model-error classifier can recognize. Contract at `src/types/stream/interfaces.ts:201`. |
| `BaseStreamAdapter.createErrorDescription()` abstract method | **A new provider adapter implements this to produce localized, provider-specific error text** for the error embed shown in Discord when `retryable: false` and user errors are not suppressed. For `model_error`, preserve the provider's actionable details, such as supported model IDs. Contract at `src/types/stream/interfaces.ts:207`. |
| `FunctionCall` shape (`name`, `args`, `thoughtSignature`) | The provider-agnostic function call format, at `src/types/provider/interfaces.ts:167`. Fields like `thoughtSignature`, `reasoning_details`, and `deepseekReasoningContent` are provider-specific optional fields that must be preserved when passing tool results back to the provider in stage 01. `argumentsTruncated` is a core field: any adapter that recovers arguments from an incomplete payload must set it, because the tool loop uses it to refuse the dispatch. |

## Related docs

- Stage 02 (produces `RawStreamChunk` consumed here): → [`02-raw-chunk-generation.md`](02-raw-chunk-generation.md)
- Stage 04 (routes the `ProcessedChunk` produced here): → [`04-orchestrator-state-machine.md`](04-orchestrator-state-machine.md)
- `ProcessedChunk` type: `src/types/stream/interfaces.ts:36`
- `ProviderError` type: `src/types/stream/interfaces.ts:47`
- `FunctionCall` type: `src/types/provider/interfaces.ts:145`
- Error embed formatting: `src/utils/discord/stream/errorUi.ts`
