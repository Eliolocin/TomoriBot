---
title: "Security & Privacy"
---

This document describes TomoriBot's current (2026) security and privacy behavior based on the active codebase.

## Security Surface

TomoriBot's security model combines:
- Secret loading and environment isolation
- Encryption-at-rest for provider/API credentials
- Key versioning and rotation support
- Provider API key failover/round-robin controls
- SQL injection protections
- Runtime anti-abuse guards (cooldowns, quotas, memory/flood guards)
- User privacy controls (global levels + per-server blacklist)

## Secrets Management

Primary files:
- `src/utils/security/secretsManager.ts`
- `src/index.ts`

Behavior:
- Non-production (or `TEST_PRODUCTION=true`): secrets load from `.env`.
- Production (`RUN_ENV=production`): secrets load from `SECRET_FILE` when set, then
  `GCP_SECRET_FILE` for the legacy Cloud Run mount, then AWS Secrets Manager
  (`tomoribot/production`, region from `AWS_REGION`, default `us-east-1`).
- Required secrets are validated at startup:
  - `DISCORD_TOKEN`
  - `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
  - `CRYPTO_SECRET`
- After loading, secrets are mapped to `process.env` and `keyManager.initialize()` is called.
  This includes S3-compatible storage credentials such as `S3_ENDPOINT`,
  `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

Key takeaway: encryption key initialization happens only after secrets are loaded.

## API Key Encryption at Rest

Primary files:
- `src/utils/security/crypto.ts`
- `src/utils/security/keyManager.ts`
- `src/db/schema.sql`

Current implementation:
- API keys are encrypted/decrypted via PostgreSQL `pgcrypto` (`pgp_sym_encrypt` / `pgp_sym_decrypt`).
- Encrypted values are stored as `BYTEA`.
- Each encrypted row stores `key_version` to support multi-version decryption.

