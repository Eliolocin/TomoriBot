---
title: "Scheduled Tasks"
sidebar:
  order: 2
---

TomoriBot can set reminders and schedule tasks for later — one-time or recurring. The
easiest way is to just **ask her**; she creates the task through her `create_task` tool.
Scheduled tasks are persona-specific.

Each persona keeps its pending self-tasks in context whenever it responds, regardless of
which members appear in the recent conversation. Human-targeted reminders are more selective:
the target must be present or referenced in the active conversation context, and the reminder
must belong to the active persona.

## Creating One

Just tell her in chat:

```text
remind me to submit the report at 14:30
every Friday at 8pm, post a reminder that game night is starting
```

She parses the time and recurrence and schedules it. Reminders **ping the target user** when
they fire; tasks are silent self-actions the persona performs at the scheduled time.

## Timezones

Absolute times ("at 14:30", "on Friday at 8pm") are interpreted in the **server's timezone**
(`/config` > Engine > General) by default. If you've set a personal timezone with `/personal config`,
the AI sees your local clock in context and labels your times with your UTC offset when
creating the task — the bot then does the conversion deterministically, so "remind me at 9am"
means *your* 9am even if the server is on another continent. Relative times ("in 2 hours")
are timezone-free and always safe.

When a reminder targets a user whose personal timezone differs from the server's, the
confirmation embed shows **both clocks** (server time and the target's local time), so a
mislabeled time is immediately visible and can be fixed with a follow-up message or
`/scheduled-task edit`.

## Managing Tasks

Two slash commands let you review and adjust existing schedules:

- `/scheduled-task edit` — change a task's content, next trigger time, recurrence interval,
  or whether it's a reminder. Set the interval to `0` to disable recurrence.
- `/scheduled-task remove` — delete a reminder or task.

Both open a picker listing your existing schedules (persona, time, channel, and recurrence),
so you don't need to remember IDs.

## How Delivery Works

Reminders are delivered by an in-app scheduler and are only marked done **after delivery
succeeds** — if a delivery is aborted or the channel queue is cleared, it's automatically
retried. Retry delays do not change the original recurring cadence.

Automated attempts do not post an error message each time. If delivery still fails after the
retry limit, TomoriBot posts one warning containing the unchanged scheduled content and its ID.
Failed human reminders ping the target so the reminder is not missed; failed self-tasks do not
ping anyone. One-time schedules are then removed, while recurring schedules stay active for the
next original occurrence and can be managed with `/scheduled-task edit` or
`/scheduled-task remove`. For the runtime details, see the
[architecture overview](/architecture/#runtime-extensions).

---

Scheduling is one of several agentic capabilities — see
[Tools & Extensions](/features/capabilities/tools-and-extensions/) for the full picture.
