---
title: "Utils and Helpers"
---

This is a current map of shared utility modules under `src/utils/`.

## Folder Map

- `utils/async`
- `utils/audio`
- `utils/bridges`
- `utils/cache`
- `utils/chat`
- `utils/compaction`
- `utils/conditioning`
- `utils/db`
- `utils/discord`
- `utils/documents`
- `utils/embeddings`
- `utils/image`
- `utils/mcp`
- `utils/media`
- `utils/memory`
- `utils/metrics`
- `utils/misc`
- `utils/novelai`
- `utils/persona`
- `utils/provider`
- `utils/quota`
- `utils/security`
- `utils/storage`
- `utils/teach`
- `utils/text`
- `utils/tools`

## High-Impact Modules

### `utils/db`

- `client.ts`: DB client wiring
- `initializeDatabase.ts`: schema + seed startup runner
- `sqlSecurity.ts`: query parameterisation helpers
- `sqlSplitter.ts`: SQL file parsing utilities
- `ragAvailability.ts`: pgvector / RAG feature detection
- `repositories/`: 28 domain-owned repository modules + `index.ts` (shared instance + type re-exports only). SQL remains in its owning module; no `*ReadSql.ts` / `*WriteSql.ts` sibling files exist. `ErrorLogRepository` is a thin shim used by `logger.ts` to insert into `error_logs` without creating a circular import. See `docs/en/architecture/subsystems/database-schema.md` for the full repository table and SQL convention.

### `utils/discord`

