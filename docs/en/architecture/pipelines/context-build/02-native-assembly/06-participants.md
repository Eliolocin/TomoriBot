---
title: "02.6: Participants"
---

The densest single contributor: list every conversation participant with
per-user details (presence, roles, **personal memories**, reminders),
mention aliases with conflict detection, the active persona's pending
self-tasks, and the closing
channel/time-of-day footer.

**Files:**

- `src/utils/text/participants/identity.ts` owns typed participant keys, inclusion reasons,
  alias contracts, stable key serialization, and first-seen deduplication.
- `src/utils/text/participants/aliases.ts` owns alias normalization, source builders,
  purpose filtering, exposure policy, priority, ownership, and collision indexes.
- `src/utils/text/participants/referenceDiscovery.ts` owns pure standalone alias matching
  and context-only persona-trigger discovery.
- `src/utils/text/participants/discoveryPlan.ts` composes visible authors, active identity,
  historical synthetic identities, bridges, and typed reference candidates into one ordered
  `ParticipantDiscoveryPlan`. It also owns parsing the canonical `persona:N` and legacy
  numeric synthetic-persona key forms used by discovery and preparation.
- `src/utils/text/participants/candidateSources.ts` defines the injected repository and
  guild-member directory contracts used by reference orchestration.
- `src/utils/text/participants/preparation.ts` is the supported orchestration boundary for
  all context producers and owns request-local discovery reuse plus aggregate diagnostics.
- `src/utils/text/participants/sources.ts` runs ordered Discord, persona, webhook, reference,
  and Matrix sources plus explicitly supplied extensions.
- `src/utils/text/participants/hydration.ts` owns active-persona-scoped identity loading,
  exposure policy, profile-field enrichment, public persona details, and persona self-tasks.
- `src/utils/text/participants/profileEnrichers.ts` runs core and extension fields through
  the ordered, owner-stamped enricher contract.
- `src/utils/text/participants/renderer.ts` is the pure composite prompt renderer.
- `src/utils/text/participants/targetIndex.ts` derives purpose-aware downstream targets
  and the `conversationUsers` projection from hydrated profiles.
- `src/utils/text/context/participants.ts` owns the render boundary, supplies the
  deterministic time/footer values, and invokes hydration plus pure rendering.

## Typed preparation boundary

Live chat, prompt snapshot, cost inspection, and hidden image turns call
`prepareParticipantContext()` with their sanitized visible history before calling
`buildContext()`. The returned `PreparedParticipantContext` carries the authoritative typed
discovery plan, bridge and synthetic identities, preloaded reference rows, public persona profiles, diagnostics,
and the authoritative `ParticipantDiscoveryPlan`. Optional source/enricher registries also
flow through this one adapter-ready boundary. The plan retains ordered typed seeds,
candidate evidence, aggregate rejection reasons, and alias diagnostics. A seed carries a discriminated
`ParticipantKey`, all known inclusion reasons, its alias catalog, and its first-seen order. Numeric strings
from Discord users, webhooks, personas, Matrix users, and the bot cannot collide because
the key kind participates in equality and serialization.

`BuildContextParams` requires that prepared result. `buildContextNative()` passes its typed
seeds and preloaded data directly to `buildParticipantContextItem()`; there is no parallel
participant collection or fallback adapter.
`buildParticipantContextItem()` passes those seeds into `hydrateParticipantProfiles()`
with a required `ActivePersonaScope`. Hydration returns ordered typed profiles whose fields
carry a stable owner key, render order, and visibility decision. The pure renderer creates
the one composite prompt item payload and `ParticipantTargetIndex` without performing
database, cache, Discord, clock, or logging work.

Live multi-persona turns attach a `ParticipantRequestScope` to the locked chat turn. The
scope captures an exact copy of the sanitized messages, visible identities, persona catalog,
and responder set. Equivalent persona turns share the in-flight or completed discovery
promise, while different sanitized inputs receive distinct cache entries. Active persona
identity and public-profile exclusion are recomposed for every call, and hydration always
runs again with the current persona scope. The request scope is held by a `WeakMap` and does
not extend the lifetime of repository, privacy, blacklist, or Discord member caches.

