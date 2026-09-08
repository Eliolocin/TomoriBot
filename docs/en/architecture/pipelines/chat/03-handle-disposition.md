---
title: "03: Chat Disposition"
---

Terminal handler for non-run dispositions.

**File:** `src/utils/chat/admission.ts:378-385`

## Mission

The "exit door" for the four non-runnable dispositions. Currently log-only:
emits `log.warn` for errors and `log.info` for ignore/queued/blocked. Exists as
a named stage (rather than being inlined into the coordinator) precisely so
disposition handling has a single seam to grow into.

Separately, the coordinator (`tomoriChat`) returns the final
`ChatAdmissionDisposition` to its caller (`"run"` after a successful turn,
otherwise the disposition reported by stage 02). A `"queued"` return means the
message was accepted into live channel work, not discarded. The coordinator
leaves queue callbacks attached, and the replayed invocation reports the
eventual generation outcome. Callers that schedule work
externally — notably the reminder processor (`src/timers/reminderProcessor.ts`)
— inspect this return value to decide whether to delete the source DB row,
treat it as in-flight (queued), or leave it for the next reconcile cycle
(ignore/blocked/error). The Discord `messageCreate` handler discards the value.

Reminder redelivery is capped at `REMINDER_DELIVERY_MAX_RETRIES` (default 5)
attempts spaced `REMINDER_DELIVERY_RETRY_DELAY_MS` apart; on exhaustion the
scheduled content is surfaced through a plain fallback embed. Automated
attempts suppress ordinary user-facing generation/admission errors, so this
final fallback is the only failure notice. One-time schedules are then removed;
recurring schedules advance from their canonical occurrence time and retain
their original cadence. Human reminders include a real content mention while
self-tasks do not.

Retries persist `next_attempt_at` and `delivery_retry_count` without replacing
`reminder_time`. Keeping the retry lease separate prevents a five-minute retry
window from shifting every future occurrence by five minutes and preserves the
retry budget across restarts.

## Input

`NonRunnableChatAdmission` (from stage 02, when `disposition !== "run"`).

## Output

`Promise<void>` — terminal stage. No further pipeline activity for this message.

## Side effects

- `log.warn(...)` if `admission.error` is set.
- `log.info(...)` otherwise.

## Invariants

After this stage runs:

- For `"ignore"`, `"blocked"`, and `"error"`, the chat coordinator returns
  immediately; no lock is acquired and no further stages execute for this
  message. An accepted `"queued"` admission has already enqueued work and is
  replayed by the channel-lock stage.
- The original `messageCreate` event has been fully consumed.
- Channel state (locks, queues, self-reply chain) is **not** mutated here —
  stage 02 made any required mutations already.

## Extension points

**Internal — log-only terminal handler.** This is the natural seam if the
project ever needs to:

- Emit metrics (`disposition_count{disposition="blocked", reason="rate_limit"}`)
- Surface user-visible feedback for certain block reasons that don't already
  emit an embed in stage 02
- Notify external observability (Sentry, log aggregator) for `error`
  dispositions with structured metadata

For now, the stage is intentionally minimal. Plugins should not hook here
unless they're adding orthogonal telemetry — disposition decisions belong in
stage 02 (or its helpers), not after the fact.
