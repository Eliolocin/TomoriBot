---
title: "Command System"
---

TomoriBot uses Discord slash commands loaded dynamically from `src/commands/`.

## Loader and Execution Pipeline

- Registration/building: `src/utils/discord/commandLoader.ts`
- Runtime dispatch: `src/events/interactionCreate/handleCommands.ts`

Flow:

1. `loadCommandData()` scans command folders and top-level command files.
2. Command metadata is built into `SlashCommandBuilder` trees.
3. `handleCommands.ts` classifies chat-input commands and globally routed component or modal interactions.
4. For a chat-input command, it resolves a root command, or category + group + subcommand.
5. Category cooldown is checked/set in `cooldowns` table (`COMMAND_CATEGORY`).
6. Target `execute()` is called with `(client, interaction, userData, locale)`.

`commandLoader.ts` is an ESM-only loader. It uses async directory reads while building slash-command registration data and dynamically imports command modules so command files can use top-level await. Do not add `require`, `module.exports`, or synchronous directory traversal to command discovery.

### Single-flight loading (race protection)

`loadCommandData()` is called from two places: the startup registration path (`clientReady/01_registercommands.ts`) and the lazy first-interaction path (`interactionCreate/handleCommands.ts`). It is memoized behind a single shared promise (`cachedCommandDataPromise`) so both callers await **one** evaluation.

This guards against a startup race: if an interaction arrives while registration is still loading, a second concurrent `loadCommandData()` would independently `await import()` the same command modules. Because ES module evaluation interleaves across `await` points, the second loader could read an export binding (e.g. `configureSubcommand`) while the module was still in its Temporal Dead Zone, throwing `Cannot access 'configureSubcommand' before initialization` and silently skipping that command — leaving the bot "dead" for those commands until restart.

The memoized promise is **not** cached when a load fails catastrophically (empty execution map) or rejects, so a later interaction can retry instead of locking in a broken state. `handleCommands.ts` likewise only commits its module-level maps when the load produced commands. New callers must use the exported `loadCommandData()`, never the private `loadCommandDataUncached()`.

### Import hygiene (keep the loaded graph shallow)

The race above is only *possible* because a command module's static import graph can be large and cyclic. Most command files import the repositories barrel (`@/utils/db/repositories`), so any heavy dependency reachable from that barrel is pulled into every command load.

Rule: **data-layer modules (repositories, caches) must not import high-level subsystems** (context building, tools, webhooks, providers). Import shared leaf constants directly from their owning leaf module, not from a barrel that also re-exports heavy code. Example: `ServerRepository.ts` imports `DEFAULT_SYSTEM_PROMPT` from `@/utils/text/context/templates` (a leaf), **not** from `@/utils/text/contextBuilder` (a barrel that also re-exports `buildContext` and its tool/webhook/provider graph). That single edge previously routed the entire runtime subsystem into the repositories barrel.

Run `bunx madge --circular --extensions ts --ts-config tsconfig.json src` to audit cycles. Remaining cycles are expected to be either type-only (`import type`, erased at runtime), localized repository↔cache↔barrel cycles, or self-contained subsystem-internal cycles (Matrix bridge, chat pipeline) — none should route the repositories barrel into context/tool/webhook code.

## Discord UI Helper Layout

Command files import Discord UI helpers from responsibility-owned modules:

- `src/utils/discord/ui/confirmation.ts` - confirmation prompts
- `src/utils/discord/ui/modals.ts` - raw, legacy, and paginated modal prompts
- `src/utils/discord/ui/embeds.ts` - info and summary embed replies
- `src/utils/discord/ui/statusComponents.ts` - Components V2 status replies and status-page pagination
- `src/utils/discord/ui/pagination.ts` - generic choice pagination
- `src/utils/discord/ui/panel.ts` - shared Components V2 panel containers, receipts, state controls, and pagination
- `src/utils/discord/ui/personalConfigParameterControls.ts` - shared provider-parameter summaries and semantic edit rows
- `src/utils/discord/ui/personaWorkflow.ts` - command-facing persona picker lifecycle, acknowledgment phases, and anchor-message controller
- `src/utils/discord/ui/helpDashboard.ts` - the persistent Components V2 `/help` dashboard and provider information modals

The low-level persona renderer remains private to `interactionCore.ts` and
`personaWorkflow.ts`; it has no command-facing barrel or compatibility export.

`src/utils/discord/interactionHelper.ts` remains only as the subsystem compatibility barrel. New command code should import from the owned module that matches the helper it uses.

List panels use `buildPaginationRow(...)` for selector pagination. A row with Previous, a disabled
`Page <current> of <total>` indicator, and Next sits below the select, keeping the panel body and
the selected item in place across page transitions.

### Globally routed persistent interactions

Collector-owned workflows and globally routed panels solve different lifecycle problems:

- A collector-owned workflow is a bounded command session. Its command invocation owns the collector, timeout, and terminal repaint.
- A globally routed panel handles every matching button, select, or modal submission as a fresh `interactionCreate` event. It does not depend on the original command process or an in-memory collector remaining alive.

The reusable global path is intentionally small:

- `src/utils/discord/interactions/routeRegistry.ts` parses versioned custom IDs and dispatches an exact namespace/version route.
- `src/utils/discord/interactions/router.ts` owns the registered route list and defensive error response.
- Feature routes, such as `src/utils/discord/interactions/helpRoutes.ts`, validate their own action and state segments.

Only IDs registered in this path are consumed. Every Discord message component type and modal
submission can enter the global route registry. This uses Discord's common message-component guard
instead of enumerating button and select variants, so a new native selector cannot be filtered out
before its route acknowledges it. Unmatched component interactions return to the existing
collector-owned behavior unchanged. Custom IDs must include a namespace and version, such as
`help:v2:page:en-US:memory`, so incompatible future state can use a new version without silently
changing old messages. Persistent help IDs also carry the panel locale so later interactions
preserve the language selected by the slash-command dispatcher without another database read before
`showModal()`.

Deferred panel branches call `beginPanelInteraction(...)`. The helper owns `deferUpdate()` and runs
it before authorization or state loading, so its callers cannot accidentally move asynchronous
work ahead of acknowledgement. A branch that opens a modal stays outside this helper because
`showModal()` must be that interaction's acknowledgement.

Multi-step modal continuations and collection-derived operations (such as personal spotlight configuration and removal in `/personal config`) bind state to a deterministic actor- and workspace-scoped collection fingerprint in the custom ID instead of process-local memory. If the underlying collection drifts (for example, personas or active spotlight rows are added, removed, or reordered between render and submit), fingerprint verification fails closed and surfaces a localized stale-panel notice: drift prevents the requested identity-sensitive mutation, its success telemetry, and its success receipt or cache effects, while repository-owned read cleanup may still prune expired or orphaned records.

`/help` is the pilot. `src/commands/help.ts` sends one ephemeral Components V2 panel, while `src/utils/discord/helpCatalog.ts` owns its five categories and 20 pages. Category buttons, the page select, and Previous/Next controls repaint that message through fresh interactions. Setup Step 1 opens a text-only provider modal. Discord emits no interaction when a modal is dismissed, so dismissal leaves the underlying help message unchanged and its globally routed controls available for a later click. The exact way a Discord client returns focus to that message is client behavior and is not guaranteed by the bot.

Do not move existing collectors to the global path merely because the registry exists. Use global routing only when the message is intended to outlive a bounded command session and every interaction can reconstruct its state from the custom ID plus durable data. Continue to use the anchor workflow for multi-step writes, validation, permissions, and cache invalidation that belong to one command session.

### Panel failure observability

A panel reports an expected refusal by returning a status object (`{ status: "write-failed" }`) and
repainting with a red receipt. It does not throw, so the router's exception handler never sees it and
the actor's failure leaves no trace unless something else records it. Two rules keep that class of
failure traceable.

