---
title: "Server Moderation"
sidebar:
  order: 2
---

TomoriBot gives server admins controls over how she behaves in your server — who can use her,
where, and how much she costs — through the `/server` commands. Most require the **Manage
Server** permission. This page covers the highlights; every command is in the
[Command Reference](/features/command-reference/).

## Cost Control: Quotas

Generation costs money (yours or your members'). Quotas cap usage per user and server-wide:

- `/moderation` → **Quotas**: configure daily per-user limits and resetting server-wide pools for text, image, and video generation.
- `/server quota reset`: manually reset a user or server pool.

Set a per-user limit to `0` for unlimited. Server-wide pools reset on a configurable day
interval.

## User BYOK (Bring Your Own Key)

`/server user-byok toggle` requires each member to bring their **own** personal provider for
their triggers — the server pays for nothing on user-initiated messages. Server-initiated
triggers still use the server provider. This is the strongest cost control: it shifts API
spend entirely to members. Members set theirs up under
[Personalization → Your Own Providers](/features/knowledge/personalization/#your-own-providers).

You can also bootstrap a server with **no** server-side text provider at all by choosing
"User BYOK" during `/setup`.

## Access Control: Whitelists

- `/moderation` → **Whitelist** → **Channels** — choose triggering channels and optional cooldown overrides.
- `/moderation` → **Whitelist** → **Personas** — limit which channels a specific persona can trigger in.
- `/moderation` → **Whitelist** → **Roles** — restrict triggering to specific roles.
- `/server cooldown` (or `/config cooldown`) — set the global cooldown between responses.

Whitelisted channels inherit the global cooldown unless you set a channel-specific override.

## Learning & Privacy Controls

- `/server memberpermissions` — control who can teach her things.
- `/server blacklist` — prevent her from learning from or using memories about specific users.
- `/server private-channels` — mark channels where short-term memory is isolated and thought
  logs are suppressed.

## Transparency: Thought Logs

`/server thought-logs` sets a channel where her internal reasoning and successful tool calls
are posted — useful for auditing what she's doing (including which trigger exposed a tool in
[Deliberate Tool Mode](/features/capabilities/tools-and-extensions/#deliberate-tool-mode)).

## Welcome Greetings

`/server welcome-channel set` configures an automated greeting for new members in a chosen
channel. By default, Tomori waits one minute before greeting them so server onboarding can
finish. Instance operators can tune this grace period with `WELCOME_DELAY_MS`. Use
`/server welcome-channel remove` to stop greetings.

## Expressions

`/expressions initialize` registers your server's custom emojis and stickers so she
uses them accurately — recommended right after setup. For what she does with them (natural
`:emoji:` use, stickers, reactions), see
[Expressions & Reactions](/features/chatting-personality/chatting-and-triggers/#expressions--reactions).
