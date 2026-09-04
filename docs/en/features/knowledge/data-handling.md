---
title: "Data Handling"
sidebar:
  order: 4
---

TomoriBot is built to be transparent about your data. You can export, import, or delete
everything she stores, and this page spells out exactly what that is. For the legal text,
see `/legal privacy` and `/legal terms`.

:::note
This page covers the in-Discord, per-user controls. **Self-hosting your own instance?**
Whole-database backups and restores are a host-side operation — see
[Maintenance & Backups](/self-hosting/maintenance/).
:::

## What She Stores

**Stored:**

- Server and personal memories
- Her settings and persona data
- Server configuration
- Encrypted API keys

**Not stored:**

- Your Discord messages
- Chat history

**Sent to your AI provider:** whenever she's triggered, she fetches the **latest messages**
in the channel plus any **relevant memories** as context for the model. She does not monitor
or read messages outside of those triggers.

:::note
Your chosen AI provider (Google, OpenRouter, NovelAI, …) processes messages under *their own*
privacy policies. Never share sensitive personal information with any AI.
:::

## Export Your Data

Everything exportable is sent to your DMs as a JSON file:

- `/memory personal export` — your personal memories (one persona scope, or your global scope).
- `/memory server export` — server memories for a selected persona.
- `/server config export` — server configuration values (no API keys or triggers).
- `/persona export` — full persona definitions.

## Import Your Data

Attach a previously exported file to restore it:

- `/memory personal import`, `/memory server import` — file type is auto-detected; you choose
  a target persona or global scope.
- `/server config import` — server imports require **Manage
  Server**.
- `/persona import` — restore a persona (also imports SillyTavern cards — see
  [SillyTavern Support](/features/integrations/sillytavern-support/)).

## Delete Your Data

These permanently remove or reset data — **they cannot be undone**:

- `/personal memories`, `/memories`
- `/server config remove` (reset server configuration)

## Opting Out

- `/personal config` — control your visibility to her, up to full invisibility (opt out of
  memory features entirely).
- `/config` > Permissions — server admins can turn off self-learning and other features.

See [Memory](/features/knowledge/memory/) for how memories work day to day.