The shared reference result is scoped again for each responder before source composition.
The active persona is supplied only by the active-identity source, so a visible trigger does
not duplicate it. A persona found only through a reference is included only when it has a
public attribute or Physical Appearance value to render. Historical personas keep their
history-derived identity and inclusion evidence without gaining new nickname or trigger
aliases that could suppress a human participant's output handles.

## Mission

For every typed seed in the prepared discovery plan, emit a rich detail block: display name, mention aliases
(unique-resolution computed), online/presence status, server roles,
per-user personal memories (with tag-filtering against the conversation
corpus, like server memories in stage 03), pending reminders, and public
Physical Appearance tags for image generation. Then fold in Matrix bridge users and
synthetic webhook users (persona-flavored). Independently append every pending
self-task assigned to the active persona, even when its creator is not a
conversation participant. Close with channel name +
current time-of-day (timezone-aware).

The output is *one* context item — all participants live in a single
`[System: The following users are having a conversation: ...]` block.

## Input

The production participant input to `buildContext()` is
`preparedParticipantContext: PreparedParticipantContext`. It contains ordered participant
seeds, Matrix and synthetic identities, public persona profiles,
reference-only rows and IDs, and aggregate diagnostics. The hydration facade additionally
receives:

- `participantSeeds: readonly ParticipantSeed[]` — collision-safe identities, inclusion
  reasons, purpose-aware aliases, and first-seen order from the prepared discovery plan
- `triggererName`, `botName`, `personaLineageId`
- `ActivePersonaScope` is derived at the hydration boundary from the active persona ID,
  lineage ID, main/alter state, and impersonation state
- `tomoriState`, `tomoriConfig` (provides `personal_memories_enabled`,
  `timezone_offset`)
- `isDMChannel`, `isUserImpersonation`, `impersonatedUserId`,
  `impersonatedIdentityName`
- `conversationCorpus` — for personal-memory tag filtering
- `snapshot`, `convertMentions`

## Output

`Promise<StructuredContextItem | null>` — `null` if the prepared discovery plan has no seeds,
otherwise one `user`-role item tagged `KNOWLEDGE_USERS_IN_CONVERSATION`.

Also populates `conversationUsers: ConversationUserReference[]` on the
context item — the provider-safe projection used by existing downstream mention resolution.
It is derived from the hidden
`ParticipantTargetIndex`; new participant-aware consumers use the index's typed keys and
purpose-specific aliases directly.

Content shape:

```
[System: The following users are having a conversation:

If {botName} wants to ping any of these users, prepend an "@" symbol to a unique
mention handle shown below (case-insensitive). [...]

{botName} (This is you!)
- Status: Online - Currently active and responding to messages
- Physical Appearance: blue hair, red eyes, white hoodie

UserA (Mention: @{UserA}; Aliases: @{aliceA}, @{alice_global})
- Physical Appearance: short white hair, red eyes
- Status: Online - Playing Stardew Valley
- Server Roles: Mod, Member
- Memories: [id:42] Likes cats (tags: pets, animals)
- Reminders:
  - ID:42 "Take meds" (scheduled for Tue, May 21, 2026 10:00 AM (UTC-7), repeats every 24 hour(s))

Pending Tasks Assigned to You:
- ID:77 "Post the daily summary" (scheduled for Tue, May 21, 2026 06:00 PM (UTC-7), repeats every 24 hour(s)) (destination: #daily-summary)

Conversation context: #general (ID: 1234...).
Current time: May 21, 2026 18:30 UTC+09:00 (JST), evening.
]
```

## Hydration and side effects

Hydration separates critical base identity from optional profile fields. A Discord user
must resolve to a stored row, including the existing eligible auto-registration path, or
the participant is skipped. Missing guild-member display data falls back to the Discord
user object or `<@id>`. Presence is optional: a failed presence lookup records an
`optional_failure` visibility decision and retains the participant.

The centralized exposure policy decides saved-name use and visibility for presence, roles,
physical appearance, timezone, and personal memories from privacy, blacklist,
personalization, and impersonation state. Human reminders retain their active-persona
filter independently of those profile-field decisions. Persona self-tasks are hydrated
independently of human participant membership.

