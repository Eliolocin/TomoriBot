---
title: "Refactor Record"
sidebar:
  order: 99
---

Historical record of the plugin-architecture-prerequisite refactor (`refactor/plugin-architecture` branch, Phases 1–5.5e). Covers module restructuring decisions, behavioral verification results, DB layer reorganization, and cache invalidation ownership after the repository migration.

Snapshot date: 2026-05-28

---

## Dynamic Tool Schema Assembler

Added a focused assembler seam for backend-sensitive tool schemas. Built-in tools now pass through `src/tools/assembly.ts` after centralized availability filtering and before provider adapter serialization. Tools without `assembleForContext()` are returned unchanged; tools with dynamic backend constraints can return a narrowed per-turn `Tool` variant or `null`.

Initial adopters:

- `web_search` now advertises only categories supported by the active backend: SearXNG all categories, Brave base categories, DuckDuckGo/IAsk text-only, and no tool when no search backend is available.
- `generate_image` now prunes image-to-image, inpaint, and outpaint arguments unless the configured standard image backend supports them. Custom image endpoints declare image request support through `workflow_supports`; ComfyUI defaults to text-to-image, image-to-image, and negative prompts, while generic endpoints default to text-to-image only.
- `generate_voice_message` moved script-markup and VoiceDesign schema shaping out of `availability.ts` into the tool assembler hook.

Deferred candidates: video generation provider/model option tables, permission-sensitive Discord message/thread tools, sticker-name schema hints, and fetch-url backend details.

## NovelAI Image Tags Decoupling

Image tags moved out of `/novelai image-tags` into provider-neutral commands: `/config` > Persona > Appearance, `/personal config`, and the default tag fields on `/config` > Models > ImageGen Defaults. User and persona tags are rendered in context as public `Physical Appearance` lines. `generate_image` now receives default positive tag guidance, while default negative tags are consumed only by NovelAI or custom image endpoints with the `Negative Prompt` support checkbox enabled.

---

## Module Restructure

Records which refactor phases produced real responsibility-owned modules and which left thin facades over a new god file. The integrity check script `scripts/archived/checkRefactorIntegrity.ts` was used to detect facade-shaped barrels, active `*.legacy.ts` files, and oversized runtime/orchestrator files.

### Inventory

