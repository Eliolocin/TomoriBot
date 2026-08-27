---
title: "02: Admission Check"
---

The gatekeeper. Decides if/how a message becomes a generation turn.

**File:** `src/utils/chat/admission.ts:66-267`

## Mission

Decide whether this message turns into a generation pass and, if so, eagerly
load the early state (persona list, main `TomoriState`) downstream stages need
to start one. Returns a discriminated `ChatAdmission` — runnable or one of four
non-runnable dispositions.

## Input

`ChatIncoming` (from stage 01).

## Output

`ChatAdmission` — discriminated union (`src/utils/chat/types.ts:93-126`):

- **`RunnableChatAdmission { disposition: "run", ...gathered state }`** —
  proceed to stage 04. Eagerly populated fields:
  - `serverDiscId`, `userDiscId`, `cooldownUserDiscId`
  - `isDMChannel`, `guild`

  `serverDiscId` is the key every downstream persona/config lookup uses. In a
  guild it is `guild.id`; in a DM it is the synthetic per-user server, resolved
  from `DMChannel.recipientId`. See "DM server-key resolution" below.
  - `tomoriState`, `allPersonas` (main persona + sibling personas)
- **`NonRunnableChatAdmission { disposition, reason, error? }`** — terminate
  at stage 03. Disposition variants:
  - `"ignore"` — bot/webhook/self-reply suppression, easter eggs, audio failure
  - `"queued"` — channel busy; the queue policy in `admissionQueue` decided
    enqueue rather than reject
  - `"blocked"` — privacy, permissions, rate limit, unsupported channel,
    bot-reply-block, full-privacy user
  - `"error"` — unexpected failure (rare)

## Side effects

- **Voice transcription** — if the message has audio attachments, transcribes
  them and either posts a transcript-as-webhook (chat mode) or caches the
  transcript text (legacy mode); message content is mutated in-place via
  `applyEffectiveMessageContent` to inject the transcript inline so downstream
  stages see the spoken text.
- **Self-reply chain bookkeeping** — `updateSelfReplyChainState` and
  `setSelfReplyChainOriginUser` updated based on message authorship and
  manual-trigger flag.
- **`$whoami` easter egg** — sends an info embed to the channel and returns
  `ignore` when content === `"$whoami"`.
- **Audio transcription failure embed** — sends a user-visible warn embed when
  STT fails with an attributable reason, the message has no text content, and
  the turn is allowed to surface user errors. Passive guild messages stay
  quiet.
- **Suppression cleanup** — clears `selfReplySuppressionUntil` entries that
  have expired.
- **Text-quota state cleanup** — `cleanupTextQuotaTriggerStates()` prunes stale
  entries.
- **Persona-job mutation** — if the message is a likely-self message and not
  manually triggered, sets `incoming.isPersonaJob = true` so downstream stages
  can distinguish persona-driven self-replies from user messages.

## DM server-key resolution

DMs have no guild, so TomoriBot gives each DM a synthetic server whose
`server_disc_id` is the human's Discord ID. `resolveAdmissionChannelScope`
derives that key from `DMChannel.recipientId`, which is a property of the
channel and therefore independent of who authored the trigger message.

Scheduled reminder/task turns additionally provide `systemTriggerIdentity`
from the reminder row's joined `servers` record. This authoritative identity
wins in DMs because cached or partial Discord channel metadata may not contain
a usable recipient even though the persisted schedule still has the correct
private-server owner.

This matters because system-initiated turns do not supply a user-authored
trigger. Reminders (`reminderProcessor`) and boomerang follow-ups
(`postTurnEffects`) pass the channel's most recent message, which in an active
DM is frequently one of Tomori's own. Keying off the message author there would
resolve the DM to the bot's ID, find no server row, and report a configured DM
as needing `/config setup`. Guilds are immune because `guild.id` never depends
on authorship.

`userDiscId` follows the same rule: in a DM, a trigger message authored by the
client user falls back to the recipient rather than to the bot.

