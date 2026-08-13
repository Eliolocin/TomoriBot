---
title: "Entry Point and Initialization Flow"
sidebar:
  order: 4
---

`src/index.ts` is a thin orchestrator. All initialization logic lives in `src/init/` modules.

## Files

- `src/index.ts` — orchestrator (calls init modules in order)
- `src/init/backup.ts` — non-production automatic data backup gate
- `src/init/healthServer.ts` — health HTTP server
- `src/init/secrets.ts` — secrets loading + key manager init
- `src/init/discord.ts` — Discord client construction + error handlers
- `src/init/database.ts` — DB init, cooldown cleanup, pg_cron setup
- `src/init/loaders.ts` — tool registry, localizer, caches, event handler
- `src/init/bridges.ts` — Matrix bridge (optional)
- `src/init/timers.ts` — health tracker, scheduled work, memory monitor, cache metrics, quota cleanup
- `src/types/config.ts` — `AppConfig` interface + `resolveEnvironment()`

## Startup Sequence

1. Load `.env` (`dotenv`); resolve `AppEnvironment`.
2. In non-production: run the automatic data backup gate before secrets, Discord, or database initialization. It creates a full `backupData.ts`-compatible bundle when the latest data backup was made by another bot version or is older than `TOMORI_AUTO_BACKUP_INTERVAL_HOURS` (default 24). Only automatic bundles count toward `TOMORI_AUTO_BACKUP_MAX` retention (default 5); manual `bun run backup` bundles are never pruned by this gate.
3. In production: bind health HTTP server on `$PORT` (default 8080) — returns 503 until Discord ready.
4. Load secrets via `getAppSecrets()`; populate `process.env` for downstream consumers; initialize `keyManager`.
5. Construct Discord client with intents + sweepers; register process/client error handlers.
6. Initialize database:
   - run narrow pre-schema legacy rename bridges for known table renames that would otherwise conflict with fresh `schema.sql`
     - The persona rename bridge (`runPreSchemaPersonaRenameBridge`) also self-heals **rollback artifacts**: running pre-rename code against an already-migrated database re-materializes legacy tables (`tomoris`, `tomori_presets`, `tomori_configs`) as empty shells via their old `CREATE TABLE IF NOT EXISTS` schema. When an empty legacy table coexists with its populated renamed counterpart, the bridge drops the empty shell (logged via `log.warn`) and continues. A **non-empty** legacy table coexisting with the renamed table is treated as an ambiguous data fork and still throws, requiring human inspection before boot. This runs on every startup (unlike run-once migrations), so the fix survives repeated rollback/merge cycles.
   - run `src/db/schema.sql`
   - run `src/db/schema_rag.sql` only when pgvector is detected
     - Detection (`detectRagAvailability`) is probed once per initialization attempt rather than once above the retry loop, and only a probe that completed is cached. A probe that could not reach the server proves nothing about pgvector, so caching that as "absent" would gate every RAG command until the next restart: `isRagAvailable()` reads a process-lifetime flag with no invalidation path. Production hit exactly that, answering `/teach document` with "Document RAG Disabled" against a database carrying pgvector 0.8.2.
     - While no probe has completed, `isRagAvailable()` returns `false`, which is the honest answer for an unknown state. `isRagAvailable()` stays synchronous and side-effect free because the context builder consults it on every chat turn; recovery is owned by `ragAvailabilityMonitor` (registered in `src/init/timers.ts`), which re-probes every `RAG_AVAILABILITY_REPROBE_INTERVAL_MS` (default 5 minutes) and stops on the first success. A startup probe that *completed* starts no timer, so a database genuinely without pgvector is never polled.
     - The monitor's re-probe additionally requires `document_chunks` to exist, because the same failure that skipped detection also skipped `schema_rag.sql`, and flipping the flag on the extension alone would expose commands to missing tables. `getRagAvailabilityState()` exposes the `null` (undetermined) vs `false` (probed, absent) distinction that `isRagAvailable()` collapses.
   - run `src/db/schema_stpreset.sql`
   - run typed seed catalogs in order: models, personas, system prompts, NovelAI presets
   - run pending numbered migrations from `src/db/migrations/` (fresh databases instead record every historical migration as applied via `markAllMigrationsApplied`, because `schema.sql` already embodies the final shape)
     - Because `schema.sql` is applied *before* the migration runner, a legacy untracked production database (still carrying `tomori_configs`, never seen by the runner) reaches the historical "expand + backfill" migrations with the split tables already in their final post-migration shape. The data-mover backfills that copy out of the god table (`002`, `003`, `004`, `007`) therefore detect whether the destination still has the pre-`021` image-tag columns (`nai_style_tags`/`nai_tags`/`nai_char_tags`) or the post-`021` ones (`image_default_positive_tags`/`physical_appearance_tags`) and write the matching column set. Without this guard the backfill fails with `column "nai_style_tags" of relation "server_novelai_imagegen_configs" does not exist` (42703). Migration `021` reconciles the rename afterwards, so no tag data is lost.
