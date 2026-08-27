---
title: "TomoriBot Docs Index"
---

The docs site is organized as an audience gradient: curious visitor → user → self-hoster
→ contributor → deep-diver. Sidebar order follows that gradient.

> **Restructure in progress.** Many `introduction/`, `features/`, and `self-hosting/`
> pages are Phase 1 stubs (frontmatter + placeholder). Prose lands in Phase 2 — see
> `plans/docs-site-restructure.md`.

## Introduction (order 1)

The marketing front door — what TomoriBot is and how to start using it.

- [`introduction/README.mdx`](./introduction/) — hero + feature-card deck (Phase 2)
- [`introduction/quickstart.md`](./introduction/quickstart) — invite the public instance or self-host

## Features (order 2)

Capability-oriented pages for people *using* TomoriBot. Category pages with sections;
a section graduates to its own file when it outgrows ~2-3 screens or gains its own setup flow.

Pages are bucketed into task-based sub-categories, each with a landing card-grid README.

- [`features/README.mdx`](./features/) — capability tour card grid
- **Chatting & Personality** — [`chatting-personality/`](./features/chatting-personality/)
  - [`chatting-and-triggers.md`](./features/chatting-personality/chatting-and-triggers/)
  - [`multiple-personas.md`](./features/chatting-personality/multiple-personas/)
  - [`behavior-tweaking.md`](./features/chatting-personality/behavior-tweaking/)
- **Knowledge** — [`knowledge/`](./features/knowledge/)
  - [`memory.md`](./features/knowledge/memory/)
  - [`inside-the-prompt.md`](./features/knowledge/inside-the-prompt/)
  - [`personalization.md`](./features/knowledge/personalization/)
  - [`data-handling.md`](./features/knowledge/data-handling/)
- **Capabilities** — [`capabilities/`](./features/capabilities/)
  - [`tools-and-extensions.md`](./features/capabilities/tools-and-extensions/)
  - [`scheduled-tasks.md`](./features/capabilities/scheduled-tasks/)
  - [`media-generation/`](./features/capabilities/media-generation/) — image, video, and voice generation
- **Setup & Administration** — [`setup-administration/`](./features/setup-administration/)
  - [`providers-and-models.md`](./features/setup-administration/providers-and-models/)
  - [`server-moderation.md`](./features/setup-administration/server-moderation/)
  - [`age-restricted-commands.md`](./features/setup-administration/age-restricted-commands/)
  - [`stats-and-insights.md`](./features/setup-administration/stats-and-insights/)
- **Integrations** — [`integrations/`](./features/integrations/)
  - [`matrix-bridge.md`](./features/integrations/matrix-bridge/)
  - [`sillytavern-support.md`](./features/integrations/sillytavern-support/)
- [`features/command-reference.md`](./features/command-reference/) — generated from command locales (Phase 3)

## Self-Hosting (order 3)

Running your own instance — core install plus every optional module. You don't need the
source open to follow these.

- [`self-hosting/README.md`](./self-hosting/) — requirements + module directory
- [`self-hosting/setup-wizard.md`](./self-hosting/setup-wizard) — guided `bun run setup`
- [`self-hosting/manual-setup.md`](./self-hosting/manual-setup) — manual procedure for technical users
- [`self-hosting/docker-compose.md`](./self-hosting/docker-compose) — containerized local bot + database
- [`self-hosting/local-endpoints/`](./self-hosting/local-endpoints/) — self-hosted endpoints hub
  - [`local-endpoints/setup-local-llm.md`](./self-hosting/local-endpoints/setup-local-llm)
  - [`local-endpoints/setup-comfyui.md`](./self-hosting/local-endpoints/setup-comfyui)
  - [`local-endpoints/setup-searxng.md`](./self-hosting/local-endpoints/setup-searxng)
  - [`local-endpoints/setup-crawl4ai.md`](./self-hosting/local-endpoints/setup-crawl4ai)
  - [`local-endpoints/setup-chatmock.md`](./self-hosting/local-endpoints/setup-chatmock)
  - [`local-endpoints/setup-local-mcp.md`](./self-hosting/local-endpoints/setup-local-mcp)
  - [`local-endpoints/text-to-speech/`](./self-hosting/local-endpoints/text-to-speech/) — local TTS engines
  - [`local-endpoints/speech-to-text/`](./self-hosting/local-endpoints/speech-to-text/) — local STT engines
- [`self-hosting/maintenance.md`](./self-hosting/maintenance) — maintenance scripts, updating, backups/restore
- [`self-hosting/safe-migration.md`](./self-hosting/safe-migration)
- [`self-hosting/local-monitoring.md`](./self-hosting/local-monitoring)

## Contributing (order 4)