**Every receipt repaint is observable.** `deliverGuardedPanel` takes the receipt in its delivery
options and emits one `panel_failure` metric for an `error` or `warning` tone, carrying the locale,
the heading, and the namespace parsed from the interaction's custom ID. The per-namespace `repaint`
helpers pass their receipt through, so a panel that repaints as failed is countable in production
without each of the roughly 149 receipt literals opting in.

The receipt travels beside the payload rather than inside it. Embedding a marker in the rendered
content would spend the payload's Discord text budget and could push a receipt line past the panel
prose width limit; passing it as an option keeps the outgoing payload byte-for-byte what the caller
built.

**Genuinely broken paths log at error level where the cause is still in scope.** The `panel_failure`
metric is deliberately not an `error_logs` row: most receipts are expected outcomes the actor can
correct (bad input, a stale panel, an unavailable read), and the production log level filters `warn`
out entirely, so neither `log.error` for all of them nor `log.warn` for any of them is right. Paths
where a rollback succeeded, a cause would otherwise be discarded, or a caught error was never read
call `log.error` at the point the cause still exists. That covers the thrown-away cause in the
custom endpoint write rollback, the unreachable-endpoint reasons, the moderation quota result's
unused `error` field, the cross-server memory toggle, and the voice sample download, insert, and
storage failures.

Collector-owned pagination helpers (`replyPaginatedChoices`, `replyPaginatedPersonaChoicesV2`)
follow the same split: an expiry stays at `warn`, while a callback failure or an abnormal collector
end logs at error level with the interaction context.

### The `/setup` wizard

`/setup` is the largest consumer of the global route path. `src/utils/discord/interactions/setupRoutes.ts`
registers the `setup:v1` namespace and `src/utils/discord/ui/setupPanel.ts` builds every panel and modal
from the same draft, so each control and every modal submission arrives as its own `interactionCreate`
rather than through a collector.

- The custom ID carries only the action, the locale, and an opaque nonce. The nonce resolves a bounded
  process-local draft (`setupDraftStore.ts`) bound to the actor, the workspace, and the guild-or-DM
  context, so the panel outlives the command invocation but not the process. `SETUP_DRAFT_MAX_ENTRIES`
  bounds pending drafts, and opening, editing, cancelling, or restarting the process writes nothing.
- Every routed action rechecks the owner, the workspace, the context, `Manage Server`, the step set the
  environment renders before it acts. A stale or forged nonce answers with the terminal session-ended
  payload instead of repainting.
- The step set is captured in the draft, so a draft created under one environment cannot complete a step
  the other environment renders.
- `Finish Setup` acknowledges the interaction before it claims the draft, because the claim, the catalog
  and authorization revalidation, the transaction, the cache invalidation, a guild expression sync, and
  a Discord REST avatar call all follow it.
- A claimed draft is frozen: reads report `in-flight` and writes are refused until the commit releases or
  consumes the claim, so a repeated press cannot run setup twice and a concurrent Cancel cannot zero the
  credential being committed.
- The receipt repaints the wizard's own ephemeral message as Components V2 text displays, because a
  classic embed cannot be edited onto a Components V2 message.

The wizard writes only on the final commit: no step control creates a provider, credential, or
preference row, and the workspace's orphan recovery moved into the same transaction that creates the
replacement rows.

## Webhook Helper Layout

Command, event, tool, and stream code import webhook helpers from responsibility-owned modules:

- `src/utils/discord/webhook/lifecycle.ts` - shared/persona webhook creation, lookup, deletion, and avatar updates
- `src/utils/discord/webhook/personaDispatch.ts` - persona/webhook send paths
- `src/utils/discord/webhook/identity.ts` - persona avatar and webhook identity resolution
- `src/utils/discord/webhook/fallback.ts` - managed-webhook restore and transcript fallback behavior
- `src/utils/discord/webhook/cache.ts` - webhook cache metrics and invalidation helpers

`src/utils/discord/webhookManager.ts` remains only as the subsystem compatibility barrel. New code should import from the owned webhook module directly.

Keep webhook cache invalidation in the same success path as the write or delete that changes webhook state.

## Command File Contract

Subcommand modules export:

- `configureSubcommand(subcommand)`
- `execute(client, interaction, userData, locale)`

Root command modules export:

- `configureCommand(command)`
- `execute(client, interaction, userData, locale)`

Grouped commands are represented by folders:

- `src/commands/export/personal/config.ts` -> `/export personal config`

Model and provider flows that still call `promptForSavedProvider()` use one shared initial
provider-selection embed. Model-selection callers pass the effective slot selection so
the embed can show the active model codename and provider; channel and persona text
commands resolve their scoped override before falling back to the server text model.

The live `/model *` family no longer uses that primitive.
It renders the provider picker, the `>25` range selector, the modal, and the terminal
result on one anchor ephemeral message through the shared helpers in
`src/utils/discord/ui/anchorModelFlow.ts` (see the anchor message controller section
below). `promptForSavedProvider()` is forbidden in those files, and the allow-list audit in
`tests/unit/commands/anchorMigrationLockdown.test.ts` enforces it.

Root commands are represented by top-level command files:

- `src/commands/subscribe.ts` -> `/subscribe`

Root command files may also export optional command-level flags:

- `guildOnly = true` - restricts the command to guilds
- `managerOnly = true` - requires `ManageGuild`
- `nsfw = true` - marks the command as age-restricted
- `isCommandEnabled(context)` - returns `false` to skip command registration and
  execution-map wiring for this module

Use `isCommandEnabled` for commands that are present in source but should be
absent unless a feature gate is active. The loader evaluates the gate after
importing the module but before calling `configureCommand()` or
`configureSubcommand()`. If every subcommand in a category is disabled, the
top-level category command is omitted from registration.

Example:

```ts
export const isCommandEnabled = () =>
  process.env.RUN_ENV === "production" &&
  process.env.TOMORI_SUPPORTER_BILLING_ENABLED === "true";
```

Command modules must not perform production-only side effects at import time.
Keep feature-gated initialization in startup hooks or inside the gated runtime
handler.

## Current Top-Level Categories

- `comment`
- `compact`
- `conditioning`
- `config`
- `contribute`
- `donate`
- `export`
- `expressions`
- `generate`
- `help`
- `impersonate`
- `import`
- `kill`
- `learn`
- `legal`
- `matrix`
- `memories`
- `model`
- `moderation`
- `novelai`
- `nsfw`
- `nuke`
- `persona`
- `personal`
- `ping`
- `providers`
- `punish`
- `quota`
- `refresh`
- `reset`
- `respond`
- `reward`
- `scheduled-task`
- `setup`
- `stats`
- `status`
- `support`
- `tool`
- `update`

## Category Restrictions

Defined in `commandLoader.ts`:

- Guild-only categories: `conditioning`, `expressions`, `impersonate`, `matrix`, `moderation`, `nuke`, `punish`, `quota`, `reward`, `stats`
- Manage Server required by default: `expressions`, `matrix`, `model`, `moderation`, `nsfw`, `nuke`, `providers`, `quota`, `setup`

## Localization Strategy for Command Metadata

Do not hardcode descriptions/choice names.
Use `localizer("en-US", key)` in command builders.

`commandLoader.ts` then auto-applies locale localizations for other loaded locales.

Key pattern:

- Root command description: `commands.{command}.description`
- Root command option description: `commands.{command}.{option}_description`
- Root command choice name: `commands.{command}.{option}_choice_{value}`
- Subcommand description: `commands.{category}.{path}.description`
- Option description: `commands.{category}.{path}.{option}_description`
- Choice name: `commands.{category}.{path}.{option}_choice_{value}`

Example path:

- file: `src/commands/export/personal/config.ts`
- command path: `export.personal.config`

Root command example:

- file: `src/commands/subscribe.ts`
- command path: `subscribe`

## Interaction Timing Rules (Important)

Discord requires interaction acknowledgement within ~3 seconds.

### 3-Second Rule

