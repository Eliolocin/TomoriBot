---
title: "Chatting & Triggers"
sidebar:
  order: 1
---

TomoriBot only responds when something tells her to. This page covers the ways she can be
triggered, how to chat hands-free with auto-trigger, and how to stop accidental triggers
with Deliberate Trigger Mode.

## How to Trigger Her

By default, she replies when you:

- **Mention her** — `@TomoriBot`
- **Reply** to one of her messages (including a persona's webhook message)
- **Use a trigger word** — any plain word you've registered, said anywhere in a message
- **Use `/respond`** — manually prompt a reply

Trigger words are the most convenient path: once a word is registered, simply naming it
activates her. In a DM, just say hi — no trigger needed.

### Managing Trigger Words

- `/server trigger add` — add a custom trigger word (also works for alter personas, so a
  word can summon a specific character).
- `/server trigger remove` — remove a trigger word.

## Expressions & Reactions

Once she replies, she can use your server's custom emojis and stickers, and react to
messages:

- Custom emojis are used naturally in conversation with case-insensitive `:name:` syntax.
- Stickers can accompany replies; she can also add emoji reactions.
- Run `/expressions initialize` to register your server's emojis and stickers so she
  uses them accurately.

## Situational Awareness

Beyond the message text, she's handed a snapshot of the Discord context every time she
replies — so she can talk about *where* and *when* the conversation is happening, not just
what was said. This context includes:

- **Where she is** — the current server's name and description (or that it's a Direct
  Message), and the current channel.
- **The current time** — the server's local time and rough time of day, based on
  `/server timezone`, plus each person's own local time if they've set `/personal timezone`.
- **Who's in the conversation** — participants' display names, how to mention them, any
  physical-appearance tags, and their pending reminders.
- **What someone's up to (presence)** — a user's Discord activity: what they're **playing**,
  **streaming**, **listening to** (e.g. a Spotify track and artist), **watching**, or their
  custom status.

Presence is privacy-gated: it's only shared for users at the **Minimal** privacy level (the
default — see `/personal privacy`) and only when the bot has Discord's *Guild Presences*
intent enabled. Users who raise their privacy, or self-hosts running without that intent,
simply won't have their activity surfaced to her.

## Auto-Trigger (Hands-Free Chatting)

Auto-trigger lets her join the conversation without being named at all.

- `/server autotrigger channels` — set the channels where she responds without a mention.
- `/server autotrigger threshold` — set how many messages accumulate before she chimes in.
- `/config random-trigger add`: add a probabilistic timer-based auto-trigger to a channel.
- `/config random-trigger remove`: remove an existing random trigger.
- ~~`/natres` — humanlike timing for autonomous responses~~ to be implemented

Use this in a dedicated chat channel where you want her to feel like a participant rather
than a summoned assistant.

## Deliberate Trigger Mode

If people say a persona's name a lot in ordinary conversation, plain trigger words can fire
her by accident. **Deliberate Trigger Mode (DTM)** fixes this by making plain trigger words
stop counting as an explicit trigger.

When DTM is on:

- `@{trigger}` (the trigger word prefixed like a mention) still works
- Discord mentions still work
- Replies still work
- `/respond` still works
- **Plain trigger words no longer trigger her**

This forces deliberate invocation instead of accidental activation.

### Server and Personal Control

- `/server dtm` — server admins toggle the server-wide behavior.
- `/personal dtm` — each user overrides it for themselves, with three modes:
  - **off** — always allow plain trigger words
  - **follow** — use the server setting
  - **on** — always require deliberate invocation

In `/help`, choose **Behavior**, then **Deliberate Trigger Mode**, for the same summary in Discord.

:::note
Don't confuse **Deliberate Trigger Mode** (this page — controls *how she's triggered*) with
**Deliberate Tool Mode**, which controls *which tools are exposed to the model* on a given
turn. They share the "DTM" abbreviation but are unrelated. See
[Tools & Extensions](/features/capabilities/tools-and-extensions/#deliberate-tool-mode).
:::
