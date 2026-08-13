/**
 * Regression harness: migration 063 fork naming-config backfill.
 *
 * Migration 062 gave every existing persona an empty naming config, including
 * personas already forked out of a preset pointer. 063 fills those in from the
 * catalog without disturbing pointers or configs an owner has since edited.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const MIGRATION_DIR = path.join(process.cwd(), "src", "db", "migrations");
const UP = path.join(MIGRATION_DIR, "063_fork_naming_config_backfill.sql");
const DOWN = path.join(MIGRATION_DIR, "063_fork_naming_config_backfill.down.sql");
const PROBE_SERVER = "_mig063_regression_probe";
const EDITED_PREFIXES = { neutral: "Chief" };

async function executeSqlFile(filePath: string): Promise<void> {
  const sqlText = await readFile(filePath, "utf-8");
  for (const stmt of splitSqlStatements(sqlText)) {
    await testSql.unsafe(stmt);
  }
}

interface NamingRow {
  prefixes: Record<string, string>;
  suffixes: Record<string, string>;
  address_terms: Record<string, string>;
}

async function readConfig(personaId: number): Promise<NamingRow> {
  const [row] = await testSql`
    SELECT prefixes, suffixes, address_terms FROM persona_naming_configs WHERE persona_id = ${personaId}`;
  return row as NamingRow;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Fork naming config backfill", () => {
  let forkId: number;
  let pointerId: number;
  let editedId: number;
  let presetConfig: { prefixes: object; suffixes: object; addressTerms: object };

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;

    // Any official pair carrying a non-empty catalog config proves the join; the
    // specific lineage is incidental, so the test does not pin one.
    const [preset] = await testSql`
      SELECT preset_lineage_id, preset_language, preset_naming_config
      FROM persona_presets
      WHERE preset_naming_config -> 'prefixes' <> '{}'::JSONB
         OR preset_naming_config -> 'suffixes' <> '{}'::JSONB
         OR preset_naming_config -> 'addressTerms' <> '{}'::JSONB
      ORDER BY preset_lineage_id
      LIMIT 1`;
    presetConfig = preset.preset_naming_config;

    const [server] = await testSql`
      INSERT INTO servers (server_disc_id) VALUES (${PROBE_SERVER}) RETURNING server_id`;

    let isAlter = false;
    const createPersona = async (nickname: string, isPointer: boolean): Promise<number> => {
      const [persona] = await testSql`
        INSERT INTO personas (
          server_id, persona_nickname, persona_lineage_id, is_alter, is_pointer, preset_lineage_id, preset_language
        ) VALUES (
          ${server.server_id}, ${nickname}, ${Math.floor(Math.random() * 1e8)}, ${isAlter}, ${isPointer},
          ${preset.preset_lineage_id}, ${preset.preset_language}
        ) RETURNING persona_id`;
      isAlter = true;
      await testSql`
        INSERT INTO persona_naming_configs (persona_id) VALUES (${persona.persona_id}) ON CONFLICT DO NOTHING`;
      return persona.persona_id;
    };

    forkId = await createPersona("_mig063_fork", false);
    pointerId = await createPersona("_mig063_pointer", true);
    editedId = await createPersona("_mig063_edited", false);
    // Bound as an object, not a JSON string: `${JSON.stringify(x)}::JSONB`
    // stores a JSONB scalar string rather than an object.
    await testSql`
      UPDATE persona_naming_configs SET prefixes = ${EDITED_PREFIXES} WHERE persona_id = ${editedId}`;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
  });

  it("fills a fork from its preset, leaves pointers and edited configs alone, and rolls back", async () => {
    await executeSqlFile(UP);

    const fork = await readConfig(forkId);
    expect(fork.prefixes).toEqual(presetConfig.prefixes);
    expect(fork.suffixes).toEqual(presetConfig.suffixes);
    expect(fork.address_terms).toEqual(presetConfig.addressTerms);

    // A live pointer holds no config of its own; it resolves the preset at load
    // time, so writing one here would create a second source of truth.
    const pointer = await readConfig(pointerId);
    expect(pointer.prefixes).toEqual({});
    expect(pointer.suffixes).toEqual({});
    expect(pointer.address_terms).toEqual({});

    const edited = await readConfig(editedId);
    expect(edited.prefixes).toEqual(EDITED_PREFIXES);

    await executeSqlFile(UP);
    expect(await readConfig(forkId)).toMatchObject({ address_terms: presetConfig.addressTerms });

    await executeSqlFile(DOWN);
    const rolledBack = await readConfig(forkId);
    expect(rolledBack.prefixes).toEqual({});
    expect(rolledBack.suffixes).toEqual({});
    expect(rolledBack.address_terms).toEqual({});
    expect((await readConfig(editedId)).prefixes).toEqual(EDITED_PREFIXES);
  });
});
