---
title: "In-Memory Caching System"
---

This document reflects current cache layers in `src/utils/cache/` and related modules.

## Why Caching Matters Here

TomoriBot reads server config, user state, memories, and tool capability metadata on almost every interaction.
Caching reduces repeated DB/API calls and helps meet Discord interaction timing constraints.

## TTL Does Not Bound Memory

Every TTL in this document is **lazy**: the deadline is checked when an entry is read, a stale entry
is treated as a miss and refetched, and the entry itself stays in its `Map` until something
overwrites or explicitly invalidates it. No cache in `src/utils/cache/` runs a periodic sweeper.

The practical consequence, confirmed in production: a cache's reported `size` only ever grows.
`channelWhitelistCache` was observed holding 1772 entries under a 5-minute TTL, because a key written
once and never read again is never revisited.

Two implementations of the same lazy pattern exist, so a search for one will miss the other:

| Pattern | Examples |
|---|---|
| `expiresAt` timestamp compared on read | `channelWhitelistCache`, `channelLlmCacheStore`, `personalSpotlightCache` |
| `cachedAt` plus a duration constant | `userCache.ts:33,55`, `tomoriStateCache.ts:23,105` |

So **tightening a TTL reduces staleness, not memory.** It shortens how long a value is served before
a refetch, and it adds database reads, but it frees nothing. Bounding memory requires a different
mechanism, and the codebase offers three:

1. **A size cap with eviction on insert.** See `personalSpotlightCache.evictForInsert()`, which drops
   expired entries first and then oldest-inserted.
2. **A gate that prevents the entry from being created at all.** Preferred when the answer is
   uniform across a coarser key. See the personal spotlight gate below.
