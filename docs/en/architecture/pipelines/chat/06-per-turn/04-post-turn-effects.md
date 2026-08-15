---
title: "06.4: Post-Turn Effects"
---

Side-effect sequence after generation completes.

**File:** `src/utils/chat/postTurnEffects.ts:21-28`

## Mission

Run the post-generation side effects that depend on the produced result.
Eight ordered steps: selected-sticker delivery, empty-response retry,
text-quota consumption, self-reply chain bookkeeping, short-term memory write,
thought-log emission, boomerang follow-up scheduling, and fire-and-forget usage
statistics. Recoverable delivery/storage failures are logged without breaking
the completed turn.

## Input

- `ChatTurnContext` (the closure built in per-turn stage 01).
- `GenerationTurnResult` (from per-turn stage 03).

## Output

`Promise<void>` — terminal stage for this turn iteration.

## Side effects

Steps run in this order:

### 1. `sendSelectedSticker`

If a completed `GenerationTurnResult` carries `selectedSticker`:

- The sticker URL is sent through a webhook using the identity the stream last
  delivered under, read from `getChannelDeliveredWebhookIdentity()`, forwarding
  the thread ID where applicable. The webhook is taken from
  `responseTarget.webhook` when present and otherwise resolved lazily via
  `resolveManagedChannelWebhook()`, since the main persona has none.
- This is **not** gated on `is_alter`: the main persona also delivers through a
  webhook whenever a sprite renders, and the sticker must match it.
- The recorded username is reused **verbatim** — it may be the decorated
  `Persona (sprite)` form chosen by the group-break alternation. Re-resolving the
  persona's default identity would yield a different name, and Discord would
  split the sticker into its own message group instead of attaching it to the
  message it belongs with.
- A null identity means the last delivery was an ordinary bot message, so the
  sticker follows: a queued turn replies to the trigger message with the native
  sticker; a non-queued turn sends it directly to the channel. The same path is
  the fallback if the webhook send fails.
- A `50081 Cannot use this sticker` rejection is permanent for that ID rather
  than transient, so the sticker is retired via `markStickerRejected()`
  (`utils/discord/stickerAvailability.ts`) and logged at `warn`. Without that
  retirement the sticker stays in the Discord cache, stays in the candidate list
  the model is shown, and gets reselected on the next turn. Retirement is
  process-local: a restart refetches every guild's stickers, which is also when
  a restored boost tier should get a clean slate.
- Other final delivery failures are logged at `error` with the server and
  sticker IDs and do not propagate.

### 2. `maybeScheduleEmptyResponseRetry`

If `result.status === "empty_response"` and `incoming.retryCount <
MAX_EMPTY_RESPONSE_RETRIES` (default 2):

- Logs the current attempt and terminal finish reason.
- Sleeps `EMPTY_RESPONSE_RETRY_DELAY_MS` (default 1000ms).
- If the empty-response reason was `"speaker_guard"`, prepends a synthetic
  speaker-guard directive to `injectedContextItems` via
  `buildSpeakerGuardRetryDirective`.
- Re-enters `tomoriChat()` with `skipLock=true`, `retryCount + 1`,
  `selectedPersonaId` pinned to the same persona, and the OpenRouter
  finish-reason-length flag forwarded so stage 03 can trim history.

The `"speaker_guard"` reason is produced both by the config-gated mid-text
speaker guard and by the always-on opening-label leak guard (a response
opening with a foreign speaker label like `Chris (smug):` — see provider
stage 06). The stream side reads `incoming.retryCount` (threaded through
`StreamingContext.emptyResponseRetryCount`) to strip-and-deliver instead of
discarding once this retry budget is exhausted, so leak turns degrade to a
label-stripped reply rather than silence.

When the retry budget is exhausted:

- Deliberate turns (`context.shouldSurfaceUserErrors === true`) receive the
  localized `genai.empty_response_*` warning embed.
- Passive autochat and other non-deliberate turns log the exhaustion without
  posting an error embed into the conversation.
- User-impersonation turns throw an error back to their command flow instead
  of posting the standard warning embed.

### 3. `consumeTextQuota`

If `shouldApplyTextQuota` was true, quota state exists, it wasn't already
consumed, and the response was non-empty:

- `incrementTextQuota(serverId, userDiscId)`.
- Marks the quota state consumed and writes it back to
  `textQuotaTriggerStates`.

### 4. `updateSelfReplyBookkeeping`

If the response was non-empty:

- `setLastRespondedPersona(channel.id, persona_id)` — records which persona
  spoke last (used by stage 05 self-message persona-rotation).
- Increments `selfReplyChainState.triggerCount` for non-manual, non-reminder,
  non-stop real responses. If the message was a self-message, also sets
  `lastWasSelf = true`.

### 5. `writeShortTermMemory`

If not a stop response, history is non-empty, user is not privacy-FULL, and
the response was non-empty:

- Builds the user/persona conversation entries plus persona responses (one
  entry per responding persona); the STM cache applies its configured
  per-channel storage cap.
- Calls `storeShortTermMemory(...)` once per unique persona ID (or once with
  `null` if no persona IDs are known).
- After storing the short-term memory entries, advances the STM cadence
  counter via `incrementStmTurnCounter()`. The counter tracks
  bot-participation cycles (not raw inbound messages) and is scoped to the
  live STM row — server-shared in guilds, user-scoped in DMs. It increments
  unconditionally (whether or not an STM was written this turn) and is reset
  to `0` only when the bot calls `update_short_term_memory`. The counter
  value gates the unified create/update nudge in the context-build STM stage.
- Failures are logged but don't propagate.

### 6. `emitThoughtLog`

If a `thought_log_channel_disc_id` is configured, the source channel isn't
DM, and the source channel isn't in the persona's `private_channel_ids`:

