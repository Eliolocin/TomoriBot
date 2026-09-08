---
title: "06.1: Build Context"
---

Assemble the LLM-visible prompt for one persona turn.

**Files:** `src/utils/chat/contextPipelineIntent.ts` (intent wrapper) and
`src/utils/chat/contextPipeline.ts` (base builder)

## Mission

Build the `ChatTurnContext` closure carried through the rest of the per-turn
loop. Fetch and simplify recent message history, hydrate per-message
annotations (reply/reaction/forward/media/embed), load emoji/sticker assets,
delegate to the **context-build pipeline** for the LLM-shaped prompt
assembly, then append tail directives. Returns the full `ChatTurnContext` —
the closure that stages 02–04 read and mutate.

This stage is the **thin chat-side wrapper** around a much larger inner
pipeline. The heavy lifting (mentions, memories, RAG, persona prompt,
participants, dialogue history) lives in [context-build](../../context-build/).

When Deliberate Tool Mode is active, the intent wrapper performs an autonomous
STM maintenance preflight before calling the base builder. A due refresh is
carried through the existing `endTurnAfterTools` allowlist path so
`update_short_term_memory` is exposed without changing the user-intent rules;
the temporary marker is removed before generation. Config or cache failures in
this preflight are logged as `SHORT_TERM_MEMORY_CONTEXT_ERROR` with the
triggering user and channel metadata, then treated as "not due" so the base
chat context still builds.

## Input

`ChatTurn` (one element from `ChatTurnPlan.turns`, produced by stage 05). See
`src/utils/chat/types.ts:141-171`.

## Output

`ChatTurnContext` — the per-turn closure. See `src/utils/chat/types.ts:173-212`.

Key fields populated here:

- `contextItems: StructuredContextItem[]` — the LLM-shaped prompt, including
  tail directives.
- `simplifiedMessages: SimplifiedMessageForContext[]` — the message-history
  digest used both for the LLM and for post-turn memory capture.
- `streamingContext: StreamingContext` — per-turn flags consumed by the
  stream orchestrator and tool layer.
- `messageIdMap: MessageIdMap` — translation table between Discord message
  IDs and LLM-visible compact IDs (used for reply targeting).
- `emojiStrings`, `loadedEmojis`, `loadedStickers` — persona assets.
- Carried trigger metadata (`triggererName`, channel name/description, etc.).

## Side effects

- **Message-history fetch** — `channel.messages.fetch({ limit })` retrieves up
  to `message_fetch_limit` recent messages from Discord.
- **Voice-transcript pre-hydration** — for historical audio messages not in
  chat mode, runs STT synchronously *before* the simplify loop so cache
  lookups inside `simplifyMessage` are non-async. Writes results to the
  voice-transcript cache.
- **Consecutive same-author merge** — after simplifying each message, the loop
  collapses it into the previous entry when (1) the effective `authorId`
  matches, (2) the debug (`$:`)/normal kind matches (a debug message never
  merges with a normal one even though they share an authorId), and (3)
  **neither side carries media** (media forces a separate turn so per-message
  media IDs stay unambiguous). Merged entries record `combinedMessageIds`,
  `individualContents`, and `combinedCreatedAts` so `reveal_message_metadata`
  can still surface one `ref_N` + timestamp per original message.
- **Persona-asset cache load** — `loadEmojiStickerCache(...)` may hit Discord
  if the cache is cold.
- **Reply-target fetch** — `channel.messages.fetch(referenceMessageId)` if
  the message references one that's not in cache.
- **Reset/compact-refresh detection** — scans message embeds for `"reset"` or
  `"compact_refresh"` markers and slices history at the marker.
- **Reminder injection** — if the incoming carries `reminderData`, injects a
  synthetic `[System: …]` message into `simplifiedMessages` so the LLM sees
  the reminder context.
- **Media descriptor capture** — this stage no longer decides whether the
  answering model can see images or videos. `buildContext` records
  capability-neutral `mediaDescriptors` on dialogue items, plus budget-only
  notices such as rendered-image-limit skips. The per-attempt generation stage
  resolves those descriptors against the routed attempt model, including
  personal-provider routing, OpenRouter live capability overrides, and fallback
  attempts.
- **Impersonation identity resolution** — if `isUserImpersonation`, fetches
  the impersonated user's nickname/avatar via `resolveImpersonatedIdentity`.
- **Participant preparation** — after privacy/block filtering and message simplification,
  `prepareParticipantContext()` scans the entire visible fetched window for persona triggers
  and eligible Discord user aliases/mentions, then composes visible authors, active identity,
  references, historical personas, co-responders, webhooks, and Matrix identities into one
  ordered typed result. That result is the required and only participant input to
  `buildContext()`; transport maps and raw participant ID lists do not cross the builder
  boundary. This context-only discovery never changes response planning.
- **Locked-turn discovery reuse** — all persona turns sharing a `LockedChatTurn` share a
  request scope keyed by an exact snapshot of the sanitized discovery inputs. Equivalent
  inputs reuse candidate and membership discovery, including concurrent in-flight work;
  changed privacy-filtered history receives a separate entry. Every call recomposes active
  identity and public-profile exposure, and the participant stage rehydrates member data,
  privacy, blacklist, lineage memories, persona-filtered reminders, and persona self-tasks
  for the current active persona. The scope is request-local and weakly held.