- **DB / cache reads (per user)**:
  - `userRepository.loadByDiscordId(userId)` — load or `null`
  - If missing and the user is in the guild: `userRepository.register(...)`
    auto-registers them
  - `userRepository.isBlacklisted` (cached via `userCache`)
  - `userRepository.getPrivacyLevel` (cached)
  - `personalMemoryRepository.loadForUserLineage` if eligible
  - `serverScheduleRepository.getPendingRemindersForUser` for each user;
    pending reminders include `ID:N` so the LLM can target them with
    `update_task` for requester-scoped edits/deletes
  - One additional `getPendingRemindersForUser` read for the bot Discord ID,
    current server, and exact active `persona_id`; only `self_reminder = true`
    rows are rendered as persona tasks
- **Discord fetches**:
  - `guild.members.fetch(userId)` for role / display-name resolution
  - `client.users.fetch(userId)` fallback for users not in guild
  - `getUserPresenceDetails` for online status + activities (requires
    `GuildPresences` intent)
- **Reference discovery (upstream)** — `contextReferences.ts` scans the complete
  sanitized fetched window. Persona triggers use normal trigger matching even
  when Deliberate Trigger Mode is active, but this affects context only and
  never schedules a response.
- **User reference candidates (upstream)** — one repository read combines real
  Discord mentions, cached guild members, users with `message_sent` or
  `command_used` activity on this server, and eligible saved nicknames found in
  the history. Uncached database candidates are individually verified as
  current guild members; the pipeline never fetches the guild's entire member
  list.
- **Candidate policy and membership (upstream)** — repository rows carry the evidence for
  explicitly versioned eligibility policy v1. The pure policy runs before one deduplicated,
  targeted member lookup per eligible Discord ID. Cached members are used first; uncached
  members use `guild.members.fetch(id)`, and the no-argument full-list fetch is never called.
- **Discovery diagnostics (upstream)** — the typed plan aggregates ineligible-state, bot,
  non-member, ambiguous-alias, existing-participant, blocked-source, and missing-guild
  rejections. Production paths do not log candidate IDs, aliases, or message content.
- **Preparation diagnostics are not logged** — the typed preparation and hydration
  diagnostics stay in-process for tests and callers. No per-generation metric line is
  emitted, so participant preparation adds nothing to production log volume.
- **Alias catalog construction** — saved nicknames, guild display names and nicknames,
  global names, usernames, persona nicknames and triggers, Matrix display names, webhook
  display names, and impersonated identities use source-owned builders. Each alias records
  its owner, normalized value, purpose set, exposure, and priority.
- **Matrix alias exposure** — a Matrix display name remains a lookup-only tool target and
  output-mention collision claimant. It is never rendered as a Discord ping handle, but a
  human participant cannot be offered the same ambiguous handle.
- **Pure alias discovery** — eligibility and guild membership are resolved before the pure
  matcher receives `ParticipantAlias[]`. Its diagnostics expose only aggregate accepted,
  ambiguous, and unmatched counts, never raw alias text.
- **Final mention conversion** — assembled text passes through
  `convertMentions` after pure rendering.

`ParticipantHydrationDependencies` is the fakeable I/O boundary used by focused tests.
The default implementation wraps the repositories, Discord member/user reads, and presence
helper. Existing repositories do not expose behavior-equivalent batch APIs for the scoped
privacy, blacklist, memory, and reminder reads, so hydration retains those calls while
deduplicating base member loading. The regression fixture records aggregate calls and keeps
them at or below the pre-refactor baseline.

The request-reuse fixture measures two equivalent builds in one locked request. Candidate
repository reads improve from two to one, with no full-guild member fetch. Hydration remains
fresh on both builds: four member reads, four blacklist reads, four privacy reads, four
personal-memory reads, and six reminder reads still occur across the two turns.

## Invariants

After this stage runs:

- Returns `null` only when the prepared discovery plan has no seeds.
- Every user entry has a `displayName` (falls back to `<@id>` for missing
  data).
- Mention aliases are selected only from the `output_mention` purpose. A per-purpose
  collision index treats an alias as unique when exactly one typed participant owner claims
  its normalized value; duplicates are dropped from the mention handle list and the LLM is
  told "mention requires clarification" instead.
- Input recognition does not imply output exposure. Saved nicknames remain valid
  `input_reference` aliases when privacy or personalization excludes them from
  `output_mention`, `tool_target`, and `copied_identity` purposes. Guild display names are
  likewise lookup-only input aliases unless another visible source supplies the same value.