On slash command invoke, acknowledge within 3 seconds using one of:

- `interaction.reply(...)`
- `interaction.deferReply(...)`
- `interaction.showModal(...)` (or modal helper that sends modal response)

After acknowledgement, you have up to ~15 minutes to complete.

### Pattern 1: Simple Command (No Deferral)

Use when work is synchronous/very fast and has no DB/API/file latency before response.

```ts
export async function execute(...) {
	if (!interaction.guild) {
		await replyInfoEmbed(...);
		return;
	}

	await interaction.reply({ content: "..." });
}
```

Rules:

- no DB query before first reply
- no external API call before first reply
- no filesystem work before first reply

### Pattern 2: Async Command (Defer First)

Use when any meaningful async work happens before first response.

```ts
export async function execute(...) {
	if (!interaction.guild) {
		await replyInfoEmbed(...);
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const state = await getCachedTomoriState(interaction.guild.id);
	await sql`UPDATE ...`;

	await replyInfoEmbed(interaction, locale, { ... });
}
```

Rules:

- run fast validation first
- then defer before DB/API work
- do not defer at function start if early-return validation can finish immediately
- `/tool estimate cost` follows this pattern: it defers first, then fetches recent messages, prepares participants through the shared context API, builds context, and performs provider API token counting

### Pattern 3: Modal Command (No Initial Deferral)

Use when opening a modal for user input.

```ts
const modalResult = await promptWithRawModal(
	interaction,
	locale,
	{ ... },
	MessageFlags.Ephemeral, // auto-defer modal submission
);

if (modalResult.outcome !== "submit") return;
await sql`UPDATE ...`;
await replyInfoEmbed(modalResult.interaction, locale, { ... });
```

Rules:

- do not call `deferReply()` before showing modal
- pre-modal data loading must stay within the initial 3-second window
- if modal submit processing is async and the command will reply on the modal submission itself, pass `MessageFlags.Ephemeral` as `promptWithRawModal` arg 4

### Pattern 3A: Bulk Management Modal (Checkbox Groups)

Use when the user is managing an existing set of configured entries and batch keep/remove is better UX than a one-at-a-time select.

Examples:

- `/moderation` User Blacklist and Whitelist removal actions
- `/model override remove` (channels + personas together)
- `/config` > Engine > Experimental (experimental server-scoped workaround toggles)
- `/memories` Short-Term category (active server-shared STM entries)
- `/config` > Channels > Channel Rules (private, roleplay, and cross-channel blocklist sets)

Rules:

- use `promptWithRawModal(...)` with checkbox groups and `MessageFlags.Ephemeral` auto-defer on submit
- pre-check every existing entry; unchecked means "remove" or "disable"
- set `minValues: 0` and `required: false` so users can uncheck everything
- chunk long lists into groups of 10 options; Discord allows at most 5 groups per modal (50 total options)
- if you are managing multiple entity types in one modal, keep them in separate checkbox groups by type
- if the total set exceeds 50 options, show a page-selection step and launch page-scoped checkbox modals
- after submit, diff original entries against submitted checked values, then invalidate caches only after successful DB writes

### Pattern 3B: Persistent Checklist Setting

Use when one command owns the full enabled-set of a durable setting rather than an add/remove delta flow.

Example:

- `/config` > Channels > Channel Rules
- `/moderation` Personas (each write preserves the persona's complete enabled channel set)

Rules:

- checked means "enabled in the stored set"; unchecked means "disabled from the stored set"
- reopening the command must preload the current saved state
- submit writes the full selected set back to storage, not just the latest delta intent
- if the eligible option set exceeds one modal (`>50`), show a page-selection message first and launch page-scoped checkbox modals from there
- durable server-scoped settings added through this pattern should also be surfaced in `/status`
- keep [`status-command.md`](/architecture/subsystems/status-command/) in sync when `/status` coverage changes

### Pattern 3C: Modal -> Review Prompt -> Modal

Use when a command needs one modal to collect a bulk selection, then a follow-up confirmation or button choice before optionally opening a second modal.

Example:

- `/personal config` (spotlight workflow)

Rules:

- do not auto-defer the first modal submit if you still need to reply with buttons from that modal interaction
- reply to the first modal submit with a review embed + buttons
- if the user picks the branch that needs more input, open the second modal from the unacknowledged button interaction
- after the second modal submit, silently acknowledge with `acknowledgeModalSubmitForRefresh(...)` when you intend to edit the original review reply instead of responding on the second modal itself
- only persist the final DB write after the last user decision is known, then invalidate caches in that same success path

### Pattern 4: Pagination Helpers (No Pre-Defer)

Use when calling `replyPaginatedChoices(...)` or `promptWithPaginatedModal(...)`.

```ts
const result = await replyPaginatedChoices(interaction, locale, { ... });
```

```ts
const modalResult = await promptWithPaginatedModal(interaction, locale, { ... });
if (modalResult.outcome !== "submit") return;

// If submission handling is heavy, defer the modal submission immediately.
await modalResult.interaction.deferReply({ flags: MessageFlags.Ephemeral });
await sql`UPDATE ...`;
await replyInfoEmbed(modalResult.interaction, locale, { ... });
```

Rules:

- do not defer before `replyPaginatedChoices(...)` or `promptWithPaginatedModal(...)` (they acknowledge directly)
- keep pre-helper work under 3 seconds
- `promptWithPaginatedModal(...)` does not expose an auto-defer parameter; defer on submission manually when needed
- commands that begin with a persona picker use Pattern 4A; the workflow owns picker acknowledgment and retries

**`>25`-option selector style (pre-anchor).** This applies to callers still on
`promptWithPaginatedModal(...)`. Commands migrated to the anchor message workflow
(Pattern 4A/4B) never set `selectorStyle`: their `>25` handling is chosen for them by the
engine's range-selector bridge, which always renders the Components V2 selector.

`promptWithPaginatedModal(...)` accepts an optional
`selectorStyle: "legacy" | "componentsV2"` (default `"legacy"`). At `<=25` options both
styles open a modal directly, so this only affects the paginated path:

- `"legacy"` — numbered page-button embed on the interaction's reply (`1` `2` `3`, capped
  at 9 pages).
- `"componentsV2"` — the shared Components V2 range selector (`1-25` / `26-50` ranges +
  Previous/Cancel/Next), byte-identical to the persona workflow's `>25` shell
  (`buildRangeSelectorPayload`). Its Cancel button returns `outcome: "cancelled"` (the
  legacy selector has no Cancel and never returns it); callers gating on
  `outcome !== "submit"` already handle it.

The V2 selector renders `IsComponentsV2` onto the interaction's reply, which Discord then
forbids editing with legacy embeds. The selector marks the interaction, and the shared
sinks (`replyInfoEmbed`/`replySummaryEmbed`/`replyPaginatedStatusPages`) detect the mark
and emit a V2 notice container instead of embeds — so a later error/info reply to the same
interaction cannot collide. Before opting a caller into `"componentsV2"`, confirm the
interaction reaching the helper is unacknowledged (fresh-reply path) rather than a
deferred/replied **legacy** message, since Discord cannot convert a legacy reply to V2 via
`editReply`.

### Pattern 4A: Anchor Message Workflow (persona picker)

The **anchor message workflow** is the engine behind Patterns 4A and 4B. Its rule: one
command invocation owns exactly **one** ephemeral message, edited in place through every
stage — picker, `>25` range selector, modal, progress, and terminal result. Opening a modal
is an acknowledgment, not a second message.

This exists because Discord emits **no event when a user dismisses a modal**. A flow that
opens a modal and leaves its picker message behind therefore strands dead-but-clickable
buttons ("This interaction failed") until the modal's timeout. Rendering everything on one
message makes that orphan impossible by construction, and *collapse-at-open* swaps the live
controls for an inert notice the instant the modal opens.

Two specializations share the engine:

- **Pattern 4A** (below) — the persona picker, via `runPersonaPickerWorkflow`.
- **Pattern 4B** — one-shot picker → modal config commands, via
  `beginAnchorPrivateWorkflow` plus the shared helpers in `anchorModelFlow.ts`.

Non-persona callers import the engine from `src/utils/discord/ui/anchorWorkflow.ts`,
which also exports neutral `Anchor*` aliases for the generic types. The implementation
itself lives in `personaWorkflow.ts`, alongside the persona specialization it shares its
internals with.

Commands that begin with a persona picker use the single command-facing entry point in
`src/utils/discord/ui/personaWorkflow.ts`:

```ts
const result = await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    // Perform one acknowledged workflow transaction.
    return completePersonaWorkflow();
  },
});
```

The options are `personas`, optional picker `titleKey`, `descriptionKey`, and `color`,
optional `requiredPersonaId`, optional asynchronous `onCancel`, and required asynchronous
`onSelected`. The selection phase exposes `persona`, `absoluteIndex`, `phaseId`,
`deliveryPolicy: "replace-picker"`, the message controller, and the typed phase methods
shown below. A successful result has `outcome: "selected"` plus the selected persona,
absolute index, and the value passed to `completePersonaWorkflow(value)`. Error and fatal
results may also include the causal error.

`runPersonaPickerWorkflow(...)` owns the low-level picker, its retry loop, and one
`AvatarSessionCache` for the complete invocation. Callers return
`completePersonaWorkflow(value)` or `retryPersonaWorkflow(updatedPersonas?)`; they do not
write their own outer picker loop. Picker outcomes remain discriminated as `selected`,
`cancelled`, `timeout`, `empty`, `error`, and `fatal`. A fatal picker result exits before
`onSelected` runs, so it cannot enter the retry path. The `empty` outcome
(see the eligibility section) is a terminal state distinct from all others and is never
retried.

Classify collector expiry with `isCollectorTimeoutError(error)` from `interactionCore` —
never with a bare `error === "time"` check. discord.js uses two rejection shapes for the
same event: raw collectors reject with the end-reason string (`"time"` / `"idle"`), while
`Message#awaitMessageComponent` and `awaitModalSubmit` reject with an
`InteractionCollectorError` whose message carries the reason
(`"...ending with reason: time"`). Missing the second shape makes an ordinary user timeout
present as `fatal` with the generic unknown-error copy instead of the timeout notice. Other
end reasons (`limit`, `messageDelete`) and dead-token errors are genuine failures and must
stay classified as `error`/`fatal`.

#### Eligibility filtering (item-scoped `remove` / `edit` / `view`)

Item-scoped commands should only offer personas they can actually act on. Supplying an
optional `eligibility` object to `runPersonaPickerWorkflow(...)` makes the picker show only
qualifying personas, disclose that it is filtered, and reach a terminal `empty` outcome
instead of ever rendering a zero-persona picker.

```ts
export interface PersonaWorkflowEligibility<TPersona extends TomoriState> {
  isEligible: (persona: TPersona) => boolean; // synchronous — never per-persona queries
  emptyTitleKey: string; // terminal state when no persona qualifies
  emptyDescriptionKey: string;
  itemsLabelKey: string; // bare item noun, interpolated into the shared filtered notice
}
```

Rules:

- **Filtering is a UX layer, never the correctness layer.** Every migrated command keeps its
  existing post-selection emptiness guard as a concurrency backstop; the guard and the filter
  must call the *same* predicate so they can never disagree. Shared predicates live in
  `src/utils/discord/ui/personaEligibility.ts`.
- **Filter only `remove` / `edit` / `view` verbs.** `add` / `set` / `assign` must always list
  every persona and must not receive an `eligibility` object.
- **`isEligible` is synchronous.** Class B commands resolve one batched query per invocation
  into a `Set` of eligible keys and close over it (`personaIdIsEligible(set)` /
  `lineageIdIsEligible(set)`); they never issue a query per persona.
- **Refresh the set for mid-loop drains.** When a retry loop deletes items, refresh the
  closed-over set in place with `refreshEligibilitySet(set, freshSet)` after each successful
  write so a persona whose last item was removed drops out on the next retry and the last
  such removal reaches the `empty` terminal state on the anchor message.
- The caller renders its own pre-picker empty notice on its deferred reply (it already
  computes the eligible set for its own guard) and returns before calling the workflow. The
  workflow renders the `empty` terminal state in place only for the mid-loop case.

##### Grouping Key Contract (Class B)

Batched availability queries must key on the same column the loader keys on and reproduce
every filter the loader applies:

| Family | Loader | Grouping key | Extra filters to reproduce |
|---|---|---|---|
| Documents | `serverMemoryRepository.loadDocuments` | `documents.persona_id` | `server_id`; **no** `source_type` filter (history docs count too) |
| History documents | `serverMemoryRepository.loadHistoryDocuments` | `documents.persona_id` | `server_id` **and** `source_type = 'history'` |
| Server memories | `serverMemoryRepository.loadServerMemoriesScoped` | `server_memories.persona_lineage_id` | `server_id`, plus optional `user_id` (permission-dependent) |
| Personal memories | `personalMemoryRepository.loadForUserLineage` | `personal_memories.persona_lineage_id` | `user_id`; lineage `0` excluded so a global memory never marks a specific persona eligible |
| Sprites | `personaSpriteRepository.listForPersona` | **not** `persona_id` | resolves preset pointers first — a pointer persona has zero `persona_sprites` rows yet still has sprites, so a bare `GROUP BY persona_id` is wrong; reproduce the numeric `sprite_id` narrowing |

Two traps are worth stating explicitly:

- **Permission-dependent eligibility.** `/memories` Server category operations
  scope their loads by `hasManagePermission ? undefined : userData.user_id`. The batched
  availability query takes the same optional `userId`, so a manager and a non-manager can see
  different eligible sets for the same command in the same guild.
- **Sprite pointer trap.** `personaSpriteRepository.personaIdsWithSprites(personaIds)`
  resolves pointers in bulk (own rows for materialized personas, shared `preset_sprites` for
  live pointer personas); it must not be reduced to a `GROUP BY persona_id` over
  `persona_sprites`.

##### Class A example (field-backed predicate, no query)

```ts
import { hasAttributes } from "@/utils/discord/ui/personaEligibility";

const eligible = allPersonas.filter(hasAttributes);
if (eligible.length === 0) {
  await replyInfoEmbed(interaction, locale, {
    titleKey: "commands.forget.attribute.no_attributes_title",
    descriptionKey: "commands.forget.attribute.no_attributes",
    color: ColorCode.WARN,
    flags: MessageFlags.Ephemeral,
  });
  return;
}

await runPersonaPickerWorkflow(interaction, locale, {
  personas: allPersonas, // full list — the workflow filters for display
  eligibility: {
    isEligible: hasAttributes,
    emptyTitleKey: "commands.forget.attribute.no_attributes_title",
    emptyDescriptionKey: "commands.forget.attribute.no_attributes",
    itemsLabelKey: "general.persona_workflow.items.attributes",
  },
  onSelected: async (selection) => {
    if (!hasAttributes(selection.persona)) return retryPersonaWorkflow(); // backstop
    // ...perform the acknowledged transaction...
    return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
  },
});
```

##### Class B example (batched query + refreshed set)

```ts
import { personaIdIsEligible, refreshEligibilitySet } from "@/utils/discord/ui/personaEligibility";

const eligibleIds = await serverMemoryRepository.personaIdsWithDocuments(serverId);
const isEligible = personaIdIsEligible(eligibleIds);
if (allPersonas.filter(isEligible).length === 0) {
  /* render pre-picker empty notice and return */
}

await runPersonaPickerWorkflow(interaction, locale, {
  personas: allPersonas,
  eligibility: { isEligible, emptyTitleKey, emptyDescriptionKey, itemsLabelKey },
  onSelected: async (selection) => {
    // ...remove one document (post-selection load stays the backstop)...
    await refreshEligibilitySet(eligibleIds, serverMemoryRepository.personaIdsWithDocuments(serverId));
    return retryPersonaWorkflow(await personaRepository.loadAllForServer(serverDiscId));
  },
});
```

