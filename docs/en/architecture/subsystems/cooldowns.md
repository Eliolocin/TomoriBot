---
title: "Cooldown System"
---

This document describes the currently implemented cooldown behavior.

## Scope

TomoriBot has two cooldown domains:

1. Slash command category cooldowns (`interactionCreate`)
2. Message-trigger cooldowns (`messageCreate`) with whitelist-aware channel/role gating and per-channel overrides

## Data Storage

Table: `cooldowns` (UNLOGGED) in `src/db/schema.sql`

Columns used for explicit scope:

- `cooldown_type`
- `server_disc_id`
- `user_disc_id`
- `channel_disc_id`
- `command_category`
- `expiry_time` (ms epoch)

Unique scope index is built with COALESCE across those columns for safe UPSERT behavior.

## Command Category Cooldowns

Handler: `src/events/interactionCreate/handleCommands.ts`

- Cooldown type: `CooldownType.COMMAND_CATEGORY`
- Key shape: `user_disc_id + command_category`
- Durations come from env (`DEFAULT_COMMAND_COOLDOWN`, `COOLDOWN_CONFIG`, `COOLDOWN_PERSONA`, `COOLDOWN_MEMORY`, `COOLDOWN_SERVER`, `COOLDOWN_PERSONAL`, `COOLDOWN_CONDITIONING`)
- Cooldown warning uses localized `general.cooldown*` keys

## Message Trigger Cooldowns

Core module: `src/utils/db/messageCooldown.ts`

Used for automatic message-triggered chat flow.

### Effective cooldown source

1. Check whitelist cache (`getCachedWhitelistStatus`).
2. If the trigger is in a thread, first check the thread itself, then fall back to its parent channel's whitelist entry.
3. If channel whitelist is active and current channel (or its parent channel for threads) is not whitelisted -> blocked.
4. If role whitelist is active and triggering member has no whitelisted role -> blocked.
5. If a persona has a channel whitelist configured anywhere in the server, that persona is only eligible in its whitelisted channels (threads inherit the parent channel entry); personas with no rows remain eligible everywhere. Disallowed automatic persona matches fail silently and manual persona selections (for example `/respond`, `/impersonate persona`, conditioning, and scene-image sender selection) are rejected.
6. If the triggering user has a personal spotlight for the effective channel, that spotlight becomes an additional persona filter on top of the server whitelist. Only personas present in both sets may trigger, including proxy/self chains. The spotlight's optional personal auto-trigger persona behaves like a user+channel-scoped always-reply fallback, but still respects the server whitelist result.
7. If channel is whitelisted and has an explicit override, use that channel-specific cooldown type/length.
8. If channel is whitelisted without an override, inherit global `server_trigger_behavior_configs.cooldown_type/cooldown_length`.
9. Otherwise use global `server_trigger_behavior_configs.cooldown_type/cooldown_length`.

### Cooldown types

Enum in `src/types/db/schema.ts`:

- `OFF` (0)
- `PER_USER` (1)
- `PER_CHANNEL` (2)
- `SERVER_WIDE` (3)
- `STRICT_SERVER_WIDE` (4)
- `COMMAND_CATEGORY` (5, for slash command cooldowns)

Operational note:

- `/server cooldown triggers` currently allows selecting types `0..3`.
- Type 4 remains in enum/runtime support for legacy rows.

### Manager exemption

- ManageGuild members bypass message cooldowns for types 1..3
- no exemption for strict type 4
- test override: `DISABLE_COOLDOWN_EXEMPTIONS=true`

## Configuration Commands

- Global trigger cooldown: `/server cooldown triggers`
- Trigger whitelist:
  - `/moderation` Whitelist Channels (leave cooldown options empty to inherit the global cooldown)
  - `/moderation` Whitelist Personas
  - `/moderation` Whitelist Roles
- Personal spotlight:
  - `/personal spotlight set`
  - `/personal spotlight manage`

## Cleanup

Function: `cleanup_expired_cooldowns()` in schema.

Invoked by:

- startup cleanup in `src/index.ts`
- optional `pg_cron` scheduled job (hourly) when available

## Cache Interaction

When cooldown config/whitelist settings change, invalidate:

- Tomori state cache
- whitelist cache
- personal spotlight cache

to avoid stale trigger behavior.
