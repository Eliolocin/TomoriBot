---
title: "04: Channel Lock"
---

Per-channel mutex wrapper around the per-turn body.

**File:** `src/utils/chat/channelQueue.ts:75-134`

> **Concurrency wrapper, not a data-transform stage.** Input and output are
> structurally the same (`RunnableChatAdmission` flows in; the callback receives
> a `LockedChatTurn` derived from it). What this stage *does* is enforce that
> exactly one turn-sequence runs per channel at a time, manage the Discord
> typing indicator, and replay queued messages on release.

## Mission

Acquire a channel-scoped mutex, run the per-turn callback under that lock with a
Discord typing keepalive active, and on release: replay the next queued message
and/or trigger any pending stop-response generation. Make recursive re-entries
into `tomoriChat()` safe by recognizing the `skipLock=true` flag and reusing the
outer lock instead of deadlocking on it.

## Input

- `RunnableChatAdmission` (from stage 02).
- `callback: (LockedChatTurn, startTyping) => Promise<T>` — receives the locked
  turn and a function that starts the typing keepalive.
- `options: { handleStopResponse, processQueuedMessage }` — the coordinator's
  re-entry callbacks for stop-response and queued messages.

## Output

`Promise<T>` — the callback's return value, pass-through.

The callback receives `LockedChatTurn`:

```ts
{
  admission: RunnableChatAdmission;
  channelId: string;
  lockedAt: number;
  queueDepth: number;
  skipLock: boolean;
}
```

## Side effects

**Lock acquisition (if `skipLock === false`):**

- Looks up or creates a `ChannelLockEntry` keyed by `channelId` in the in-memory
  `channelLocks` map.
- Forcibly releases the lock if older than `CHANNEL_LOCK_TIMEOUT_MS` (default
  180s, configurable via env). Logs a warning, aborts the turn abort controller,
  fires the stream kill callback, and clears the existing queue.
- Sets `isLocked = true`, records `lockedAt`, `currentMessageId`, `userDiscId`,
  persona-job/persona-id/command-triggered flags.
- Creates a **fresh `AbortController`** (`activeTurnAbortController`) for this
  turn. Its signal is passed to tools via `ToolContext.abortSignal` so HTTP-level
  cancellation propagates on `/kill`.

**During the callback:**

- `startTyping()` (called by the coordinator after `planChatTurns` produces
  ≥ 1 turn) starts the Discord typing keepalive interval (default 8s,
  configurable via env). Interval auto-stops when the lock is released or a
  stop request is registered.

**Lock release (always runs via `finally`):**

- Clears `isLocked`, `lockedAt`, all active-turn state.
- Aborts `activeTurnAbortController` and clears `activeStreamKill` — ensures no
  stale kill handles survive across turns.
- Stops the typing keepalive.
- Checks `StreamOrchestrator.getAndClearStopContext(channelId)`. If present,
  schedules `handleStopResponse(originalStopMessage, client)` via
  `setImmediate` — stop-response generation runs *after* lock release so the
  stop response itself can acquire the lock.
- Pops the next message from `messageQueue` (FIFO). If present, schedules
  `processQueuedMessage(next)` via `setImmediate`. The `QueuedMessage` shape
  mirrors the cross-cutting fields of `TomoriChatInput` that affect *what* the
  bot will say on replay — including reminder context
  (`reminderRecipientID`, `reminderData`) and the streaming-context overrides
  (`disableCrossChannelMessage`, `disableRecentMessageReplyTool`,
  `disableReminderTool`). Any new input field that influences generation must
  also be added to `QueuedMessage` and threaded through `processQueuedMessage`,
  otherwise the queued replay will be a silently-degraded copy of the original
  call.

Manual slash-command work bypasses the latest-follow-up replacement path and is
stored in this FIFO queue. This preserves command-owned callbacks and payload
fields such as the user-impersonation target while an ordinary turn is active.

**`skipLock=true` path:**

- Re-entries from retry/post-turn effects pass `skipLock=true`. The stage
  short-circuits: reuses the outer lock's `lockedAt` and queue depth, invokes
  the callback immediately, returns the result. No new typing keepalive is
  started (the outer keepalive is still active).

## Invariants

After this stage's `finally` block runs:

- `lockEntry.isLocked === false` for the duration between turn-sequences.
- The Discord typing keepalive timer is cleared (`typingKeepaliveTimer ===
  null`).
