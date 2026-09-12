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

When the bot is online, run `/setup` in Discord to connect an AI provider. A workspace that holds no
provider of its own cannot reply, unless it runs in User BYOK mode where each member's personal
provider answers instead, so this is the last step of every install path.

## The `/setup` command

`/setup` opens an ephemeral checklist panel that only the person who ran it can operate. In a server
it requires **Manage Server**; in a DM it is available to that person's own workspace. Every row on
the panel is a draft value: **Finish Setup** is the only control that writes anything, so opening,
editing, cancelling, or restarting leaves every database row untouched.

| Step | Appears | What it collects |
|---|---|---|
| **Policies** | `RUN_ENV=production` only | Acceptance of the Terms of Service and Privacy Policy, both in one modal. |
| **AI Provider** | Every environment | How replies reach a model. One of the three access modes below. |
| **Starting Settings** | Every environment | Starting persona, reply style, timezone, and the workspace default system prompt. |

Every other `RUN_ENV` value renders the two-step layout and no policy copy at all. A deployment
running with `RUN_ENV=production` registers `/legal terms-of-service` and `/legal privacy-policy`
beside `/legal license`; every other value registers only `/legal license`.

### Provider access modes

- **AI Provider (Recommended)**: pick a provider from the catalog and paste its API key. The key is
  validated against the provider and encrypted into the draft; the panel shows only that a key is
  stored, never the key itself. Run `/help`, then **Setup** > **Step 1: Get an API Key** for the
  per-provider walkthrough.
- **Custom Endpoint (Advanced)**: a two-button sub-area for a self-hosted or proxy endpoint.
  **Configure Connection** collects the API compatibility, a label, the URL, and an optional auth
  token, and checks that the endpoint answers. **Configure Text Model** collects the model code, its
  context size, and its capability declarations, and stays disabled until a connection validates.
  Saving the connection again clears the model declaration, because the declarations depend on the
  chosen API compatibility. This is the same registration `/providers` performs, done inside the
  wizard, and it creates no rows before **Finish Setup**.
- **User BYOK** (guilds only, never in a DM): the workspace keeps no provider of its own and every
  member-triggered reply resolves a personal provider instead. Confirm it in the modal, then have
  members register theirs with `/personal providers`. See
  [Server Moderation](/features/setup-administration/server-moderation/#user-byok-bring-your-own-key).

### Starting settings

One four-row modal collects the persona, the reply style, the timezone offset, and the default system
prompt. The timezone is optional and defaults to UTC. The system prompt offers
**Built-in Default (Recommended)** plus every preset in the workspace catalog: the built-in choice
stores no prompt text at all, so it keeps tracking the shipped default, and a preset choice stores
that preset's text as it reads at commit time. Deleting a stored persona or prompt from the catalog
re-opens the step until another is chosen.

### Finishing and cancelling

**Finish Setup** stays disabled until every rendered step is complete. It revalidates the catalogs and
the workspace state, commits the whole draft in one transaction, and replaces the panel with the
receipt. **Cancel** discards the draft and expires every control on the panel.

A draft lives in the bot process, not in the database, so it ends only when it is cancelled,
completed, or the process restarts. At most `SETUP_DRAFT_MAX_ENTRIES` (default 200) drafts are held
at once; the oldest is discarded at the cap. It is documented in `.env.optional.example` under
**Setup wizard drafts**. A control for a session that is no longer available writes nothing.

## Updating

Use the backup-first updater command: `bun run update` 

This runs `bun run backup`, then
`git pull --rebase --autostash`, then `bun install --frozen-lockfile`. Add `--build` if you run from `dist/`,
or `--docker` for a Compose deployment. Full details on the
[Maintenance & Backups](/self-hosting/maintenance/) page.