Every same-visibility workflow owns one anchor ephemeral Components V2 message. Its
message ID is exposed as `selection.message.anchorMessageId` and must remain unchanged
through loading, selectors, validation, progress, results, errors, and timeouts. Opening a
modal is an interaction acknowledgment, not another message. The only normal visibility
change is the typed `separate-public` phase described below.

#### First-acknowledgment contract

Choose the phase operation before doing DB, filesystem, network, image, or embedding work.
Each operation below owns the first acknowledgment; do not call a raw interaction method
before it.

| Phase operation | First acknowledgment | Use it when |
| --- | --- | --- |
| Workflow entry | The caller defers the ephemeral slash response before any asynchronous persona/state preload; the internal picker defensively defers if entry is still unacknowledged | Starting any persona workflow |
| `selection.openModal(options)` with at most 25 select options | `showModal()` on the selected persona button | Modal options are already available synchronously |
| `selection.openModal(options)` with more than 25 select options | `update()` replaces the picker with range buttons | Preloaded modal options exceed Discord's select limit; the chosen range button later calls `showModal()` |
| `selection.openModal(async () => options)` | `deferUpdate()` on the selected button, then an in-place loading state | Modal options require DB or other asynchronous work; a new launcher/range button later opens the modal |
| `selection.beginInPlaceWork()` | `deferUpdate()` on the selected persona button | Any non-modal asynchronous work |
| `modal.phase.replace(payload)` | `update()` on the message-backed modal submission | A fast terminal replacement whose payload is already built |
| `modal.phase.beginInPlaceWork()` | `deferUpdate()` on the modal submission | Processing submitted values with asynchronous work |
| `selection.useButton(button).replace(payload)` | `update()` on that nested button | A fast private-view transition whose payload is ready |
| `selection.useButton(button).beginInPlaceWork()` | `deferUpdate()` on that nested button | A nested view action needs asynchronous work |
| `selection.useButton(button).openModal(...)` | The same direct/factory modal rules above | A private view button opens a modal |
| `selection.useButton(button).delete()` | `deferUpdate()`, then anchor-message deletion | Closing a private view |
| `selection.beginSeparatePublicReply(compactPayload)` | `update()` compacts the private picker; `publicPhase.reply()` then sends one public follow-up | The result is intentionally public |

Calling two first-ack operations for the same interaction throws a
`PersonaWorkflowUpdateError` with code `already-acknowledged`. Raw REST modal state is
tracked separately from discord.js `replied`/`deferred`, so a raw modal acknowledgment is
not repeated accidentally.

Persona arrays are loaded before the workflow entry today, so acknowledge the slash command
with `deferReply({ flags: MessageFlags.Ephemeral })` before that asynchronous load. If the
command also has a root-modal scope, resolve the scope synchronously and defer only the persona
branch; a deferred root interaction cannot open its own modal. The workflow reuses the deferred
anchor response and still owns every component acknowledgment after the picker renders.

The bare message controller edits the root reply; it does not acknowledge the currently
pending button or modal submission. Do not call `selection.message.replace(...)` before
choosing `beginInPlaceWork()`, `openModal(...)`, or `beginSeparatePublicReply(...)`, and do
not mutate `modal.phase.message` before choosing `modal.phase.replace(...)` or
`modal.phase.beginInPlaceWork()`. Nested buttons use
the operations returned by `selection.useButton(button)` for the same reason.

`openModal(...)` returns `submitted`, `cancelled`, `timeout`, `error`, or `fatal`. A
submitted phase exposes single values in `values`, string-select/checkbox values in
`multiValues`, uploaded files in `attachments`, the range's `optionOffset`, the message
controller, direct `replace(payload)`, `beginInPlaceWork()`, and the narrowly scoped `unsafeInteraction()` escape
hatch. Check the outcome before accessing the phase.

#### Anchor message controller

`selection.message`, in-place phases, and modal phases expose the same typed controller:

- `replace(payload)` edits the anchor message and clears old attachments unless the
  payload explicitly supplies `attachments`;
- `edit(payload)` edits while retaining existing attachments when `attachments` is omitted;
- `fetchMessage()` returns the anchor `Message` and verifies its ID;
- `disableControls()` keeps the current view readable and disables every interactive
  component;
- `delete()` deletes the anchor reply and makes later operations fail with `deleted`.

Both `replace` and `edit` accept only `PersonaWorkflowComponentsV2Payload`: `components`
and `MessageFlags.IsComponentsV2` are required, while `content` and `embeds` are forbidden
at both the TypeScript and runtime boundaries. Message mismatch, missing message backing,
expired tokens, and Discord edit failures are typed errors. The controller never converts
an in-place failure into another ephemeral `reply`, `followUp`, or `webhook.send`.

#### Copyable examples

The examples below show command-body code. Substitute the repository method and locale keys
for the command being migrated; keep the workflow calls and acknowledgment ordering intact.

##### Simple in-place work

```ts
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
} from "@/utils/discord/ui/personaWorkflow";

await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    const work = await selection.beginInPlaceWork();
    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        color: ColorCode.INFO,
        titleKey: "general.persona_workflow.loading_title",
        descriptionKey: "general.persona_workflow.loading_description",
      }),
    );

    const removed = await personaRepository.removePrompt(selection.persona.persona_id);
    if (!removed) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          color: ColorCode.ERROR,
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
        }),
      );
      return completePersonaWorkflow();
    }

    invalidateTomoriStateCache(interaction.guildId ?? interaction.user.id);
    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        color: ColorCode.SUCCESS,
        titleKey: "commands.forget.personaprompt.success_title",
        descriptionKey: "commands.forget.personaprompt.success_description",
        descriptionVars: { persona_name: selection.persona.persona_nickname },
      }),
    );
    return completePersonaWorkflow();
  },
});
```

##### Modal transaction and retry

```ts
await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    const modal = await selection.openModal(async () => {
      // The selected button is already update-deferred before this DB read.
      const memories = await personalMemoryRepository.loadForUserLineage(
        userData.user_id,
        selection.persona.persona_lineage_id ?? 0,
        false,
      );
      return {
        modalCustomId: "memory_edit_select",
        modalTitleKey: "commands.memory.personal.edit.select_modal_title",
        components: [
          {
            customId: "memory_select",
            labelKey: "commands.memory.personal.edit.select_label",
            required: true,
            options: memories.map((memory) => ({
              label: memory.content,
              value: String(memory.personal_memory_id),
            })),
          },
        ],
      };
    });

    if (modal.outcome === "fatal") throw modal.error;
    if (modal.outcome !== "submitted") return retryPersonaWorkflow();

    const work = await modal.phase.beginInPlaceWork();
    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        color: ColorCode.INFO,
        titleKey: "general.persona_workflow.loading_title",
        descriptionKey: "general.persona_workflow.loading_description",
      }),
    );

    const memoryId = Number.parseInt(modal.phase.values.memory_select ?? "", 10);
    const updated = await personalMemoryRepository.edit(memoryId, "replacement text", []);
    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        color: updated ? ColorCode.SUCCESS : ColorCode.ERROR,
        titleKey: updated
          ? "commands.memory.personal.edit.success_title"
          : "general.errors.update_failed_title",
        descriptionKey: updated
          ? "commands.memory.personal.edit.success_description"
          : "general.errors.update_failed_description",
      }),
    );
    return retryPersonaWorkflow();
  },
});
```

When a modal select contains more than 25 options, `openModal` replaces the anchor
message with localized range buttons and opens the modal from the chosen range button.
`modal.phase.optionOffset` is the absolute offset of that slice for callers whose option
values are page-local indexes.

##### Interactive private view

