---
title: "Age-Restricted Commands"
sidebar:
  order: 3
---

TomoriBot keeps its adult-only `/nsfw` command category behind Discord's built-in age gate,
hidden until you opt in. This page explains how to access it and where it works.

## Enabling Age-Restricted Commands

1. In Discord, open **User Settings → Privacy & Safety**.
2. Toggle on **Allow access to age-restricted commands in apps**. You must be 18 or older.
3. Age-restricted commands only run in channels marked **NSFW** (right-click a channel →
   **Edit Channel → toggle NSFW**; only server admins can mark channels NSFW).

If a command is restricted and the channel isn't marked NSFW, it simply won't appear.

## What's Gated

- **NSFW content settings** — `/nsfw jailbreaks` toggles workarounds for overly strict
  *provider-side* content filters (TomoriBot itself adds no safety rails of its own). See
  [Behavior Tweaking](/features/chatting-personality/behavior-tweaking/#uncensored-output).

Image and video generation are controlled separately by their configured provider and the
server's capability settings; they are not gated by the `/nsfw` command category.

Age-restricted content is for adult users only — use responsibly and follow Discord's
[Community Guidelines](https://discord.com/guidelines). In `/help`, choose **Behavior**, then **Age-Restricted Commands**, for the same
walkthrough in Discord.