Main encrypted storage locations:
- `server_model_configs.api_key` + `server_model_configs.key_version` *(deprecated Phase 1.5 mirror; drop scheduled for step #14.5)*
- `opt_api_keys.api_key` + `opt_api_keys.key_version`
- `api_key_rotation.api_key` + `api_key_rotation.key_version` (except main-key pointer rows)
- `saved_provider_configs.api_key` and `user_saved_provider_configs.api_key`, each paired with `key_version`

## Key Versioning and Rotation

Primary files/scripts:
- `src/utils/security/keyManager.ts`
- `scripts/devtools/auditKeyVersions.ts` (`bun run audit-keys`)
- `scripts/devtools/rotateAllKeys.ts` (`bun run rotate-keys`)

Environment key model:
- Legacy: `CRYPTO_SECRET` (treated as version 1 when needed)
- Versioned: `CRYPTO_SECRET_V1`, `CRYPTO_SECRET_V2`, ...
- Optional override: `CRYPTO_SECRET_CURRENT`
- If no explicit current version is set, highest available version is used for new writes.

Rotation behavior:
- New encryptions use current version.
- Existing rows remain decryptable using their stored `key_version`.
- Optional API keys also perform lazy rotation on read when an older version is encountered.
- Full forced migration is available via `bun run rotate-keys`.

Recommended workflow:
1. Add new key version to environment/secrets.
2. Restart bot (new writes use new version).
3. Run `bun run audit-keys`.
4. Run `bun run rotate-keys` if immediate migration is needed.
5. Remove old key versions only after audit shows no remaining usage.

## Provider API Key Pool (Failover / Load Balancing)

Primary file:
- `src/utils/security/keyRotation.ts`

`api_key_rotation` provides provider-specific key pools per server:
- Round-robin-like selection (ordered by `usage_count`)
- Temporary cooldown on errored keys
  - `rate_limit`: 60s
  - `api_error`: 5min
- One main-key pointer per `(server_id, provider)` (`is_main_key_pointer=true`) so each saved provider's primary
  key can participate in its own pool without coupling rotation state to another provider
- Success/error recording updates counters and cooldown metadata

This is separate from encryption key version rotation. It controls runtime provider key usage and failover.
Personal provider credentials do not use this pool. `/personal providers` edits only the user's primary saved
credential and never reads or writes server rotation rows.

## Privacy Model

Primary files:
- `src/commands/personal/config.ts`
- `src/utils/discord/ui/personalConfigPanel.ts`
- `src/utils/discord/interactions/personalConfigRoutes.ts` and its extracted handler modules
- `src/events/messageCreate/tomoriChat.ts`
- `src/utils/text/contextBuilder.ts`
- `src/utils/db/repositories/UserRepository.ts`
- `src/utils/db/repositories/index.ts`
- `src/db/schema.sql` (`users.privacy_level`, `personalization_blacklist`)

### Global privacy levels (`/personal config`)

`users.privacy_level` values:
- `0` (`MINIMAL`): full personalization context (including status/roles/personal memories when allowed).
- `1` (`PARTIAL`): reduced personalization; level-0-only enrichments (status/roles/personal memories) are excluded.
- `2` (`FULL`): strongest privacy posture.

Current runtime effects for `FULL`:
- Message-based chat trigger flow silently ignores the user in `messageCreate` (non-manual trigger path).
- Messages from level-2 users are filtered out of conversation history context.
- Participant reference discovery may recognize a saved nickname as lookup-only evidence,
  but typed hydration applies privacy before rendering or target projection. A hidden saved
  nickname cannot become an output mention, tool target, or copied identity.

### Per-server blacklist (`/moderation`)

`personalization_blacklist` is server-scoped and keyed by `(server_id, user_disc_id)`.

Blacklisted users:
- Are excluded from personalization behavior in that server.
- Are not globally opted out.
- Can still exist and interact; blacklist controls personalization scope rather than account existence.

Participant profile fields pass through the same centralized exposure policy before profile
enrichers run. Extension enrichers receive cloned privacy-filtered core fields and can emit
only owner-stamped `extension:{id}` fields; they cannot restore suppressed names, memories,
presence, roles, timezone, or physical appearance.

`/moderation` also lists active `persona_user_blocks` rows so moderators can remove persona-scoped mutes/blocks through the same checklist flow. These rows are separate from `personalization_blacklist`: a `mute` prevents the target from triggering that persona, while a `block` also hides the target's recent live dialogue-history messages/media from that persona's context. Persona user blocks are not data deletion, forgetting, or memory redaction.

## Data Export and Deletion (Current Behavior)

Primary files:
- `src/commands/memory/personal/export.ts`
- `src/commands/personal/memories.ts`
- `src/utils/discord/ui/personalMemoriesPanel.ts`
- `src/utils/discord/interactions/personalMemoriesOperations.ts`
- `src/commands/memory/server/export.ts`
- `src/commands/memories.ts`
- `src/utils/discord/ui/memoriesPanel.ts`
- `src/utils/discord/interactions/memoriesRoutes.ts`
- `src/utils/discord/interactions/memoriesDocumentOperations.ts`
- `src/commands/server/config/export.ts`
- `src/commands/reset/config.ts`
- `src/utils/db/repositories/ImportExportRepository.ts`
- `src/utils/db/repositoryExportSql.ts`

Export is granular by type (JSON file via DM), including:
- persona personal memories
- persona server memories
- personal settings
- server config
- global personal memories

Delete/reset remains type-scoped. Commands that currently require confirmation choice are:
- personal settings reset
- server config reset

Personal row management is through `/personal memories` (type-scoped by persona/global scope), and server memory management remains type-scoped by persona scope (`/memories`). Both operate on selected stored rows rather than bulk-resetting a whole scope.

Important: the current reset/remove commands do not implement a blanket user-row/account hard delete path in these command implementations.

## SQL Injection Protections

Primary files:
- `src/utils/db/client.ts`
- `src/utils/db/sqlSecurity.ts`

Protections in place:
- Parameterized Bun SQL template queries are used for values.
- Dynamic UPDATE field names are validated against explicit allowlists (`validateUserFields`, `validateTomoriFields`, `validateTomoriConfigFields`).

## User-Supplied Remote URL Protections

Primary files:
- `src/utils/security/remoteUrlSecurity.ts`
- `src/utils/security/userRemoteFetch.ts`
- `src/utils/mcp/guildMcpManager.ts`
- `src/utils/provider/customEndpointService.ts`
- `src/providers/custom/`

Current runtime protections for guild MCP servers and custom endpoints:
- URL preflight validation still enforces the existing protocol/host policy from `validateRemoteUrl()`.
- Actual HTTP requests no longer trust that preflight alone; each request revalidates the target URL immediately before sending.
- The real connection is pinned to the just-validated DNS results, so the request does not perform a second untrusted DNS lookup. Idempotent `GET` and `HEAD` requests try the next validated address after a transport failure, covering hosts such as `localhost` that resolve to both IPv6 and IPv4 while listening on only one family. Non-idempotent requests fail over only after an explicit connection refusal, which occurs before the remote service accepts or processes the request.
- Custom endpoint redirects are handled hop-by-hop with revalidation on every `Location` target and a bounded redirect depth (`USER_REMOTE_FETCH_MAX_REDIRECTS`, default `3`).
- Guild MCP HTTP transports continue to reject redirects (`redirect: "error"`), but now use the same pinned-DNS fetch path for the underlying network call.

Key takeaway: user-supplied remote endpoints no longer rely on a validation-only DNS check; every attempted address comes from the validated result set.

The same URL-validation path is also used by `safeDownload()` for user/media downloads. Discord attachment imports, workflow JSON uploads, image/GIF/video context expansion, avatar/character-reference reloads, and provider-returned media downloads get bounded size checks, timeout enforcement, redirect revalidation, and production SSRF blocking before bytes are read into memory.

### Refusals versus transport failures

A URL the gate rejects never reaches the network, so it is reported separately from a real connection failure:

- `fetchUserRemoteUrl()` throws `RemoteUrlPolicyError` (not a bare `Error`) for every deliberate refusal: preflight validation, per-hop redirect revalidation, a forbidden or over-deep redirect chain, a missing `Location` header, and an unpinnable address. It carries the `hostname` and a `failureCode`.
- `safeDownload()` maps that to `error: "blocked_by_policy"` and logs it at **warn** with `errorType: "download_blocked_by_policy"`, instead of the **error**-level `download_network_error` used for genuine transport faults.

This matters for log-based alerting: user-supplied content routinely contains URLs that policy declines (a plain-HTTP image CDN, a shortener redirecting to a private address). Those are expected outcomes, not incidents, and they no longer land in the error-level stream or the `error_logs` table.

Because `validateRemoteUrl()` backs MCP config, custom endpoints, `fetch_url`, and every `safeDownload()` caller, its `details` string is caller-neutral diagnostic text. User-facing remediation belongs in the caller, keyed off `failureCode`.

## Runtime Guardrails and Anti-Abuse Controls

Primary files:
- `src/db/schema.sql` (`cooldowns`, `cleanup_expired_cooldowns()`)
- `src/utils/db/cooldownManager.ts`
- `src/utils/db/messageCooldown.ts`
- `src/utils/security/rateLimiter.ts`
- `src/utils/security/safeDownload.ts`

Controls include:
- Command and message cooldown system (see `docs/en/architecture/subsystems/cooldowns.md`)
- Production-only message concurrency limits per user/server
- Daily in-memory quotas for persona/import/document/avatar operations
- Stream flood guard (`MAX_FLUSH_COUNT`)
- Memory pressure guard with warning/critical modes, emergency cooldown, and automatic recoverable-cache clearing
- Safe attachment download with max size + timeout + response validation
- Media download limits for provider-returned videos and Gemini/Vertex inline video context are configurable through `PROVIDER_VIDEO_DOWNLOAD_MAX_MB` and `VIDEO_CONTEXT_MAX_INLINE_MB`.

Critical memory behavior:

- `memoryGuard` enters emergency mode when RSS reaches `MEMORY_CRITICAL_THRESHOLD`
  of `CONTAINER_MEMORY_LIMIT_MB`.
- Emergency mode disables media processing and triggers `clearEmergencyCaches()`.
- Cache clearing preserves non-expired short-term memory by default; operators can
  opt into full STM clearing with `EMERGENCY_CACHE_CLEAR_INCLUDE_STM=true`.
- Forced GC runs after cache clearing when the runtime exposes `Bun.gc` or
  Node's `global.gc`; `memory_forced_gc` logs pre/post process memory fields.

## Supply Chain Security

TomoriBot implements several controls to mitigate supply chain risks during development and deployment:

- **Lockfiles and Pinning:** Always use `--frozen-lockfile` to ensure deterministic builds. Never use floating tags like `@latest` in the `Dockerfile`, workflow actions, dependency overrides, or bundled MCP server configs. A global dependency override must remain within every dependent package's declared version range; update or patch the parent dependency instead of forcing an incompatible major version.
- **Pinned Runtime Images and Actions:** Production Docker builds pin the Bun base image by digest, and deployment workflows pin third-party GitHub Actions by commit SHA.
- **Bundled MCP Packages:** Built-in npm MCP servers are pinned in `package.json`/`bun.lock`; production uses installed binaries instead of runtime `bunx` package resolution.
- **Dependency Auditing:** The CI/CD pipeline enforces `bun audit` (failing on high/critical) and container scanning (Trivy).
- **Asset Checksums:** External dependencies downloaded outside the primary package manager must be verified against cryptographic hashes before the Docker image is built.
- **Dependency Patches:** Patches and overrides are tracked in `patches/README.md`. When updating dependencies, always refer to this document to check if a patch can be reverted.
- **OIDC Deployments:** Production infrastructure uses short-lived OIDC tokens for AWS authentication rather than static IAM credentials.

## Operational Checklist

- Keep `.env` and secret material out of version control.
- Prefer versioned encryption keys (`CRYPTO_SECRET_V*`) even if starting with one version.
- Run `bun run audit-keys` before removing old key versions.
- Use `bun run rotate-keys --dry-run` before forced migration.
- When changing privacy or blacklist behavior in code, verify matching cache invalidation paths (user cache / blacklist cache).

## Related Docs

- `docs/en/architecture/subsystems/database-schema.md`
- `docs/en/architecture/subsystems/caching.md`
- `docs/en/architecture/subsystems/cooldowns.md`
- `docs/en/architecture/pipelines/context-build/02-native-assembly/08-rag-documents.md` (document memory gating and limits)