| Phase item | Current surface | Hidden or remaining implementation | Status | Owner / responsibility |
|---|---|---|---|---|
| #1 Fragment locales | `src/locales/en-US/` 36 files, 6,184 lines; `src/locales/ja/` 36 files, 6,195 lines | None identified | Real split | Locale categories |
| #2 Simplify `stringHelper.ts` | Deleted | Processor modules under `src/utils/text/processors/`; markdown-table helpers under `src/utils/text/markdownTable.ts` | Complete | Text processors |
| #3 Decouple `index.ts` | `src/index.ts`, 24 lines | `src/init/*` modules | Real split | Startup initialization |
| #4b Repository pattern | Repository classes under `src/utils/db/repositories/`; `repositoryReadSql.ts` 7-line barrel; `repositoryWriteSql.ts` 6-line barrel | Domain SQL lives in `src/utils/db/repositories/*Sql.ts`; large LLM/persona/server transaction modules tracked in the Intentional Large File table | Real domain split with tracked compatibility barrels | Repository-owned SQL by domain |
| #4b Import/Export split | `src/utils/db/repositories/ExportRepository.ts`, 671 lines; `src/utils/db/repositories/ImportRepository.ts`, 774 lines | Deleted `ImportExportRepository.ts`, `repositoryExportSql.ts`, `repositoryImportSql.ts`; no remaining sibling files | Complete | Export-direction SQL (ExportRepository); import-direction SQL + cache invalidation (ImportRepository) |
| #5 `/tool status` split | `src/commands/tool/status.ts`, 32 lines; `src/utils/metrics/status/command.ts`, 73 lines | Deleted `statusCommandMetrics.ts` and `status/commandImplementation.ts`; owned modules under `src/utils/metrics/status/` are all <600 lines | Complete | Status command coordination, page builders, and redaction-aware formatters |
| #5 `/compact` split | `src/commands/compact.ts`, 33 lines | `src/utils/compaction/compactOrchestrator.ts`, 1,102 lines | Facade-only split | Compaction workflow stages |
| #6 Base stream adapter | Provider adapters and `BaseStreamAdapter` | Provider-specific large files remain provider-owned | No facade finding | Provider stream adapters |
| #6.5 Provider registry | `src/utils/providerInfoRegistry.ts` and provider-local `providerInfo.ts` files | None identified | Real split | Provider metadata discovery |
| #7 Tool registry split | `src/tools/toolRegistry.ts`, 514 lines | `src/tools/availability.ts`, 387 lines | Real partial split | Tool registry vs. availability |
| #8 Discord UI helpers | `src/utils/discord/interactionHelper.ts`, 1 line; owned modules under `src/utils/discord/ui/` | `src/utils/discord/ui/interactionCore.ts` retains shared Discord UI internals after legacy-file deletion | Legacy file eliminated | Discord UI flows |
| #8 Webhook helpers | `src/utils/discord/webhookManager.ts`, 1 line; owned modules under `src/utils/discord/webhook/` | `src/utils/discord/webhook/webhookCore.ts` retains shared webhook internals after legacy-file deletion | Legacy file eliminated | Webhook lifecycle, identity, dispatch, fallback |
| #9 Matrix bridge | Responsibility modules under `src/utils/bridges/matrix/`; obsolete compatibility barrels deleted | Legacy `runtime.ts`, `matrixManager.ts`, and `appserviceImplementation.ts` removed | Complete | Matrix client, events, rooms, state sync, user mapping, media |
| #10 Context builder | `contextBuilder.ts`, 5 lines; owned modules under `src/utils/text/context/` are all <600 lines | Deleted `context/core/builderImplementation.ts` | Complete | Context assembly pipeline |
| #11 Stream orchestrator | `streamOrchestrator.ts`, 1 line; owned modules under `src/utils/discord/stream/` are all <600 lines | Deleted `stream/core/orchestratorImplementation.ts` | Complete | Stream state machine, stop registry, buffer flushing, segment processing, message delivery, UI updates, and thought logs |
| #12b / #12c / 5.5d Chat | `tomoriChat.ts`, ~145 lines; stage modules under `src/utils/chat/` | Deleted `turnRunner.ts`; chat implementation lives in `admission.ts`, `admissionQueue.ts`, `channelQueue.ts`, `turnPlanner.ts`, `contextPipeline.ts`, `contextAnnotations.ts`, `contextEmbeds.ts`, `contextMedia.ts`, `generationTurn.ts`, `toolLoop.ts`, `responseEmitter.ts`, `postTurnEffects.ts`, and small queue/identity helpers | Complete | Chat admission, queueing, turn planning, context, provider turn, tool loop, response, post-turn effects |
| #13 Event handler eager-load | Not completed | N/A | Out of scope | Event loading |
| Extra: Web-search unification (Phase 1) | Single `web_search(query, category)` BaseTool under `src/tools/webSearch/`; engine layer (`braveEngine.ts`, `duckduckgoEngine.ts`, `iaskEngine.ts`, `dispatcher.ts`) implementing `WebSearchEngine` chain | `InternalBraveWebSearchTool` / `InternalBraveImageSearchTool` / `InternalBraveVideoSearchTool` / `InternalBraveNewsSearchTool` under `src/tools/restAPIs/brave/internal/braveServiceClasses.ts` — no longer LLM-visible. DuckDuckGo/IAsk are accessed through `DuckDuckGoHandler`. | Complete (Phase 1) | Engine-chain dispatch for web search; replaces the previous 4-tool Brave surface and the per-adapter Brave-key dedup logic. Phase 2 adds a `SearxngEngine` to the chain. |
| Extra: URL-fetch unification and SSRF hardening | Single `fetch_url(url, max_length?, start_index?, raw?)` BaseTool under `src/tools/fetchUrl/`; the default engine is `safe_http` | The in-process fallback validates and DNS-pins every redirect hop and converts HTML to Markdown. The historical `mcp_fetch` config name aliases `safe_http`; raw bundled MCP fetch is hidden. Crawl4AI remains available only through an explicit trusted-development opt-in. Guild `url_fetcher` replacements suppress bundled `fetch_url` when present. | Complete | One LLM-visible URL-fetch surface with a fail-closed production network boundary. |

