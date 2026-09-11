---
title: "Matrix Bridge & Bridge Utilities"
---

This document describes TomoriBot's Matrix bridge implementation — what it does, why it was built the way it was, and how the codebase is organized to keep bridge concerns cleanly separated from core Discord logic.

## Table of Contents

- [Overview](#overview)
- [Feature Parity: Matrix vs Discord](#feature-parity-matrix-vs-discord)
  - [Known Gaps & Planned Work](#known-gaps--planned-work)
- [Why a Built-In Bridge?](#why-a-built-in-bridge)
- [Why Not Mautrix or an Existing Bridge?](#why-not-mautrix-or-an-existing-bridge)
- [Architecture](#architecture)
  - [Directory Layout](#directory-layout)
  - [Data Flow](#data-flow)
  - [Loop Prevention](#loop-prevention)
- [Key Components](#key-components)
  - [src/utils/bridges/ — Generic Bridge Utilities](#srcutilsbridges--generic-bridge-utilities)
  - [src/utils/bridges/matrix/ — Matrix Appservice](#srcutilsbridgesmatrix--matrix-appservice)
  - [src/events/messageCreate/matrixRelay.ts — Discord→Matrix Relay](#srceventsmessagecreatemayrixrelayts--discordmatrix-relay)
- [Webhook Username Format](#webhook-username-format)
- [Virtual Persona Users](#virtual-persona-users)
- [Matrix Mentions](#matrix-mentions)
- [Media Relay](#media-relay)
- [Embed Relay](#embed-relay)
- [Reply Detection](#reply-detection)
- [Reminders for Matrix Users](#reminders-for-matrix-users)
- [LLM Defensive Checks](#llm-defensive-checks)
- [Setup & Configuration](#setup--configuration)
- [Production Topology](#production-topology)
- [Design Decisions](#design-decisions)

---

## Overview

TomoriBot includes a built-in [Matrix](https://matrix.org/) appservice bridge that allows Matrix users to chat with TomoriBot's AI without needing a separate bridging service. A server admin links a Matrix room to a Discord channel with a single slash command. After that:

- Messages from Matrix users are relayed into Discord via webhook, where TomoriBot reads and responds to them normally.
- TomoriBot's AI responses are relayed back to the Matrix room, appearing under the persona's own Matrix virtual user identity (e.g., `@_tomori_lilya:yourdomain.com`).
- The room receives short onboarding notices when the bot is invited and when the bridge is linked, so Matrix-side users see the remaining setup steps and current limitations in-context.

The bridge is entirely optional — if Matrix credentials are not configured, TomoriBot starts normally with no Matrix functionality.

---

## Feature Parity: Matrix vs Discord

This table reflects the current state of feature support for Matrix users compared to native Discord users.

### Fully Working ✅

| Feature | Notes |
|---|---|
| AI conversation | Full responses, personality, streaming |
| Server-wide memories | AI can learn and recall server-scoped facts |
| Reminders | Set and delivered with a proper Matrix mention ping |
| Web search / URL fetch | MCP tools fire transparently |
| Image generation | Image is generated and relayed as a Matrix media event |
| Short-term memory | Cross-channel conversation summaries work passively |
| Typing indicator | Shown under the persona's virtual Matrix user and explicitly cleared on stream completion/interrupt |
| Media relay | Bidirectional — images, video, and files |
| `/refresh` (text command) | Resets conversation history and clears short-term memory |
| `/kill` (text command) | Stops active stream, clears queued responses, and clears Matrix typing indicators |
| Matrix per-user cooldowns | Per-user cooldown keying uses extracted Matrix user IDs, so users no longer share one webhook cooldown bucket |

### Broken / Degraded ⚠️

| Feature | Status | Root Cause |
|---|---|---|
| **Personal memories** | Downgraded to attributed server memory | Matrix users have no `users` table row, so `target_user` scope is forced to `server_wide`. During downgrade, `{user}` is replaced with the resolved Matrix display name before save so attribution is preserved. |
| **User language preference** | No-op | Stored in the `users` table; Matrix users have no row. Server locale is used as fallback. |
| **User timezone** | No-op | Same — reminders use the server timezone as fallback. |
| **Profile picture peek tool** | Discord users only | The tool looks up a Discord snowflake for avatar URL; Matrix user IDs cannot be resolved through the Discord API. |
| **Pin message tool** | Meaningless | Pins a Discord message; has no effect visible to Matrix users. |

### Known Gaps & Planned Work

Remaining degraded features are listed in the table above. Current parity work for personal-memory attribution and Matrix per-user cooldown keying is complete.

---

## Why a Built-In Bridge?

### From the server admin's perspective

Setting up the bridge requires **two steps**:
1. Invite `@tomoribot:yourdomain.com` to a Matrix room.
   - TomoriBot auto-accepts the invite and posts a short setup hint in the Matrix room telling users to finish the link from Discord, where to find the Internal Room ID, and that the room must stay unencrypted.
2. Run `/matrix link` in the Discord channel to link them.
   - On a successful link, TomoriBot posts a second Matrix-side onboarding note summarizing the usable Matrix commands (`/kill`, `/refresh`) and the main Matrix-specific limitations.

That's it. The homeserver infrastructure is invisible to server admins — the same way Discord server admins don't think about Discord's servers when they add a bot.

### From the operator's perspective (you)

The homeserver and appservice are set up **once**, centrally. All server admins share the same bridge infrastructure. Compare this to solutions like mautrix-discord, where each admin would need to run their own bridge instance.

---

## Why Not Mautrix or an Existing Bridge?

Existing bridges like [mautrix-discord](https://github.com/mautrix/discord) and [Heisenbridge](https://github.com/hifi/heisenbridge) are **general-purpose room-mirroring bridges**. Their goal is to replicate an entire community across platforms — every user gets a puppet, every room gets bridged.

TomoriBot's use case is fundamentally different:

| | Mautrix / Heisenbridge | TomoriBot's Bridge |
|---|---|---|
| **Purpose** | Full community mirroring | AI chatbot access point |
| **User puppeting** | All Discord users → Matrix | Only Tomori personas → Matrix |
| **Matrix users → Discord** | Full identity mirroring | Webhook relay (display only) |
| **Setup per server admin** | Run own bridge instance | Invite bot + one slash command |
| **Deployment** | Separate process | Embedded in TomoriBot |

Using mautrix would bring all the puppet/mirroring infrastructure without solving the actual need (AI responding to Matrix users), and would still require custom code to integrate TomoriBot's persona system. The `matrix-appservice-bridge` SDK provides just the low-level plumbing (HTTP appservice server, Intent objects, registration) without imposing any bridging logic on top.

### What about users running their own mautrix-discord?

A power user who already has mautrix-discord running could technically bridge their server. mautrix would relay Matrix users' messages into Discord as webhook messages. However, TomoriBot **ignores webhook messages by default** (to prevent echo loops from its own alter persona webhooks). The only missing piece would be a carve-out to allow webhook triggers in Matrix-linked channels — this could be added in the future as an "external bridge mode" flag. TomoriBot's responses would be picked up and relayed to Matrix by the external bridge automatically.

---

## Architecture

### Directory Layout

```
src/utils/bridges/
  bridgeUserId.ts       ← Pure, stateless bridge utilities (ID detection, webhook parsing)
  index.ts              ← Generic bridge utilities barrel

src/utils/bridges/matrix/
  client.ts             ← Appservice boot and setup notices
  media.ts              ← Matrix media upload/download and outbound sends
  state.ts              ← Session-scoped Matrix bridge state and caches
  events.ts             ← Matrix inbound event handling and Matrix command handling
  stateSync.ts          ← Reply tracking, pending reply channels, reminder mention surface
  userMapping.ts        ← Display-name/Matrix-ID maps and persona intent surface
  rooms.ts              ← Link cache, room joins, and encryption helpers
  index.ts              ← Matrix-specific barrel export

src/events/messageCreate/
  matrixRelay.ts        ← Watches for TomoriBot's own Discord messages and relays them to Matrix

src/commands/matrix/
  link.ts               ← /matrix link command
  unlink.ts             ← /matrix unlink command
```

The split under `utils/bridges/` is intentional:

- `utils/bridges/` contains **pure string utilities** with no runtime dependencies — ID format detection, webhook username parsing. These work for any bridge protocol.
- `utils/bridges/matrix/` contains **stateful Matrix operations** — the appservice HTTP server, session-scoped display name maps, Matrix API calls.

This means a file like `reminderProcessor.ts` imports from `utils/bridges` for the ID check, not `utils/bridges/matrix`, making it clear the bridge support is a general concern rather than Matrix-specific logic scattered everywhere.

### Data Flow

**Matrix → Discord (inbound):**
```
Matrix user sends message
  → Homeserver pushes event to appservice HTTP server (port 9993)
  → client.ts appservice controller dispatches to events.ts
  → Looks up linked Discord channel via matrix_channel_links table
  → Sends webhook message to Discord channel as "[Matrix|@user:host] DisplayName"
  → TomoriBot's messageCreate handler sees the webhook message
  → isMatrixRelayMessage = true → exempted from self-message/persona guards
  → TomoriBot processes and responds normally
```

During context preparation, the relay's Matrix ID and stripped display name enter the core
Matrix `ParticipantSource`. It emits a typed `matrix_user` identity with bridge-presence
evidence and aliases owned by that identity. Matrix participants are non-mentionable in the
Discord target index; reminder delivery continues to use the bridge's Matrix-specific mention
surface. Their display names remain lookup-only tool targets and participate in output-handle
collision detection, preventing the provider from receiving an ambiguous Discord handle with
the same name without rendering the Matrix alias as a ping. The required
`PreparedParticipantContext` carries this result into native context assembly, so the context
builder does not accept a separate Matrix participant map.

**Discord → Matrix (outbound):**
```
TomoriBot sends AI response to Discord channel
  → matrixRelay.ts messageCreate handler fires
  → isSelfTriggerMessage() confirms message is from TomoriBot or an alter persona
  → getLinkedMatrixRoom() checks for a linked Matrix room (cached DB lookup)
  → sendToMatrixRoom() sends the message via the persona's virtual Matrix user Intent
  → Attachments are relayed as Matrix media events (m.image / m.video / m.file)
  → Tool-result embeds are converted to plain-text notices and relayed
```

### Loop Prevention

Two separate guards prevent message echo loops:

**Matrix → Discord direction:** `onEvent` in `client.ts` filters out any event where `sender === botUserId` OR `sender` starts with `@_tomori_` and ends with `:${serverName}`. The domain suffix check prevents a remote user named `@_tomori_*:evil.org` from bypassing the guard.

**Discord → Matrix direction:** `matrixRelay.ts` only relays messages where `isSelfTriggerMessage()` returns true — i.e., messages from TomoriBot's own bot account or alter persona webhooks. Regular user messages and Matrix relay webhooks are never relayed back.

---

## Key Components

### `src/utils/bridges/` — Generic Bridge Utilities

Three pure, stateless utility functions covering all bridge-related string operations:

| Function | Purpose |
|---|---|
| `isBridgeUserId(id)` | Returns true if the string is a bridge user ID (currently: Matrix `@localpart:homeserver` format). Extend to support future bridge formats. |
| `stripBridgePrefix(username)` | Strips the `[BridgeName\|userId] ` prefix from a bridge webhook username, returning just the display name. |
| `extractBridgeUserId(username)` | Extracts the userId portion from a bridge webhook username (the part between `\|` and `]`). |

These functions are format-agnostic by design. The `[BridgeName|userId] DisplayName` webhook username convention is TomoriBot's own format — a future IRC bridge would use `[IRC|user@host] DisplayName` and these functions would handle it without any changes.

### `src/utils/bridges/matrix/` — Matrix Appservice

The public Matrix surface is grouped by responsibility and exported through `index.ts`:

- **`client.ts`**: Appservice initialization (`initializeMatrixClient`) plus Matrix setup notices.
- **`events.ts`**: Matrix inbound event handling, Matrix `/kill`, Matrix `/refresh`, and Matrix-to-Discord relay.
- **`rooms.ts`**: Link cache (`getLinkedMatrixRoom`, `getDiscordChannelForRoom`), cache invalidation, room joins, and encryption checks.
- **`stateSync.ts`**: Sent-event reply tracking, pending reply channels, Matrix reply fallback stripping, and reminder mention pings.
- **`userMapping.ts`**: Display-name/Matrix-ID maps, persona intent provisioning, typing indicators, and bridge user ID recovery.
- **`media.ts`**: Matrix media upload/download, attachment limits, and outbound text/media sends (`sendToMatrixRoom`, `sendAttachmentToMatrixRoom`).
- **`state.ts`**: Session-scoped bridge instance, link caches, persona provisioning caches, and shared constants.

New code should import from the responsibility module or from `@/utils/bridges/matrix`.

### `src/events/messageCreate/matrixRelay.ts` — Discord→Matrix Relay

Auto-discovered by the event handler system and invoked on every `messageCreate` event. Exits immediately (fast path) if:
1. Matrix bridge is not configured
2. Message is not from a guild
3. Message is not from TomoriBot itself (`isSelfTriggerMessage` check)
4. Channel has no linked Matrix room

When relaying, it:
- Identifies which persona sent the message (main bot account or alter webhook) to select the correct Matrix virtual user
- Resolves `<@discordId>` and `@{name}` mention placeholders to proper Matrix mention anchor tags (`<a href="https://matrix.to/#/@user:host">Name</a>`) with MSC3952 `m.mentions` fields
- Serializes every Discord embed into plain text and relays it (author/title/description/fields/footer/URLs)
- Splits oversized serialized embeds into numbered chunks using `MATRIX_EMBED_CHUNK_MAX_CHARS` (default: `3500`) so relay remains deterministic

---

## Webhook Username Format

Bridge relay messages in Discord use a structured webhook username format:

```
[Matrix|@user:host] DisplayName
```

Example: `[Matrix|@obonya:localhost] obonya`

This format serves three purposes:
1. `startsWith("[Matrix|")` — fast detection of Matrix relay messages in `tomoriChat.ts`
2. `extractBridgeUserId()` — extracts `@obonya:localhost` for the `matrixUserMap` (used by `contextBuilder.ts` to inject Matrix users into the AI's context)
3. `stripBridgePrefix()` — extracts `obonya` as the display name for history formatting and persona matching

When building context, Matrix users are listed with both display name and bridge ID (`User ID: @user:host`) so memory/reminder tools can target them using an explicit identifier.

The outer bracket format `[BridgeName|userId]` is designed to be extensible — future bridges follow the same convention.

---

## Virtual Persona Users

Each TomoriBot persona gets its own Matrix virtual user identity:

```
@_tomori_{nickname}:{serverName}
```

Example: `@_tomori_lilya:yourdomain.com`

The appservice registration claims **exclusive** control over the `@_tomori_.*:{serverName}` namespace, meaning no other user can register an account matching that pattern on the homeserver.

On first use per bot session, the virtual user is:
1. Registered on the homeserver (idempotent — safe to call repeatedly)
2. Given the persona's display name
3. Given the persona's avatar (downloaded from Discord CDN, uploaded to the homeserver)

An in-memory cache (`provisionedIntents`) prevents redundant provisioning API calls within a session. If the avatar URL changes (for example, after `/config` > Persona > Identity & Personality), the cache entry is invalidated on next restart.

---

## Matrix Mentions

TomoriBot's AI uses the `@{displayName}` placeholder format for mentioning users in responses (e.g., `@{obonya}`). When relaying to Matrix, `matrixRelay.ts` resolves these placeholders to proper Matrix mention links:

**Plain text body:**
```
@obonya:localhost
```

**Formatted HTML body:**
```html
<a href="https://matrix.to/#/@obonya:localhost">obonya</a>
```

**MSC3952 m.mentions field:**
```json
{ "user_ids": ["@obonya:localhost"] }
```

The `m.mentions` field tells the homeserver to notify the mentioned user even if the client doesn't parse HTML — a more reliable notification mechanism than content-based detection.

The display name → Matrix ID mapping is maintained in a session-scoped `matrixDisplayNameToId` map in `state.ts`, populated through `userMapping.ts` whenever a Matrix user sends a message in a linked channel.

---

## Media Relay

**Matrix → Discord:** Media events (`m.image`, `m.video`, `m.file`, `m.audio`) are downloaded from the homeserver using MSC3916 authenticated media endpoints (`/_matrix/client/v1/media/download/`) and re-uploaded as Discord webhook file attachments. Files exceeding `MATRIX_MAX_ATTACHMENT_MB` (default: 8 MB) are replaced with a text notice.

**Discord → Matrix:** Attachments in TomoriBot's messages are fetched from Discord's proxy CDN and uploaded to the homeserver's media repository, then sent as typed media events (`m.image` for images, `m.video` for video, `m.file` for everything else).

Both directions enforce the same size limit via the shared `MATRIX_MAX_ATTACHMENT_BYTES` constant.

---

## Embed Relay

Discord embeds cannot be rendered natively in Matrix. Instead, `matrixRelay.ts` serializes **all** visible embed content to plain text and relays it:

- Author name/url
- Title/url
- Description
- Fields (name + value)
- Image/thumbnail/video URLs
- Timestamp/footer text/footer icon URL

If the serialized text exceeds `MATRIX_EMBED_CHUNK_MAX_CHARS` (default: `3500`), it is split into numbered chunks (`[1/N]`, `[2/N]`, ...), each sent as its own Matrix message.

This removed the old whitelist-title matching model and prevents silent drops when new embed formats are introduced.

---

## Reply Detection

Matrix clients prepend a fallback block-quote when replying to a message:
```
> <@sender:host> original message

actual reply text
```

`stateSync.ts` strips this fallback block before `events.ts` relays the message to Discord, so TomoriBot only sees the actual reply text.

When a Matrix user replies to a TomoriBot persona message, a `[System: user is replying to PersonaName's message "..."]` annotation is appended to the relayed Discord message body when the original message text is available. Reply triggering itself is handled by `pendingMatrixReplyChannels` in `stateSync.ts`/`tomoriChat.ts`, since Discord webhooks cannot carry native reply references.

The bot tracks sent Matrix event IDs → persona name in a bounded in-memory map (`sentEventPersonas`, capped at 500 entries). For replies to messages sent in a previous session (not in the map), it falls back to fetching the original event from the homeserver to check whether the sender was a `@_tomori_*` virtual user.

---

## Reminders for Matrix Users

Matrix users can be set as reminder targets. Since they have no row in the `users` table (which stores Discord snowflake IDs), several adjustments are made:

1. **`reminderTool.ts`**: Skips BigInt fuzzy-matching (Matrix IDs are not numeric), skips `users` table lookup, and trusts the AI-provided nickname directly.
2. **`reminderProcessor.ts`**: After acknowledged reminder delivery, calls `sendMatrixReminderMention()` instead of the Discord mention path. This sends a direct Matrix mention to the linked room if the AI response didn't already include the `@{localpart}` placeholder. If delivery is stopped or cleared from the queue, the reminder is rescheduled instead of consumed.
3. **`scheduled-task/remove.ts`**: Displays Matrix reminders with `(Matrix)` suffix and `for {nickname}` instead of `created by {nickname}` so server managers can identify them.
4. **`updateTaskTool.ts`**: Matrix relay users can edit/delete non-self reminders targeted at their own Matrix user ID through `update_task`; Matrix-originated self-tasks without a requester row stay slash-command managed.

Matrix user IDs are stored as-is in the `user_discord_id` TEXT column of the `reminders` table (which already accepts arbitrary strings). No schema changes were needed for reminder support.

---

## LLM Defensive Checks

LLMs occasionally mangle Matrix user IDs. `resolveBridgeUserId()` in `userMapping.ts` consolidates all recovery logic:

| Failure mode | Example | Recovery |
|---|---|---|
| Dropped `@` prefix | `obonya:localhost` | Prepend `@`, re-validate |
| Plain display name | `obonya` | Look up in `matrixDisplayNameToId` session map |
| Valid ID | `@obonya:localhost` | No-op, returned unchanged |
| Discord snowflake | `123456789012345678` | No-op, returned unchanged |

This function is called by both `reminderTool.ts` and `memoryTool.ts` before any ID-dependent logic runs.

---

## Setup & Configuration

All configuration is via environment variables. The bridge is silently disabled if any required variable is absent.

| Variable | Required | Description |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | Yes | e.g., `http://localhost:8448` |
| `MATRIX_ACCESS_TOKEN` | Yes | `as_token` — appservice → homeserver auth |
| `MATRIX_HS_TOKEN` | Yes | `hs_token` — homeserver → appservice auth |
| `MATRIX_BOT_USER_ID` | Yes | e.g., `@tomoribot:yourdomain.com` |
| `MATRIX_SERVER_NAME` | Yes | Domain portion, e.g., `yourdomain.com` |
| `MATRIX_APPSERVICE_PUBLIC_URL` | No | Homeserver-facing callback URL in appservice registration. Use this when the homeserver cannot reach `localhost` on the bot host. Non-local endpoints must use `https://` (`http://` is only accepted for localhost dev). |
| `MATRIX_APPSERVICE_PORT` | No | HTTP listen port (default: `9993`) |
| `MATRIX_MAX_ATTACHMENT_MB` | No | Max file size to relay in either direction (default: `8`) |
| `MATRIX_MEDIA_TIMEOUT_MS` | No | Timeout for media download/upload requests (default: `15000`) |
| `MATRIX_EMBED_CHUNK_MAX_CHARS` | No | Max characters per relayed embed message chunk before splitting (default: `3500`) |
| `MATRIX_TYPING_TIMEOUT_MS` | No | Typing indicator auto-clear timeout (default: `60000`) |
| `MATRIX_LINK_CACHE_TTL_MINUTES` | No | TTL for channel↔room link cache (default: `5`) |
| `MATRIX_MAX_TRACKED_SENT_EVENTS` | No | Max event IDs tracked for reply detection (default: `500`) |

The homeserver's `registration.yaml` is generated programmatically from these environment variables — there is no separate registration file to maintain.

---

## Production Topology

For local development, the appservice callback URL can remain `http://localhost:{MATRIX_APPSERVICE_PORT}`.  
For production split-topology deployments (for example, homeserver on DigitalOcean and TomoriBot on AWS ECS), the homeserver must be able to reach TomoriBot's appservice callback URL over the network.

### Remote homeserver callback requirements

- Set `MATRIX_APPSERVICE_PUBLIC_URL` to a stable HTTPS endpoint that routes to TomoriBot's Matrix appservice listener (`MATRIX_APPSERVICE_PORT`, default `9993`).
- Keep `MATRIX_HOMESERVER_URL` pointed at the homeserver base URL used by TomoriBot for Matrix API calls.
- Keep `MATRIX_ACCESS_TOKEN` / `MATRIX_HS_TOKEN` secret and rotate if exposed.
- Avoid exposing a plaintext public callback endpoint.

### Federation requirements

To support rooms hosted on `matrix.org` or other custom homeservers:

- The homeserver must run with federation enabled.
- `MATRIX_SERVER_NAME` should match the real homeserver domain used in Matrix IDs.
- DNS/TLS should be configured so remote servers can federate reliably with your homeserver.

### Encryption limitation (unchanged)

Bridged rooms must remain non-encrypted. `/matrix link` intentionally blocks rooms with `m.room.encryption` enabled because E2EE cannot be disabled once turned on in Matrix rooms.

---

## Design Decisions

### Why generic bridge utilities live outside `bridges/matrix/`

The pure string utilities (`isBridgeUserId`, `stripBridgePrefix`, `extractBridgeUserId`) have no dependency on the Matrix appservice runtime. Keeping them in `utils/bridges/` means:
- Files like `reminderProcessor.ts` import from `utils/bridges`, not `utils/bridges/matrix` — making it clear the dependency is on the concept of bridged users, not the Matrix implementation.
- Adding a second bridge (IRC, XMPP) only requires extending `utils/bridges/` functions — no changes to `utils/bridges/matrix/`.

### Why not store Matrix user IDs in the `users` table

The `users` table uses `BIGINT` for `user_id` (Discord snowflakes are purely numeric). Matrix IDs are strings (`@user:host`). Accommodating them would require a schema migration touching the most central table in the database, for a use case where Matrix user persistence has low value (Matrix IDs are stable within a homeserver but change if users migrate). Reminder support is the exception because the `user_discord_id` column on `reminders` is already `TEXT`.

### Why persona identities appear as separate Matrix users

Using Intent objects (one per persona) rather than a single bot account gives Matrix users a richer experience — each persona appears with its own display name and avatar, matching what Discord users see. It also avoids the need to prefix messages with the persona name, keeping the Matrix conversation clean.

### Why `resolveBridgeUserId` lives in `utils/bridges/matrix/` rather than `utils/bridges/`

The resolution function needs access to `matrixDisplayNameToId` — a session-scoped Map populated by the Matrix appservice event handler. This is inherently runtime state tied to the Matrix connection. Moving it to `utils/bridges/` would either require passing the map as a parameter (awkward for a utility function) or creating a circular dependency. The function is named `resolveBridgeUserId` (not `resolveMatrixUserId`) to signal that it's a general concept even though its current implementation details are Matrix-specific.

### Why the `[BridgeName|userId] DisplayName` webhook username format

This format was chosen to be:
- **Machine-parseable**: `extractBridgeUserId()` can extract the ID portion generically for any bridge type.
- **Human-readable**: The display name portion is shown in Discord's webhook UI without the bracket noise.
- **Collision-safe**: The `[Matrix|...]` prefix is unlikely to appear in a real Discord username.
- **Extensible**: Future bridges follow the same pattern (`[IRC|user@host] Nick`) without changing any parsing logic.
