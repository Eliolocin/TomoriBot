---
title: "Setup Wizard"
aiGenerated: false
sidebar:
  label: "Setup Wizard"
  order: 1
---

:::note
Users who want to use Docker Compose should skip this wizard, see
[Docker Compose](/self-hosting/docker-compose/) for the containerized install path.
:::

`bun run setup` is the recommended self-host path for local Bun-based installs. It creates your `.env`, generates a `CRYPTO_SECRET`, asks for your Discord bot token, configures PostgreSQL, and installs the exact dependencies from `bun.lock` interactively, so just follow the prompts. It's safe
to re-run; existing `.env` values are kept unless you choose to reconfigure them.

## Get the code

```sh
git clone https://github.com/Bredrumb/TomoriBot.git
cd TomoriBot
```

## Choose a path

Once you run the command, you'll pick one of two paths:

```bash
bun run setup
```


| Path | Use When | What It Does |
|---|---|---|
| **Full Install** | You want the recommended setup with lightweight extras. | Runs Base Install, then attempts the four extras below. |
| **Base Install** | You want only the minimum working bot. | Creates/configures `.env`, Discord token, PostgreSQL, and dependencies. |



## What to have ready

- **[Bun](https://bun.sh/)** to run the bot and the wizard itself.
- **Node.js v20+** (used for MCP tooling).
- **A Discord bot token** with the `GuildMembers`, `MessageContent`, and `GuildPresences`
  privileged intents enabled.
- **A database.** TomoriBot stores everything in PostgreSQL. You don't set it up by hand as
  the wizard does it for you: it'll use PostgreSQL if you already have it installed, or run
  one for you in [Docker](https://www.docker.com/) if you don't. Just make sure one of the
  two is installed before you start.

:::caution
- **Bundled Docker PostgreSQL runs only the database in Docker.** The bot itself, startup
  backups, `bun run backup`, and `restore-backup` still run through host Bun and host
  PostgreSQL client tools. If you'd rather run everything in Docker, use
  [Docker Compose](/self-hosting/docker-compose/) instead.
:::

If `psql` is missing or provisioning fails, the wizard prints the SQL to run by hand. Either
way, TomoriBot initializes its schema, seeds, migrations, `pgcrypto`, and RAG schema
automatically on first startup.

## Full Install extras

Full Install runs Base Install first, then tries to install the extras below. If any fails, it
prints the command or guide to finish manually and keeps going:

| Extra | Purpose |
|---|---|
| `pgvector` | Vector search for document/RAG memory. |
| `pg_cron` | Optional scheduled cooldown/reminder-row cleanup. |
| Tokenizer assets | Local tokenizer assets for model-aware logit bias. |

To install any of these by hand, see the
[Manual Setup extras](/self-hosting/manual-setup/#optional-extras-the-manual-full-install).

## After setup

```bash
bun run dev                          # bot only
bun run launch --searxng --crawl4ai  # bot + sidecars (see bun run launch --help)
```

When the bot is online, run `/config setup` in Discord to add your AI provider key.

## Updating

Use the backup-first updater command: `bun run update` 

This runs `bun run backup`, then
`git pull --rebase --autostash`, then `bun install --frozen-lockfile`. Add `--build` if you run from `dist/`,
or `--docker` for a Compose deployment. Full details on the
[Maintenance & Backups](/self-hosting/maintenance/) page.