### Chat Coordinator Shape

The chat entry point exposes the named stage sequence:

```ts
const incoming = normalizeChatInvocation(...);
const admission = await evaluateChatAdmission(incoming);
if (admission.disposition !== "run") {
  await handleChatDisposition(admission);
  return;
}

await runWithChannelLock(admission, async (lockedTurn) => {
  const turnPlan = await planChatTurns(lockedTurn);

  for (const turn of turnPlan.turns) {
    const context = await buildChatTurnContext(turn);
    const responseSink = createChatResponseSink(context);
    const result = await runGenerationTurn(context, responseSink);

    await runPostTurnEffects(context, result);
  }
});
```

`turnRunner.ts` was deleted; response delivery is represented as a response sink used during generation because Discord streaming happens while the provider turn is running.

### Intentional Large Files

These files were retained above the 600-line heuristic because each owns one clear responsibility, has a narrow public surface named after that responsibility, and splitting would have introduced meaningless file fragmentation.

| Path | Lines | Responsibility | Rationale |
|---|---:|---|---|
| `src/utils/db/repositories/LlmModelRepository.ts` | ~600 | Global model catalog | `llms`, `embedding_models`, `image_diffusion_models`, `video_generation_models` reads are cohesive: all share provider normalization, deprecation filtering, and OpenRouter scope delegation. Split from `LlmRepository` + `llmReadSql.ts`. |
| `src/utils/db/repositories/LlmProviderRepository.ts` | 1,709 | Saved provider configs, custom endpoints, OpenRouter registrations | 7 tables share OpenRouter scope SQL helpers and cache-invalidation boundary. Exceeds the 1,000-line heuristic by 709 lines; no further split warranted before provider-table partitioning. |
| `src/utils/db/repositories/LlmOverrideRepository.ts` | 556 | Channel/persona override assignments and fallback refs | `channel_llm_overrides`, `persona_configs` (llm_id), and `tomori_configs` (fallback columns) writes share cache-invalidation semantics; bulk restore calls private SQL helpers to avoid per-override cache thrashing. |
| `src/utils/db/repositories/PresetRepository.ts` | 1,150 | TomoriBot preset export/import + SillyTavern preset CRUD + ST card conversion | `sillyTavernImport.ts` (545 lines) is pure text-processing tightly coupled to `convertSillyTavernJsonToPresetData` and the ST preset insertion workflow. Extracting it would add an import-dependency layer with no cohesion gain — callers always pair parsing with insertion. |
| `src/utils/db/repositories/PersonaRepository.ts` | 859 | Persona state loading + write | `loadTomoriState` and `loadAllPersonasForServer` stay together because both construct the same composite persona runtime state. Combined 859 lines after Stage C inline of `personaReadSql` + `personaWriteSql`. |
| `src/utils/db/repositories/ServerRepository.ts` | 941 | Server identity: setup, emojis/stickers, webhooks, blacklist | `sqlSetupServer` is one atomic transaction (~400 SQL lines) that creates server, persona, config, and initial emoji rows — splitting it would separate transactional setup context from its server repository owner. |
| `src/utils/db/repositories/ServerScheduleRepository.ts` | 850 | Reminder + random-trigger schedule domain | Reminders and random triggers share scheduled-work nudge behavior and form a cohesive scheduling domain split from server identity. |
| `src/utils/db/repositories/ExportRepository.ts` | 671 | All data export operations | Export methods are all read-only; `sanitizeForJson` + `sanitizeMemoryItems` helpers are tightly coupled to every export path. The large `exportServerData` method carries the full config COALESCE query (60+ fields). |
| `src/utils/db/repositories/ImportRepository.ts` | 774 | All data import operations + cache invalidation | `sqlImportServerConfig` carries the full `tomori_configs` UPDATE (60+ fields, repeated twice for server-id vs tomori-id fallback). Private SQL helpers (`ensureUserId`, `resolveServerId`, `resolveMainTomoriScope`) are shared across all import paths. |

### Intentional Barrels

Two public API boundary barrels were retained. Each marks a stable subsystem boundary where callers consume the capability as a single unit and the internal split is an implementation detail.