- `commandLoader.ts`: command discovery + localization wiring
- `commandRegistry.ts`: runtime command maps used by handlers
- `interactionHelper.ts`: compatibility barrel for grouped UI helpers in `utils/discord/ui/`; new code imports the owned UI module directly
- `streamOrchestrator.ts`: public stream orchestration entry point backed by responsibility modules in `utils/discord/stream/`
- `webhookManager.ts`: compatibility barrel for grouped webhook helpers in `utils/discord/webhook/`; new code imports the owned webhook module directly
- `embedHelper.ts`: shared embed builders and senders (`createStandardEmbed`, `createSummaryEmbed`, `createTipText`, `sendStandardEmbed`) — see [Tip modals](#tip-modals) below
- `textDisplayModal.ts`: reusable read-only text modal, trigger button, and collector wiring
- `historyFetcher.ts`, `historyFormatter.ts`

#### Tip modals

`createTipText(locale, tipKeys, tipVars?)` in `embedHelper.ts` builds the reusable markdown opened by
the **What You Can Do** button below an error (e.g. in `stream/errorUi.ts` and `ui/interactionCore.ts`).

- Each entry in `tipKeys` is an **atomic** locale key resolved independently and rendered as its own
  dashed bullet (`- item`). Keys live under `genai.tips.*` (see the Localization doc's
  [Tip-item keys](./localization.md#tip-item-keys-genaitips) convention).
- Tips render in a read-only Discord text-display modal, so markdown and hyperlinks remain usable
  without adding another embed or ephemeral reply to the channel.
- **Conditional tips are the caller's job**: include or omit a key inline (e.g. an OpenRouter-only
  item) instead of maintaining whole-paragraph tip strings per branch. Items that resolve to empty
  text are dropped, and the function returns `null` when nothing resolves, so the caller can skip
  attaching a tip button entirely.
- **The Official Support Server link is automatic**: `genai.tips.support_server` (exported as
  `SUPPORT_SERVER_TIP_KEY`) is appended as the last bullet of every rendered tip modal. Callers must
  not list it in `tipKeys` — it is filtered out if they do, so it can never be duplicated or
  reordered. It is appended *after* the empty check, so a tip modal with no caller-supplied items
  still returns `null` rather than degrading into a support-link-only embed.
- The button is disabled after `TIP_BUTTON_TIMEOUT_MS` (default 24 hours). The generic
  `textDisplayModal.ts` builder is also available to read-only legal and help surfaces.

### `utils/text`

- `localizer.ts`: locale auto-discovery + lookup
- `contextBuilder.ts`: public structured context routing and native orchestration
- `context/`: context-builder support modules for types, template/conditioning blocks, memories, RAG, and history/media helpers
- `contextTruncator.ts`: token-budget truncation strategy
- `processors/regexUtils.ts`: `escapeRegExp`
- `processors/mentionProcessor.ts`: mention resolution, template variables, emoji normalization
- `processors/llmOutputProcessor.ts`: LLM output cleaning, speaker-turn truncation
- `processors/chunkProcessor.ts`: message chunking, sentence splitting
- `processors/formatters.ts`: time formatting, text humanization, boolean display
- `processors/timeUtils.ts`: reminder time parsing, lateness calculation
- `emojiHelper.ts`, `emojiPenalty.ts`
- `timezoneHelper.ts`, `uncensor.ts`, `youTubeUrlCleaner.ts`

### `utils/cache`

- `tomoriStateCache.ts`
- `userCache.ts`
- `emojiStickerCache.ts`
- `channelLlmCache.ts`, `channelLlmCacheStore.ts`
- `channelWhitelistCache.ts`
- `shortTermMemoryCache.ts`
- `llmCache.ts`
- `openrouterCatalog.ts`: shared refresh machinery for the OpenRouter model catalogs
- `openrouterCapabilityCache.ts`, `openrouterEmbeddingModelCache.ts`, `openrouterImageModelCache.ts`, `openrouterVideoModelCache.ts`
- `geminiCapabilityCache.ts`
- `novelaiCapabilityCache.ts`
- `emergencyCacheClearer.ts`: critical-memory cleanup for recoverable caches
- lazy sync helpers (`emojiLazySync.ts`, `stickerLazySync.ts`)

### `utils/security`

- `secretsManager.ts`: `.env` vs AWS Secrets Manager load path
- `keyManager.ts`: encryption key version management
- `crypto.ts`: encryption/decryption helpers
- `keyRotation.ts`: rotation workflows
- `rateLimiter.ts`: upload quota cleanup scheduler
- `safeDownload.ts`: constrained external content download
- `remoteUrlSecurity.ts`: the single SSRF gate for user-supplied URLs (protocol/host policy, DNS resolution, blocklists)
- `userRemoteFetch.ts`: DNS-pinned fetch with per-hop redirect revalidation, built on `remoteUrlSecurity.ts`
- `cloudMetadata.ts`: always-on cloud instance-metadata / link-local denylist

### `utils/quota`

- `imageQuotaManager.ts`: per-user and server-wide image generation quotas
- `textQuotaManager.ts`: per-user and server-wide text trigger quotas
- `videoQuotaManager.ts`: per-user and server-wide video generation quotas

### `utils/provider`

- `providerFactory.ts`: provider auto-discovery and instance resolution

### `utils/mcp`

- `mcpManager.ts`: MCP lifecycle
- `mcpExecutor.ts`: MCP execution abstraction
- `mcpConfig.ts`: MCP config loading

Guild MCP URL validation lives in `utils/security/remoteUrlSecurity.ts`, which guards every user-supplied URL rather than MCP alone.

### `utils/bridges`

- `bridgeUserId.ts`: bridge ID and webhook username parsing utilities
- `matrix/`: Matrix appservice bridge runtime
- `matrix/events.ts`: appservice init and Matrix inbound event surface
- `matrix/stateSync.ts`: Matrix link cache, typing state, reminder mention surface
- `matrix/userMapping.ts`: Matrix display-name/ID maps and persona intent surface
- `matrix/rooms.ts`: Matrix room join/config/encryption helpers
- `matrix/index.ts`: public Matrix exports grouped from the responsibility modules

New code should use `utils/bridges` for generic bridge helpers and `utils/bridges/matrix` for Matrix runtime operations.

### `utils/image` and `utils/storage`

- `avatarHelper.ts`, `imageProcessor.ts`, `pngMetadata.ts`
- `avatarStorage.ts` for GCS or S3-compatible public avatar URL support
- `voiceSampleStorage.ts` for GCS or S3-compatible voice sample storage
- `charrefStorage.ts` for NovelAI character reference storage (S3-compatible in production, local filesystem in non-production)
- `S3_ENDPOINT` enables Cloudflare R2 or another S3-compatible endpoint; when set,
  storage clients use path-style requests while public URLs still come from the
  relevant `*_PUBLIC_BASE_URL` value.

### `utils/misc`

- `logger.ts`: structured logging facade
- `errorContextStore.ts`: ambient error identity (see below)
- `ioHelper.ts`: filesystem traversal helpers
- `healthTracker.ts`: runtime health signals used by `/health`

#### Ambient error context

`log.error()` and `log.warn()` accept an optional `ErrorContext`, but most call sites are far from
the code that knows which server or user they belong to. Threading that identity through every
signature is impractical, so `errorContextStore.ts` carries it out of band using an
`AsyncLocalStorage` scope.

The four entry points that begin a unit of work open a scope:

| Entry point | Opened in | `source` |
|---|---|---|
| Message chat turn | `events/messageCreate/tomoriChat.ts` | `chat` |
| Slash command | `events/interactionCreate/handleCommands.ts` | `command` |
| Scheduled reminder/task | `timers/reminderProcessor.ts` | `reminder` |
| Random trigger | `timers/randomTriggerProcessor.ts` | `random_trigger` |

Everything reached from inside a scope, at any await depth, logs with that identity attached. A
provider adapter deep in a stream needs no plumbing to produce an attributable error record.

- `runWithErrorContext(identity, fn)` opens a scope. Nested scopes inherit and override.
- `enrichErrorContext(patch)` upgrades the active scope once more IDs are known. Entry points seed
  Discord snowflakes; database row IDs are added after admission or user lookup resolves them.
- `resolveErrorContext(explicit)` is called by the logger. An explicit context wins per field, so a
  call site that names its own IDs stays authoritative.

Typed `ErrorContext` fields (`serverId`, `userId`, `personaId`) are database row IDs. Discord
snowflakes travel in `metadata` (`serverDiscId`, `userDiscId`, `channelDiscId`) alongside `source`
and `sourceDetail`, which identify the unit of work.

Timers and event handlers started *outside* a scope are unaffected, so background work that belongs
to no server stays unattributed rather than inheriting a stale identity.

## Usage Guidance

- Prefer these shared modules over duplicating logic in commands/events.
- For user-facing responses, always pair utility usage with localization via `localizer()`.
- For DB writes touching cached data, invalidate the affected caches in the same code path.