- The queued-message replay is **scheduled via `setImmediate`**, not awaited —
  the current invocation returns before the next message is processed, so the
  call stack stays shallow even under heavy queue pressure.
- A pending stop-response (if any) was scheduled *before* the queue replay, so
  the stop response runs first.

## `/kill` mechanics

`forceKillChannelStream(channelId)` is the single entry point for hard-killing
an active turn. It does both:

1. **Abort the turn controller** (`activeTurnAbortController.abort()`) — if a
   tool is executing, the `killPromise` in `executeToolCall`'s race fires
   immediately, returning `{kind: "abort", status: "stopped_by_user"}`. The
   channel lock releases as normal via the `finally` block of `runWithChannelLock`.
2. **Fire the stream kill callback** (`activeStreamKill(...)`) — if the LLM is
   mid-stream, this simultaneously calls `abortController.abort()` (cancels the
   HTTP request) and rejects the `Promise.race` in `streamOnce`. Explicit stop
   requests return `{status: "stopped_by_user"}`; SDK/stale-lock timeouts still
   return `{status: "timeout"}`.

`/kill` in `src/commands/kill.ts` additionally calls
`StreamOrchestrator.requestStop` before `forceKillChannelStream`, and
`clearChannelProcessingQueue` to drain the message queue — so neither the
current turn nor any queued messages continue processing.

While that stop request is pending, locked-channel admission ignores new
same-user follow-up candidates with `locked_stop_requested` instead of queuing
them. This prevents a message that arrives during the short kill-unwind window
from re-populating the queue after `/kill` already cleared it.

When the kill path aborts the provider SDK race, `toolLoop.ts/streamOnce`
classifies the result as `stopped_by_user` rather than a generic SDK timeout,
then clears the non-context stop request. Stale-lock SDK timeouts remain
timeouts because they do not have an active stop request.

`activeStreamKill` is registered by `toolLoop.ts/streamOnce` at the start of
each provider call and cleared in `finally`. `activeTurnAbortController` is
created in `acquireChannelLockForTurn` and cleared on release.

## Extension points

**Internal — concurrency primitive.** The lock, queue, and typing-keepalive
mechanics are tightly coupled to Discord rate limits, the stream orchestrator's
stop/follow-up signaling, and the recursive `tomoriChat()` re-entry pattern.
Replacing this stage from a plugin would risk breaking those guarantees.

**Plugin-relevant adjacent surfaces** (lower in the same module):

| Helper | What a plugin might do | Plugin-relevance |
|---|---|---|
| `enqueueBusyChannelMessage`, `queuePersonaJobsAtFront`, `queueStopResponseAtFront` | Add a new "queue at front" entry type | → plugin plan candidate; today these are call-site-specific |
| `queueFollowUpForLockedTurn` | Change follow-up interrupt eligibility rules | Internal — coupled to `MAX_FOLLOW_UP_INTERRUPTS`, the tool-call-chain flag, and the cross-persona trigger guard (see `hasExplicitCrossPersonaTrigger` in `triggerProcessor.ts`) |
| `requestNaturalStopForLockedTurn` | Add a new "soft stop" signal type | Internal — coupled to `StreamOrchestrator.requestStop` semantics |
| `clearQueuedSelfReplyWork` | Customize what gets cleared on natural stop | Internal — coupled to `isSelfTriggerMessage` and persona-job semantics |

The lock's *policy* (timeout, typing interval, max follow-ups) is configurable
via env vars; behaviour customization should go through that channel rather
than monkey-patching the stage.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CHANNEL_LOCK_TIMEOUT_MS` | `180000` | Stale-lock detection threshold |
| `DISCORD_TYPING_KEEPALIVE_INTERVAL_MS` | `8000` | Typing-refresh cadence |
| `MAX_FOLLOW_UP_INTERRUPTS` | `3` | Per-lock follow-up interrupt cap |

## Related docs

- Queue policy decision tree: lives in `evaluateAdmissionQueueAndTriggerGate`
  (stage 02 helper); → admission-queue helper doc TBD if it grows.
- Stop request mechanics: → [provider pipeline](../provider/) (stream orchestrator stage).
- Follow-up interrupt semantics: → folded into stage 05 docs (follow-up
  eligibility gating).