| Path | Lines | Rationale |
|---|---:|---|
| `src/utils/text/contextBuilder.ts` | 5 | Callers consume context building as one subsystem capability while mention normalization, preset routing, native assembly, memories, RAG, server assets, participants, and dialogue history live in responsibility-owned modules. 11 import sites. |
| `src/utils/discord/streamOrchestrator.ts` | 1 | Callers consume Discord streaming as one subsystem capability while stop requests, buffer flushing, segment processing, message delivery, UI updates, errors, text config, mention resolution, and thought logs live in responsibility-owned modules. 15 import sites. |

---

## Behavioral Verification (Phases 1–5)

For each function deleted during Phases 1–5: did its behavior survive somewhere — renamed, relocated, or inlined — or did it silently disappear?

A behavioral regression is narrowly defined: a function performed a real, observable behavior; the function was deleted; and no equivalent code (by name OR inlined body) exists in the current tree. Pure dead-code removal, rename-only moves, and intentional consolidations are not regressions.

### Method

For each phase commit:
1. `git diff <commit>^..<commit> --diff-filter=D --name-only` enumerated fully-deleted files.
2. `git diff <commit>^..<commit>` searched for `^-export `, `^-function `, `^-async function ` to find function definitions that vanished from surviving files.
3. Each candidate deletion was checked against current `src/` with Grep — first by function name (catches renames), then by 1–2 distinctive identifiers from the old body (catches inlining).
4. A finding is only a regression if BOTH the name AND the distinctive-body search come up empty.

Type-only deletions, deleted tests, and locale-file shuffles in Phase 1 were skipped.

### Results

| Phase | Commit | Title | Audit verdict |
|---|---|---|---|
| 1 | `d9d284bb` | Phase 1: Locales, String Helpers, Index Entry Point | Clean |
| 2.1 | `9836d968` | Phase 2: Data Access (1/2) | Clean |
| 2.2 | `b3a3bd5f` | Phase 2: Data Access (2/2) | Clean |
| 3.1 | `aff0b537` | Phase 3: Core Abstractions & Integrations (1/2) | Clean |
| 3.2 | `7a631afb` | Phase 3: Core Abstractions & Integrations (2/2) | Clean |
| 4 | `643aaef1` | Phase 4: Context & Output | Clean |
| 5 | `44c975e0` | Phase 5: Orchestrator | Clean (caveat below) |

**Phase 1** — `chunkMessage`, `cleanLLMOutput`, `replaceMentionHandles`, `normalizeCustomEmojisForLlm`, `findMarkdownCodeRanges`, `truncateBeforeGenericSpeakerLine`, `isGenericSpeakerStopLabel`, `escapeRegExp` → moved to `src/utils/text/processors/`. `index.ts` bootstrap split into `src/init/*` modules.

**Phase 2.1** — Pure adapter-layer insertion: queries previously called inline against `Bun.sql` were wrapped in `*Repository` classes with the same SQL bodies. Compile errors at every caller site forced exhaustive rewiring.

**Phase 2.2** — Status command internals → `src/utils/metrics/statusCommandMetrics.ts` and submodules. Compact command internals → `src/utils/compaction/compactOrchestrator.ts`. Channel LLM cache functions → `src/utils/cache/channelLlmCacheStore.ts`.

**Phase 3.1** — Stream adapter classes refactored to extend `BaseStreamAdapter`. Duplicated methods hoisted; provider-specific overrides remain in subclasses.

**Phase 3.2** — `interactionHelper.ts` exports split across `src/utils/discord/ui/{buttons,confirmation,embeds,errors,modals,pagination,statusComponents,interactionCore}.ts`. Matrix bridge moved from `src/utils/matrix/index.ts` to `src/utils/bridges/matrix/`.

**Phase 4** — Internal context-building functions extracted from `src/utils/text/contextBuilder.ts` into `src/utils/text/context/{history,memories,rag,templates,types}.ts`. Stream orchestration helpers split into `src/utils/discord/stream/` submodules.

**Phase 5 (caveat)** — Phase 5 moved `tomoriChat.ts` (~9,500 lines) into `src/utils/chat/turnRunner.ts` as a near-verbatim relocation. Function bodies survived intact at commit `44c975e0`. The behavioral regressions later catalogued in the Phase 5.5d appendix (`plans/archive/refactor/phases/phase-5.5d-chat-drain.md`) were introduced by Phase 5.5d's *drain* of `turnRunner.ts`, not by Phase 5's *move*.