```ts
import { PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS } from "@/utils/discord/ui/personaWorkflow";

await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    let page = 0;
    const work = await selection.beginInPlaceWork();
    await work.message.replace(renderPrivatePage(locale, page));
    const message = await work.message.fetchMessage();

    try {
      while (true) {
        const button = await message.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (candidate) => candidate.user.id === interaction.user.id,
          time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
        });
        const action = selection.useButton(button);

        if (button.customId === "view_close") {
          await action.delete();
          return completePersonaWorkflow();
        }

        page += button.customId === "view_next" ? 1 : -1;
        await action.replace(renderPrivatePage(locale, page));
      }
    } catch {
      await work.message.disableControls();
      return completePersonaWorkflow();
    }
  },
});
```

Declare `renderPrivatePage` to return `PersonaWorkflowComponentsV2Payload`; this makes a
legacy `content` or `embeds` field a compile-time error. For navigation that must load data,
call `action.beginInPlaceWork()` before the load and then replace through its controller.
The example reuses the documented workflow timeout instead of hardcoding a separate
collector lifetime.

##### Explicit public result

```ts
await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    const publicPhase = await selection.beginSeparatePublicReply(
      buildPersonaWorkflowNotice({
        locale,
        color: ColorCode.SUCCESS,
        titleKey: "commands.stats.persona.chosen_title",
        titleVars: { name: selection.persona.persona_nickname },
      }),
    );

    await publicPhase.reply({
      content: localizer(locale, "commands.stats.generate.picker_description"),
      allowedMentions: { parse: [] },
    });
    return completePersonaWorkflow();
  },
});
```

`publicPhase.reply()` rejects ephemeral flags and a second call. The compact private picker
and the one public response are the two messages only because visibility changed explicitly.

#### Rare low-level exception process

Command and feature code must not import or invoke `replyPaginatedPersonaChoicesV2`, set
`preserveSelectedInteraction: true`, provide an empty picker `onSelect`, or introduce a
competing persona-selection helper such as `selectConditioningPersona`. The
`tests/unit/checks/personaWorkflowBoundary.test.ts` audit enforces this across `src/`.

If Discord exposes an operation that the typed phases cannot represent, use
`selection.unsafeInteractions()` only for that operation and keep all message mutations on
`selection.message`. If direct low-level picker access is genuinely unavoidable, the change
must include all of the following:

1. A narrow, exact-path entry with rationale in
   `scripts/checks/lib/personaWorkflowBoundary.ts`.
2. A focused test proving acknowledgment timing, anchor-message identity, V2-only
   payloads, and no private fallback reply.
3. An update to this section documenting why the workflow API could not express the case.

An exception must never weaken the repository-wide scanner or add a directory-wide bypass.

### Pattern 4B: Anchor One-Shot Picker -> Modal

Use for a config command shaped *pick a provider -> choose a value in a modal -> show the
result*. The whole `/model *` family is built
this way, plus `/config` > Models > Fallbacks & Randomizer.

The command expresses only business intent — which model table to read, which column to
write, which terminal copy to show. All lifecycle branching lives in the shared helpers in
`src/utils/discord/ui/anchorModelFlow.ts`:

```ts
const initialPayload =
  savedProviders.length === 0
    ? buildNoProvidersPayload(locale, "personal")
    : savedProviders.length === 1
      ? buildOpenSelectorPayload(locale, `${ID_ROOT}_open`)
      : buildProviderPickerPayload(locale, ID_ROOT, providers, currentSelections);

const phase = await beginAnchorPrivateWorkflow(interaction, locale, initialPayload);
anchorMessage = phase.message;                        // for the outer catch
if (savedProviders.length === 0) return;

const opener = await acquireModelModalOpener(phase, userId, locale, savedProviders, ID_ROOT);
if (!opener) return;                                     // cancel/timeout already rendered

const modalPhase = await openAnchorModal(phase, opener.button, locale, modalOptions);
if (!modalPhase) return;                                 // dismiss/cancel already rendered

const work = await modalPhase.beginInPlaceWork();        // acks the submit within 3s
await work.message.replace(terminalPayload);             // terminal lands on the same message
```

Rules:

- **Never** call `promptForSavedProvider`, `promptWithPaginatedModal`, `promptWithRawModal`,
  or `replaceProviderPickerWithInfo` from a file that uses this pattern. List the file in
  `MIGRATED_ANCHOR_CALLERS`; the audit in
  `tests/unit/commands/anchorMigrationLockdown.test.ts` then fails the build if one of
  those primitives reappears in it.
- Every terminal — success, validation failure, write failure, and the outer `catch` —
  renders through `work.message.replace(...)` or the tracked `anchorMessage`, never
  `replyInfoEmbed`. Absence of the banned primitives is what transitively guarantees this.
- `>25` options need no caller handling: `openAnchorModal` routes through the engine's
  range-selector bridge automatically.
- Single-provider flows still show an explicit "open selector" button. A modal must open from
  an interaction the controller owns, so the slash command cannot open it directly.

**When the bridge does not fit.** The bridge slices exactly one select component and assumes
every entry is a selectable option. `/config` > Models > Fallbacks & Randomizer violates both — five selects over one
shared option list, with one entry per page reserved for an explicit "None" choice. Such a
command picks its range on the anchor message first via `acquireModalOptionRange(...)`
(passing a `pageSize` below 25 to reserve entries), then hands `openAnchorModal` an
already-sliced `<=25` list, which opens directly.

### Pattern 5: Manual Deferral Timing

Use when you must delay deferral until after quick checks.

```ts
if (!hasPermission) {
	await replyInfoEmbed(...);
	return;
}

await interaction.deferReply({ flags: MessageFlags.Ephemeral });
const data = await exportServerData(...);
await interaction.editReply({ files: [data] });
```

Rules:

- keep pre-defer path fast
- once async heavy work starts, interaction must already be acknowledged

### Common Mistakes

- defer before `promptWithRawModal(...)` (causes already-acknowledged errors)
- no defer before DB/API updates in async command paths
- pre-defer before pagination helpers
- forgetting to defer modal submissions that do heavy async processing

### Helper Behavior Notes

- `replyInfoEmbed(...)` / `replySummaryEmbed(...)`:
  - handle `reply` vs `editReply` based on interaction state
- `promptWithRawModal(...)`:
  - shows modal (acknowledges original interaction)
  - optional arg 4 (`autoDeferReply`) can defer modal submission automatically
- `promptWithUnacknowledgedConfirmation(...)`:
  - shows confirm/cancel buttons without pre-acknowledging the confirm button
  - use this for button -> modal flows where `showModal()` must happen after confirmation
- `replyPaginatedChoices(...)` / `promptWithPaginatedModal(...)`:
  - send pagination UI immediately (acknowledges interaction)
  - should be called without pre-deferring

### Quick Reference

| Command Type | Defer Before Work? | Primary API |
| --- | --- | --- |
| Simple/Fast | No | `interaction.reply(...)` |
| DB/API before response | Yes | `interaction.deferReply(...)` then helper reply |
| Modal | No (before modal) | `promptWithRawModal(...)` |
| Pagination | No (before helper) | `replyPaginatedChoices(...)` / `promptWithPaginatedModal(...)` |
| Persona workflow | No | `runPersonaPickerWorkflow(...)`; select a typed phase operation before work |
| Manual timing | Depends | defer after quick checks, before heavy work |

## Representative Command Groups

