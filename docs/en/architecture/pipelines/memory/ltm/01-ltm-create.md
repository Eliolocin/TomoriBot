---
title: "LTM 01: Memory Creation"
---

LLM-initiated creation of a new persistent memory — server-wide or
user-specific — written to the database.

**File:** `src/tools/functionCalls/memoryTool.ts` — class `MemoryTool`,
tool name `create_long_term_memory`

## Mission

When the LLM identifies a new, distinct fact or preference worth preserving
across sessions, it calls `create_long_term_memory` with a `memory_content`
string and a `memory_scope` of either `server_wide` or `target_user`.

`MemoryTool.execute()` runs the following sequence:

1. **Validate** parameters (content non-empty, scope valid, feature flag on,
   critical state present).
2. **Resolve target user** (scope `target_user` only) — `resolveUserTarget()`
   looks up the provided display name in the conversation/guild, disambiguating
   multiple matches and handling bridge-user and bot-self fallbacks. Persona-scoped
   nicknames and affixed labels ("Master Sparrow") resolve too; see
   `docs/en/architecture/pipelines/context-build/02-native-assembly/06-participants.md`
   for the stage ladder.
3. **Sanitize content** — `sanitizeUnknownTemplatePlaceholders()` strips
   brace-wrapped tokens that don't match `{user}` or `{bot}` (e.g. the LLM
   writing `{Obonya}` instead of the correct template token).
4. **Guard lineage** — blocks if `persona_lineage_id === 0` (reserved; signals
   an un-run schema migration).
5. **Check limits** — `serverMemoryRepository.checkServerMemoryLimit()` or
   `personalMemoryRepository.checkPersonalMemoryLimit()` before writing.
6. **DB write** — `serverMemoryRepository.add(...)` or
   `personalMemoryRepository.add(...)`.
7. **Notify** — send a success embed to Discord (`sendStandardEmbed`).
8. **Invalidate cache** — `invalidateTomoriStateCache(serverId)` or
   `invalidateUserCache(userId)`.

## Input

Tool arguments (from LLM):

| Arg | Type | Required | Description |
|---|---|---|---|
| `memory_content` | `string` | yes | The fact to persist. Must use `{user}` / `{bot}` tokens instead of hardcoded names. |
| `memory_scope` | `"server_wide" \| "target_user"` | yes | Determines the DB table and cache key. |
| `target_user` | `string` | when scope = `target_user` | Display name of the target user (not a Discord ID). |

Context required:

- `context.tomoriState` — `server_id`, `persona_id`, `persona_lineage_id`,
  `config.self_teaching_enabled`, `config.personal_memories_enabled`.
- `context.userId` / `context.message.author.id` — triggering user for audit
  and `{user}` resolution.
- `context.channel` — for `serverId` extraction and embed delivery.

## Output

`Promise<ToolResult>` with `data.status` indicating outcome:

| Status | Meaning |
|---|---|
| `memory_saved_successfully` | DB write succeeded; `data.memory_id` is the new row ID |
| `memory_save_failed_disabled` | `self_teaching_enabled` is off |
| `memory_save_failed_limit_exceeded` | Server or personal memory limit reached |
| `memory_save_failed_ambiguous_user` | Multiple users matched `target_user` |
| `memory_save_failed_user_not_found` | No matching user found |
| `memory_save_failed_privacy_restricted` | Target user has `PrivacyLevel.PARTIAL` or `FULL` |
| `memory_save_failed_internal_error` | Missing critical state or invalid lineage ID |
| `memory_save_failed_db_error` | DB operation failed |

## Side effects

- **DB row inserted** — one row in `server_memories` (server-wide) or
  `personal_memories` (target-user).
- **Discord embed sent** — success notification in `context.channel`;
  routed through webhook if in alter-persona mode.
- **Cache invalidated:**
  - Server-wide: `invalidateTomoriStateCache(serverId)`
  - Personal: `invalidateUserCache(resolvedTargetUserId)`
- **Log entry** — `log.success(...)` on success with memory ID and content.

## Invariants

After a successful write:

- The new memory row exists in the DB, scoped to
  `(server_id, persona_lineage_id)` for server memories or
  `(user_id, persona_lineage_id)` for personal memories.
- The TomoriState or user cache for the affected scope has been invalidated —
  the next context-build will load from DB.
- `data.memory_id` in the `ToolResult` matches the `server_memory_id` or
  `personal_memory_id` of the inserted row.

## Scope fallback rules

| Input condition | Effective scope | Reason |
|---|---|---|
| `target_user` resolves to the bot itself | `server_wide` | Bot can't have personal memories about itself |
| `target_user` is a Matrix bridge user | `server_wide` | Bridge users are not stored in `users` table with full identity |
| `target_user` has `PrivacyLevel.PARTIAL/FULL` | Error (no fallback) | Privacy restriction; user must change setting |

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `serverMemoryRepository.add()` / `personalMemoryRepository.add()` | **A plugin adding a new memory scope (e.g., channel-specific LTM) would add a repository method and a matching `memory_scope` enum value here.** → plugin plan candidate |
| `resolveUserTarget()` | `src/utils/discord/targetResolver.ts`. Internal — user resolution is a guild-lookup utility; no plugin seam. |
| Memory limit checks (`checkServerMemoryLimit`, `checkPersonalMemoryLimit`) | Internal — limits are DB-column configured, not plugin-controlled. |
| `convertMentions()` | `src/utils/text/contextBuilder.ts`. Internal — token replacement (`{user}` / `{bot}`) for embed display only; does not affect the stored content. |

## Configuration

| Source | Key / Env var | Default | Purpose |
|---|---|---|---|
| `TomoriState.config` | `self_teaching_enabled` | `true` | Master feature flag for all LTM tools |
| `TomoriState.config` | `personal_memories_enabled` | `true` | Controls embed footer wording for personal memory notifications |
| Env var | `MAX_SERVER_MEMORIES` | `100` | Max server memories per `(server_id, persona_lineage_id)` |
| Env var | `MAX_PERSONAL_MEMORIES` | `100` | Max personal memories per `(user_id, persona_lineage_id)`, counting lineage `0` globals |
| Env var | `MAX_MEMORY_LENGTH` | `1000` | Max characters per memory, enforced by `validateMemoryContent()` |

Limits live only in `src/utils/misc/memoryLimits.ts`; there are no per-server limit columns.
Counting is scoped to a persona lineage, so a multi-persona server holds `MAX_SERVER_MEMORIES`
per persona rather than in total.

## Related docs

- LTM update/delete that acts on the ID assigned here: → [`ltm/02-ltm-update-delete.md`](02-ltm-update-delete.md)
- Context-build stage that reads server memories: → [context-build server-memory stage](../../../context-build/02-native-assembly/03-server-memories)
- Context-build stage that reads personal memories: → [context-build personal-memory stage](../../../context-build/02-native-assembly/07-personal-memories)
- Memory ID format seen by the LLM: → `src/utils/memory/memoryId.ts`
- Privacy level schema: → `src/types/db/schema.ts` (`PrivacyLevel` enum)