7. Cleanup expired cooldown rows at startup (`cleanupExpiredCooldowns`).
8. Attempt optional `pg_cron` registration for hourly cooldown cleanup job.
9. Initialize tool registry (`initializeTools`).
10. Initialize localization (`initializeLocalizer`).
11. Initialize model caches:
    - LLM cache (`initializeLLMCache`)
    - OpenRouter text catalog (`initializeOpenRouterCapabilityCache`)
    - OpenRouter modality catalogs, in parallel (`initializeOpenRouterVideoModelCache`, `initializeOpenRouterImageModelCache`, `initializeOpenRouterEmbeddingModelCache`)
    - A failed catalog fetch here is non-fatal and non-permanent: lookups refresh on a miss and the background refresher retries on the TTL, so the bot recovers without a restart.
12. Preload preset avatar cache from DB presets.
13. Initialize Matrix bridge (optional; non-fatal on failure).
14. Attach all event listeners (`eventHandler(client)`).
15. Register post-ready startup hooks (deferred until `clientReady`):
    - health tracker init
    - scheduled work coordinator init (reminders + random triggers)
    - memory monitor init
    - cache metrics logger init
    - OpenRouter catalog refresher init
16. Initialize upload quota cleanup scheduler.
17. `await client.login(DISCORD_TOKEN)` inside a try/catch — a `DisallowedIntents` rejection (privileged intent requested without approval) is logged as an actionable misconfiguration and exits, rather than leaving the process alive but disconnected.

## Error Criticality

- Fatal (process exits):
  - due automatic startup backup failure in non-production
  - database init failure
  - tool registry init failure
  - Discord login failure (including `DisallowedIntents` for an unapproved privileged intent)
- Non-fatal (warn and continue):
  - cache warmup failures
  - pg_cron setup failures
  - matrix init failure
  - cooldown cleanup failure
  - scheduled work/memory monitor/quota cleanup init failures

## Discord Client Configuration Notes

- `GuildPresences` is a privileged intent resolved by `resolvePresenceIntentEnabled()` in `src/init/discord.ts`. Before the client is built, it probes `GET /applications/@me` and includes the intent only when Discord reports it as enabled (`ApplicationFlags.GatewayPresence` or `GatewayPresenceLimited`). This is self-resolving: the intent turns on automatically on the next restart once Discord approves it — no code or env change. If the probe fails (e.g. network error), it falls back to the legacy default: enabled outside production, disabled in production.
- Consumers detect the intent at runtime via `client.options.intents.has(GatewayIntentBits.GuildPresences)` (see the participants context builder) and omit presence/status lines when it is absent, so toggling it needs no other code changes.
- Sweeper configuration is enabled for message/user cache pressure control.

## clientReady Event Work

`eventHandler` executes all handlers in `src/events/clientReady/` (sorted), including:

- command registration
- MCP server registration
- command registry initialization
- status/presence setup

Additional `client.once("clientReady")` hooks in `index.ts` initialize health tracking, scheduled work, and memory monitoring.

## Production Health Endpoint

`GET /health` returns:

- `200` when healthy
- `503` when unhealthy

Health is computed from:

- Discord ready state
- websocket ping threshold
- recent Discord event activity