- If `thoughtLog` has content (provider emitted reasoning/thinking blocks):
  computes `generationDurationMs = now - message.createdTimestamp`, sends a
  full thought-log embed via `sendThoughtLogEmbed`.
- Else if the response was via personal BYOK (`textCredentialSource ===
  "personal"`): sends an attribution-only embed crediting the user's
  provider.
- Else: no-op.

### 7. `scheduleBoomerangFollowUp`

Schedules a `setImmediate` callback:

- Checks `consumePendingBoomerang(channel.id)` — set by the
  `crossChannelMessage` tool when the active turn used it.
- If pending, fetches the latest message in the boomerang's source channel,
  calls `suppressNextSelfReply(sourceChannel.id)` to prevent the boomerang
  from triggering its own self-reply detection, and re-enters
  `tomoriChat()` against the source channel with the boomerang's persona +
  injected context.

### 8. `recordUsageStats`

Starts fire-and-forget recording for completed persona responses: turn/model,
token, impersonation, emoji, and sprite metrics.

Expression metrics are **delivery-gated**: they count what Discord accepted, not
what the model produced. `emoji_used` is therefore scanned from each stream
segment's `StreamResult.accumulatedText` (appended only inside the post-send
`recordSuccessfulSend` block) rather than from `personaResponses[].text`, which
is the short-term-memory payload and carries the `[Scene Metadata]` block drained
out of `<details>` (content that never reaches the channel). Scanning the
segments also picks up text delivered *before* a tool call, which the response
text drops because stream state is fresh per `streamOnce`.

`sticker_used` follows the same rule from its own delivery site: it is recorded
in `recordStickerDelivery`, called by `sendSelectedSticker` once a webhook or
native send succeeds, not at tool-selection time.

## Invariants

After this stage runs:

- The text-quota state for this trigger is *consumed exactly once* per
  successful turn-sequence (across multiple personas responding to the same
  trigger, only the first non-empty response increments).
- `setLastRespondedPersona` reflects the last persona to actually speak in
  this channel — used by the next turn's persona-rotation logic.
- Short-term memory entries are scoped per-persona-ID (so each persona has
  its own conversational continuity in the cache).
- The STM cadence counter (`turnsSinceRefresh`) advances once per
  bot-participation cycle after each STM write.
- A pending boomerang from this turn is consumed exactly once.
- A selected sticker is delivered only for a completed result and always after
  the provider text stream has finalized.
- Recursive re-entries (empty-response retry, boomerang) are *scheduled*
  with the appropriate flags (`skipLock=true` for retry,
  `suppressNextSelfReply` for boomerang) so they do not interfere with the
  outer lock or self-reply chain semantics.
- Empty-response exhaustion is user-visible only for deliberate turns;
  passive and internal chat turns remain silent.

## Extension points

This is **the richest plugin surface in the chat pipeline.** Each of the six
steps is an independent side-effect concern that a plugin might want to
extend or replace:

| Step | Named helper | Plugin-relevance |
|---|---|---|
| Sticker delivery | `sendSelectedSticker` | Post-stream media companion path; reuses the last delivered webhook identity, with native-sticker fallback |
| Empty-response retry | `maybeScheduleEmptyResponseRetry` | Retry policy (provider-specific) — extension via per-provider hook |
| Text-quota consumption | `incrementTextQuota` | Quota-manager subsystem; plugins shipping their own quotas would add hooks here |
| Self-reply bookkeeping | `setLastRespondedPersona`, `getSelfReplyChainState` | Cascade-trigger limit semantics; coupled to stage 05 |
| Short-term memory write | `storeShortTermMemory` | → [memory pipeline — STM Stage 01](../../memory/stm/01-passive-capture) |
| Thought-log emission | `sendThoughtLogEmbed`, `sendAttributionOnlyEmbed` | New "logging channel kinds" plug in here |
| Boomerang follow-up | `consumePendingBoomerang`, `buildBoomerangContext` | Cross-channel-tool-specific; one plugin (the cross-channel tool) owns the pending-boomerang state |
| Usage statistics | `recordUsageStats` | Post-turn metrics chokepoint; intentionally fire-and-forget |

**The sequencing matters**: sticker delivery runs first but is completed-turn
only; an empty result therefore proceeds directly to retry handling. Quota
consumption runs *before* memory write so quota
exhaustion doesn't pollute the memory cache; boomerang runs *last* via
`setImmediate` (before the non-blocking stats dispatch) so the outer lock has
released before the cross-channel re-entry attempts to acquire its own lock.

A future plugin extension for "add a new post-turn hook" would likely take
the form of a hook list (`postTurnHooks: PostTurnHook[]`) where each hook
runs after the built-in steps with the same `(context, result)` signature.
→ plugin plan candidate.

## Configuration

| Constant | Default | Purpose |
|---|---|---|
| `MAX_EMPTY_RESPONSE_RETRIES` | `2` | Cap on empty-response retry chain (shared constant in `src/utils/discord/stream/constants.ts`; also read by the stage 06 opening-label leak guard) |
| `EMPTY_RESPONSE_RETRY_DELAY_MS` | `1000` | Backoff between retries (file-local constant) |

Both are currently file-local — promoting to env vars would be a small
follow-up if operational tuning becomes useful.

## Related docs

- Short-term memory: → [memory pipeline](../../memory/) — see [STM Stage 01](../../memory/stm/01-passive-capture) for the write path
- Thought log: → no dedicated doc; `thoughtLog.ts` helper only
- Boomerang / cross-channel tool: → no dedicated doc;
  `crossChannelMessageTool.ts` helper only
- Self-reply chain semantics: → folded into stage 05 docs (cascade limits)