### Why Phases 1–5 Were Low-Risk

Phases 1–5 were predominantly **relocation refactors**: files were deleted and recreated under new paths with the same function set. Import-site rewrites force compile errors at every caller, which surfaces missing functions immediately.

Phase 5.5d broke that pattern — it was a **reshape refactor** that dissolved `runChatTurn()` into named stages with different signatures and control flow. There was no 1:1 import rewrite to force errors; pieces of the old function body could be quietly dropped while the file still compiled. The Phase 5.5d appendix proposes a per-function before/after diff audit as the template for any future drain work.

---

## DB Layer Reorganization

Records the final shape of `src/utils/db/` after Phase 5.5e consolidation of the 26 orphan files at the `db/` root.

### Final Structure

```
src/utils/db/
├── client.ts                          # infrastructure
├── initializeDatabase.ts              # infrastructure
├── sqlSecurity.ts                     # infrastructure
├── sqlSplitter.ts                     # infrastructure
├── ragAvailability.ts                 # renamed from ragDetection.ts
└── repositories/
    ├── index.ts                       # ≤50 lines: instances + types only
    ├── IRepository.ts
    ├── ServerRepository.ts            # core: setup, emojis/stickers, webhooks, blacklist
    ├── ServerScheduleRepository.ts    # reminders + random triggers (split from ServerRepository)
    ├── UserRepository.ts              # + personalSpotlight (folded; 965 lines — under limit)
    ├── PersonaRepository.ts           # + persona-scoped memoryLimits checks
    ├── ConfigRepository.ts
    ├── LlmModelRepository.ts          # global model catalog (split from LlmRepository)
    ├── LlmProviderRepository.ts       # saved configs + OpenRouter registrations (split from LlmRepository)
    ├── LlmOverrideRepository.ts       # channel/persona override assignments (split from LlmRepository)
    ├── ToolRepository.ts              # + guildMcpDb
    ├── RagRepository.ts
    ├── ExportRepository.ts            # split from ImportExportRepository
    ├── ImportRepository.ts            # split from ImportExportRepository
    ├── PersonalMemoryRepository.ts    # + checkPersonalMemoryLimit
    ├── ServerMemoryRepository.ts      # + checkServerMemoryLimit
    ├── ConditioningMemoryRepository.ts # + conditioningDb
    ├── WhitelistRepository.ts         # also absorbed whitelist delegation from ServerRepository
    ├── PresetRepository.ts
    └── CooldownRepository.ts
```

Outside `src/utils/db/`:
```
src/utils/persona/personaAccess.ts     # moved from db/personaAccess.ts (pure functional, no DB access)
src/utils/misc/memoryLimits.ts         # env-loading half of db/memoryLimits.ts
src/utils/cache/shortTermMemoryCache.ts # short-term memory data access; obsolete repository wrapper removed
```

**SQL inlining:** All `*ReadSql.ts` / `*WriteSql.ts` siblings were dissolved into their repository as `private` methods and deleted. The public/private boundary is enforced by TypeScript's `private` keyword, not by folder convention.

### Repository Headroom (Post-5.5e)

Budget was ~1,000 lines per Repository file once SQL is inlined.

| Repository | Class LOC | SQL sibling LOC | Combined | Notes |
|---|---:|---:|---:|---|
| `RagRepository` | 137 | 0 | **137** | |
| `ToolRepository` | 156 | 23 | **179** | +~110 from guildMcpDb fold |
| `ConditioningMemoryRepository` | 119 | 0 | **119** | +~130 from conditioningDb fold |
| `ShortTermMemoryRepository` (retired) | 147 | 213 | **360** | Wrapper later removed; cache module owns this path directly |
| `PersonalMemoryRepository` | 175 | 0 | **175** | |
| `ServerMemoryRepository` | 138 | 0 | **138** | |
| `PersonaRepository` | 91 | 717 | **808** | |
| `UserRepository` | 490 | 407 | **897** | 965 post-personalSpotlight fold — under limit |
| `ImportExportRepository` | 223 | 1,507 | **1,730** | Over budget; PresetRepository split reduces; final split by direction into ExportRepository + ImportRepository |
| `ConfigRepository` | 600 | 532 | **1,132** | Marginally over; SQL inlined and re-measured — no split warranted |
| `ServerRepository` | 352 | 1,278 | **1,630** | Over budget; split into core + ServerScheduleRepository |
| `LlmRepository` | 706 | 3,007 | **3,713** | Severely over; 3-way split into LlmModelRepository + LlmProviderRepository + LlmOverrideRepository |

