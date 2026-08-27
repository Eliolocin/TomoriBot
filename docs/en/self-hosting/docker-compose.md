---
title: "Docker Compose"
sidebar:
  order: 3
---

Docker Compose builds and runs TomoriBot **plus** PostgreSQL as containers. It's the
third install path alongside the [setup wizard](/self-hosting/setup-wizard/) and
[manual setup](/self-hosting/manual-setup/) — pick it when you'd rather run everything in Docker than
install Bun and PostgreSQL on the host. It does **not** use the setup wizard; the database
connection is auto-configured for you.

:::caution[Host-side scripts still need host tooling]
Running the bot and database in Docker does not containerize the maintenance scripts.
`bun run backup`, `bun run restore-backup`, `bun run update`, `bun run rotate-keys`, and
friends still run through host Bun and the host PostgreSQL client tools. See
[Maintenance & Backups](/self-hosting/maintenance/) for the Compose-specific procedures.
:::

## 1. Get the code

```sh
git clone https://github.com/Bredrumb/TomoriBot.git
cd TomoriBot
```

## 2. Required `.env` values

Start from the example file:

```sh
cp .env.example .env
```

Then set at minimum:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your Discord bot token (enable the `GuildMembers`, `MessageContent`, and `GuildPresences` privileged intents). |
| `CRYPTO_SECRET` | A 32-character encryption key used to encrypt stored API keys. |
| `POSTGRES_PASSWORD` | The database password. Every other `POSTGRES_*` value is auto-configured. |

Unlike the setup wizard, Compose won't generate `CRYPTO_SECRET` for you — set it yourself
(any 32-character string). Optional tuning values can be copied from
`.env.optional.example`.

:::note[Database connection is automatic]
The Compose PostgreSQL service runs in development mode (no SSL) on the internal Docker
network, and the bundled image already has `pgvector` and `pg_cron` configured — so
document/RAG memory and scheduled cleanup work out of the box. Don't set `POSTGRES_HOST`,
`POSTGRES_PORT`, `POSTGRES_USER`, or `POSTGRES_DB` for Compose; they're managed for you.
:::

## 3. Build and run

```sh
docker compose build   # first time, or after code/dependency changes
docker compose up      # bot + database
```

For later starts, `docker compose up` alone is enough unless you changed code or
dependencies. When the bot is online, run `/config setup` in Discord to add your AI
provider key — see the [Quickstart](/introduction/quickstart/) for the in-Discord side.

## 4. Optional sidecars (Compose profiles)

Sidecars are opt-in via Compose profiles, so you only run what you need:

```sh
# SearXNG (private web search) + Crawl4AI (browser-rendered fetch)
docker compose --profile searxng --profile fetch-crawl4ai up
```

See [SearXNG](/self-hosting/local-endpoints/setup-searxng/), [Crawl4AI](/self-hosting/local-endpoints/setup-crawl4ai/),
and [Local Monitoring](/self-hosting/local-monitoring/) for per-sidecar details.

## Maintenance, updating & backups

Use `bun run update --docker` for the backup-first update procedure on a Compose
deployment. Backing up and restoring the Compose database (including running host scripts
against it) is covered on the [Maintenance & Backups](/self-hosting/maintenance/) page. Before pulling a
new version, start with [Safe Migration](/self-hosting/safe-migration/).
