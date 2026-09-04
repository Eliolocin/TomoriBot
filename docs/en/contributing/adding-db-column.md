---
title: "Adding a DB Column"
---

This guide walks through adding a new column to an existing TomoriBot database table.

## Steps

1. Add an idempotent migration to `src/db/schema.sql`.
   Use `add_column_if_not_exists` or an `IF NOT EXISTS` guard so the migration is safe to re-run:

   ```sql
   SELECT add_column_if_not_exists('table_name', 'column_name', 'TEXT DEFAULT NULL');
   ```

2. Update the Zod schema and TypeScript types in `src/types/db/schema.ts` to include the new field.

3. Wire read/write usage in the relevant `src/utils/db/` module. Use Bun SQL template literals:

   ```ts
   const rows = await sql`SELECT column_name FROM table_name WHERE id = ${id}`;
   ```

   ⚠️ **If the column lives on a `server_*_configs` table and must be readable at runtime
   via `tomoriState.config`**, you MUST also add it to the config-assembly SELECTs in
   `src/utils/db/repositories/PersonaRepository.ts` (there are **two** — `loadTomoriState`
   and `loadAllForServer`, search for `scaps.tool_use_enabled`). These rows are validated
   with `assembledServerConfigSchema.safeParse(...)`. Because that schema gives each field a
   `.default(...)`, a column that's missing from the SELECT is **silently filled with its
   default** instead of erroring — so a runtime gate like `config.flag === false` will never
   fire and the feature appears not to work, with no type or test failure to flag it.
   Adding the column to the Zod schema and the `/config` > Permissions write path is NOT enough.

4. Invalidate any affected caches **after** successful writes — never before, never on failure.
   Keep the invalidation call in the same code path as the write:

   ```ts
   await sql`UPDATE table_name SET column_name = ${value} WHERE id = ${id}`;
   someCache.delete(cacheKey); // only reached if update didn't throw
   ```

## Quality Gate

```bash
bun run check    # TypeScript strict mode
bun run lint     # Biome formatting
bun run db:lifecycle  # full schema lifecycle test (requires local PostgreSQL)
```

`bun run db:lifecycle` creates and drops its own temporary database and runs fresh initialization plus backup/restore scripts. It requires a local disposable PostgreSQL target with CREATE/DROP database permission.

## Related Docs

- [`docs/en/architecture/subsystems/database-schema.md`](../subsystems/database-schema) — full schema reference and column index
- [`docs/en/architecture/subsystems/caching.md`](../subsystems/caching) — cache map and invalidation APIs