### File Disposition (26 Orphan Files)

**Group A — Infrastructure (stays at `db/` root)**

| File | LOC | Disposition |
|---|---:|---|
| `client.ts` | 208 | Unchanged |
| `initializeDatabase.ts` | 108 | Unchanged |
| `sqlSecurity.ts` | 116 | Unchanged |
| `sqlSplitter.ts` | 129 | Unchanged |

**Group B — SQL barrels (deleted)**

| File | LOC | Disposition |
|---|---:|---|
| `repositoryExportSql.ts` | 753 | SQL inlined as `private` methods into `ImportExportRepository`; file deleted |
| `repositoryImportSql.ts` | 754 | Same |
| `repositoryReadSql.ts` | 7 | Deleted (barrel into SQL siblings, which were themselves dissolved) |
| `repositoryWriteSql.ts` | 6 | Deleted (same reason) |

**Group C — Folded into existing repositories**

| File | LOC | Target Repository | Why |
|---|---:|---|---|
| `emojiStickerSync.ts` | 331 | `ServerRepository` | Server-scoped sync logic; SQL (~250 lines) inlined as private methods |
| `managedWebhookDb.ts` | 197 | `ServerRepository` | Single-table, server-scoped; encryption pattern matches `guildMcpDb` |
| `guildMcpDb.ts` | 237 | `ToolRepository` | MCP servers are tool sources |
| `conditioningDb.ts` | 358 | `ConditioningMemoryRepository` | Conditioning history is the natural extension of conditioning memory |
| `personalSpotlight.ts` | 361 | `UserRepository` | Post-fold `UserRepository` is 965 lines — under limit |

**Group D — New repositories**

| New Repository | Source files absorbed | Why a new repository |
|---|---|---|
| `WhitelistRepository` | `channelWhitelist.ts` (283), `personaWhitelist.ts` (122), `roleWhitelist.ts` (71) | Folding into `ServerRepository` would push it past budget; whitelists are a coherent standalone domain |
| `PresetRepository` | `presetExport.ts` (214), `presetImport.ts` (264), `stPresetDb.ts` (285), `sillyTavernImport.ts` (545) | 1,308 combined LOC; ST card ingestion is a distinct concern from TomoriBot export/import |
| `CooldownRepository` | `cooldownManager.ts` (365), `cooldownsCleanup.ts` (82), `messageCooldown.ts` (305) | Duplication between `cooldownManager` and `messageCooldown` (both had `isExemptFromCooldown` variants) collapsed into one canonical pair |

**Group E — Moved out of `db/`**

| File | LOC | Destination | Why |
|---|---:|---|---|
| `personaAccess.ts` | 22 | `src/utils/persona/personaAccess.ts` | Pure functional composition of `isPersonaAllowedByWhitelistStatus` + `isPersonaAllowedByPersonalSpotlight`; no DB access |
| `ragDetection.ts` | 45 | `src/utils/db/ragAvailability.ts` (renamed) | Startup-time infrastructure; `RagRepository` does CRUD on documents/chunks and should not depend on availability detection |

**Group F — Split between locations**

| File | LOC | Split |
|---|---:|---|
| `memoryLimits.ts` | 504 | `getMemoryLimits()` + env helpers + content validators → `src/utils/misc/memoryLimits.ts`; `checkPersonalMemoryLimit()` → `PersonalMemoryRepository`; `checkServerMemoryLimit()` → `ServerMemoryRepository`; `checkTriggerWordLimit()`, `checkSampleDialogueLimit()`, `checkAttributeLimit()` → `PersonaRepository` |

### Repository Split Decisions

**LlmRepository → 3-way split** (combined ~3,713 lines, severely over budget)

