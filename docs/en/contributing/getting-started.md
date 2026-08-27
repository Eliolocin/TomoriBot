---
title: "Getting Started with TomoriBot Development"
sidebar:
  order: 2
---

This guide sets up TomoriBot locally with Bun + PostgreSQL.

## Prerequisites

- Bun
- PostgreSQL
- A Discord bot application with:
  - `bot` and `applications.commands` scopes
  - Privileged intents enabled in Discord Developer Portal:
    - `Server Members Intent`
    - `Message Content Intent`
  - `Presence Intent` is optional (used only outside production)

## 1. Install Dependencies

```bash
bun install --frozen-lockfile
```

## 2. Create Local Environment File

```bash
cp .env.example .env
```

`.env.example` is intentionally minimal and only includes the required local setup values.

Minimum required values for local development:

```dotenv
DISCORD_TOKEN=...
CRYPTO_SECRET=...
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_DB=tomodb
RUN_ENV=development
```

Notes:

- Runtime uses `RUN_ENV` (not `NODE_ENV`) for production/dev branching.
- In production mode (`RUN_ENV=production`), secrets are fetched from AWS Secrets Manager (`tomoribot/production`) unless `TEST_PRODUCTION=true`.
- Additional tuning and feature flags live in `.env.optional.example`. Copy only the values you actually want into `.env`.

## 3. Prepare PostgreSQL

Create a DB/user, then ensure `.env` credentials match.

## 4. Start the Bot

```bash
bun run dev
```

Expected startup stages include:

- secrets loading
- encryption key manager init
- schema + seed verification
- tool registry init
- locale init
- cache warmup
- event handler setup
- Discord login

## 5. First-Time Discord Setup

Run in your test server:

```text
/config setup
```

`/config setup` normally captures your initial provider credentials.

If you are testing a server that should start in member-funded mode, `/config setup` also exposes a `None (User BYOK)` option. That bootstraps the server with no server-side text provider and immediately enables member BYOK, so users must configure their own personal providers.

If you want to use only a self-hosted or proxy-backed custom endpoint, `/config setup` now also exposes `Custom Endpoint (finish after setup)`. That bootstraps the server without enabling BYOK, then you finish the provider setup with:

```text
/provider custom-endpoint add
```

The add command registers the endpoint and makes it the current model for the selected capability.
Later changes to that registration can be done in place with `/provider custom-endpoint edit`.

If you want to save and activate an additional provider afterward:

```text
/provider add
```

Then use `/model text` whenever you want to switch to another saved provider or model later.

Common saved providers:

- `provider:openrouter`
- `provider:novelai`

The old inline `custom` provider path is deprecated. Use `/provider custom-endpoint add` instead.

## Common Development Commands

```bash
bun run dev
bun run build
bun run start
bun run lint
bun run check
bun run check-runtime-imports
bun run vl
bun run nuke-db
bun run backup
bun run purge-commands
bun run check-locales
bun run check-limits
bun run check-media-size
bun run compress-media
```

`bun run check-runtime-imports` verifies that critical runtime dependencies load and that
`bun.lock` preserves their compatible transitive versions. It also runs as a fatal check in
`bun run vl` and CI.

`bun run check-media-size` (also bundled into `bun run vl`) rejects tracked media
over a per-file budget (default 1 MiB, set via `MEDIA_SIZE_LIMIT_BYTES`). It scans
`src/db/seed/catalog/personas/**` (Default Persona avatars/sprites that ship to
Discord) and `assets/img/**`.

`bun run compress-media` fixes offenders automatically: it re-encodes losslessly
(max deflate, metadata stripped — color stays Δ0) and only downscales a file when
lossless alone cannot reach the budget, capping the long edge at `MEDIA_MAX_DIMENSION`
(default 768px). Use `--dry-run` to preview, or pass a path substring to target one file.
Note: these PNGs are already near-optimally compressed, so lossless rarely fits 1 MiB on
its own — downscaling (invisible at Discord's <=128px avatar render size) is the trade.

`compress-media` also normalizes release cards under `.github/release/**` (not gate-scoped)
to WebP q`RELEASE_CARD_WEBP_QUALITY` (default 90) at full resolution, rewriting sibling
`release-notes.md` references. Already-WebP cards are skipped (re-encoding lossy WebP each
run would degrade it). That tree lives on the `release` branch only, so run this from a
`release` checkout. During deployment, the release workflow rewrites the card URL to the immutable
release tag and tags the deployed commit. After converting a card for an already-published release,
you must still update its published body (`gh release edit`).

## Quick Health Checks

- `/tool ping`
- `/tool status`
- Mention the bot or use trigger words in chat

## Troubleshooting

- Command registration issues: run `/tool refresh`
- Type errors: `bun run check`
- Formatting/lint: `bun run lint`
- Locales mismatch: `bun run check-locales`
