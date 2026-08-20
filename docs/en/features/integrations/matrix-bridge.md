---
title: "Matrix Bridge"
sidebar:
  order: 1
---

TomoriBot can bridge a **Matrix room** to a Discord channel: people chat from Matrix, their
messages relay into Discord as webhook messages, and she replies back into the Matrix room.
This page is the user's side of the bridge. For the appservice internals, see the
[Matrix bridge architecture](/architecture/integrations/matrix/bridge/).

## Setup

1. Invite the configured Matrix bot account to an **unencrypted** Matrix room.
2. Copy that room's **Internal Room ID**.
3. Run `/matrix link` in the Discord channel you want to bridge, and paste the room
   ID.

After the bot accepts the invite, it posts a short reminder in the Matrix room — but you
still finish the link from Discord with `/matrix link`.

### Finding the Room ID

In most Matrix clients: **Room Settings → Advanced → Internal Room ID**. It looks like
`!abc:matrix.org`.

## Using It From Matrix

- Talk normally after the room is linked; Matrix messages relay into the Discord channel.
- She replies back into the Matrix room.
- The only Matrix text commands are `/kill` and `/refresh`.

## Current Limitations

- No slash commands from Matrix (beyond `/kill` and `/refresh`).
- No DMs or DM-based cooldown reminders.
- Matrix profile pictures aren't visible to her.
- Can't pin messages.
- Custom emojis and Markdown don't render reliably; embeds relay as plain text.
- Personal memories for Matrix users fall back to attributed server memories.

## Notes

- If the bot doesn't auto-join, invite the Matrix bot account manually and rerun
  `/matrix link`.
- **Matrix encryption can't be disabled later** — an encrypted room must be replaced with a
  fresh unencrypted one.
- If a limitation isn't listed above, assume it should work and report bugs in the support
  server (`/support discord`).

In `/help`, choose **Integrations**, then **Matrix**, for the same guide in Discord.
