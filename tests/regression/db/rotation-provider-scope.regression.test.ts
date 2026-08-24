import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  addRotationKey,
  getRotationKeyCountForProvider,
  isRotationActiveForProvider,
  loadRotationKeysForProvider,
} from "@/utils/security/keyRotation";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const SERVER_DISC_ID = "_rotation_provider_scope_server";

async function executeMigration(name: string): Promise<void> {
  const sqlText = await readFile(path.join(process.cwd(), "src", "db", "migrations", name), "utf8");
  for (const statement of splitSqlStatements(sqlText)) await testSql.unsafe(statement);
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Provider-scoped key rotation (Migration C)", () => {
  let serverId: number;

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC_ID}`;
    const [server] = await testSql<[{ server_id: number }]>`
      INSERT INTO servers (server_disc_id) VALUES (${SERVER_DISC_ID}) RETURNING server_id
    `;
    serverId = Number(server.server_id);
  });

  afterAll(async () => {
    const [index] = await testSql<[{ definition: string | null }]>`
      SELECT pg_get_indexdef(to_regclass('idx_api_key_rotation_main_pointer')) AS definition
    `;
    if (!index.definition?.includes("server_id, provider")) {
      await executeMigration("072_scope_rotation_main_pointer_by_provider.sql");
    }
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC_ID}`;
  });

  it("creates independent provider pools and survives down, forward, and replay", async () => {
    expect(await addRotationKey(serverId, "google", "google-rotation-key-one")).toBe(true);
    expect(await addRotationKey(serverId, "openrouter", "openrouter-rotation-key-one")).toBe(true);

    expect(await getRotationKeyCountForProvider(serverId, "GOOGLE")).toBe(1);
    expect(await getRotationKeyCountForProvider(serverId, "openrouter")).toBe(1);
    expect(await isRotationActiveForProvider(serverId, "google")).toBe(true);
    expect(await isRotationActiveForProvider(serverId, "openrouter")).toBe(true);
    expect((await loadRotationKeysForProvider(serverId, "google")).map((row) => row.provider)).toEqual([
      "google",
      "google",
    ]);

    const [beforeDown] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM api_key_rotation
      WHERE server_id = ${serverId} AND is_main_key_pointer = true
    `;
    expect(Number(beforeDown.count)).toBe(2);

    await executeMigration("072_scope_rotation_main_pointer_by_provider.down.sql");
    const [legacyPointers] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM api_key_rotation
      WHERE server_id = ${serverId} AND is_main_key_pointer = true
    `;
    expect(Number(legacyPointers.count)).toBe(1);

    await executeMigration("072_scope_rotation_main_pointer_by_provider.sql");
    await executeMigration("072_scope_rotation_main_pointer_by_provider.sql");
    const [restoredPointers] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM api_key_rotation
      WHERE server_id = ${serverId} AND is_main_key_pointer = true
    `;
    const [index] = await testSql<[{ definition: string }]>`
      SELECT pg_get_indexdef('idx_api_key_rotation_main_pointer'::regclass) AS definition
    `;
    expect(Number(restoredPointers.count)).toBe(2);
    expect(index.definition).toContain("(server_id, provider)");
  }, 30_000);
});