The primary MCP management surface is `/config` > Plugins > MCP Servers. The page's navigation is
reconstructable and performs no writes. Routed navigation and mutation
submissions derive guild or DM-workspace scope again and recheck Manage Server in guilds. The Add
opener rechecks permission before showing the form; its submit repeats the full scope and permission
checks. Entity mutations resolve stable MCP row IDs inside that scope before a write. Known unsupported
route versions receive a localized stale-panel response; unrelated component IDs remain available to
collector workflows.
Healthy empty and collection views repaint automatically after transactions and do not expose a routine
refresh control. Stale or unavailable reads expose a read-only **Retry** action; Retry reloads saved
configuration and never connects to an MCP endpoint. The collection renders every supported registration
in deterministic order with its own Enable/Disable and Remove actions, then a **+ Add MCP** action.
Receipts render in a separate top-level container below the authoritative collection repaint.
**+ Add MCP** opens one raw modal containing Name, URL, optional Auth Token, and the required
General Purpose/Web Search/URL Fetcher Radio Group, with General Purpose selected by default. Its modal
and field IDs carry bounded random nonces, and submission returns through the global router rather
than an invocation-scoped modal collector, so a supported open modal can survive a process restart.

- `config`: setup, model(text/image/embedding/video/vision/speech/transcription), api-key(rotation), provider(add/remove), custom-endpoint(add/edit/remove), image-tags(default-positive/default-negative), system-prompt(set/remove/preset), context-note(set), params(*), timezone, message-fetch-limit, self-debug, model-randomizer, workarounds, bot-permissions -> tool-use(toggle/manage), notice-embeds(visibility)
- `speech`: elevenlabs, voice-assign, transcripts, voice-design(set/remove)
- `nsfw`: jailbreaks
- `optional-key`: brave/set/remove
- `server`: trigger(add/delete), whitelist(channel/persona/role/remove), stm(manage), cooldown(triggers), auto-trigger(channels/threshold), matrix(link/unlink), quota(image-generation/text-generation/video-generation/reset), rp-channels, crosschannel-blocklist, welcome-channel(set/remove), private-channels, user-blacklist(add/remove), member-permissions, always-reply, thought-logs-channel, channel-prompt
- `novelai`: generate(image)
- `server`: trigger(add/delete), whitelist(channel/persona/role/remove), stm(manage), cooldown(triggers), auto-trigger(*), matrix(link/unlink), quota(image-generation/text-generation/video-generation/reset), rp-channels, crosschannel-blocklist, welcome-channel(set/remove), private-channels, user-blacklist(add/remove)
- `persona`: create, generate, import, export, default, swap, remove, image-tags, sprites(add/edit/remove/export/import), attribute(add/edit/remove), sample-dialogue(add/edit/remove), prompt(set/remove), history(import/remove)
- `memory`: document(add/remove)
- `export`: config, memories, personal(config/memories)
- `import`: config, memories, personal(config/memories)
- `personal`: privacy, language, nickname, image-tags, cache, config(import/export/remove), provider(add/remove/model-text/model-embedding/model-image/model-video/model-vision/toggle-models), model(fallback), parameters, impersonate(prompt), spotlight(set/manage)
- `scheduled-task`: edit, remove
- `conditioning`: manage, reward(headpat/hug/kiss/tickle), punish(spank/pinch/bite/squeeze)
- `tool`: ping, status, refresh, compact, comment
- `stats`: personal(scope toggle), persona(autocomplete), server — each takes an optional `timeframe` (default All-Time)

`/stats` is a guild-only category that reads the `stat_counters` telemetry table (see [database-schema](database-schema)). Each subcommand (`personal`, `persona`, `server`) takes an **optional** `timeframe` choice (`Today` / `Last 7 Days` / `Last 30 Days` / `Last Year` / `All-Time`), defaulting to **All-Time** when omitted; `personal` adds a required `scope` choice (`This Server` / `All Servers`) — declared before `timeframe` because Discord rejects a required option after an optional one. The result is a **public, invoker-controlled tabbed dashboard** (`src/utils/stats/statsDashboard.ts`) built on **Components V2**: each tab is a single container (H3 title, separator-divided stat sections, and the tab buttons living inside the card). A row of named tab buttons swaps which container is shown (a tabbed view, not item pagination). Only the invoker can operate the tabs; the buttons are stripped on collector timeout (`STATS_DASHBOARD_TIMEOUT_MS`, default 5 min). The renderer uses a single **persistent** `createMessageComponentCollector` (not a one-shot `awaitMessageComponent` loop) so rapid tab switching can't land in a no-collector gap, and wraps each `button.update` in try/catch so a stale/expired interaction (DiscordAPIError 10062) can never tear down the dashboard. Dashboard and infographic entry points drain the in-memory stat buffer before querying, so their snapshots include all successfully buffered work from the current process. **Timeframe gating:** rewards/punishments and memories are all-time-only; daily telemetry, including generation totals, works for every timeframe. Span metrics (streaks, most-active hour/day) are hidden under the single-day `Today` view. `/stats persona` uses autocomplete to select from all guild personas, validating the ID and rendering the public dashboard directly via follow-up after an initial private deferral. Token and cost figures prefer provider-reported usage and fall back to character estimates when unavailable; they remain estimates because pricing can be incomplete or provider-dependent. Timeframe windows use the daily-bucket floor, so `Today` is the current UTC day, not a rolling 24h.

`/config` > Channels > Auto-Trigger is channel-scoped and uses one shared cycle across its configured channels. Threshold `0` enables always-reply in those channels. Positive values use either a fixed trigger (`min = max`) or a shared inclusive random range (`min-max`), rerolling after each successful auto-trigger. The cycle only advances on qualifying real user-like messages; TomoriBot and alter webhook self-messages do not advance or consume the auto-trigger counter. Removing a channel disables auto-trigger behavior for that channel. The page can also target a single channel and assign one persona to that room's auto-trigger fallback instead of always using the main persona.

`/config` > Channels > Channel Overrides scopes a system prompt to one channel. It selects the channel, then opens a prefilled 4-part modal (up to 16000 chars, part 1 optional) plus a Radio Group for Prompt Mode (`Append` / `Replace`). `Append` injects the channel prompt as a distinct `SYSTEM_CHANNEL_PROMPT` block after the server system prompt; `Replace` substitutes the channel prompt for the server system prompt's slot — persona prompt and persona attributes are never affected. Submitting with all prompt parts empty removes the channel's override. State lives in the standalone `channel_prompt_overrides` table (per-channel, never exported) and is resolved per request via `getCachedChannelPrompt`. The override surfaces in `/tool prompt snapshot` under the `Channel Prompt` header.

`/config` > Persona > Sprites carries every sprite action for the selected persona. Add validates a
sprite label, uploads an image, converts it to PNG, and upserts a `persona_sprites` row. Reusing a
normalized label replaces the existing sprite. Edit opens a prefilled modal for name, optional
replacement image, usage instructions, and identity status. A replacement image consumes the
shared avatar quota, while a metadata-only edit does not. Remove uses a fingerprinted confirmation
for the selected sprite. Export bundles the persona's sprites into a shareable `.zip`. Import takes
a `.zip` file upload, validates and converts every image up front, reserves one import-quota slot
for the whole batch, overwrites on name conflicts, and rejects the entire import if it would exceed
`PERSONA_SPRITE_MAX_PER_PERSONA`. The archive format and its ZIP-bomb guards live in
`src/utils/persona/spriteArchive.ts`. See [multi-persona](multi-persona) for the format details.

The sprite selector reserves its first option for `+ Add Sprite`, leaving 24 stored sprites per
page. Selecting a stored sprite shows its image as a thumbnail beside its details. Public image
URLs render directly, while local storage references are attached to the ephemeral panel and use an
`attachment://` thumbnail URL. Persona avatar resolution and sprite-list loading run concurrently
after the component interaction has been acknowledged. The add option is absent for actors who
cannot mutate sprites because Discord cannot disable one select option.

`/config` > Persona > Triggers keeps trigger-word controls separate from Identity & Personality so
collection selections and write receipts remain below Discord's 40-component message limit.
Ordinary members may inspect trigger words, but both mutation buttons and their replayed routes
require Manage Server.