3. **The emergency clearer**, which is reactive rather than continuous. See
   [Emergency Memory Cleanup](#emergency-memory-cleanup).

`clearExpiredEntries()` in `shortTermMemoryCache.ts` is the only expired-entry sweeper in the
codebase, and its single caller is `emergencyCacheClearer.ts`. It is not a background task.

## Discord.js Caches Dominate Process Memory

Application caches are small next to the discord.js client caches. A production snapshot across ~516
guilds recorded roughly 90,900 discord.js entries (members ~31,800, users ~27,100, presences ~12,100,
channels ~11,200, emojis ~6,500) against roughly 6,500 entries across every cache in this document.
`cacheMetricsLogger` reports both under `discord_*` and per-cache names.

### Where the measurements go

`cacheMetricsLogger` writes each snapshot to two sinks, because they fail at different times:

| Sink | Written by | Survives |
|---|---|---|
| Structured log line | `log.metric("cache_sizes", ...)` | container recreate, host reboot, and the bot stalling, since it lands in a host file |
| `metric_samples` row | `metricSampleRepository.recordSample()` | whatever the database survives; it is the copy Grafana can graph |

The same interval emits a second row under `metric_name = 'host_memory'`, sampling the host's `procfs`
and `sysfs` counters rather than this process's. It deliberately has no `log.metric()` twin:
`tomoribot-oom-observer` already writes those counters to disk every 15 s, so a 5-minute copy would
duplicate a finer record while adding to that file's growth. The database row is the part that did
not exist, since removing the monitoring agent left host memory with no queryable series.

The database insert is fire-and-forget and never rejects: a telemetry sample must not be able to
break the interval that produces it. It is deliberately **not** retried, because for a 5-minute
sample a retry adds load to a connection pool at exactly the moment the pool is already failing.

Retention rides the same write path, pruning at most once per `METRIC_SAMPLE_PRUNE_INTERVAL_MS` and
deleting rows older than `METRIC_SAMPLE_RETENTION_DAYS`. It is not a scheduled job: production runs
with schema management disabled, which skips all pg_cron setup, and pg_cron is not installed on the
server, so a scheduled job would never run and nothing would report that the table was growing.

Investigate `sweepers` in `src/init/discord.ts` before tuning anything here. Configured sweepers:

| Cache | Policy |
|---|---|
| `messages` | Hourly, 30-minute lifetime |
| `guildMembers` | Hourly; excludes the client's own member and anyone in a voice channel |
| `users` | Hourly, bots only |

Two exclusions in the `guildMembers` filter are load-bearing. discord.js resolves permissions through
the client's own `GuildMember`, and the voice paths read members synchronously with no fetch
fallback. Member eviction is otherwise safe because every `MESSAGE_CREATE` carries a `member` field,
so anyone actively chatting is re-cached within minutes and only idle members stay evicted.

Widening the `users` sweeper is deliberately conservative: `historyFormatter.resolveMentions` runs
inside a `String.replace()` callback, so it cannot await a fetch, and `client.users.cache` is its last
fallback before rendering `@UnknownUser`. Sweeping a `User` still referenced by a cached
`GuildMember` also frees nothing, because the object stays reachable.

## Active Cache Layers

### 1) Tomori state cache (`tomoriStateCache.ts`)

- Key: `serverDiscId`
- Stores all personas for a server + main persona shortcut
- Default TTL: `TOMORI_STATE_CACHE_TTL_MINUTES` (default 10)
- Main APIs:
  - `getCachedAllPersonas(serverDiscId)`
  - `getCachedMainPersona(serverDiscId)`
  - `invalidateTomoriStateCache(serverDiscId)`
- Note: `getCachedTomoriState` is kept as a compatibility wrapper.

### 2) User cache (`userCache.ts`)

- Key: `userDiscId`
- Stores user row, privacy level, and per-server blacklist sub-cache
- Default TTL: `USER_CACHE_TTL_MINUTES` (default 30)
- APIs:
  - `getCachedUserRow`, `getCachedPrivacyLevel`, `getCachedBlacklistStatus`
  - `invalidateUserCache`, `invalidateUserBlacklistCache`

### 3) Emoji/sticker cache (`emojiStickerCache.ts`)

- Key: internal `server_id`
- Stores expression rows loaded from DB after lazy sync checks
- Default TTL: `EMOJI_STICKER_CACHE_TTL_MINUTES` (default 10)
- API: `loadEmojiStickerCache`, `invalidateEmojiStickerCache`

### 4) Channel whitelist cache (`channelWhitelistCache.ts`)

- Key: `serverDiscId:channelDiscId:parentChannelDiscId:roleSignature`
- Stores whitelist decision (channel + role), persona-channel restriction metadata, and optional channel cooldown overrides
- For thread triggers, the parent channel ID is part of the cache key so parent-whitelist inheritance does not collide with non-thread checks
- Default TTL: `CHANNEL_WHITELIST_CACHE_TTL_MINUTES` (default 5)
- API: `getCachedWhitelistStatus`, `invalidateWhitelistCache`

### 5) Short-term memory cache (`shortTermMemoryCache.ts`)

- Keys:
  - user-scoped: `shortterm:user:{userId}:{channelId}` (persona-scoped variant includes `:{personaId}`)
  - server-shared: `shortterm:server:{serverId}:{channelId}` (persona-scoped variant includes `:{personaId}`)
- Stores per-channel conversation snippets and optional summaries
- Guild behavior: the latest STM for a persona in a channel is shared across that server's other channels; user-scoped STM is retained for cross-server opt-in behavior
- When the triggering user message explicitly asks Tomori to remember something for future use, STM tool nudges are suppressed for that turn so long-term memory tools take priority; raw short-term conversation capture still continues after the reply
- TTL env vars:
  - `SHORT_TERM_MEMORY_TTL_HOURS`
  - `SHORT_TERM_MEMORY_SUMMARY_TTL_HOURS`
- Code fallback defaults are 12h/24h; deployers commonly override in `.env`.
- APIs:
  - `storeShortTermMemory`, `getShortTermMemoryForUserChannel`, `getShortTermMemoryForServerChannel`
  - `getShortTermMemoriesForUser`, `getShortTermMemoriesForServer`
  - `updateShortTermMemorySummary`
  - `clearShortTermMemoryForUser`, `clearShortTermMemoryForChannel`, `clearShortTermMemoryForServerChannel`
- Operational note:
  - `/server stm manage` lists the current server's active server-shared STM entries across personas.
  - Unchecking an entry clears only that server-scoped STM entry; user-scoped cross-server STM entries are left intact.

### 6) LLM model cache (`llmCache.ts`)

- Key: `llm_id`
- Warmed at startup from `llms` table
- No runtime TTL/invalidation
- APIs: `initializeLLMCache`, `getCachedLLM`, `getCachedLLMsByProvider`, `getCachedDefaultLLM`

### 7) OpenRouter model catalogs (`openrouterCatalog.ts` and friends)

OpenRouter publishes one catalog per modality, and a model appears only in the catalogs that
serve it. Embedding models are absent from `/api/v1/models` entirely, and image generation has
a much larger catalog than the handful of chat models that can emit images, so each capability
must be validated against its own endpoint:

| Capability | Endpoint | Module |
|---|---|---|
| Text | `/api/v1/models` | `openrouterCapabilityCache.ts` |
| Embedding | `/api/v1/embeddings/models` | `openrouterEmbeddingModelCache.ts` |
| Image | `/api/v1/images/models` | `openrouterImageModelCache.ts` |
| Video | `/api/v1/videos/models` | `openrouterVideoModelCache.ts` |

All four share the refresh machinery in `openrouterCatalog.ts`:

- Key: model codename, normalized to lowercase on both write and lookup
- Warmed at startup, then refreshed on a cache miss and on a TTL
- A refresh builds a replacement map and swaps it only on success, so a failed refresh leaves
  the previous catalog serving rather than emptying it
- Concurrent refreshes are collapsed into one request, and attempts are rate-limited by
  `OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS` (default 60s) so an unrecognized codename cannot
  amplify into a fetch per lookup
- Interactive model registration passes `{ fresh: true }` to `getOrFetch`, which refreshes
  before the lookup and ignores that rate limit. A codename someone types by hand is usually
  one OpenRouter published minutes ago, and the rate is bounded by submitted registrations
  rather than by chat turns
- `OPENROUTER_CATALOG_TTL_MS` (default 6h) drives the background refresher in
  `timers/openrouterCatalogRefresher.ts`, which exists for the synchronous readers: pricing,
  context limits, tokenizer, and `supported_parameters` are consulted per turn and never
  refresh on their own

The text catalog additionally stores tools/vision/structured-output capability, token limits,
tokenizer, and pricing:

- Tool capability is derived primarily from the reported `tools` parameter, with a fallback for models whose OpenRouter description explicitly advertises native function/tool calling even when the metadata is incomplete.
- `tool_choice` is tracked separately through cached `supported_parameters` and only sent when supported.

Because a miss reaches the network, a startup fetch that fails is recoverable without a
restart. `isOpenRouterCapabilityCacheReady()` reports whether a usable snapshot exists at all;
it says nothing about any individual model, so a lookup can still miss on a ready catalog.

The catalogs are deliberately excluded from `emergencyCacheClearer.ts`: they are provider
metadata rather than per-guild growth, and dropping one would gate chat on database flags until
the next refresh window to reclaim a few hundred KB.

### 8) Gemini token-limit map (`geminiCapabilityCache.ts`)

- Static in-memory lookup map for known Gemini model token limits

### 9) NovelAI token-limit map (`novelaiCapabilityCache.ts`)

- Static in-memory lookup map for known NovelAI model token limits

### 10) Webhook cache (`utils/discord/webhook/cache.ts`)

- Keys:
  - channel webhook cache (`channelId`)
  - persona webhook cache (`channelId:personaId`)
- No TTL; invalidated on delete/change conditions
- Shared channel webhook tokens are also persisted encrypted in Postgres so restart recovery can rehydrate the cache without recreating the webhook

### 11) Preset avatar cache (`utils/image/avatarHelper.ts`)

- Warmed at startup from preset rows
- No TTL; refresh via restart/re-init

### 12) Voice transcript cache (`utils/audio/voiceTranscriptCache.ts`)

- Key: Discord message ID
- Stores STT/TTS transcript text for older audio messages in history
- Default TTL: `VOICE_TRANSCRIPT_CACHE_TTL_MINUTES` (default 120)

### 13) Markdown table render cache (`utils/text/markdownTableCache.ts`)

- Key: Discord message ID
- Stores original markdown behind rendered table images
- Default TTL: `MARKDOWN_TABLE_CACHE_TTL_MINUTES` (default 120)
- Read by history/context builders so Tomori sees the table's text rather than an opaque image,
  and by the message's "Show Markdown" button to serve the source ephemerally. Keep
  `MARKDOWN_TABLE_BUTTON_TIMEOUT_MS` at or below this TTL, or the button will outlive its entry
  and reply with the expired notice.

### 14b) Channel system prompt cache (`channelPromptCache.ts`)

- **Scope:** per `(server_id, channel_disc_id)`: one entry per channel that may carry an override
- **Value:** `{ prompt, mode }` (`append`/`replace`) for the per-channel system prompt, or `null`
- **Negative caching:** channels with no override cache `null` so DM channels and unconfigured channels cost a single cheap lookup
- Default TTL: `TOMORI_STATE_CACHE_TTL_MINUTES` (default 10)
- Backed by the standalone `channel_prompt_overrides` table; `ChannelPromptRepository` invalidates the entry after each successful write/delete (`invalidateChannelPromptCache`). Mirrors the per-channel LLM override cache (`channelLlmCache.ts`).

### 15) Persona sprite cache (`personaSpriteCache.ts`)

- **Scope:** per `persona_id`
- **Value:** ordered `persona_sprites` rows used by prompt context and render-modifier resolution
- Default TTL: `PERSONA_SPRITE_CACHE_TTL_MINUTES` (falls back to `TOMORI_STATE_CACHE_TTL_MINUTES`, default 10)
- Backed by `persona_sprites`; `PersonaSpriteRepository` invalidates after successful add/replace/delete.
- Related operational limits:
  - `PERSONA_SPRITE_MAX_PER_PERSONA` (default 50)
  - `PERSONA_SPRITE_MAX_INSTRUCTIONS_LENGTH` (default 300, DB maximum 1000)
  - `PERSONA_SPRITE_PROMPT_MAX_COUNT` (default 20)

### 15b) Persona sprite message cache (`personaSpriteMessageCache.ts`)

- **Scope:** per Discord `message_disc_id`
- **Value:** the `persona_sprite_messages` mapping row, or `null` (negative entry) when the
  message has no sprite mapping. Most persona webhook messages are plain sends, so caching
  the miss avoids re-querying them every turn
- Entries are **immutable** (a sent message's sprite never changes), so the cache needs no
  invalidation; the TTL only bounds memory (`PERSONA_SPRITE_MESSAGE_CACHE_TTL_MINUTES`, default 120)
- Context builds prime it with one batched query (`primePersonaSpriteMessageRecords`) over the
  fetched history window's webhook message IDs; sends seed it directly (`recordPersonaSpriteMessage`)
- On transient DB errors the prime/lookup skips seeding instead of negative-caching, so real
  sprite messages are not masked for the TTL duration
- DB retention pruning (`PERSONA_SPRITE_MESSAGE_RETENTION_DAYS`, default 30) piggybacks on the
  write path, gated to run at most once per few hours

### 16) Persona workflow avatar session cache (transient, in `utils/discord/ui/personaWorkflow.ts`)

Unlike the caches above, this one is **not** stored in `src/utils/cache/`. It is an
ephemeral `Map<number, AvatarCacheEntry>` owned by one
`runPersonaPickerWorkflow(...)` invocation and discarded when that workflow returns.

- **Scope:** the complete persona workflow started by one slash command, including picker
  navigation and every explicit retry directive
- **Key:** absolute persona index within the workflow's current `personas` array
- **Value:** `{ type: "url"; url: string }` for public/fallback URLs, or
  `{ type: "buffer"; buffer: Buffer }` for local-disk avatars attached to Discord
- **Purpose:** resolve each avatar once and reuse it across page navigation, modal
  cancel/timeout recovery, validation retries, and transaction-loop re-entry
- **Owner:** the workflow runner creates the cache before its internal retry loop and passes
  the same instance to the low-level renderer on every iteration
- **Lifetime:** when the runner returns `selected`, `cancelled`, `timeout`, `error`, or
  `fatal`, it releases the cache; an internal `retryPersonaWorkflow()` directive retains it

Command code must not import `AvatarSessionCache`, construct the map, or pass
`avatarSessionCache` manually. It declares retry intent and lets the runner preserve the
cache:

```ts
await runPersonaPickerWorkflow(interaction, locale, {
  personas,
  onSelected: async (selection) => {
    const modal = await selection.openModal(modalOptions);
    if (modal.outcome === "fatal") throw modal.error;
    if (modal.outcome !== "submitted") return retryPersonaWorkflow();

    // Process the modal and optionally reopen the picker with the same cache.
    return retryPersonaWorkflow();
  },
});
```

When `retryPersonaWorkflow(updatedPersonas)` supplies a refreshed array, the runner compares
persona IDs by absolute index. It retains the avatar cache only when that identity ordering is
unchanged; a removal, addition, or reorder clears the map before the next picker render.

### 17) Personal spotlight cache (`personalSpotlightCache.ts`)

Two maps, deliberately keyed at different granularities.

- **Gate:** `serverId -> { hasAny, expiresAt }`, bounded by guild count
- **Result:** `serverId:userId:channelDiscId -> { result, expiresAt }`, the highest-cardinality key
  in the cache layer
- Default TTL: `PERSONAL_SPOTLIGHT_CACHE_TTL_MINUTES` (default 5), applied to both maps
- Hard cap: `PERSONAL_SPOTLIGHT_CACHE_MAX_ENTRIES` (default 2000) on the result map
- API: `getCachedPersonalSpotlightStatus`, `invalidatePersonalSpotlightCache`

A read consults the gate before the triple. When a server has no spotlight rows, the gate answers
`null` and **no triple entry is created**, so a server that never uses the feature contributes one
entry instead of one per user per channel. Misses are cached as `null` (an unconfigured spotlight
must not hit the database on every message), which is what made the unbounded triple key expensive
before the gate existed.

The gate also avoids real database work, not just a `Map` write:
`UserRepository.getPersonalSpotlightStatus` issues a `DELETE` for expired rows before its aggregate
`SELECT`, so every miss was costing a write plus a `LEFT JOIN`.

`invalidatePersonalSpotlightCache` drops the gate alongside matching triple keys. The spotlight
write routes in `utils/discord/interactions/personalConfigRoutes.ts` already call it, so a server's
first spotlight takes effect immediately rather than after the TTL. **Any new write path must call
it too**, or the gate will keep answering "none" for up to the TTL.

## Cache Invalidation Rules (Critical)

Invalidate after successful DB writes that affect cached reads.

Repository methods are the preferred owner for DB-write invalidation. During the Phase 2 repository migration, caller-side invalidation should only be removed after the corresponding repository method performs the same invalidation after a successful write. The migration audit lives at [`../refactor/phase4-cache-audit.md`](../refactor/phase4-cache-audit).

Common examples:

- server/persona/config changes -> `invalidateTomoriStateCache(serverDiscId)`
- user preference/memory changes -> `invalidateUserCache(userDiscId)`
- blacklist toggles -> `invalidateUserBlacklistCache(serverDiscId, userDiscId)`
- whitelist/inherited cooldown override changes -> `invalidateWhitelistCache(serverDiscId, channelDiscId?)`
- emoji/sticker update events -> `invalidateEmojiStickerCache(serverId)`
- persona webhook/avatar changes -> webhook invalidation helpers
- channel system prompt changes -> `invalidateChannelPromptCache(serverId, channelDiscId)` (handled inside `ChannelPromptRepository`)
- persona sprite changes -> `invalidatePersonaSpriteCache(personaId)` (handled inside `PersonaSpriteRepository`)
- personal spotlight create/remove -> `invalidatePersonalSpotlightCache(serverId, userId?, channelDiscId?)` (also drops the per-server gate)
- successful MCP tool-name snapshot changes -> `invalidateGuildMcpConfigCache(serverId)` only; unchanged or failed metadata writes do not invalidate it, and display metadata does not invalidate Tomori state

## Emergency Memory Cleanup

When `memoryGuard` enters critical emergency mode, the memory monitor runs
`clearEmergencyCaches()` before forced GC. This clears recoverable DB/API-backed
caches plus volatile Discord.js message/user/presence/voice-state caches. Short-term
memory is preserved by default; only expired STM entries are swept.

Default emergency behavior:

- Clears: Tomori state, user, whitelist, channel LLM, emoji/sticker, guild MCP,
  personal spotlight, ST preset, webhook, webhook identity, NovelAI subscription,
  OpenRouter on-demand capability, preset avatar, voice transcript, markdown table,
  and volatile Discord.js message/bot-user/presence/voice-state caches.
- Preserves: non-expired short-term memory, static LLM model cache, static provider
  capability maps, command registries, MCP connections, active channel locks, and
  other runtime coordination state.
- Emits `log.metric("emergency_cache_clear", ...)` with total and per-cache
  cleared counts plus pre/post process memory (`rss`, `heapUsed`, `external`,
  `arrayBuffers`), and `log.metric("memory_emergency_entered", ...)` so
  CloudWatch/Grafana can correlate cache eviction with RSS pressure.

`clearEmergencyCaches()` runs a forced collection between dropping the cache references
and taking its post-clear snapshot. Without it the `*_delta_clear` fields are structurally
always zero, because dropping a reference frees nothing measurable until the collector runs
and the guard's own forced GC happens after the clear returns. Production samples taken
before this was fixed show exactly that signature: `heap_used_mb_delta_clear` of `0` across
every event despite 5,000-15,000 entries cleared. Pass `collectBeforeMeasuring: false` only
in tests that assert on entry counts rather than on memory.

Operational knobs:

```dotenv
EMERGENCY_CACHE_CLEAR_ENABLED=true
EMERGENCY_CACHE_CLEAR_INCLUDE_STM=false
EMERGENCY_CACHE_CLEAR_DISCORD_VOLATILE=true
EMERGENCY_COOLDOWN_MS=60000
```

`EMERGENCY_CACHE_CLEAR_INCLUDE_STM=true` should be treated as a last-resort setting
because STM is conversational state, not merely a database read-through cache.

## Native Image Memory

libvips (via `sharp`) allocates decoded bitmaps and its operation cache outside the JS heap,
where they land in `process.memoryUsage().external` and `arrayBuffers`. No entry in any cache
above accounts for that memory and no sweep or emergency clear can reclaim it, so a burst of
image work can push a container toward its limit while every cache count looks healthy.

`src/init/media.ts` applies process-global limits at startup, before any module performs image
work, because `sharp.concurrency()` and `sharp.cache()` configure one shared libvips instance.
Concurrency is the dominant term: each in-flight pipeline holds its own fully decoded bitmaps.

```dotenv
SHARP_CONCURRENCY=1
SHARP_CACHE_MEMORY_MB=16
SHARP_CACHE_ITEMS=50
SHARP_CACHE_FILES=0
```

Defaults target a 512MB, 2-vCPU container. libvips on its own defaults would use a 50MB
operation cache and one worker thread per CPU. Raise these only with headroom above
`CONTAINER_MEMORY_LIMIT_MB`; `SHARP_CONCURRENCY` above 1 trades peak memory for image latency.

## Anti-Patterns to Avoid

- Invalidating before write success
- Forgetting invalidation on alternate code paths
- Manually mutating cached objects instead of invalidating
- Clearing whole caches when only one key changed
- Shortening a TTL to reduce memory. TTLs here are lazy, so this adds database reads and frees
  nothing. Add a size cap or a coarser-keyed gate instead.
- Reading a cache `size` metric as a population count. It reports entries currently resident, which
  for a lazily-expiring cache means "keys touched since the last restart or invalidation". For
  example `tomoriState` size is not the number of configured servers; that is
  `SELECT count(*) FROM server_model_configs WHERE api_key IS NOT NULL`.
- Adding a cache keyed on a product of identifiers (server x user x channel) without either a size
  cap or a gate on a coarser key

## Recommended Env Knobs

```dotenv
TOMORI_STATE_CACHE_TTL_MINUTES=10
USER_CACHE_TTL_MINUTES=30
EMOJI_STICKER_CACHE_TTL_MINUTES=10
CHANNEL_WHITELIST_CACHE_TTL_MINUTES=5
PERSONAL_SPOTLIGHT_CACHE_TTL_MINUTES=5
PERSONAL_SPOTLIGHT_CACHE_MAX_ENTRIES=2000
PERSONA_SPRITE_CACHE_TTL_MINUTES=10
PERSONA_SPRITE_MAX_PER_PERSONA=50
PERSONA_SPRITE_MAX_INSTRUCTIONS_LENGTH=300
PERSONA_SPRITE_PROMPT_MAX_COUNT=20
PERSONA_SPRITE_MESSAGE_CACHE_TTL_MINUTES=120
PERSONA_SPRITE_MESSAGE_RETENTION_DAYS=30
EMERGENCY_CACHE_CLEAR_ENABLED=true
EMERGENCY_CACHE_CLEAR_INCLUDE_STM=false
EMERGENCY_CACHE_CLEAR_DISCORD_VOLATILE=true
SHORT_TERM_MEMORY_TTL_HOURS=2
SHORT_TERM_MEMORY_SUMMARY_TTL_HOURS=4
SHORT_TERM_MEMORY_MAX_SUMMARY_LENGTH=500
SHORT_TERM_MEMORY_DEFAULT_CRUDE_MESSAGE_COUNT=6
SHORT_TERM_MEMORY_MAX_MESSAGES_PER_CHANNEL=10
SHORT_TERM_MEMORY_MAX_OTHER_CHANNELS=3
```

## Practical Rule

If a code path writes DB state that a cache reads, keep the invalidation call in the same function directly after the write.
