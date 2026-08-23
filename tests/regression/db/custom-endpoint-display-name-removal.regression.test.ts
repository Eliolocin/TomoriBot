import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { llmProviderRepo } from "@/utils/db/repositories";
import {
  ModalFieldId,
  buildCapabilityAddModalComponents,
  parseCapabilityModalFields,
} from "@/utils/provider/customEndpointCapabilityModal";
import { formatCustomModelDisplay } from "@/utils/provider/customProviderUtils";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

async function executeSqlFile(filePath: string): Promise<void> {
  const sqlText = await readFile(filePath, "utf-8");
  for (const stmt of splitSqlStatements(sqlText)) {
    await testSql.unsafe(stmt);
  }
}

const PROBE_SERVER = "_custom_endpoint_disp_name_server";
const PROBE_USER = "_custom_endpoint_disp_name_user";

describe.skipIf(!DB_TESTS_AVAILABLE)("Custom Endpoint display_name removal (Migration 069)", () => {
  let serverId: number;
  let userId: number;

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${PROBE_USER}`;

    const [server] = await testSql`
      INSERT INTO servers (server_disc_id) VALUES (${PROBE_SERVER}) RETURNING server_id`;
    serverId = server.server_id;

    const [user] = await testSql`
      INSERT INTO users (user_disc_id)
      VALUES (${PROBE_USER}) RETURNING user_id`;
    userId = user.user_id;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${PROBE_USER}`;
  });

  it("upserts and hydrates custom endpoint without display_name column in repository layer", async () => {
    const ep = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "rep-text",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://test.local:8000/v1",
      modelName: "test-model-1",
      requiresAuth: false,
    });

    expect(ep).not.toBeNull();
    expect(ep?.model_name).toBe("test-model-1");
    expect(ep?.label).toBe("rep-text");
    expect((ep as Record<string, unknown>).display_name).toBeUndefined();

    const loaded = await llmProviderRepo.loadCustomEndpoint({
      serverId,
      label: "rep-text",
      capability: "text",
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.model_name).toBe("test-model-1");
    expect((loaded as Record<string, unknown>).display_name).toBeUndefined();

    const formatted = formatCustomModelDisplay({
      label: ep?.label ?? "",
      model_name: ep?.model_name ?? null,
    });
    expect(formatted).toBe("test-model-1 (rep-text)");

    const personalEp = await llmProviderRepo.upsertCustomEndpoint({
      serverId: null,
      userId,
      label: "rep-personal",
      capability: "image",
      apiStyle: "comfyui",
      endpointUrl: "http://127.0.0.1:8188",
      modelName: "flux-1",
      requiresAuth: false,
    });
    expect(personalEp).not.toBeNull();
    expect(personalEp?.model_name).toBe("flux-1");
    expect((personalEp as Record<string, unknown>).display_name).toBeUndefined();

    const loadedPersonal = await llmProviderRepo.loadCustomEndpointsForUser(userId);
    const foundPersonal = loadedPersonal.find((e) => e.label === "rep-personal");
    expect(foundPersonal?.model_name).toBe("flux-1");
    expect((foundPersonal as Record<string, unknown>).display_name).toBeUndefined();
  });

  it("migration 069 backfills ComfyUI model_name from display_name via joined connection, leaves non-Comfy rows null, and restores deterministically on rollback", async () => {
    const downPath069 = path.join(
      process.cwd(),
      "src",
      "db",
      "migrations",
      "069_drop_custom_endpoint_display_name.down.sql",
    );
    const upPath069 = path.join(process.cwd(), "src", "db", "migrations", "069_drop_custom_endpoint_display_name.sql");

    await executeSqlFile(downPath069);

    try {
      const [comfyConn] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'comfy-probe', 'image', 'comfyui', 'http://127.0.0.1:8188', false
        ) RETURNING connection_id
      `;

      const [comfyEp] = await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (
          connection_id, model_name, display_name
        ) VALUES (
          ${comfyConn.connection_id}, NULL, 'sdxl-checkpoint.safetensors'
        ) RETURNING custom_endpoint_id
      `;

      const [comfyExistingEp] = await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (
          connection_id, model_name, display_name
        ) VALUES (
          ${comfyConn.connection_id}, 'explicit-model-name', 'Different Display Label'
        ) RETURNING custom_endpoint_id
      `;

      const [ttsConn] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'tts-probe', 'speech', 'tts-clone', 'http://127.0.0.1:8011', false
        ) RETURNING connection_id
      `;

      const [ttsEp] = await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (
          connection_id, model_name, display_name
        ) VALUES (
          ${ttsConn.connection_id}, NULL, 'Chatterbox TTS'
        ) RETURNING custom_endpoint_id
      `;

      await executeSqlFile(upPath069);

      const [comfyRow] = await testSql<[{ model_name: string | null }]>`
        SELECT model_name FROM custom_endpoints WHERE custom_endpoint_id = ${comfyEp.custom_endpoint_id}
      `;
      expect(comfyRow.model_name).toBe("sdxl-checkpoint.safetensors");

      const [comfyExistingRow] = await testSql<[{ model_name: string | null }]>`
        SELECT model_name FROM custom_endpoints WHERE custom_endpoint_id = ${comfyExistingEp.custom_endpoint_id}
      `;
      expect(comfyExistingRow.model_name).toBe("explicit-model-name");

      const [ttsRow] = await testSql<[{ model_name: string | null }]>`
        SELECT model_name FROM custom_endpoints WHERE custom_endpoint_id = ${ttsEp.custom_endpoint_id}
      `;
      expect(ttsRow.model_name).toBeNull();

      const [columnCheck] = await testSql<[{ count: string }]>`
        SELECT COUNT(*) AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'custom_endpoints'
          AND column_name = 'display_name'
      `;
      expect(Number(columnCheck.count)).toBe(0);

      await executeSqlFile(downPath069);

      const [comfyRestored] = await testSql<[{ display_name: string }]>`
        SELECT display_name FROM custom_endpoints WHERE custom_endpoint_id = ${comfyEp.custom_endpoint_id}
      `;
      expect(comfyRestored.display_name).toBe("sdxl-checkpoint.safetensors");

      const [ttsRestored] = await testSql<[{ display_name: string }]>`
        SELECT display_name FROM custom_endpoints WHERE custom_endpoint_id = ${ttsEp.custom_endpoint_id}
      `;
      expect(ttsRestored.display_name).toBe("tts-probe");
    } finally {
      await executeSqlFile(upPath069);
    }

    await executeSqlFile(upPath069);

    const [columnCheckAfterReplay] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'custom_endpoints'
        AND column_name = 'display_name'
    `;
    expect(Number(columnCheckAfterReplay.count)).toBe(0);
  });

  it("modal builder excludes display_name and requires model_name for text and embedding", () => {
    const textComponents = buildCapabilityAddModalComponents("text", "en-US");
    const textIds = textComponents.map((c) => c.customId);
    expect(textIds).toContain(ModalFieldId.model_name);
    expect(textIds).not.toContain("display_name");

    const textModelField = textComponents.find((c) => c.customId === ModalFieldId.model_name);
    expect(textModelField?.required).toBe(true);

    const embeddingComponents = buildCapabilityAddModalComponents("embedding", "en-US");
    const embeddingIds = embeddingComponents.map((c) => c.customId);
    expect(embeddingIds).toContain(ModalFieldId.model_name);
    expect(embeddingIds).not.toContain("display_name");

    const embeddingModelField = embeddingComponents.find((c) => c.customId === ModalFieldId.model_name);
    expect(embeddingModelField?.required).toBe(true);

    const speechComponents = buildCapabilityAddModalComponents("speech", "en-US");
    const speechIds = speechComponents.map((c) => c.customId);
    expect(speechIds).not.toContain("display_name");
    expect(speechIds).toContain(ModalFieldId.voice_mode);
    expect(speechIds).toContain(ModalFieldId.script_markup);

    const parsed = parseCapabilityModalFields(
      {
        [ModalFieldId.model_name]: "parsed-model",
      },
      {},
      "text",
    );
    expect(parsed.modelName).toBe("parsed-model");
    expect((parsed as Record<string, unknown>).displayName).toBeUndefined();
  });
});