`/config` > Persona > Appearance owns per-persona image tags and the NovelAI character reference.
The panel previews a trusted saved reference without exposing its storage URL or path, using a
configured public URL directly and a local attachment fallback. Uploading a reference is required
in the upload modal; clearing uses a separate confirmation.
Appearance follows Memories in the page selector, followed by Voice and Overrides, with Advanced placed last. Advanced owns persona prompts, context notes, and
ATTG metadata; Overrides owns response style and text-model overrides.
Text model overrides use a provider picker followed by a modal model picker when the provider has
at most 25 models; larger catalogs retain the paginated picker because Discord limits one select to
25 options.

Behavior pages place Advanced Memory before Notice Behavior and keep Experimental Behavior last.
Trigger cooldown omits its stored duration while disabled. Notice Behavior marks each notice with
a green or red status icon and explains that disabled notice embeds are redirected to Logs.

`/config` > Models > Switch Models exposes eight capability slots. The six ordinary model-routing
slots select a model from the registered provider catalogs and persist their corresponding model-column
choices. TTS and STT are workspace-wide speech slots: each selects a registered, server-scoped endpoint
and activates its selected scoped endpoint record (the active/default endpoint), without writing a model
column. Each speech selector is bounded by Discord's 25-option limit and validates a freshly loaded scoped
endpoint list before writing, so a stale choice cannot change state. TTS follows `voice_message_enabled`;
STT has no equivalent flag. `/personal config` retains six personal model-routing slots and directs users
to `/config` for workspace-wide TTS/STT.

`/conditioning remove` shows the removal modal directly when stored conditioning entries are at or under
the modal ceiling of 50. When more than 50 entries exist, it displays a minimal ephemeral page-select
whose routed buttons each open the removal modal for a 50-entry batch. Modal submissions remain bound to a
fingerprint of the exact entries presented. `/conditioning manage` is a temporary compatibility leaf running
the same implementation.

`/generate image` Auto mode is a modal-driven, fire-and-forget scene snapshot flow. It plans against the current channel context with the active text provider, preparing its simplified-history participants through the same API as live chat, then renders with either the current provider's native image path or NovelAI's tag-based image tool when a NovelAI backend is available. Personal provider overlays apply before the hidden turn is built so personal text/image routing is respected.

`/generate scene` is a modal-driven scripted text-scene command. V1 requires two different personas, optionally accepts a third, blocks duplicate selections, and only opens when the available persona set fits Discord's 25-option select limit. The `Rounds` field repeats the selected speaking order and is bounded by `GENERATE_SCENE_MAX_CYCLES` (default `10`; TomoriBot is BYOK so each generated turn bills the invoking user's own provider). Each generated turn receives a concise tail directive: additional instructions when provided, then "Begin your next reply as {persona}. Write only this character's next message." Scene turns keep tools enabled, suppress `/respond` continuation prompting, and use unique text-quota trigger keys so each generated turn is charged separately. Because every scene turn shares one trigger message, both reply-to-trigger mechanisms are suppressed for scene turns: the visual Discord reply (`replyToMessage` in `toolLoop.ts`) and the textual `buildQueuedReplyDirective` context directive (`contextPipeline.ts`) — otherwise every queued persona would render and be told to reply to the same unrelated message. The command-execution status embed (`commands.generate.scene.success_title`) is sent non-ephemerally so it is classified as a `scene_directive` system embed and re-read into context as `[System: ...]`. For scene turns after the first, `triggererName` (what `{{user}}` resolves to in `turnPlanner.ts`) is overridden to the previous speaker in `sceneTurn.sequence`, so each persona treats the prior persona as the entity it is responding to rather than the command invoker; turn 0 has no prior speaker and keeps the invoker.

`/generate video` is a modal-driven async generation command. It validates `videogen_enabled`, provider capability, API key, configured `video_model_id`, and server quota before polling the selected provider until the MP4 result is ready.

`/generate voice-message` is a modal-driven manual driver for the server's active speech endpoint, so auditioning a clone sample or a voice design prompt does not require a chat turn and a model that decides to call the tool. It accepts an optional `persona` (autocompleted through the same whitelist and personal-spotlight filter as `/impersonate persona`, then re-checked on submit because autocomplete output is only a client-side suggestion), an optional `voice_sample` attachment, and an optional `voice_design` prompt. The two overrides are never persisted: the uploaded buffer stays in memory for the invocation, and `resolveVoiceSourceCandidates` decides which of the four possible sources the modal offers, in the order upload, typed design prompt, persona sample, persona design prompt. An endpoint that accepts neither request shape, such as ElevenLabs, ignores both user options and uses the persona's stored voice id.

The command holds the same pre-modal line as the other `/generate` subcommands: it must acknowledge within three seconds without deferring, so `voice_sample` is validated on metadata only (MIME type and byte size) before the modal opens, and the download, duration check, and ffmpeg normalization happen after submission. It gates on `voice_message_enabled` and shares the trigger cooldown with message triggers, mirroring `/generate scene`. Because a voice message is sent under a persona's name and avatar, the command requires a guild text channel or thread, resolves a webhook rather than falling back to bot identity, and posts the transcript caption plus `setCachedVoiceTranscript` exactly as the tool path does. `audio_generated` is recorded once, on success only, with the same three backend keys as the tool.

The randomizer on `/config` > Models > Fallbacks & Randomizer is a server-level toggle for the per-turn text model randomizer. When enabled, each generation turn randomly promotes one model from the pool (primary model + configured fallbacks) to lead the attempt chain, breaking the bot out of any single model's repetitive phrasing while keeping the rest as failover. It enforces a **block-until-fallbacks** precondition: enabling is refused with a localized warning embed unless the server has ≥1 fallback configured on that same page, guaranteeing the pool always has ≥2 members so the toggle is never a silent no-op. The flag lives in `server_chat_configs.model_randomizer_enabled` and is consumed by `buildGenerationAttempts` — see the [generation-turn pipeline](../pipelines/chat/06-per-turn/03-run-generation-turn).

The Compatibility section of `/config` > Engine > Experimental is a checkbox-group modal for experimental compatibility patches. V1 exposes `Verbatim Tool-Calling`, a default-off server flag stored in `server_capabilities_configs.verbatim_tool_calling_enabled`. It writes only changed columns through `ConfigRepository.updateCapabilitiesConfig` and invalidates TomoriState cache after a successful DB write.

### Personal-provider (BYOK) routing in commands

Any command that performs AI work the invoking user triggers must honor that user's personal (BYOK) provider. TomoriState-consuming command handlers apply the user's personal provider onto the loaded server state via `applyPersonalProviderSelectionsToTomoriState(tomoriState, userData.user_id)` before reading `config.api_key`, deriving the provider/model name, or validating capabilities. The overlay returns the server state unchanged when the user has no enabled personal provider, so it is always safe to call. Commands that currently apply it: `/persona generate`, `/novelai generate image`, `/generate image`, `/generate video`, `/learn history`, `/expressions initialize`, and `/tool estimate cost` (so its live estimate stays in parity with what would actually run for the user).

In contrast, `/memories` resolves the invoking user's embedding credentials directly through the credential resolver via `resolveCapabilityCredentials(serverId, "embedding", { userId })` during document addition and memory vectorization operations.

The one deliberate exception is `/config` > Models > Switch Models, which re-embeds **server-wide** documents under server credentials (`resolveCapabilityCredentials(serverId, "embedding")` with no `userId`). This is bulk maintenance of a pre-existing server resource rather than a fresh user action, so it intentionally stays on server credentials.

Forward-looking command rewrite guidance (naming conventions, checklist-style settings pattern, migration map) is now part of `docs/en/contributing/adding-slash-command.md`. The runtime loader and current implementation still use the existing `src/commands/` structure.

## Adding a New Command

1. Add a `.ts` file under the correct command category/group path.
2. Export `configureSubcommand` and `execute`. Root commands export
   `configureCommand` and `execute`.
3. Add locale keys in both locale trees (`src/locales/en-US/` and `src/locales/ja/`). Command keys live in `commands/{category}.ts` within each locale directory.
4. Run:
   - `bun run check-locales`
   - `bun run check`
   - `bun run lint`