- Each entry's `aliases` (server nickname, global name, username, custom
  nickname) plus its `displayLabel` are emitted as `conversationUsers` metadata
  for tool-side user resolution (`resolveUserTarget`). The conversation stage of
  that resolver matches input against the full alias set, but breaks ties by
  preferring a single candidate whose `displayLabel` (primary name) equals the
  input over candidates that only matched a secondary alias — so one user's
  server-nickname alias colliding with another user's actual name no longer
  forces a needless clarify round-trip.
- Personal memories are filtered by privacy (`PrivacyLevel.MINIMAL`
  required) AND blacklist AND `personal_memories_enabled` AND
  conversation-corpus tag match (if `memory_tagging_enabled`).
- Plain and textual `@` aliases are case-insensitive standalone phrases across
  saved Tomori nickname, guild display/nickname, global name, and username.
  Exactly one eligible guild member must own the alias; shared aliases, partial
  words, bots, non-members, unknown users, and default-only registrations add
  nobody. Real `<@id>` mentions are unambiguous but still require eligibility
  and current guild membership.
- All participant alias consumers share whitespace, case, and leading-`@` normalization.
  Standalone matching uses Unicode letter, number, and combining-mark boundaries. Persona
  trigger discovery deliberately retains the routing trigger processor's fuzzy and legacy
  quote behavior instead of treating persona nicknames as textual references.
- Eligibility requires `message_sent`/`command_used` activity or meaningful
  state: personal memories, pending reminders/tasks, non-default
  personalization/image settings, timezone, privacy, or a deliberate-mode
  preference. Registration language, the initial nickname, and default rows
  alone do not qualify.
- Visible authors, historical synthetic identities, bridges, real mentions, textual aliases,
  persona triggers, historical personas, and co-responders are isolated source functions.
  Repeated sources merge by typed key while preserving every reason and earliest seen order.
- Referenced users use this same full renderer, including privacy, blacklist,
  memory-tag, lineage, reminder/task, presence, role, timezone, alias,
  impersonation, and mention-target behavior.
- User reminders require both context membership and an active-persona match.
  Main personas additionally include legacy unassigned user reminders.
- Persona self-tasks do not require their creator or any other human to be in
  context. They require an exact active `persona_id` match, include their
  destination channel, and are omitted during user-impersonation turns.
- Persona public attributes and Physical Appearance tags are attached to the
  same participant entry. A tags-only persona is still rendered; a referenced
  persona with no existing synthetic entry is non-mentionable but retains its unknown-status
  line and `persona:N` tool target under its nickname. When a historical persona already has
  a decorated display label, such as a sprite label, public fields use that history-derived
  label instead of replacing it with the plain persona nickname.
- Public persona fields merge only by the stable persona key. A Discord user with the same
  display text remains a separate profile and cannot receive persona attributes or tags.
- Matrix and synthetic users are appended *after* normal users and are
  marked non-mentionable (`mentionable: false`).
- The closing footer always emits, even with one participant.
- Persona-dependent hydration always receives an explicit scope. Personal memories use its
  lineage, human reminders use its persona ID plus main/alter compatibility flag, and
  persona self-tasks use its exact persona ID.
- Request-scope reuse covers only active-independent discovery. A cache hit recomposes the
  active identity and public-profile exposure, then repeats all persona-scoped hydration.
- Source capabilities are core-granted. An ungranted Discord identity remains
  non-mentionable, and non-core sources cannot claim the bot or active-persona identity.
- Core profile fields and extension fields use the same ordered enricher contract. Extension
  inputs are cloned and privacy-filtered; returned fields are owner-stamped, ordered after
  core, and restricted to the contributor's `extension:{id}` namespace.
- Triggerer blacklist, privacy, and presence-member snapshot fast paths remain request-local.
- Rendering consumes only `HydratedParticipantProfile` values and has no repository,
  cache, or Discord read path.
- Output handles, tool targets, copied-user identities, and persona canonical-trigger
  aliases are purpose-filtered views of one `ParticipantTargetIndex`. Discord pings still
  require a mentionable 17-20 digit snowflake, and tool targets retain primary-display-name
  tie-breaking. Preset and strict-chat transforms preserve both the index and its
  `conversationUsers` compatibility projection.