| New repository | Tables owned |
|---|---|
| `LlmModelRepository` | `llms`, `embedding_models`, `diffusion_models`, `video_generation_models` |
| `LlmProviderRepository` | `saved_provider_configs`, `user_saved_provider_configs`, `custom_endpoint_connections`, `custom_endpoints`, `openrouter_*_registrations` |
| `LlmOverrideRepository` | `channel_llm_overrides`, `persona_llm_overrides`, fallback refs |

`toExportShape()` / `fromExportShape()` moved to `LlmProviderRepository` (saved provider configs and OpenRouter registrations are the exportable state; model catalog is global seed data).

**ServerRepository → 2-way split** (combined ~1,630 lines, over budget)

| Repository | Tables owned |
|---|---|
| `ServerRepository` (core) | `servers`, `server_emojis`, `server_stickers`, `managed_webhooks` |
| `ServerScheduleRepository` | `reminders`, `random_triggers` |

`setupServer` is a single unavoidably large transaction (~400 SQL lines); the marginal overrun of the core file was accepted and documented inline.

**ConfigRepository** — combined ~1,132 lines. SQL inlined and re-measured; no further split warranted given the uniform config-read-write surface.

**ImportExportRepository** — after PresetRepository absorbed ~1,308 LOC, the remaining export/import SQL still exceeded the 1,000-line heuristic. Split by direction: `ExportRepository` (read-only export paths) and `ImportRepository` (import paths + cache invalidation).

---

## Cache Invalidation Ownership

Records where cache invalidation lives after the repository migration. All invalidations listed are co-located with the write they guard: they execute after a confirmed successful DB write, in the same code path.

### Repository-Owned

| Cache | Owning repository methods |
|---|---|
| User row/preferences | `UserRepository.register`, `setPrivacyLevel`, `setPrivacyOptOut`, `toggleCrossServerShmOptIn`, `update`, `fromExportShape`; personal-memory writes in `PersonalMemoryRepository` / `ImportRepository` |
| User blacklist | `UserRepository.removeBlacklistEntry` and equivalent blacklist-add methods |
| Tomori state: config/provider/model settings | `ConfigRepository.update*Config()` methods; LLM/provider-specific writes owned by `LlmModelRepository`, `LlmProviderRepository`, `LlmOverrideRepository` |
| Tomori state: persona/profile/settings | `PersonaRepository.update`; import/persona-creation/delete/default/swap flows |
| Tomori state: server memories/documents/history | `ServerMemoryRepository.add` and edit/remove variants |
| Guild MCP config | `ToolRepository.insertMcpServer`, `deleteMcpServer`, `updateMcpServerEnabled` |
| Channel LLM overrides | `LlmOverrideRepository.setChannelLlmOverride`, `deleteChannelLlmOverride`, `clearAllChannelLlmOverrides` |
| Whitelist decisions | `WhitelistRepository.upsertChannelWhitelist`, `removeChannelWhitelist`, `replacePersonaWhitelistChannels`, `removeChannelPersonaWhitelist`, `upsertRoleWhitelist`, `removeRoleWhitelist` |
| Full import/export | `ImportRepository.importPersonalSettings`, `importPersonalMemories`, `importServerConfig`, `importServerMemories`, `importPersonalData`, `importServerData` |

### Caller-Owned (Intentionally Outside Repositories)

| Cache | Call sites | Reason |
|---|---|---|
| Personal spotlight | `src/utils/discord/interactions/personalConfigSpotlightRoutes.ts` | Panel routes retain caller-owned writes and post-write invalidation unless they later move under a repository |
| ST preset cache | `src/utils/db/stPresetDb.ts` (now `PresetRepository`) | Write-after-success placement preserved during fold |
| Emoji/sticker cache | `src/events/guildEmojisUpdate/refreshEmojis.ts`, `guildStickersUpdate/refreshStickers.ts` | Event-driven cache; invalidation follows Discord events, not DB writes |
| Matrix link cache | `src/commands/matrix/link.ts`, `unlink.ts` | Matrix bridge module - not part of the repository layer |
| Webhook cache | `src/utils/discord/webhook/` internal helpers | Cache keys are Discord webhook lifecycle state, not repository reads |