## Can the bot actually deliver a reply?

Three checks answer this, in a guild channel only, and they are separate because each one sees
something the others cannot. All three run before any model call, so a channel that cannot receive
a reply costs nothing to generate for.

| Block reason | Catches | Why the others miss it |
|---|---|---|
| `cannot_send_in_channel` | `SendMessages`, or `SendMessagesInThreads` in a thread | The ordinary case |
| `bot_timed_out_in_guild` | A moderator timeout on the bot | A timed-out member keeps **every permission bit**, so the bitfield check passes and Discord still rejects the send with 50013. The state lives on the member as `communicationDisabledUntilTimestamp`, entirely outside permissions |
| `recent_send_refused` | Any channel whose last send was actually refused | Reacts to a refusal that happened rather than predicting one, so it holds for causes not yet identified |

The timeout check reads the cached member and never fetches: turning a per-turn gate into a Discord
round trip would cost more than the failures it prevents, and a stale answer self-corrects because
the send path still classifies the resulting 50013 into the third check.

That third check is `sendFailureCache`, populated by the stream send path on a 50013 or 50001 and
cleared the moment any send to that channel lands, so lifting a timeout or granting a permission
takes effect on the next message instead of after `SEND_FAILURE_RETRY_MINUTES`. It deliberately
ignores transient codes such as 429: silencing a channel that is having a bad minute is worse than
the wasted call it exists to prevent.

This matters because the failure is otherwise invisible and expensive. A production guild timed the
bot out and drew **397 refused sends over two days**, each one a fully generated response discarded
at the last step, and at two error rows per attempt it accounted for 63% of that day's error volume
while looking exactly like a correctly configured channel.

## Invariants

After this stage runs:

- If `disposition === "run"`, `tomoriState` and `allPersonas` are non-undefined.
- Privacy-level `FULL` users are blocked unconditionally (except for
  self-reminders and manual triggers).
- A guild channel that just refused a send is not generated for again until the entry expires or
  a later send succeeds.
- DM channels never carry a guild; guild text/thread/voice channels always do.
- In a DM, `serverDiscId` is the persisted system-trigger identity when one is
  supplied; otherwise it is the channel recipient's ID regardless of who
  authored the trigger message.
- An audio transcript that succeeded leaves a `voice_transcript` cache entry
  keyed by message ID (legacy mode) or a posted webhook message (chat mode),
  not both.

## Extension points

This stage is **a long sequence of fixed checks**, not a polymorphic seam.
Extensibility lives in the helpers it calls:

| Helper | File | What it does | Plugin-relevance |
|---|---|---|---|
| `isMatrixRelayMessage`, `isRealUserLikeMessage` | `triggerProcessor.ts` | Trigger-source classification | A new bridge plugin would extend trigger detection here |
| `transcribeMessageAudioAttachment` | `audioAttachmentTranscription.ts` | STT dispatch | STT providers register via `customEndpointService` — existing mechanism, not chat-specific |
| `evaluateAdmissionQueueAndTriggerGate` | `admissionQueue.ts` | Channel-busy + trigger gate decision tree; includes cross-persona trigger guard that bypasses the follow-up path when the incoming message explicitly targets a different persona than the active one | → plugin plan candidate if plugins want to add admission policies |
| `getSelfReplyChainOriginUser`, `updateSelfReplyChainState` | `selfReplyState.ts` | Self-reply chain memory | Internal — tightly coupled to cascade-trigger limit semantics |

**The stage itself is internal** — there is no current seam for "replace
`evaluateChatAdmission`." A future plugin-extension for early admission veto
would likely take the form of a pre-admission hook (`beforeAdmission(incoming)
→ Disposition | null`) running before the fixed checks, not a wholesale
override.

## Related docs

- Self-reply chain mechanics: → folded into stage 05 docs (cascade limits)
- Trigger word + screaming regex: → `triggerProcessor.ts` (no dedicated doc;
  internal helper)
- Voice transcription: → no dedicated doc yet; helper-only subsystem