## Configuration

## Persona-relative naming and identity

Participant identity remains the typed Discord user ID. Display headings are a projection for
the receiving persona: persona-lineage override, global nickname, then live Discord name, with
prefix and suffix resolved independently. Stable Discord-derived mention handles remain
separate from display labels; exact plain and formatted names are additional collision-aware
aliases, never reparsed to discover a target.

`{user}` is the plain effective nickname, `{user_formatted}` is the deterministic formatted
name, and `{user_term}` is a persona-authored standalone address term. Single- and
double-brace forms are supported. Address terms are expanded in persona prompts, attributes,
and sample dialogue, not participant fields.

Dialogue user labels use the receiving persona's projection. A real mention in a historical
persona-authored message uses that proven author persona's lineage; unproven or user-authored
content falls back to the plain nickname. Required user-lineage preferences are batch-loaded.
Gender identity and pronouns are sparse independent fields visible only at Minimal privacy.
Timezone is omitted when unset and during user impersonation.

The `naming` field names each resolved affix separately from the nickname, using the tool's own
field words, and is emitted only when a prefix or suffix actually resolves:

```text
- I call Sparrow "Master Sparrow-san" (prefix "Master", suffix "-san")
```

A joined display name gives a model no way to tell an affix from the nickname, so a request to
drop a title degrades into a nickname rewrite that re-composes the same string. The line does
not state which precedence layer supplied an affix: `none` suppresses at any layer, and
`update_user_info` closes the one case where a global `none` would be outranked, so the origin
never has to reach the prompt.

Adding a core field kind requires an entry in both `hydrateDiscordUser` and
`CORE_FIELD_ENRICHERS`; a kind present in only one is dropped silently.

| Source | Field | Effect |
|---|---|---|
| `tomoriConfig` | `personal_memories_enabled` | Master switch for per-user memories + nickname usage |
| `tomoriConfig` | `memory_tagging_enabled` | (Set upstream in `nativeBuilder`) Drives `conversationCorpus` tag filter for personal memories |
| `tomoriConfig` | `timezone_offset` | Hours offset for current-time footer |
| Client intent | `GuildPresences` | Required for online/activity status; without it, only static info is shown |
| User row | `personal_dtm`, `privacy_level` | Reference eligibility and per-field privacy behavior; authored messages from `FULL` users are removed upstream |
| User row | `physical_appearance_tags` | Public physical appearance image tags |
| Environment | `PARTICIPANT_SOURCE_TIMEOUT_MS` | Abort timeout for each participant source; default 1500 ms |
| Environment | `PARTICIPANT_ENRICHER_TIMEOUT_MS` | Abort timeout for each profile enricher; default 1500 ms |

## Extension points

`ParticipantSource` and `ParticipantProfileEnricher` are the supported narrow contracts.
Both use the shared contribution kernel for normalized IDs, owner/source diagnostics,
dependency ordering, cycles, criticality, abort timeouts, and measured outcomes. Optional
failure contributes no output; a critical first-party failure throws structurally.

Identity deduplication, block/privacy enforcement, alias collisions, capability grants, and
rendering remain in core. Sources have no routing or response scheduler access. Enrichers
cannot replace profiles or core fields and receive no DB/client service bag. The generic
`ContextContributor` registry has not landed, so this entire participant slice remains one
adapter-ready boundary without claiming modularization Batch 4A completion.

See [Adding a Participant Source or Profile Enricher](/contributing/adding-participant-extension/)
for contracts, registration, security rules, and required tests.

## Related docs

- Server memories (parallel): [`03-server-memories.md`](/architecture/pipelines/context-build/02-native-assembly/03-server-memories/)
- User presence (helper, `history.ts`): covered in
  [native-assembly README](/architecture/pipelines/context-build/02-native-assembly/#shared-helpers-used-across-contributors).
- Display-name resolution: → no dedicated doc;
  `src/utils/discord/displayName.ts` helper only
- Reminder system: → no dedicated doc;
  `serverScheduleRepository` API only
- Image-generation Physical Appearance tags: → no dedicated doc;
  `physical_appearance_tags` is documented inline in the persona/user schemas