Code-contribution guides — for extending or modifying the bot with the source open.
Start at [`contributing/development-tasks.md`](./contributing/development-tasks) for the
task index and coding conventions, and
[`contributing/getting-started.md`](./contributing/getting-started) for local dev setup.

Per-task guides:

- [`contributing/adding-slash-command.md`](./contributing/adding-slash-command)
- [`contributing/adding-event-handler.md`](./contributing/adding-event-handler)
- [`contributing/adding-builtin-tool.md`](./contributing/adding-builtin-tool)
- [`contributing/adding-feature-flag-tool.md`](./contributing/adding-feature-flag-tool)
- [`contributing/adding-setup-module.md`](./contributing/adding-setup-module)
- [`contributing/adding-db-column.md`](./contributing/adding-db-column)
- [`contributing/adding-new-provider.md`](./contributing/adding-new-provider)
- [`contributing/adding-locale.md`](./contributing/adding-locale)
- [`contributing/adding-persona-preset.md`](./contributing/adding-persona-preset)
- [`contributing/adding-participant-extension.md`](./contributing/adding-participant-extension)
- [`contributing/comment-policy.md`](./contributing/comment-policy) — durable comments and the advisory policy audit
- [`contributing/raw-sql-boundary.md`](./contributing/raw-sql-boundary) — keeping raw SQL in the repository layer
- [`contributing/docs-authoring.md`](./contributing/docs-authoring) — docs routes, frontmatter, sidebar, cards, and asset conventions
- [`contributing/dependency-security-policy.md`](./contributing/dependency-security-policy) — dependency overrides, patches, and audit exceptions

Testing your changes:

- [`contributing/testing-db-changes.md`](./contributing/testing-db-changes)
- [`contributing/testing-chat-changes.md`](./contributing/testing-chat-changes)
- [`contributing/testing-module-mocks.md`](./contributing/testing-module-mocks) — leak-safe Bun module mocks

## Architecture (order 5)

Code-level reference for deep-divers and plugin authors.

- [`architecture/README.md`](./architecture/) — code-level overview
- [`architecture/entry-point.md`](./architecture/entry-point) — startup and initialization flow

### Pipelines

Per-stage reference. Each folder has a `README.md` (overview + ASCII flow) and numbered stage files.

- [`architecture/pipelines/chat/`](./architecture/pipelines/chat/) — message ingress → per-turn execution
- [`architecture/pipelines/context-build/`](./architecture/pipelines/context-build/) — preset routing + native context assembly
- [`architecture/pipelines/tool-loop/`](./architecture/pipelines/tool-loop/) — tool-call dispatch loop
- [`architecture/pipelines/provider/`](./architecture/pipelines/provider/) — stream adapter → chunk normalization → Discord delivery
- [`architecture/pipelines/memory/`](./architecture/pipelines/memory/) — STM passive capture + LTM create/update/delete

### Subsystems

Supporting services that pipelines depend on.

- [`architecture/subsystems/`](./architecture/subsystems/) — database schema, events, commands, tools,
  caching, cooldowns, security, localization, multi-persona, persona-presets, and more

### Integrations

- [`architecture/integrations/`](./architecture/integrations/) — Discord platform, Matrix bridge,
  NovelAI, SillyTavern, and voice pipeline internals

### Cloud

Production infrastructure on cloud provider services (Azure, AWS, GCP).

These pages live on the `release` branch under `docs/en/wiki/cloud/`, next to the `terraform/` and
`deploy/` trees they document. A `main` checkout omits them so a self-hoster's clone carries only
the bot. Read one without switching branches:

```bash
git show release:docs/en/wiki/cloud/azure/azure-production-deployment.md
```

## Meet Tomori (order 6)

The persona gallery — a card deck introducing each of Tomori's "sisters" (the default
personas TomoriBot ships with). Card sources: `src/db/seed/catalog/personas/*`.

- [`meet-tomori/README.mdx`](./meet-tomori/) — hero + sister card deck (stub)
- [`meet-tomori/rose.md`](./meet-tomori/rose/) — Default Tomori, the eldest
- [`meet-tomori/zaya.md`](./meet-tomori/zaya/) — Prideful Tomori, the former esports champion
- [`meet-tomori/aphel.md`](./meet-tomori/aphel/) — Gloomy Tomori, the exhausted advisor
- [`meet-tomori/lilya.md`](./meet-tomori/lilya/) — Shy Tomori, the youngest
- [`meet-tomori/nerine.md`](./meet-tomori/nerine/) — Loyal Tomori, the discontinued model
- [`meet-tomori/locke.md`](./meet-tomori/locke/) — Unhinged Tomori, planned (replaces Temari)

## Wiki (hidden)

Reachable only via in-page links — not shown in the sidebar.

- [`wiki/refactor-record.md`](./wiki/refactor-record) — historical plugin-architecture-prerequisite refactor record
- [`wiki/threat-models.md`](./wiki/threat-models) — security threat models
