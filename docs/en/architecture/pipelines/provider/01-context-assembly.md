---
title: "01: Context Assembly"
---

Translates the provider-agnostic `StructuredContextItem[]` into a provider-native API request and opens the HTTP streaming connection.

**Contract:** `BaseStreamAdapter.startStream` — `src/types/stream/interfaces.ts:245`
**Canonical implementation:** `GoogleStreamAdapter.startStream` — `src/providers/google/googleStreamAdapter.ts:151-291`

## Mission

Each provider's `StreamAdapter` subclass implements `startStream(config, context)` as an async
generator. The first half of that method — covered in this stage — handles all *request
construction* before any HTTP bytes arrive. It converts the provider-agnostic
`StructuredContextItem[]` from `StreamContext.contextItems` into the format the provider's SDK
expects (e.g., Gemini `Content[]`), attaches tools and function interaction history, applies
per-provider config options (stop strings, thinking mode, generation parameters), and opens the
HTTP streaming connection to the provider's API. Stage 02 covers what happens after the
connection is open (the generator loop).

The [`LLMProvider.streamToDiscord()`](../provider/#pipeline-wide-concerns) facade (on each
provider class) constructs the adapter and `StreamConfig`, then calls
`StreamOrchestrator.streamToDiscord(adapter, config, context)`, which calls `adapter.startStream`
to begin this stage.

Tool declarations are prepared before this stage by `getAvailableToolsWithMCP()`. That path first
filters tools by provider/config/model constraints, then runs the dynamic tool assembler
(`src/tools/assembly.ts`) so provider adapters receive normal `Tool` objects whose descriptions and
parameter schemas already match the active backend for the turn.

## Input

- `config: StreamConfig` — extends `ProviderConfig` with Discord-specific settings (buffer sizes,
  timing, humanizer degree). Defined at `src/types/stream/interfaces.ts:62`.
