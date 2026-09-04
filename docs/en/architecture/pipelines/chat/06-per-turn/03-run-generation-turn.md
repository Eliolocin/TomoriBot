---
title: "06.3: Generation Turn"
---

Drive the provider call with model fallback and API-key rotation.

**File:** `src/utils/chat/generationTurn.ts:50-187`

## Mission

Run the LLM call for this turn, with two layers of resilience: a **model
fallback chain** (primary model + any configured fallback entries) and, per
attempt, an **API-key rotation loop** (cycles through saved rotation keys
before giving up). Each attempt delegates the actual streaming + tool-call
dispatch to the [tool-loop pipeline](../../tool-loop/). Emits stream results to the sink and finalizes
with the first non-error result (or the last attempt's result if all fail).

## Input

- `ChatTurnContext` (from per-turn stage 01, with `responseTarget` populated
  by stage 02).
- `ChatResponseSink` (from per-turn stage 02).

## Output

`GenerationTurnResult` — see `src/utils/chat/types.ts:244-250`:

```ts
{
  status: StreamResult["status"] | "skipped";
  streamResults: StreamResult[];
  personaResponses: ChatPersonaResponse[];
  thoughtLog?: ThoughtLogPayload;
  thoughtLogOwner?: ThoughtLogOwner;
}
```

`status === "skipped"` is emitted when the attempts list is exhausted without
a non-error result *and* the loop falls through (rare; defensive).

## Side effects

**Per-attempt setup (`buildGenerationAttempts`, `createAttempt`):**

- Resolves the primary `TomoriState` — applies personal-provider selection
  (if BYOK), channel LLM override, and any `llmOverrideCodename` from the
  incoming.
- Selects an API key from the rotation pool, falling back to the server's
  own encrypted key via `decryptApiKey`.
- Builds a `ProviderConfig` via the resolved `LLMProvider.createConfig`.
- Assembles a **unified pool** with the primary model at index 0 followed by
  every configured fallback entry, then builds one attempt per pool member
  (custom-endpoint or saved-provider-config flavor). The lead attempt is always
  labelled `"primary"` in logs even when the randomizer (below) promoted a
  fallback into that slot; the true model is still visible via `successModel`.
- Resolves a custom-endpoint fallback from the endpoint row's connection ID. Server
  endpoints use the server's saved custom provider, while personal endpoints use
  the owning user's saved provider and key. Personal fallback refs are isolated
  from the server chain and retain their configured order.

**Per-turn model randomizer (`buildGenerationAttempts`):**

- When `config.model_randomizer_enabled` is `true` and the pool has ≥2 members,
  a random pool member is spliced to the front of the attempt list **per
  generation turn**; the remaining members keep their relative order as the
  failover tail. This is a pure *reordering* — the original primary stays in the
  chain and serves as failover if the random lead errors. No model is dropped
  and no model is attempted twice.
- Because the fallback-used notice keys on `index > 0`, a randomized lead that
  *succeeds* stays silent (no spurious "Fallback Used" embed); a genuine
  failover after the lead fails still notifies correctly.
- When the toggle is `false`, the pool order is unchanged (`[primary,
  ...fallbacks]`), preserving the deterministic primary-first behavior.
- The server toggle is `server_chat_configs.model_randomizer_enabled`, set via
  `/config` > Models > Fallbacks & Randomizer, which refuses to enable unless ≥1 fallback model is
  configured — guaranteeing the pool always has ≥2 members.
- `config.model_randomizer_enabled` is not always the server value. When a user has
  an **active personal Text route**, `applyPersonalProviderSelectionsToTomoriState`
  overlays that provider row's own `user_saved_provider_configs.model_randomizer_enabled`
  (migration 076), so a personal preference wins in both directions: personal `false`
  suppresses a server `true`, and personal `true` applies under a server `false`. A row
  counts as the active Text route only when it has the `text` capability enabled **and**
  a configured text model, so a personal row whose model pointer went NULL leaves the
  server value in place. The personal flag has no user-facing control yet, so today it is
  written only through its repository setter.

**Per-attempt context prep (`prepareProviderContextItems`):**

- Resolves dialogue `mediaDescriptors` into final image/video parts or
  model-appropriate system notices using the attempt's `TomoriState`. This is
  where personal-provider routing, fallback model capability differences, and
  OpenRouter live media capability corrections affect media visibility.
- Applies provider-specific token-limit truncation
  (`truncateDialogueHistory`) for Gemini, OpenRouter, NovelAI. The reserved
  output budget is resolved by `resolveMaxOutputTokens` so it matches what the
  request builder actually sends: the server's `/config` > Models > Text Samplers & Parameters override
  (`config.llm_max_output_tokens`) wins, then the provider env cap
  (`OPENROUTER_MAX_OUTPUT_TOKENS` / `GOOGLE_MAX_OUTPUT_TOKENS`), then a
  per-provider fallback (flat 8192 for OpenRouter and Gemini, the model-reported
  completion ceiling for NovelAI), always clamped to the model's reported
  ceiling. Keeping the reserve in lockstep with the request avoids over-dropping
  history.
- If the previous attempt ended with `emptyResponseFinishReason === "length"`
  and we're on a retry, additionally drops the oldest history exchange
  pairs.

**Per-attempt execution (key rotation inner loop):**

- Calls `runToolLoop(...)` — see [tool-loop pipeline](../../tool-loop/).
- On success: `recordKeySuccess(rotationKeyId)`, break out of the rotation
  loop.
- On error: classifies the error (rate-limit vs api-error),
  `recordKeyError(...)`, rotates to the next rotation key (up to
- Suppresses user-facing stream errors while another rotation key or model
  fallback can still be tried.
- Holds non-final failed model attempts out of `responseSink.emitStreamResult`
  so their details can be summarized by the fallback notice instead of posted
  as public errors.
- On completed model fallback: sends the compact `Fallback Used` button notice
  with the earlier failure chain available on demand, unless a stop/follow-up
  interrupt is pending for the channel.
- On non-error or last attempt: emits only final error results, calls
  `responseSink.finalize(result)`, and returns.
- On thrown error: calls `responseSink.emitError(error)` and finalizes with
  an `error` result — except under user impersonation, where `emitError`
  rethrows by design and neither the `error` result nor `finalize` is reached.
  `responseSink.cleanup()` runs from a `finally` on every path, so per-turn
  resources are released even then.

**Superseded-message cleanup (`purgeSupersededDeliveries`):**

- A shared, per-turn sink (`streamingContext.deliveredMessageRefs`) collects one
  entry per message the streaming layer commits to Discord. The orchestrator
  appends to it in `uiUpdater.recordSuccessfulSend`, and because it is threaded
  through `buildStreamContext` as an array *reference*, the entries survive even
  when a stalled `streamToDiscord` promise is abandoned by the SDK-call-timeout
  race in the tool loop (that path returns `timeout` but never reports the
  messages it had already flushed).
- Whenever the stage decides **not** to keep an invocation's result — a
  key-rotation retry, or a model fallback after an `error`/`timeout` — it deletes
  that invocation's already-committed messages. Deletion tries the persona webhook
  first (`webhook.deleteMessage`, no Manage Messages needed) and falls back to a
  channel-level delete (`channel.messages.delete`) if that fails — e.g. the
  webhook was recreated mid-stream — or for bot-native messages. It is
  best-effort: individual failures are logged and skipped. This prevents a
  timed-out primary's truncated partial output from lingering above the fallback
  model's complete response (two conflicting messages). The surviving/final
  attempt's messages are always kept. On total failure, the last attempt's output
  stays and the error embed is shown.
- **Straggler safety:** on the SDK-call timeout the tool loop aborts the stalled
  stream but the losing `streamToDiscord` promise is not cancelled — only its HTTP
  request is. `streamOnce` therefore awaits that promise settling (bounded by
  `STREAM_ABANDONED_SETTLE_TIMEOUT_MS`) before returning `timeout`, so any Discord
  send that was already in flight is recorded in `deliveredMessageRefs` *before*
  the fallback path's cleanup runs and cannot leak past it.
- **Scope:** only messages sent through `StreamUiUpdater.recordSuccessfulSend` are
  tracked. Ancillary artifacts posted outside that path — the alter "Replying
  to…" notice, warning/progress embeds — are not tracked and may persist after a
  purge.

**NovelAI subscription refresh:**

- For NovelAI providers without a cached context-token count, refreshes the
  subscription via `refreshNovelAISubscription` (one-shot, cached for
  subsequent turns).

## Invariants

After this stage runs:

- `responseSink.finalize(result)` has been called exactly once on every path
  that returns a result — that is, all of them except user impersonation, whose
  rethrowing error handler propagates instead of returning.
- `responseSink.cleanup()` has been called exactly once, without exception.
  This is the invariant per-turn resource release relies on; `finalize` is not.
- If the result is non-error, `result.personaResponses.length > 0` (or the
  status is `"skipped"`, which post-turn effects will distinguish).
- Rotation-key bookkeeping (`recordKeySuccess`/`recordKeyError`) reflects
  the outcome of the key that was actually used for each attempt.
- No superseded attempt's partial output committed through the streaming send
  path (`recordSuccessfulSend`) remains in the channel — those messages are
  deleted, leaving only the surviving (or final) attempt's response. Artifacts
  sent outside that path (alter reply notice, warning embeds) are not tracked and
  are out of scope for this guarantee.

## Extension points

The stage is a coordinator over several plugin-relevant subsystems:

| Subsystem | Helper | Plugin-relevance |
|---|---|---|
| Provider dispatch | `ProviderFactory.getProviderByName`, `getProviderForTomori` | The provider plugin contract is the seam — see [provider pipeline](../../provider/) |
| Tool execution | `runToolLoop` | See [tool-loop pipeline](../../tool-loop/) |
| Key rotation | `selectApiKey`, `recordKeySuccess`, `recordKeyError`, `hasAvailableRotationKey` | Internal — rotation-key schema is core, not plugin-relevant |
| Fallback chain | `createFallbackAttempt`, `applySavedProviderConfig` | The fallback-entry schema (`FallbackEntry` union: `model` or `custom_endpoint`) is the data-model seam |
| Context truncation | `truncateDialogueHistory` | Per-provider token-limit table is the registration surface |
| Personal-provider routing | `applyPersonalProviderSelectionsToTomoriState` | BYOK substitution; see [provider pipeline](../../provider/) |

**The stage itself is internal** — its job is to orchestrate the
"attempt with fallback + key rotation" pattern. Plugins wanting to:

- **Add a new provider** — register it via the provider plugin contract.
- **Change attempt-list construction** (e.g. add a probe attempt before the
  primary) — would extend `buildGenerationAttempts`. → plugin plan candidate.
- **Intercept stream results** — wrap the sink (per-turn stage 02), not this
  stage.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPENROUTER_APP_ATTRIBUTION_ENABLED` | `true` | Sends TomoriBot app attribution headers to OpenRouter for app rankings and aggregated usage analytics. Set to `false` to omit them. |
| `OPENROUTER_LENGTH_EMPTY_RETRY_DROP_PAIRS` | `2` | Per-retry history-pair drop count when OpenRouter returns empty/length |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | `8192` | OpenRouter truncation/request output-token cap (overridden by `/config` > Models > Text Samplers & Parameters) |
| `GOOGLE_MAX_OUTPUT_TOKENS` | `8192` | Gemini truncation/request output-token cap (overridden by `/config` > Models > Text Samplers & Parameters) |
| `STREAM_ABANDONED_SETTLE_TIMEOUT_MS` | `5000` | Max wait (ms) for an SDK-timeout-aborted stream to settle so its in-flight sends are recorded before superseded-message cleanup. `0` disables the wait. Defined in `toolLoop.ts`. |

Plus `MAX_KEY_ATTEMPTS` from `keyRotation.ts`.

## Related docs

- Tool execution loop: → [tool-loop pipeline](../../tool-loop/)
- Provider streaming + adapter pattern: → [provider pipeline](../../provider/)
- Key rotation: → no dedicated doc yet; `keyRotation.ts` helper only
- Fallback chain schema: → [`docs/en/architecture/subsystems/database-schema.md`](../../../subsystems/database-schema) (`fallback_chain` column)
- Personal-provider runtime substitution: → [provider pipeline](../../provider/)
