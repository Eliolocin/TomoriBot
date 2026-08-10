---
title: "Self-Hosting"
# Keyword-rich <title> targeting "self-host AI Discord bot" queries; replaces
# Starlight's default for this page only. H1 and sidebar keep the plain title.
head:
  - tag: title
    content: "TomoriBot | Self-Host a Free Open-Source AI Discord Bot"
# Hand-written search snippet; overrides the auto-derived description from
# routeData.ts middleware.
description: "Easily self-host a fully local and private AI Discord bot with KoboldCPP, ComfyUI, and more."
aiGenerated: false
sidebar:
  label: "Overview"
  groupLabel: "Self-Hosting"
  order: 3
---

<!-- STUB (Phase 1 structural). Phase 2 writes: requirements + module directory.
     Source for manual-setup.md: `git show HEAD:README.md` "Self-Hosting" section. -->

Start running your own TomoriBot instance through any of these install paths:

1. [`setup-wizard`](./setup-wizard) : guided `bun run setup` install
2. [`manual-setup`](./manual-setup) : the manual procedure, for technical users
3. [`docker-compose`](./docker-compose) : containerized bot + database, no host Bun/PostgreSQL

Optional modules (local LLMs, ComfyUI, SearXNG, Crawl4AI, local TTS/STT, ChatMock,
local MCP servers) each have their own page, see
[`local-endpoints`](./local-endpoints) for the full directory.

Once she's up and running, [`maintenance`](./maintenance) covers the host-side scripts, updating,
and backing up/restoring your database.