- `context: StreamContext` — full Discord + application state. Defined at
  `src/types/stream/interfaces.ts:88`. Key fields consumed in this stage:
  - `context.contextItems: StructuredContextItem[]` — the assembled conversation context from the
    [context-build pipeline](../context-build/), each item tagged with a `ContextItemTag` that
    determines its placement (system instruction vs. dialogue turn).
  - `context.functionInteractionHistory` — paired `(functionCall, functionResponse)` records from
    prior iterations of the [tool-loop pipeline](../tool-loop/), replayed as model + user turns.
  - `context.currentTurnModelParts` — provider-native model parts accumulated within the current
    tool-loop iteration (used to replay partial model output before a tool call).
  - `context.tomoriState` — server config, including stop strings, speaker-pattern flag, thinking
    mode toggles.
  - `context.messageIdMap` — opaque map for resolving `media_N` / `ref_N` keys back to Discord
    message snowflake IDs (used by Google's GIF and video routing).

## Output

This stage produces no separate return value — it transitions into the generator loop (stage 02).
As a side effect of setup, the HTTP streaming connection to the provider API is opened by the
end of this stage.

## Side effects

- **Google:** Calls `GoogleStreamAdapter.buildTokenCountPayload(contextItems, model, messageIdMap)`,
  which materialises all `StructuredContextItem` parts into Gemini `Content[]` objects. Images are
  fetched and base64-encoded via `fetchAndOptimizeImage()`; GIFs are processed via
  `extractGifKeyframes()` in dev or replaced with a text placeholder in production. Videos are
  fetched and inlined if under `VIDEO_CONTEXT_MAX_INLINE_MB`.
- **All adapters:** Calls `buildProviderStopStrings()` to merge configured `llm_stop_strings` with
  persona-specific speaker-pattern stop strings and provider-native stop sequences.
- **All adapters:** Initialises speaker-guard state (per-adapter rolling tail buffers used in
  stage 02).

## Invariants

After context assembly completes (before the generator loop begins):

- The provider SDK client has been initialised with the correct API key from `config.apiKey`.
- The assembled native request payload includes all dialogue turns derived from `context.contextItems`,
  in the correct role ordering required by the provider.
- Function interaction history (if present) has been replayed in alternating model/user turns. The
  user turn carries the `functionResponse` and nothing else; any image metadata rides in a separate
  user turn appended straight after it. Vertex classifies a turn holding a `functionResponse` as a
  function-response turn and rejects one that also carries `inlineData` or text, which surfaces as
  the misleading `Requests ending with a model turn are not supported`. AI Studio accepts the mixed
  shape, but both Gemini-schema adapters emit the stricter one so a payload that works on one works
  on the other. OpenAI-compatible builders reach the same shape via a synthetic `user` message.
  They download tool-returned images locally, verify their MIME type from recognizable file bytes,
  optimize them, and replay them as inline data URLs. Providers never need to fetch expiring or
  access-restricted Discord media URLs. Tool-returned GIFs use a compatibility placeholder instead
  of being submitted to endpoints that reject animated image input.
- `config.tools` (if non-empty) has been attached to the request config after dynamic tool assembly
  and provider-specific serialization.

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `BaseStreamAdapter.startStream()` abstract method | **A plugin adding a new provider implements this method.** The contract is defined in `src/types/stream/interfaces.ts:182`. The full implementation must yield `RawStreamChunk` objects (stage 02) and conform to the generator signature. |
| Dynamic tool assembly | `src/tools/assembly.ts` is the standard seam for tools whose LLM-visible schema depends on active backend capability. A built-in tool implements `assembleForContext(context)` and returns a per-turn variant or `null`; provider adapters should keep consuming the assembled `Tool[]`. |
| `StructuredContextItem` routing (system vs. dialogue) | Each adapter decides which `ContextItemTag` values become system instructions vs. dialogue turns. Google's `SYSTEM_INSTRUCTION_TAGS` set at `src/providers/google/googleStreamAdapter.ts:94` is the canonical example. A plugin changing context routing would subclass the relevant adapter or provide its own. → plugin plan candidate |
| `buildProviderStopStrings()` | `src/providers/utils/stopStrings.ts`. Internal — stop-string merging is a provider-operational concern; the `llm_stop_strings` DB column is the configuration surface. |
| Image / video / GIF fetching (`fetchAndOptimizeImage`, `safeDownload`, `extractGifKeyframes`) | Internal — media fetching is tightly coupled to provider-specific inline-data limits and format requirements. |

## Configuration

| Source | Key / Env var | Default | Purpose |
|---|---|---|---|
| `TomoriState.config` | `llm_stop_strings` | `null` | Custom stop strings appended to provider stops |
| `TomoriState.config` | `llm_stop_speaker_pattern_enabled` | `false` | Adds a persona-name speaker-label stop string |
| `TomoriState.config` | `llm_thinking_enabled` / `llm_thinking_budget_tokens` | provider-specific | Enables chain-of-thought mode (Google / Anthropic thinking config) |
| Env var | `VIDEO_CONTEXT_MAX_INLINE_MB` | `20` | Max video size (MB) allowed for inline base64 in Google context |
| Env var | `RUN_ENV` | — | `"production"` replaces GIF frames with text placeholders to avoid memory pressure |

## Related docs

- Context items that arrive here: → [context-build pipeline](../context-build/)
- Function history that is replayed here: → [tool-loop pipeline — Stage 02 `executeToolCall`](../tool-loop/02-execute-tool-call)
- Type definitions: `StructuredContextItem` → `src/types/misc/context.ts`; `StreamConfig` / `StreamContext` → `src/types/stream/interfaces.ts`
- Provider adapter registry: `src/utils/provider/providerInfoRegistry.ts`
- Adding a new provider end-to-end: → `docs/en/contributing/adding-new-provider.md`
- Strict chat-completion normalizations applied during assembly (role alternation, prefix completion, always-on media relocation): → [`subsystems/strict-chat-completion.md`](../../subsystems/strict-chat-completion)
