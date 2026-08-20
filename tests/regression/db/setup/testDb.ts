/**
 * Test database configuration for the DB regression harness.
 *
 * DB tests are enabled automatically when `bun run test` detects a reachable
 * local Postgres instance and provisions a disposable database. The wrapper
 * (scripts/checks/runTests.ts) sets TEST_DB_READY=1 and POSTGRES_DB to
 * the disposable database name before spawning bun test.
 *
 * To run only DB regression tests (assumes wrapper has provisioned the DB):
 *   bun run test
 *
 * To target a specific pre-existing database manually:
 *   TEST_DB_READY=1 POSTGRES_DB=<name> POSTGRES_PASSWORD=<pw> bun test tests/regression/db/
 */
import { SQL } from "bun";
import { initializeDatabase } from "@/utils/db/initializeDatabase";
import { keyManager } from "@/utils/security/keyManager";

const effectiveHost = process.env.TEST_POSTGRES_HOST ?? process.env.POSTGRES_HOST ?? "localhost";
const effectivePort = process.env.TEST_POSTGRES_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const effectiveUser = process.env.TEST_POSTGRES_USER ?? process.env.POSTGRES_USER ?? "postgres";
const effectivePassword = process.env.TEST_POSTGRES_PASSWORD ?? process.env.POSTGRES_PASSWORD;
const effectiveDatabase = process.env.POSTGRES_DB ?? "tomodb";

// Keep the application singleton DB client pointed at the same test database as
// the direct fixture client below. dbRead/dbWrite import the singleton lazily, so
// setting these at module load is early enough for the harness.
process.env.POSTGRES_HOST = effectiveHost;
process.env.POSTGRES_PORT = effectivePort;
process.env.POSTGRES_USER = effectiveUser;
process.env.POSTGRES_DB = effectiveDatabase;
if (effectivePassword) process.env.POSTGRES_PASSWORD = effectivePassword;

/**
 * True when the runTests.ts wrapper has provisioned a disposable database for
 * this run (TEST_DB_READY=1) and credentials are present. Prevents the harness
 * from writing fixture data into a development or production database when
 * tests are invoked directly without the wrapper.
 */
export const DB_TESTS_AVAILABLE = Boolean(effectivePassword) && process.env.TEST_DB_READY === "1";

/**
 * A direct SQL client for the test database, used exclusively for fixture
 * insertion and cleanup. Test assertions call the real dbRead/dbWrite functions
 * which use the global sql singleton from client.ts, so those must also be pointed
 * at the test DB via POSTGRES_DB env var (set by the wrapper).
 */
export const testSql = new SQL({
  hostname: effectiveHost,
  port: Number(effectivePort),
  username: effectiveUser,
  password: effectivePassword ?? "dummy",
  database: effectiveDatabase,
});

/** Memoized bootstrap, shared by every `beforeAll` in the process. */
let bootstrapPromise: Promise<void> | null = null;

/**
 * Bootstraps the test database schema (idempotent).
 * Uses the same initializeDatabase() path as the bot, so schema drift
 * between tests and production is structurally impossible.
 *
 * initializeDatabase() is idempotent, but replaying the schema, migrations and
 * seed catalogs costs roughly two seconds per call. The runner now covers every
 * regression file with a single process, so the bootstrap is memoized for the
 * lifetime of that process instead of repeating once per `beforeAll`. The call
 * is argument-invariant, so no cache key is needed.
 */
export async function setupTestDb(): Promise<void> {
  bootstrapPromise ??= bootstrap();
  await bootstrapPromise;
}

/**
 * Repository writes that encrypt a credential read the key manager singleton, which the bot
 * populates during secret loading rather than lazily. Without this the harness leaves it at
 * version 0 and every such insert fails inside its own catch, surfacing as a null row instead
 * of an error. The fallback keeps the suite runnable on a machine that has Postgres but no
 * CRYPTO_SECRET; it is a disposable test value and never reaches a real database.
 */
async function bootstrap(): Promise<void> {
  process.env.CRYPTO_SECRET ??= "tomoribot_regression_harness_crypto_secret";
  keyManager.initialize();
  await initializeDatabase({ client: testSql, includeRag: false });
}
