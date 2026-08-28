---
title: "Contributing"
sidebar:
  label: "Overview"
  groupLabel: "Contributing"
  order: 4
---

Step-by-step guides for contributing **code** to TomoriBot. These assume you have the
repository cloned and the source open — they extend or modify the bot itself.

Start with [`development-tasks.md`](./development-tasks) for the task index and coding
conventions, then jump to the guide for your task.

## Local Setup

- [`getting-started.md`](./getting-started) — set up TomoriBot locally with Bun + PostgreSQL for development
- [`docs-authoring.md`](./docs-authoring) — docs routes, frontmatter, sidebar, cards, and asset conventions

## Adding Things

- [`adding-slash-command.md`](./adding-slash-command)
- [`adding-event-handler.md`](./adding-event-handler)
- [`adding-builtin-tool.md`](./adding-builtin-tool)
- [`adding-feature-flag-tool.md`](./adding-feature-flag-tool)
- [`adding-setup-module.md`](./adding-setup-module)
- [`adding-db-column.md`](./adding-db-column)
- [`adding-new-provider.md`](./adding-new-provider)
- [`adding-locale.md`](./adding-locale)
- [`adding-persona-preset.md`](./adding-persona-preset)

## Testing Your Changes

- [`testing-db-changes.md`](./testing-db-changes)
- [`testing-chat-changes.md`](./testing-chat-changes)
- [`testing-module-mocks.md`](./testing-module-mocks)

## Conventions and Policies

- [`comment-policy.md`](./comment-policy) — durable comments and the advisory policy audit
- [`panel-prose-and-layout.md`](./panel-prose-and-layout) — text width, markers, and structure inside a panel
- [`raw-sql-boundary.md`](./raw-sql-boundary) — keeping raw SQL in the repository layer
- [`dependency-security-policy.md`](./dependency-security-policy) — overrides, patches, and audit exceptions
