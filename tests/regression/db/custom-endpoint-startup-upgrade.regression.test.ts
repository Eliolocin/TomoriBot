import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { initializeDatabase } from "@/utils/db/initializeDatabase";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { encryptApiKey } from "@/utils/security/crypto";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

async function executeSqlFile(filePath: string): Promise<void> {
  const sqlText = await readFile(filePath, "utf-8");
  for (const statement of splitSqlStatements(sqlText)) {
    await testSql.unsafe(statement);
  }
}

const PROBE_SERVER = "_custom_endpoint_startup_upgrade_server";
const PROBE_USER = "_custom_endpoint_startup_upgrade_user";

describe.skipIf(!DB_TESTS_AVAILABLE)("Custom endpoint startup upgrade", () => {
  let serverId: number;
  let userId: number;

  const migrationsDir = path.join(process.cwd(), "src", "db", "migrations");
  const downPaths = [
    path.join(migrationsDir, "070_custom_endpoint_codename_and_keys.down.sql"),
    path.join(migrationsDir, "069_drop_custom_endpoint_display_name.down.sql"),
    path.join(migrationsDir, "068_custom_endpoint_connections.down.sql"),
  ];

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${PROBE_USER}`;

    const [server] = await testSql`
      INSERT INTO servers (server_disc_id) VALUES (${PROBE_SERVER}) RETURNING server_id`;
    serverId = server.server_id;

    const [user] = await testSql`
      INSERT INTO users (user_disc_id) VALUES (${PROBE_USER}) RETURNING user_id`;
    userId = user.user_id;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${PROBE_USER}`;
  });

  it("replays a pre-068 database through initializeDatabase and can start again", async () => {
    for (const downPath of downPaths) {
      await executeSqlFile(downPath);
    }

    await testSql`
      DELETE FROM schema_migrations
      WHERE name IN (
        '068_custom_endpoint_connections',
        '069_drop_custom_endpoint_display_name',
        '070_custom_endpoint_codename_and_keys'
      )
    `;

    const [legacyShape] = await testSql<[{ connection_table_exists: boolean; connection_column_exists: boolean }]>`
      SELECT
        to_regclass('public.custom_endpoint_connections') IS NOT NULL AS connection_table_exists,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'custom_endpoints'
            AND column_name = 'connection_id'
        ) AS connection_column_exists
    `;
    expect(legacyShape.connection_table_exists).toBe(false);
    expect(legacyShape.connection_column_exists).toBe(false);

    const oldProviderKey = `custom:s${serverId}:startup-label`;
    const [modelA] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, llm_description, is_free, is_scoped_registration)
      VALUES (${oldProviderKey}, 'legacy-startup-model-a', 'Legacy startup model A', false, true)
      RETURNING llm_id
    `;
    const [modelB] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, llm_description, is_free, is_scoped_registration)
      VALUES (${oldProviderKey}, 'legacy-startup-model-b', 'Legacy startup model B', false, true)
      RETURNING llm_id
    `;

    await testSql`
      INSERT INTO custom_endpoints (
        server_id,
        user_id,
        label,
        capability,
        api_style,
        endpoint_url,
        model_name,
        model_ref_id,
        display_name,
        requires_auth,
        is_default
      ) VALUES (
        ${serverId},
        NULL,
        'startup-label',
        'text',
        'openai-compatible',
        'http://startup-one.invalid/v1',
        'startup-model-a',
        ${modelA.llm_id},
        'startup-model-a',
        true,
        true
      )
    `;
    await testSql`
      INSERT INTO custom_endpoints (
        server_id,
        user_id,
        label,
        capability,
        api_style,
        endpoint_url,
        model_name,
        model_ref_id,
        display_name,
        requires_auth,
        is_default
      ) VALUES (
        ${serverId},
        NULL,
        'startup-label',
        'text',
        'openai-compatible',
        'http://startup-two.invalid/v1',
        'startup-model-b',
        ${modelB.llm_id},
        'startup-model-b',
        false,
        false
      )
    `;

    const encrypted = await encryptApiKey("legacy-startup-secret");
    await testSql`
      INSERT INTO saved_provider_configs (server_id, provider, api_key, key_version, llm_id)
      VALUES (${serverId}, ${oldProviderKey}, ${encrypted.encrypted}, ${encrypted.version}, ${modelA.llm_id})
    `;

    await testSql`
      INSERT INTO stat_counters (
        server_id,
        user_id,
        metric,
        metric_key,
        bucket,
        count,
        first_at,
        last_at
      ) VALUES (
        ${serverId},
        ${userId},
        'model_used',
        'legacy-startup-model-a',
        '2026-01-01',
        11,
        '2026-01-01 00:00:00+00',
        '2026-01-02 00:00:00+00'
      )
    `;

    await initializeDatabase({ client: testSql, includeRag: false, maxRetries: 1 });

    const upgradedRows: Array<{
      connection_id: number;
      label: string;
      endpoint_url: string;
      requires_auth: boolean;
      model_name: string;
      model_ref_id: number;
    }> = await testSql`
      SELECT
        cec.connection_id,
        cec.label,
        cec.endpoint_url,
        cec.requires_auth,
        ce.model_name,
        ce.model_ref_id
      FROM custom_endpoints ce
      JOIN custom_endpoint_connections cec ON cec.connection_id = ce.connection_id
      WHERE cec.server_id = ${serverId}
        AND cec.capability = 'text'
      ORDER BY cec.endpoint_url
    `;
    expect(upgradedRows).toHaveLength(2);
    expect(upgradedRows.map((row) => row.endpoint_url)).toEqual([
      "http://startup-one.invalid/v1",
      "http://startup-two.invalid/v1",
    ]);
    expect(upgradedRows.map((row) => row.label).sort()).toEqual(["startup-label", "startup-label_2"]);

    const modelAEndpoint = upgradedRows.find((row) => row.model_ref_id === modelA.llm_id);
    const modelBEndpoint = upgradedRows.find((row) => row.model_ref_id === modelB.llm_id);
    if (!modelAEndpoint || !modelBEndpoint) {
      throw new Error("Startup migration did not retain both legacy model references");
    }
    expect(modelAEndpoint.model_name).toBe("startup-model-a");
    expect(modelAEndpoint.requires_auth).toBe(true);
    expect(modelBEndpoint.model_name).toBe("startup-model-b");
    expect(modelBEndpoint.requires_auth).toBe(false);

    const [modelARow] = await testSql<[{ llm_provider: string; llm_codename: string }]>`
      SELECT llm_provider, llm_codename FROM llms WHERE llm_id = ${modelA.llm_id}
    `;
    expect(modelARow.llm_provider).toBe(`custom:${modelAEndpoint.connection_id}`);
    expect(modelARow.llm_codename).toBe("startup-model-a");

    const [modelBRow] = await testSql<[{ llm_provider: string; llm_codename: string }]>`
      SELECT llm_provider, llm_codename FROM llms WHERE llm_id = ${modelB.llm_id}
    `;
    expect(modelBRow.llm_provider).toBe(`custom:${modelBEndpoint.connection_id}`);
    expect(modelBRow.llm_codename).toBe("startup-model-b");

    const [savedConfig] = await testSql<[{ provider: string; api_key: Buffer; key_version: number }]>`
      SELECT provider, api_key, key_version
      FROM saved_provider_configs
      WHERE server_id = ${serverId}
        AND provider = ${`custom:${modelAEndpoint.connection_id}`}
    `;
    expect(savedConfig.provider).toBe(`custom:${modelAEndpoint.connection_id}`);
    expect(Buffer.compare(savedConfig.api_key, Buffer.from(encrypted.encrypted))).toBe(0);
    expect(savedConfig.key_version).toBe(encrypted.version);

    const [oldConfigCount] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM saved_provider_configs
      WHERE server_id = ${serverId} AND provider = ${oldProviderKey}
    `;
    expect(Number(oldConfigCount.count)).toBe(0);

    const [telemetry] = await testSql<[{ metric_key: string; count: string }]>`
      SELECT metric_key, count
      FROM stat_counters
      WHERE server_id = ${serverId} AND metric = 'model_used'
    `;
    expect(telemetry.metric_key).toBe("startup-model-a");
    expect(Number(telemetry.count)).toBe(11);

    const indexes = await testSql<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'idx_custom_endpoint_connections_server_unique'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain("(server_id, label, capability)");
    expect(indexes[0].indexdef).not.toContain("endpoint_url");

    await initializeDatabase({ client: testSql, includeRag: false, maxRetries: 1 });

    const rerunRows = await testSql`
      SELECT cec.label, cec.endpoint_url, cec.requires_auth, ce.model_name
      FROM custom_endpoints ce
      JOIN custom_endpoint_connections cec ON cec.connection_id = ce.connection_id
      WHERE cec.server_id = ${serverId}
        AND cec.capability = 'text'
      ORDER BY cec.endpoint_url
    `;
    expect(rerunRows).toEqual(
      upgradedRows.map(({ label, endpoint_url, requires_auth, model_name }) => ({
        label,
        endpoint_url,
        requires_auth,
        model_name,
      })),
    );
  });
});
