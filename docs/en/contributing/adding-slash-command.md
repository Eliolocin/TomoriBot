---
title: "Adding a Slash Command"
---

This guide walks through the full process of creating a new slash command in TomoriBot.

## Steps

1. Create the file in the correct path:
   - `src/commands/{command}.ts` for root commands
   - `src/commands/{category}/{subcommand}.ts`
   - or `src/commands/{category}/{group}/{subcommand}.ts` for sub-group commands

2. Export the required entry points:
   - `configureCommand(command)` for root commands, or `configureSubcommand(subcommand)` for category commands — registers the command metadata (name, description, options)
   - `execute(client, interaction, userData, locale)` — the runtime handler

3. Use `localizer("en-US", ...)` for command description and options so the loader can auto-register locale strings.

4. Add locale keys to both locales. Command keys live in `src/locales/{locale}/commands/{category}.ts`. Other key types live in the matching top-level file (`general.ts`, `tools.ts`, etc.) under `src/locales/{locale}/`.
   - Option descriptions: `{option_name}_description`
   - Choice labels: `{choice_value}_option`
   - Do NOT use `{option_name}_option` for option descriptions — it silently fails auto-localization.

5. Respect the 3-second interaction timing rule:
   - Fast commands can call `reply()` immediately.
   - Async/heavy commands must call `deferReply()` before any await.
   - Modal and pagination helpers must NOT be pre-deferred — they handle acknowledgement internally.
   - For full timing patterns and representative command groups, see [`docs/en/architecture/subsystems/command-system.md`](../subsystems/command-system).

6. The command auto-registers on next startup unless it exports
   `isCommandEnabled()` and that gate returns `false`. `commandLoader.ts`
   discovers any `.ts` file placed in the correct `src/commands/` path.

For production-only or feature-gated commands, export a gate:

```ts
export const isCommandEnabled = () =>
  process.env.RUN_ENV === "production" &&
  process.env.TOMORI_SUPPORTER_BILLING_ENABLED === "true";
```

Keep production-only side effects out of module imports. The loader must be able
to import the file safely even when the gate later skips registration.

## Quality Gate

```bash
bun run check-locales   # verify locale key parity
bun run check           # TypeScript strict mode
bun run lint            # Biome formatting
```

Then test the command end-to-end in Discord (slash shows up, options work, locale renders correctly).

## Naming Conventions

Command names should read like user-facing product language, not internal implementation names.

- Prefer explicit nouns for durable settings:
  - Good: `crosschannel-blocklist`
  - Weaker: `block-crossmsg-channels`
- Multi-word flat settings can use hyphenation when it improves clarity.
- Avoid abbreviations like `msg`, `cfg`, or `stm` unless they are already established user-facing terms.
- When a command edits a stored set, name it after the setting, not an action pair.
- Avoid shorthand that needs project context to decode.

When a command opens a modal showing the full saved set, name it after the setting itself (e.g. `/config` > Channels > Channel Rules). This fits better than separate `add` and `remove` flows because the user is managing one persisted list, not issuing a one-off mutation.

## Persistent Checklist Pattern

Use this pattern for durable settings where the best UX is "show me the whole set and let me tick what should be enabled."

**When to use it:**
- The setting is naturally a set of channels, roles, notice types, or similar entries.
- Users usually think in terms of reviewing the whole configuration, not adding one item at a time.
- The saved state should be obvious on reopen.

**Behavior:**
- One command owns the full saved set.
- The modal opens with every currently-enabled item pre-checked.
- Submitting writes the full checked set back to the database.

**Pagination rule:** If the option set fits in one modal (`<= 50` items), open the checkbox modal directly. If it exceeds one modal, show a page-selection message first; each page modal should preload saved state for just that page.

**Status rule:** If the command changes durable config, add that state to `/status` so the current configuration is visible without reopening the command.

**Reference surface:** the roleplay, private, and cross-channel blocklist checklists on `/config` > Channels > Channel Rules.

## Migration Reference

Current commands that define or inspire the v2 design direction:

| Command | Pattern | Notes |
|---|---|---|
| `/config` > Channels > Channel Rules | Checklist-setting template | Single persistent command, hyphenated flat name, saved state mirrored in `/status`. Blocking a forum/media parent also blocks tool-driven visits into threads under it. |
| `/config` > Channels > Channel Rules | Checklist-setting for a durable channel set | Single persistent command with saved-state preload and paginated fallback. |
| `/config` > Channels > Channel Rules | Checklist-setting for a durable channel set | Companion example alongside `private-channels`. |

## Related Docs

- [`docs/en/architecture/subsystems/command-system.md`](../subsystems/command-system) — interaction timing rules, pagination helpers, modal patterns
- [`docs/en/architecture/subsystems/localization.md`](../subsystems/localization) — key naming conventions, `localizer()` API