- **Bounded diagnostics** — preparation emits candidate, inclusion, rejection, cache,
  duration, and external-call counts without IDs, aliases, or message text.

## Invariants

After this stage runs:

- `contextItems` has tail directives appended in the correct priority order:
  emoji penalty (lower priority, inserted before the latest dialogue pair),
  stop/reasoning/manual directives (combined into one user message at the
  tail), queued-reply directive, uncensor directive, and manual-prefill
  model message (last).
- `simplifiedMessages` excludes messages from privacy-FULL users.
- Blocked-author content is not scanned for references; its synthetic block
  notice is excluded as well.
- Reference discovery enriches context only. It does not add matching personas
  to the turn plan, bypass Deliberate Trigger Mode for routing, or otherwise
  change which personas respond.
- `simplifiedMessages` collapses runs of consecutive same-author pure-text
  messages into a single entry (see the merge rule above); media-bearing or
  debug-boundary messages remain their own entries.
- The `messageIdMap` is populated with every message ID the LLM will see.
- `streamingContext.explicitLongTermMemoryIntent` reflects whether the
  triggering message mentions long-term memory phrasing.
- A failed STM maintenance preflight does not abort context construction; it
  fails closed and leaves the normal deliberate-tool gate in effect.
- `streamingContext.replyNoticeState` is initialized to
  `{ attempted: false, sent: false }` whenever `incoming.isFromQueue` is true —
  for **any** persona, not only alters. This is the only place where
  `replyNoticeState` is set; without it the "Replying to…" embed in stage 07 is
  suppressed (the presence of the object is the enable-switch, not its field
  values).

  It is not gated on `is_alter` because the main persona also switches to a
  webhook whenever a sprite renders, and webhooks cannot use Discord's native
  reply. Whether a sprite will fire is unknown until delivery, so the object is
  allocated up front and stage 07 gates the actual send on real webhook
  delivery — making it an inert no-op for queued turns that reply natively.

## Extension points

This stage is **a coordinator over many extension-relevant helpers**:

| Helper | File | Plugin-relevance |
|---|---|---|
| `buildContext` | `utils/text/contextBuilder.ts` | The context-build pipeline's public API — the main extension surface for memories, RAG, persona prompt assembly |
| `simplifyMessage` + sub-helpers (`withReplyContext`, `withReactionContext`, `buildForwardContext`) | this file | Per-message annotation pipeline; new annotation types hook here |
| `processEmbedsFromMessage` | `contextEmbeds.ts` | Embed classification + content extraction; new embed type plugins hook here |
| `extractNoticeTextFromComponents` | `discord/componentNoticeReader.ts` | Reconstructs `{title, description, footer}` from a Components V2 container so CV2 notices classify like embeds |
| `appendSupportedMediaFromMessage`, `appendStickersFromMessage`, etc. | `contextMedia.ts` | Media attachment extractors; new media kinds hook here |
| `buildReactionContextAnnotation`, `buildReplyReferenceContextAnnotation` | `contextAnnotations.ts` | Annotation builders; reaction/reply formatting hooks here |
| `appendTailDirectives` | this file | Tail-directive assembly; new directive kinds insert here |

**The stage itself is a thin coordinator.** Most plugin work for "show the
LLM something different" goes either into the inner context-build pipeline
(memories/RAG/persona) or into one of the per-message helpers above. The
appropriate seam depends on whether the change is per-message
(annotation/media) or per-prompt (directive/persona/memory).

## Related docs

- Inner pipeline: → [context-build](../../context-build/)
- Tail directive priorities: → folded into context-build docs
- Embed classification: → no dedicated doc; `embedClassifier.ts` helper only

## System notices: two transports

System notices that the LLM must see (memory-learning, reminder/task set,
system injection, compact summary/refresh, reward/punish, scene directive)
arrive over **two different transports**, and both must be read:

| Transport | Where the text lives | Read by |
|---|---|---|
| Discord embed | `message.embeds[].title` / `.description` | the embed loop in `processEmbedsFromMessage` |
| Components V2 | `message.components` → `Container` → `TextDisplay.content` | `extractNoticeTextFromComponents` |

A Components V2 message has an **empty `message.embeds` array and empty
`message.content`** — Discord rejects mixing `embeds` with the
`IsComponentsV2` flag. Any consumer that reads only `message.embeds` is
therefore completely blind to a CV2 notice: the message contributes no text and
no media, so `simplifyMessage` drops it from history entirely. When that
happened to the memory and task notices, Tomori stopped seeing her own tool
confirmations and re-ran the tools.

`buildNoticeContainer` (`ui/interactionCore.ts`) renders the title as a Markdown
heading via `formatContainerTitle` and the footer as Discord subtext (`-# `);
the reader strips both prefixes so the reconstructed title matches
`checkTargetEmbedTitle` exactly, including its cross-locale scan.

**If you convert a notice to Components V2, verify it still classifies.** The
formatting helpers take a transport-agnostic `{title, description}` pair
specifically so both paths emit byte-identical `[System: ...]` context. Current
CV2 senders: `expandableEmbedNotice.ts` (memory + task). All other notice types
are still embed-based.
- Voice transcripts: → no dedicated doc yet
