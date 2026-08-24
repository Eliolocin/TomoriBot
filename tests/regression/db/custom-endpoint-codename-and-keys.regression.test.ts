import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmProviderRepo } from "@/utils/db/repositories";
import { getCustomProviderDisplayName } from "@/utils/provider/customProviderUtils";
import { DB_TESTS_AVAILABLE, executeTestSqlFile, setupTestDb, testSql } from "./setup/testDb";

const PROBE_SERVER = "_custom_endpoint_m070_server";
const PROBE_USER = "_custom_endpoint_m070_user";

describe.skipIf(!DB_TESTS_AVAILABLE)("Custom Endpoint codename and keys (Migration 070)", () => {
  let serverId: number;
  let userId: number;

  const upPath070 = path.join(process.cwd(), "src", "db", "migrations", "070_custom_endpoint_codename_and_keys.sql");
  const downPath070 = path.join(
    process.cwd(),
    "src",
    "db",
    "migrations",
    "070_custom_endpoint_codename_and_keys.down.sql",
  );
  const upPath073 = path.join(process.cwd(), "src", "db", "migrations", "073_unify_custom_endpoint_group_urls.sql");
  const downPath073 = path.join(
    process.cwd(),
    "src",
    "db",
    "migrations",
    "073_unify_custom_endpoint_group_urls.down.sql",
  );

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

  it("upserts connection and endpoint through repository with stable connection_id and ON CONFLICT update", async () => {
    const connId1 = await llmProviderRepo.upsertCustomEndpointConnection({
      serverId,
      userId: null,
      label: "repo-test",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://127.0.0.1:8000/v1",
      requiresAuth: true,
    });
    expect(connId1).not.toBeNull();

    // A tokenless sibling update must preserve the connection's authenticated state.
    const connId2 = await llmProviderRepo.upsertCustomEndpointConnection({
      serverId,
      userId: null,
      label: "repo-test",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://127.0.0.1:9000/v1",
      requiresAuth: false,
    });
    expect(connId2).toBe(connId1);

    const loadedConn = await llmProviderRepo.loadCustomEndpointConnectionById(connId1 as number);
    expect(loadedConn).not.toBeNull();
    expect(loadedConn?.endpoint_url).toBe("http://127.0.0.1:9000/v1");
    expect(loadedConn?.requires_auth).toBe(true);

    const providerKey = `custom:${connId1 as number}`;
    expect(getCustomProviderDisplayName(providerKey)).toBe("Custom Endpoint: repo-test");

    const ep1 = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      label: "repo-test",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://127.0.0.1:9000/v1",
      modelName: "llama-3-8b",
      requiresAuth: false,
    });
    expect(ep1).not.toBeNull();
    expect(ep1?.connection_id).toBe(connId1 as number);
    expect(ep1?.model_name).toBe("llama-3-8b");
    const afterEndpointUpsert = await llmProviderRepo.loadCustomEndpointConnectionById(connId1 as number);
    expect(afterEndpointUpsert?.requires_auth).toBe(true);

    const loadedByConn = await llmProviderRepo.loadCustomEndpointByConnection(connId1 as number, "text");
    expect(loadedByConn).not.toBeNull();
    expect(loadedByConn?.custom_endpoint_id).toBe(ep1?.custom_endpoint_id);

    const endpointsForConn = await llmProviderRepo.loadCustomEndpointsByConnectionId(connId1 as number);
    expect(endpointsForConn.length).toBe(1);
    expect(endpointsForConn[0].custom_endpoint_id).toBe(ep1?.custom_endpoint_id);

    const personalEndpoint = await llmProviderRepo.upsertCustomEndpoint({
      userId,
      label: "personal-test",
      capability: "image",
      apiStyle: "openai-compatible",
      endpointUrl: "http://127.0.0.1:9100/v1",
      modelName: "personal-image",
      requiresAuth: false,
    });
    expect(personalEndpoint).not.toBeNull();
    const personalProviderKey = `custom:${personalEndpoint?.connection_id as number}`;
    const personalEndpoints = await llmProviderRepo.loadCustomEndpointsForUser(userId);
    expect(personalEndpoints.some((endpoint) => endpoint.model_name === "personal-image")).toBe(true);
    expect(getCustomProviderDisplayName(personalProviderKey)).toBe("Custom Endpoint: personal-test");

    await testSql`
      UPDATE custom_endpoint_connections
      SET label = 'repo-test-renamed'
      WHERE connection_id = ${connId1 as number}
    `;
    const renamedConnection = await llmProviderRepo.loadCustomEndpointConnectionById(connId1 as number);
    expect(renamedConnection?.label).toBe("repo-test-renamed");
    expect(getCustomProviderDisplayName(providerKey)).toBe("Custom Endpoint: repo-test-renamed");
  });

  it("migration 070 migrates saved_provider_configs, model codenames, and telemetry, and rolls back cleanly", async () => {
    await executeTestSqlFile(downPath073);
    await executeTestSqlFile(downPath070);

    try {
      // Legacy keys are retained here to prove the migration can disambiguate them.
      const [connA] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'm070-label', 'text', 'openai-compatible', 'http://127.0.0.1:8001/v1', false
        ) RETURNING connection_id
      `;

      const [llmA] = await testSql<[{ llm_id: number }]>`
        INSERT INTO llms (
          llm_provider, llm_codename, llm_description, is_free, is_scoped_registration
        ) VALUES (
          'custom:s' || ${serverId} || ':m070-label', 'custom-s' || ${serverId} || '-m070-label-text-llama-3', 'Model A', false, true
        ) RETURNING llm_id
      `;

      await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (
          connection_id, model_name, model_ref_id, is_default
        ) VALUES (
          ${connA.connection_id}, 'llama-3', ${llmA.llm_id}, true
        ) RETURNING custom_endpoint_id
      `;

      const [connB] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'm070-label', 'text', 'openai-compatible', 'http://127.0.0.1:8002/v1', false
        ) RETURNING connection_id
      `;
      const [llmB] = await testSql<[{ llm_id: number }]>`
        INSERT INTO llms (llm_provider, llm_codename)
        VALUES (
          'custom:s' || ${serverId} || ':m070-label',
          'custom-s' || ${serverId} || '-m070-label-text-llama-3-alt'
        ) RETURNING llm_id
      `;
      await testSql`
        INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id, is_default)
        VALUES (${connB.connection_id}, 'llama-3-alt', ${llmB.llm_id}, false)
      `;

      const [embeddingConnection] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'm070-embedding', 'embedding', 'openai-compatible', 'http://127.0.0.1:8003/v1', false
        ) RETURNING connection_id
      `;
      const [embeddingModel] = await testSql<[{ embedding_model_id: number }]>`
        INSERT INTO embedding_models (provider, codename, model_family)
        VALUES (
          'custom:s' || ${serverId} || ':m070-embedding',
          'custom-s' || ${serverId} || '-m070-embedding-embedding-embed-v1',
          'custom:custom:s' || ${serverId} || ':m070-embedding'
        ) RETURNING embedding_model_id
      `;
      await testSql`
        INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id, is_default)
        VALUES (${embeddingConnection.connection_id}, 'embed-v1', ${embeddingModel.embedding_model_id}, true)
      `;

      const [imageConnection] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'm070-image', 'image', 'openai-compatible', 'http://127.0.0.1:8004/v1', false
        ) RETURNING connection_id
      `;
      const [imageModel] = await testSql<[{ diffusion_model_id: number }]>`
        INSERT INTO image_diffusion_models (provider, codename)
        VALUES (
          'custom:s' || ${serverId} || ':m070-image',
          'custom-s' || ${serverId} || '-m070-image-image-img-v1'
        ) RETURNING diffusion_model_id
      `;
      await testSql`
        INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id, is_default)
        VALUES (${imageConnection.connection_id}, 'img-v1', ${imageModel.diffusion_model_id}, true)
      `;

      const [videoConnection] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'm070-video', 'video', 'openai-compatible', 'http://127.0.0.1:8005/v1', false
        ) RETURNING connection_id
      `;
      const [videoModel] = await testSql<[{ video_model_id: number }]>`
        INSERT INTO video_generation_models (provider, codename)
        VALUES (
          'custom:s' || ${serverId} || ':m070-video',
          'custom-s' || ${serverId} || '-m070-video-video-vid-v1'
        ) RETURNING video_model_id
      `;
      await testSql`
        INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id, is_default)
        VALUES (${videoConnection.connection_id}, 'vid-v1', ${videoModel.video_model_id}, true)
      `;

      const [personalConnection] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          NULL, ${userId}, 'm070-personal', 'image', 'openai-compatible', 'http://127.0.0.1:8006/v1', true
        ) RETURNING connection_id
      `;
      const [personalImageModel] = await testSql<[{ diffusion_model_id: number }]>`
        INSERT INTO image_diffusion_models (provider, codename)
        VALUES (
          'custom:u' || ${userId} || ':m070-personal',
          'custom-u' || ${userId} || '-m070-personal-image-personal-v1'
        ) RETURNING diffusion_model_id
      `;
      await testSql`
        INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id, is_default)
        VALUES (${personalConnection.connection_id}, 'personal-v1', ${personalImageModel.diffusion_model_id}, true)
      `;

      await testSql`
        INSERT INTO user_saved_provider_configs (
          user_id, provider, api_key, key_version, diffusion_model_id
        ) VALUES (
          ${userId}, 'custom:u' || ${userId} || ':m070-personal', 'personal_encrypted_key', 9,
          ${personalImageModel.diffusion_model_id}
        )
      `;

      await testSql`
        INSERT INTO llms (llm_provider, llm_codename)
        VALUES ('custom:s' || ${serverId} || ':m070-label', 'unrelated-model')
      `;

      await testSql`
        INSERT INTO saved_provider_configs (
          server_id, provider, api_key, key_version, llm_id
        ) VALUES (
          ${serverId}, 'custom:s' || ${serverId} || ':m070-label', 'encrypted_key_placeholder', 1, ${llmA.llm_id}
        )
      `;

      const legacyCodename = `custom-s${serverId}-m070-label-text-llama-3`;
      await testSql`
        INSERT INTO stat_counters (
          server_id, user_id, metric, metric_key, bucket, count, first_at, last_at
        ) VALUES
          (${serverId}, ${userId}, 'model_used', ${legacyCodename}, '2026-01-01', 15, '2026-01-01 00:00:00+00', '2026-01-10 00:00:00+00'),
          (${serverId}, ${userId}, 'tokens_in', ${legacyCodename}, '2026-01-01', 1500, '2026-01-01 00:00:00+00', '2026-01-10 00:00:00+00'),
          (${serverId}, ${userId}, 'tokens_out', ${legacyCodename}, '2026-01-01', 3000, '2026-01-01 00:00:00+00', '2026-01-10 00:00:00+00')
      `;

      await testSql`
        INSERT INTO stat_counters (
          server_id, user_id, metric, metric_key, bucket, count, first_at, last_at
        ) VALUES
          (${serverId}, ${userId}, 'model_used', 'llama-3', '2026-01-01', 5, '2026-01-05 00:00:00+00', '2026-01-15 00:00:00+00'),
          (${serverId}, ${userId}, 'tokens_in', 'llama-3', '2026-01-01', 500, '2026-01-05 00:00:00+00', '2026-01-15 00:00:00+00'),
          (${serverId}, ${userId}, 'tokens_out', 'llama-3', '2026-01-01', 1000, '2026-01-05 00:00:00+00', '2026-01-15 00:00:00+00')
      `;

      await testSql`
        INSERT INTO stat_counters (
          server_id, user_id, metric, metric_key, bucket, count, first_at, last_at
        ) VALUES
          (${serverId}, ${userId}, 'image_generated', 'custom-s' || ${serverId} || '-m070-image-image-img-v1', '2026-01-02', 4, '2026-01-02 00:00:00+00', '2026-01-04 00:00:00+00'),
          (${serverId}, ${userId}, 'video_generated', 'custom-s' || ${serverId} || '-m070-video-video-vid-v1', '2026-01-03', 6, '2026-01-03 00:00:00+00', '2026-01-06 00:00:00+00')
      `;

      await executeTestSqlFile(upPath070);

      const newProviderKey = `custom:${connA.connection_id}`;
      const [savedConfig] = await testSql<[{ provider: string; llm_id: number }]>`
        SELECT provider, llm_id FROM saved_provider_configs
        WHERE server_id = ${serverId} AND provider = ${newProviderKey}
      `;
      expect(savedConfig).toBeDefined();
      expect(savedConfig.provider).toBe(newProviderKey);
      expect(savedConfig.llm_id).toBe(llmA.llm_id);

      const legacySaved = await testSql`
        SELECT provider FROM saved_provider_configs
        WHERE server_id = ${serverId} AND provider = 'custom:s' || ${serverId} || ':m070-label'
      `;
      expect(legacySaved.length).toBe(0);

      const [llmRow] = await testSql<[{ llm_provider: string; llm_codename: string }]>`
        SELECT llm_provider, llm_codename FROM llms WHERE llm_id = ${llmA.llm_id}
      `;
      expect(llmRow.llm_provider).toBe(newProviderKey);
      expect(llmRow.llm_codename).toBe("llama-3");

      const [mergedModelUsed] = await testSql<[{ count: string; first_at: Date; last_at: Date }]>`
        SELECT count, first_at, last_at FROM stat_counters
        WHERE server_id = ${serverId} AND user_id = ${userId}
          AND metric = 'model_used' AND metric_key = 'llama-3'
      `;
      expect(Number(mergedModelUsed.count)).toBe(20);
      expect(new Date(mergedModelUsed.first_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(new Date(mergedModelUsed.last_at).toISOString()).toBe("2026-01-15T00:00:00.000Z");

      const [mergedTokensIn] = await testSql<[{ count: string }]>`
        SELECT count FROM stat_counters
        WHERE server_id = ${serverId} AND user_id = ${userId}
          AND metric = 'tokens_in' AND metric_key = 'llama-3'
      `;
      expect(Number(mergedTokensIn.count)).toBe(2000);

      const [imageStats] = await testSql<[{ count: string }]>`
        SELECT count FROM stat_counters
        WHERE server_id = ${serverId} AND user_id = ${userId}
          AND metric = 'image_generated' AND metric_key = 'img-v1'
      `;
      expect(Number(imageStats.count)).toBe(4);

      const [videoStats] = await testSql<[{ count: string }]>`
        SELECT count FROM stat_counters
        WHERE server_id = ${serverId} AND user_id = ${userId}
          AND metric = 'video_generated' AND metric_key = 'vid-v1'
      `;
      expect(Number(videoStats.count)).toBe(6);

      const [connectionRows] = await testSql<[{ label: string }]>`
        SELECT label FROM custom_endpoint_connections WHERE connection_id = ${connA.connection_id}
      `;
      const [suffixedConnectionRows] = await testSql<[{ label: string }]>`
        SELECT label FROM custom_endpoint_connections WHERE connection_id = ${connB.connection_id}
      `;
      expect(connectionRows.label).toBe("m070-label");
      expect(suffixedConnectionRows.label).toBe("m070-label_2");

      const [embeddingRow] = await testSql<[{ provider: string; codename: string; model_family: string }]>`
        SELECT provider, codename, model_family FROM embedding_models
        WHERE embedding_model_id = ${embeddingModel.embedding_model_id}
      `;
      expect(embeddingRow.provider).toBe(`custom:${embeddingConnection.connection_id}`);
      expect(embeddingRow.codename).toBe("embed-v1");
      expect(embeddingRow.model_family).toBe(`custom:${embeddingConnection.connection_id}`);

      const [imageRow] = await testSql<[{ provider: string; codename: string }]>`
        SELECT provider, codename FROM image_diffusion_models
        WHERE diffusion_model_id = ${imageModel.diffusion_model_id}
      `;
      expect(imageRow.provider).toBe(`custom:${imageConnection.connection_id}`);
      expect(imageRow.codename).toBe("img-v1");

      const [videoRow] = await testSql<[{ provider: string; codename: string }]>`
        SELECT provider, codename FROM video_generation_models
        WHERE video_model_id = ${videoModel.video_model_id}
      `;
      expect(videoRow.provider).toBe(`custom:${videoConnection.connection_id}`);
      expect(videoRow.codename).toBe("vid-v1");

      const [personalConfig] = await testSql<[{ provider: string; key_version: number; diffusion_model_id: number }]>`
        SELECT provider, key_version, diffusion_model_id FROM user_saved_provider_configs
        WHERE user_id = ${userId} AND provider = ${`custom:${personalConnection.connection_id}`}
      `;
      expect(personalConfig.provider).toBe(`custom:${personalConnection.connection_id}`);
      expect(personalConfig.key_version).toBe(9);
      expect(personalConfig.diffusion_model_id).toBe(personalImageModel.diffusion_model_id);

      const [unrelatedModel] = await testSql<[{ llm_provider: string; llm_codename: string }]>`
        SELECT llm_provider, llm_codename FROM llms
        WHERE llm_codename = 'unrelated-model'
      `;
      expect(unrelatedModel.llm_provider).toBe(`custom:s${serverId}:m070-label`);

      await executeTestSqlFile(downPath070);

      const [restoredConfig] = await testSql<[{ provider: string }]>`
        SELECT provider FROM saved_provider_configs
        WHERE server_id = ${serverId} AND provider = 'custom:s' || ${serverId} || ':m070-label'
      `;
      expect(restoredConfig).toBeDefined();

      const [restoredLlm] = await testSql<[{ llm_provider: string; llm_codename: string }]>`
        SELECT llm_provider, llm_codename FROM llms WHERE llm_id = ${llmA.llm_id}
      `;
      expect(restoredLlm.llm_provider).toBe(`custom:s${serverId}:m070-label`);
      expect(restoredLlm.llm_codename).toBe(`custom-s${serverId}-m070-label-text-llama-3`);
    } finally {
      await executeTestSqlFile(upPath070);
      await executeTestSqlFile(upPath073);
    }

    await executeTestSqlFile(upPath070);
  });
});
