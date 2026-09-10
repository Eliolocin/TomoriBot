---
title: "Development Tasks"
---

Quick navigation for common TomoriBot implementation tasks and coding conventions.

## Task Index

Each guide below is self-contained with steps, notes, and a quality gate.

| Task | Guide |
|---|---|
| Add a slash command | [`adding-slash-command.md`](/contributing/adding-slash-command/) |
| Add an event handler | [`adding-event-handler.md`](/contributing/adding-event-handler/) |
| Add a built-in tool | [`adding-builtin-tool.md`](/contributing/adding-builtin-tool/) |
| Add a DB column | [`adding-db-column.md`](/contributing/adding-db-column/) |
| Add a Full Install setup module | [`adding-setup-module.md`](/contributing/adding-setup-module/) |
| Add a locale | [`adding-locale.md`](/contributing/adding-locale/) |
| Add a new AI provider | [`adding-new-provider.md`](/contributing/adding-new-provider/) |
| Add a feature flag-controlled tool | [`adding-feature-flag-tool.md`](/contributing/adding-feature-flag-tool/) |
| Add a persona preset | [`adding-persona-preset.md`](/contributing/adding-persona-preset/) |
| Add or move docs pages | [`docs-authoring.md`](/contributing/docs-authoring/) |
| Write or review code comments | [`comment-policy.md`](/contributing/comment-policy/) |

## Development Checklist

Run these before merging any change:

```bash
bun run check           # TypeScript strict mode
bun run lint            # Biome lint/format
bun run check-locales   # locale key parity (when locale keys or command metadata changed)
bun run db:lifecycle    # schema lifecycle test (when schema.sql changed; needs local PostgreSQL)
```

`bun run lint` applies fixes in place, so it can leave your working tree changed after it reports
success. Commit whatever it rewrites: CI runs `bun run lint:ci`, which is the same Biome check
without `--fix`, and that one fails on formatting instead of silently correcting it.

`bun run db:lifecycle` requires a local disposable PostgreSQL target with CREATE/DROP database
permission. It creates and drops its own temporary database, then tests fresh initialization plus
backup/restore and DB maintenance scripts.

To run selected regression files through the same disposable-database harness, pass their paths to
the test script:

```bash
bun run test tests/regression/db/llm.regression.test.ts
```

---

## Coding Conventions

These rules apply to all TomoriBot source code regardless of task type.

### Formatting and Style

- Use 2 spaces for indentation (Biome project setting).
- Use double quotes for strings.
- Write comments that explain rationale, constraints, or non-obvious behavior. See the
  [`comment policy`](./comment-policy).
- Run `bun run lint` after edits.

### TypeScript and Validation

- Keep TypeScript strict; avoid `any`.
- Prefer explicit shared types under `src/types/`.
- Use Zod/runtime validation for untrusted external input.
- Add concise JSDoc for exported/public functions when behavior is non-obvious.

### File Organization and Imports

- Use `camelCase` file names.
- Use `@/*` path aliases for `src/*` imports.
- Use `node:` protocol for Node built-ins (`node:path`, `node:fs`, etc.).

### Configuration and Magic Numbers

- Do not hardcode operational limits/timeouts/thresholds in feature logic.
- Use env vars with fallback defaults:

```ts
const VALUE = Number.parseInt(process.env.CONFIG_VAR || "10", 10);
```

- Add required setup vars to `.env.example` and optional/tuning vars to `.env.optional.example`,
  each with a clear comment.

### Database and Migrations

- Use Bun SQL template literals for queries.
- Keep schema migrations idempotent (`IF NOT EXISTS`, helper functions, guarded blocks).
- For DB model details, see [`docs/en/architecture/subsystems/database-schema.md`](../subsystems/database-schema).

### Cache-Safe Write Pattern

When a write affects cached reads:

1. Perform the DB write successfully.
2. Then invalidate affected cache key(s).

Do not invalidate before failed writes, and do not manually mutate cached objects.
See [`docs/en/architecture/subsystems/caching.md`](../subsystems/caching) for the cache map and invalidation APIs.

### Logging and Error Handling

- Use `log` from `src/utils/misc/logger.ts`.
- Include useful context metadata (`errorType`, IDs, action context).
- Treat startup-critical failures differently from recoverable runtime failures.

### Discord Command Rules

- Slash commands only (no legacy prefix command surface).
- All user-facing text must be localized via `localizer()`.
- Follow interaction timing patterns in [`docs/en/architecture/subsystems/command-system.md`](../subsystems/command-system).
