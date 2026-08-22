---
title: "Testing DB Changes"
---

This guide covers the DB regression harness introduced in Phase 2 (#4a). The harness protects the data-access layer during the repository migration (#4b) and any future DB-touching work.

## TL;DR

```bash
# Run all tests — DB tests run automatically when Postgres is reachable
bun run test
```

No manual database creation is required. `bun run test` detects a local Postgres connection, creates a disposable `tomoribot_test_<id>` database, runs the full test suite against it, and drops the database on exit.

## How automatic provisioning works

`bun run test` invokes `scripts/checks/runTests.ts`, which:

1. Looks for Postgres credentials in `POSTGRES_PASSWORD`, `DATABASE_URL`, or `POSTGRES_URL`.
2. If credentials exist, probes the connection (5-second timeout).
3. On success, creates a disposable `tomoribot_test_<id>` database via the `postgres` maintenance database.
4. Discovers every `tests/**/*.test.ts` file, groups them into **lanes** (see below), and runs the lanes concurrently with `TEST_DB_READY=1` and `POSTGRES_DB=<name>` injected into each child environment.
5. Drops the database on clean exit, `SIGINT` (Ctrl+C), or `SIGTERM`.

If no Postgres credentials are found or the connection probe fails, the files still run — DB regression tests skip gracefully and unit tests still pass.

### How files are grouped into lanes

A **batch** is one `bun test` process covering one or more files. A **lane** is an ordered list of batches: batches within a lane run sequentially, and lanes run concurrently.

| Lane | Contents | Batching |
|---|---|---|
| `unit` | `tests/unit/` files that do not call `mock.module()` | one batch for all of them |
| `unit-isolated` | `tests/unit/` files that call `mock.module()` | one batch per file |
| `db` | everything under `tests/regression/` | one batch for all non-mock files, plus one batch per mock-using file |

**Why mock users are isolated.** Bun applies `mock.module()` process-wide and does not restore it between files. A test that stubs a shared module (e.g. the `@/utils/db/repositories` barrel) corrupts every file loaded *later in the same process*, producing ordering-dependent `X is not a function` / `Export named X not found` failures that shift between suites as the file set changes. That hazard is confined to a single process, so the rule required is "no two mock-using files share a process" — not "no two files ever share a process". Mock users are detected by inspecting each file's source for `mock.module`, so a newly-added one isolates itself automatically rather than silently corrupting its neighbours.

**Why regression files stay in one lane.** The DB regression suites share a single disposable database with fixed-id fixtures, so running them concurrently with each other would collide on the same rows. They are safe to overlap with the unit lanes, which touch no database. Input order is preserved within every lane, so batching never reorders fixture interactions relative to a sequential run.

**Why the bootstrap is memoized.** `setupTestDb()` in `tests/regression/db/setup/testDb.ts` runs `initializeDatabase()`, which replays the schema, migrations and seed catalogs — roughly two seconds. Because one process now covers every regression file, the bootstrap is memoized for the lifetime of that process rather than repeating once per `beforeAll`.

Output is buffered per lane and replayed in a fixed order (`unit`, `unit-isolated`, `db`) once every lane settles, because interleaved output from concurrent processes is unreadable.

### Rules when adding a test

Batching is fast because files share processes, which costs two guarantees the old one-process-per-file runner gave for free. Both are enforced by `tests/unit/checks/testIsolationHygiene.test.ts`, so breaking one fails `bun run vl` with the offending file named — you do not need to remember them:

1. **Database-touching tests go under `tests/regression/`, never `tests/unit/`.** The unit lanes run concurrently with the DB lane, so a unit-lane test reaching the fixture database would race it on the same fixed-id rows.
2. **Restore any process-wide state you mutate, in `afterEach` or `afterAll`.** `setSystemTime()`, `globalThis.x = …` and `process.env.X = …` all persist for the life of the process, so leaving one set changes behaviour for every other file in the batch — and the failure appears in *that* file, not yours.

Files that call `mock.module()` are exempt from rule 2: they already get a private process, so nothing they mutate can escape it.

The detectors are shared with the runner via `scripts/checks/lib/testIsolation.ts`, so the harness and the guard can never disagree about what counts as isolated.

When `BUN_TEST_JUNIT_OUTFILE` is set (the `vl` checklist sets it), each *batch* writes its own JUnit file and the runner merges them into the requested path. A multi-file batch still emits one file-level `<testsuite>` per file, so per-file reporting is preserved regardless of how files are grouped.

## Minimum setup

The only required environment variable is `POSTGRES_PASSWORD` (or a full `DATABASE_URL`). All other variables default to local Postgres:

| Variable | Default |
|---|---|
| `POSTGRES_PASSWORD` | *required* |
| `POSTGRES_HOST` | `localhost` |
| `POSTGRES_PORT` | `5432` |
| `POSTGRES_USER` | `postgres` |
| `POSTGRES_MAINTENANCE_DB` | `postgres` |

A minimal `.env` for contributors:

```dotenv
POSTGRES_PASSWORD=your_local_postgres_password
```

## Running tests

```bash
# Run all tests (DB tests provisioned automatically when Postgres is reachable)
bun run test

# Run a single domain without the wrapper (requires TEST_DB_READY=1)
TEST_DB_READY=1 POSTGRES_DB=<existing-db> POSTGRES_PASSWORD=<pw> bun test tests/regression/db/persona.regression.test.ts

# Run only unit tests (no DB needed)
bun test tests/unit/
```

## How DB_TESTS_AVAILABLE works

`tests/regression/db/setup/testDb.ts` exports `DB_TESTS_AVAILABLE`, which is true only when:

- `POSTGRES_PASSWORD` (or `TEST_POSTGRES_PASSWORD`) is set, **and**
- `TEST_DB_READY=1` is present in the environment.

`TEST_DB_READY=1` is set exclusively by `runTests.ts` after it has successfully created and verified the disposable database. This prevents the harness from running against a development or production database if `bun test tests/regression/db/` is invoked directly.

All DB regression `describe` blocks call `describe.skipIf(!DB_TESTS_AVAILABLE)` so they skip cleanly instead of failing when run without the wrapper.

## Test file map

| File | Domain | Functions covered |
|---|---|---|
| `user.regression.test.ts` | UserRepository | `loadUserRow`, `registerUser`, `setPrivacyLevel`, `updateUser` |
| `persona.regression.test.ts` | PersonaRepository | `loadTomoriState`, `loadAllPersonasForServer`, `loadPersonaConfigRow`, `updateTomori` |
| `memory.regression.test.ts` | ServerMemory + PersonalMemory | `addServerMemoryByTomori`, `addPersonalMemoryByTomori`, `loadPersonalMemoriesForUserLineage` |
| `config.regression.test.ts` | ConfigRepository | `loadTomoriState` (config portion), split config updates, `updateCapabilitiesAndMemberPermissionsConfig` |
| `llm.regression.test.ts` | LlmRepository | `loadAvailableLlms`, `loadLlmById`, `getLlmsByIds`, `loadSmartestModel`, `loadUniqueProviders` |
| `server.regression.test.ts` | ServerRepository | `isBlacklisted`, blacklist write/clear cycle |
| `tool-rag.regression.test.ts` | ToolRepository + RagRepository | `getBraveApiKeyStatus`, guild MCP config read, `detectRagAvailability` |
| `cache-invalidation.regression.test.ts` | All caches | write → invalidate → re-read cycle for user cache and tomori state cache |

## Fixture data

The harness inserts minimal rows using the `_rt_` prefix (regression test) for all fixture Discord IDs:

| Fixture | Discord ID / value |
|---|---|
| Test server | `_rt_server_001` |
| Test user | `_rt_user_001` |
| Registration write test user | `_rt_user_reg_001` |
| Personal memory test user | `_rt_user_alt_001` |

Fixtures are inserted in `beforeAll` and cleaned up in `afterAll` via cascade deletes. Because the wrapper creates a fresh disposable database per run, each test run starts from a clean schema.

## Adding coverage for new functions

1. Find the domain file for the function (e.g., a new LLM write → `llm.regression.test.ts`).
2. Add a `it(...)` block that calls the function against the fixture data.
3. Assert on the return value, not just that it doesn't throw.
4. If the function reads after a write, add a second `it` block that calls the read function and confirms it reflects the change.

If the function belongs to a new repository not yet covered, add a new `*.regression.test.ts` file following the existing pattern.

## Command config mapping contracts

Split-config commands should also have pure unit coverage when they translate UI choices into repository write patches. Use `tests/unit/commands/configCommandMappings.test.ts` for checkbox or dynamic mapping contracts such as `/capabilities manage` and `/moderation` Member Access.

Prefer extracting a typed write-plan helper from the command module over mocking Discord interactions. The unit test should assert both the repository method target and the table-owned patch shape, then DB regression tests should cover any mixed-table repository write that needs transaction protection.

## Verifying the harness catches regressions

Each test file has at least one `it.skip("[REGRESSION PROBE] ...")` block. To confirm the harness is catching real regressions:

1. Un-skip the probe test in the file you're modifying.
2. Introduce the described regression (e.g., add `WHERE 1=0` to the SELECT under test).
3. Run the file — the probe test must fail.
4. Revert the regression and re-run — the probe test must pass again.
5. Re-skip the probe test before committing.

## Rehearsing migrations against a production snapshot

The regression harness above runs against a *fresh* schema. Before shipping a release branch with many migrations, also rehearse them against a copy of **real production data** to catch issues that only surface against existing rows (orphaned references, backfill edge cases, data-pattern assumptions).

1. Restore a production snapshot into a scratch database. The target Postgres **must have `pgvector` available** — see the [pgvector prerequisite in the Safe Migration guide](safe-migration.md#prerequisite-the-pgvector-extension). Restore with `ON_ERROR_STOP=1` so any failure surfaces instead of silently dropping tables.
2. Point `POSTGRES_DB` at that scratch database and run the rehearsal:

   ```bash
   POSTGRES_DB=tomodb_prodrehearse POSTGRES_PASSWORD=<pw> \
     bun run scripts/db/rehearse-migration.ts
   ```

   This invokes the same `initializeDatabase` path the bot runs at boot (schema + seed + pending migrations), so a clean run means the same migrations will apply cleanly in production. The script refuses to run when `RUN_ENV=production`.
3. Run your own integrity queries against the result (orphan checks, row-count parity vs. the snapshot, and any backfill-specific assertions for the migrations under test).

## CI integration

CI sets `POSTGRES_PASSWORD` and `POSTGRES_HOST` in the job environment. `bun run test` detects the credentials, provisions a fresh disposable database per run, and drops it after tests complete — no static `tomodb_test` database or manual CI setup is required.

See `.github/workflows/validation.yml` for the current service container and env configuration.

## Safety guards

- The wrapper only creates/drops databases on local hosts (`localhost`, `127.0.0.1`, `::1`, `postgres`, `tomoribot-db`, `host.docker.internal`). Set `TOMORI_TESTS_ALLOW_NONLOCAL_DB=true` to override for a disposable remote instance.
- `RUN_ENV=production` causes the wrapper to abort immediately.
- If Postgres is unreachable (connection probe times out in 5 s), the wrapper falls back to skip mode — tests run without DB, 89 DB tests skip.
