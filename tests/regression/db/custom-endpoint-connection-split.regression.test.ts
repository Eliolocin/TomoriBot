import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmProviderRepo } from "@/utils/db/repositories";
import * as SpeechRepository from "@/utils/db/repositories/SpeechRepository";
import { encryptApiKey } from "@/utils/security/crypto";
import { DB_TESTS_AVAILABLE, executeTestSqlFile, setupTestDb, testSql } from "./setup/testDb";

const PROBE_SERVER = "_custom_endpoint_split_server";
const PROBE_USER = "_custom_endpoint_split_user";

describe.skipIf(!DB_TESTS_AVAILABLE)("Custom Endpoint connection and model split (Migration A)", () => {
  let serverId: number;
  let userId: number;
  const migration073UpPath = path.join(
    process.cwd(),
    "src",
    "db",
    "migrations",
    "073_unify_custom_endpoint_group_urls.sql",
  );
  const migration073DownPath = path.join(
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

  it("hydrates server, personal, and speech rows through joined projections with connection_id", async () => {
    const serverEp = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "srv-text",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "https://llm.example.invalid/v1",
      modelName: "llama-3.3-70b",
      requiresAuth: true,
      extraConfig: { headers: { "X-Custom": "1" } },
    });
    expect(serverEp).not.toBeNull();
    expect(serverEp?.connection_id).toBeDefined();
    expect(serverEp?.server_id).toBe(serverId);
    expect(serverEp?.user_id).toBeNull();
    expect(serverEp?.label).toBe("srv-text");
    expect(serverEp?.capability).toBe("text");
    expect(serverEp?.api_style).toBe("openai-compatible");
    expect(serverEp?.endpoint_url).toBe("https://llm.example.invalid/v1");
    expect(serverEp?.requires_auth).toBe(true);

    const loadedServerList = await llmProviderRepo.loadCustomEndpointsForServer(serverId);
    expect(loadedServerList.length).toBeGreaterThanOrEqual(1);
    const loadedServerEp = loadedServerList.find((e) => e.label === "srv-text");
    expect(loadedServerEp?.connection_id).toBe(serverEp?.connection_id);
    expect(loadedServerEp?.model_name).toBe("llama-3.3-70b");

    const loadedByLabel = await llmProviderRepo.loadCustomEndpoint({
      serverId,
      label: "srv-text",
      capability: "text",
    });
    expect(loadedByLabel?.custom_endpoint_id).toBe(serverEp?.custom_endpoint_id);
    expect(loadedByLabel?.connection_id).toBe(serverEp?.connection_id);

    const personalEp = await llmProviderRepo.upsertCustomEndpoint({
      serverId: null,
      userId,
      label: "user-sd",
      capability: "image",
      apiStyle: "comfyui",
      endpointUrl: "http://127.0.0.1:8188",
      modelName: "flux-schnell",
      requiresAuth: false,
    });
    expect(personalEp).not.toBeNull();
    expect(personalEp?.connection_id).toBeDefined();
    expect(personalEp?.user_id).toBe(userId);
    expect(personalEp?.server_id).toBeNull();
    expect(personalEp?.label).toBe("user-sd");
    expect(personalEp?.capability).toBe("image");

    const loadedPersonalList = await llmProviderRepo.loadCustomEndpointsForUser(userId);
    const loadedPersonalEp = loadedPersonalList.find((e) => e.label === "user-sd");
    expect(loadedPersonalEp?.connection_id).toBe(personalEp?.connection_id);
    expect(loadedPersonalEp?.model_name).toBe("flux-schnell");

    const speechEp = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "srv-tts",
      capability: "speech",
      apiStyle: "elevenlabs",
      endpointUrl: "https://api.elevenlabs.io",
      requiresAuth: true,
      isDefault: true,
    });
    expect(speechEp).not.toBeNull();
    expect(speechEp?.connection_id).toBeDefined();

    const activeSpeech = await SpeechRepository.loadActiveEndpoint(serverId, "speech");
    expect(activeSpeech).not.toBeNull();
    expect(activeSpeech?.custom_endpoint_id).toBe(speechEp?.custom_endpoint_id);
    expect(activeSpeech?.connection_id).toBe(speechEp?.connection_id);
    expect(activeSpeech?.capability).toBe("speech");
    expect(activeSpeech?.api_style).toBe("elevenlabs");
  });

  it("shares a single connection across sibling models under the same connection identity", async () => {
    const modelA = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "shared-conn",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://localhost:11434/v1",
      modelName: "qwen2.5:7b",
      requiresAuth: false,
    });

    const modelB = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "shared-conn",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://localhost:11434/v1",
      modelName: "deepseek-r1:8b",
      requiresAuth: false,
    });

    expect(modelA).not.toBeNull();
    expect(modelB).not.toBeNull();
    expect(modelA?.connection_id).toBeDefined();
    expect(modelB?.connection_id).toBeDefined();
    expect(modelA?.connection_id).toBe(modelB?.connection_id);
    expect(modelA?.custom_endpoint_id).not.toBe(modelB?.custom_endpoint_id);

    const [connCount] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM custom_endpoint_connections
      WHERE server_id = ${serverId} AND label = 'shared-conn' AND capability = 'text'
    `;
    expect(Number(connCount.count)).toBe(1);

    const [modelCount] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM custom_endpoints
      WHERE connection_id = ${modelA?.connection_id ?? -1}
    `;
    expect(Number(modelCount.count)).toBe(2);
  });

  it("preserves divergent URLs under the same label/capability as distinct connections", async () => {
    // Recreate the historical URL-sensitive identity without Migration 073's
    // grouped-URL invariant, then restore the current schema below.
    await executeTestSqlFile(migration073DownPath);
    await testSql`DROP INDEX IF EXISTS idx_custom_endpoint_connections_server_unique`;
    await testSql`CREATE UNIQUE INDEX idx_custom_endpoint_connections_server_unique
      ON custom_endpoint_connections(server_id, label, capability, api_style, endpoint_url)
      WHERE user_id IS NULL`;

    try {
      const [conn1] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'divergent', 'text', 'openai-compatible', 'http://10.0.0.1:8000/v1', false
        ) RETURNING connection_id
      `;
      const [conn2] = await testSql<[{ connection_id: number }]>`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES (
          ${serverId}, NULL, 'divergent', 'text', 'openai-compatible', 'http://10.0.0.2:8000/v1', false
        ) RETURNING connection_id
      `;

      expect(conn1.connection_id).not.toBe(conn2.connection_id);

      const [ep1] = await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (connection_id, model_name)
        VALUES (${conn1.connection_id}, 'model-on-ip1')
        RETURNING custom_endpoint_id
      `;
      const [ep2] = await testSql<[{ custom_endpoint_id: number }]>`
        INSERT INTO custom_endpoints (connection_id, model_name)
        VALUES (${conn2.connection_id}, 'model-on-ip2')
        RETURNING custom_endpoint_id
      `;

      const loaded = await llmProviderRepo.loadCustomEndpointsByIds([ep1.custom_endpoint_id, ep2.custom_endpoint_id]);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].endpoint_url).toBe("http://10.0.0.1:8000/v1");
      expect(loaded[0].connection_id).toBe(conn1.connection_id);
      expect(loaded[1].endpoint_url).toBe("http://10.0.0.2:8000/v1");
      expect(loaded[1].connection_id).toBe(conn2.connection_id);
    } finally {
      await testSql`
        DELETE FROM custom_endpoint_connections
        WHERE server_id = ${serverId} AND label = 'divergent' AND capability = 'text'
      `;
      await testSql`DROP INDEX IF EXISTS idx_custom_endpoint_connections_server_unique`;
      await testSql`CREATE UNIQUE INDEX idx_custom_endpoint_connections_server_unique
        ON custom_endpoint_connections(server_id, label, capability)
        WHERE user_id IS NULL`;
      await executeTestSqlFile(migration073UpPath);
    }
  });

  it("migration 073 separates legacy URL groups and installs the one-URL invariant", async () => {
    await executeTestSqlFile(migration073DownPath);

    try {
      await testSql`
        INSERT INTO custom_endpoint_connections (
          server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
        ) VALUES
          (${serverId}, NULL, 'legacy-group', 'text', 'openai-compatible', 'http://10.0.0.1:8000/v1', false),
          (${serverId}, NULL, 'legacy-group', 'image', 'comfyui', 'http://10.0.0.2:8188', false)
      `;

      await executeTestSqlFile(migration073UpPath);

      const migrated = await testSql<Array<{ label: string; endpoint_url: string }>>`
        SELECT label, endpoint_url
        FROM custom_endpoint_connections
        WHERE server_id = ${serverId} AND label LIKE 'legacy-group-%'
        ORDER BY endpoint_url
      `;
      expect(migrated).toEqual([
        { label: "legacy-group-1", endpoint_url: "http://10.0.0.1:8000/v1" },
        { label: "legacy-group-2", endpoint_url: "http://10.0.0.2:8188" },
      ]);

      const [trigger] = await testSql<[{ tgdeferrable: boolean; tginitdeferred: boolean }]>`
        SELECT tgdeferrable, tginitdeferred
        FROM pg_trigger
        WHERE tgname = 'enforce_custom_endpoint_group_url'
      `;
      expect(trigger).toEqual({ tgdeferrable: true, tginitdeferred: true });
    } finally {
      await testSql`
        DELETE FROM custom_endpoint_connections
        WHERE server_id = ${serverId} AND label LIKE 'legacy-group-%'
      `;
      await executeTestSqlFile(migration073UpPath);
    }
  });

  it("propagates connection edits to sibling models sharing that connection", async () => {
    const m1 = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "edit-sync",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://original:8000/v1",
      modelName: "mod-1",
      requiresAuth: false,
    });

    const m2 = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "edit-sync",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://original:8000/v1",
      modelName: "mod-2",
      requiresAuth: false,
    });

    expect(m1?.connection_id).toBe(m2?.connection_id);
    expect(m1?.custom_endpoint_id).toBeDefined();
    expect(m2?.custom_endpoint_id).toBeDefined();

    const updatedM1 = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "edit-sync",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://updated-host:9000/v1",
      modelName: "mod-1-renamed",
      requiresAuth: true,
      customEndpointId: m1?.custom_endpoint_id ?? null,
    });

    expect(updatedM1?.endpoint_url).toBe("http://updated-host:9000/v1");
    expect(updatedM1?.requires_auth).toBe(true);
    expect(updatedM1?.model_name).toBe("mod-1-renamed");

    const [reloadedM2] = await llmProviderRepo.loadCustomEndpointsByIds([m2?.custom_endpoint_id ?? -1]);
    expect(reloadedM2).toBeDefined();
    expect(reloadedM2.endpoint_url).toBe("http://updated-host:9000/v1");
    expect(reloadedM2.requires_auth).toBe(true);
    expect(reloadedM2.model_name).toBe("mod-2");
  });

  it("rolls back connection metadata updates when an edit violates sibling model uniqueness", async () => {
    const originalUrl = "http://rollback.test:8000/v1";
    const attemptedUrl = "http://attempted-change.invalid:9000/v1";

    const siblingA = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "atomic-rollback",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: originalUrl,
      modelName: "model-alpha",
      requiresAuth: false,
    });

    const siblingB = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "atomic-rollback",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: originalUrl,
      modelName: "model-beta",
      requiresAuth: false,
    });

    expect(siblingA).not.toBeNull();
    expect(siblingB).not.toBeNull();
    expect(siblingA?.connection_id).toBe(siblingB?.connection_id);

    const failedUpdate = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "atomic-rollback",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: attemptedUrl,
      modelName: "model-beta",
      requiresAuth: true,
      customEndpointId: siblingA?.custom_endpoint_id ?? null,
    });

    expect(failedUpdate).toBeNull();

    const [reloadedA, reloadedB] = await llmProviderRepo.loadCustomEndpointsByIds([
      siblingA?.custom_endpoint_id ?? -1,
      siblingB?.custom_endpoint_id ?? -1,
    ]);

    expect(reloadedA).toBeDefined();
    expect(reloadedA.endpoint_url).toBe(originalUrl);
    expect(reloadedA.requires_auth).toBe(false);
    expect(reloadedA.model_name).toBe("model-alpha");

    expect(reloadedB).toBeDefined();
    expect(reloadedB.endpoint_url).toBe(originalUrl);
    expect(reloadedB.requires_auth).toBe(false);
    expect(reloadedB.model_name).toBe("model-beta");

    const [connCheck] = await testSql<[{ endpoint_url: string; requires_auth: boolean }]>`
      SELECT endpoint_url, requires_auth
      FROM custom_endpoint_connections
      WHERE connection_id = ${siblingA?.connection_id ?? -1}
    `;
    expect(connCheck).toBeDefined();
    expect(connCheck.endpoint_url).toBe(originalUrl);
    expect(connCheck.requires_auth).toBe(false);
  });

  it("preserves zero-model connections when removing a model by customEndpointId", async () => {
    const single = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "zero-model-probe",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://zero.probe:8000/v1",
      modelName: "temporary-model",
      requiresAuth: false,
    });

    expect(single?.connection_id).toBeDefined();
    expect(single?.custom_endpoint_id).toBeDefined();
    const connId = single?.connection_id ?? -1;
    const epId = single?.custom_endpoint_id ?? -1;

    const deleted = await llmProviderRepo.deleteCustomEndpointById(epId);
    expect(deleted).toBe(true);

    const [modelCheck] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM custom_endpoints WHERE custom_endpoint_id = ${epId}
    `;
    expect(Number(modelCheck.count)).toBe(0);

    const [connCheck] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM custom_endpoint_connections WHERE connection_id = ${connId}
    `;
    expect(Number(connCheck.count)).toBe(1);
  });

  it("cascades deletion of all child models when deleting the entire connection", async () => {
    const c1 = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "cascade-probe",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://cascade.probe:8000/v1",
      modelName: "c-mod-1",
      requiresAuth: false,
    });

    await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "cascade-probe",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://cascade.probe:8000/v1",
      modelName: "c-mod-2",
      requiresAuth: false,
    });

    expect(c1?.connection_id).toBeDefined();
    const connId = c1?.connection_id ?? -1;

    const deleted = await llmProviderRepo.deleteCustomEndpoint({
      serverId,
      label: "cascade-probe",
      capability: "text",
    });
    expect(deleted).toBe(true);

    const [connCheck] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM custom_endpoint_connections WHERE connection_id = ${connId}
    `;
    expect(Number(connCheck.count)).toBe(0);

    const [modelsCheck] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM custom_endpoints WHERE connection_id = ${connId}
    `;
    expect(Number(modelsCheck.count)).toBe(0);
  });

  it("keeps encrypted credentials and key_version canonical in saved_provider_configs", async () => {
    const encrypted = await encryptApiKey("secret-token-12345");
    const providerKey = `custom:s${serverId}:cred-test`;

    await testSql`
      INSERT INTO saved_provider_configs (
        server_id, provider, api_key, key_version
      ) VALUES (
        ${serverId}, ${providerKey}, ${encrypted.encrypted}, ${encrypted.version}
      )
      ON CONFLICT (server_id, provider) DO UPDATE SET
        api_key = EXCLUDED.api_key,
        key_version = EXCLUDED.key_version
    `;

    const credentials = await SpeechRepository.loadEndpointCredentials(serverId, providerKey);
    expect(credentials).not.toBeNull();
    expect(credentials?.key_version).toBe(encrypted.version);
    expect(credentials ? Buffer.compare(credentials.api_key, encrypted.encrypted) : -1).toBe(0);
  });

  it("migration 068 down and forward migration round-trip preserves custom endpoints and reruns idempotently", async () => {
    const ep = await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "migration-cycle",
      capability: "text",
      apiStyle: "openai-compatible",
      endpointUrl: "http://cycle.local:8000/v1",
      modelName: "cycle-model",
      requiresAuth: true,
    });
    expect(ep).not.toBeNull();

    const downPath = path.join(process.cwd(), "src", "db", "migrations", "068_custom_endpoint_connections.down.sql");
    const upPath = path.join(process.cwd(), "src", "db", "migrations", "068_custom_endpoint_connections.sql");

    await executeTestSqlFile(downPath);

    try {
      const [downRow] = await testSql<
        [
          {
            server_id: number;
            label: string;
            capability: string;
            api_style: string;
            endpoint_url: string;
            requires_auth: boolean;
          },
        ]
      >`
        SELECT server_id, label, capability, api_style, endpoint_url, requires_auth
        FROM custom_endpoints
        WHERE server_id = ${serverId} AND label = 'migration-cycle'
      `;
      expect(downRow).toBeDefined();
      expect(downRow.server_id).toBe(serverId);
      expect(downRow.label).toBe("migration-cycle");
      expect(downRow.capability).toBe("text");
      expect(downRow.api_style).toBe("openai-compatible");
      expect(downRow.endpoint_url).toBe("http://cycle.local:8000/v1");
      expect(downRow.requires_auth).toBe(true);
    } finally {
      await executeTestSqlFile(upPath);
    }

    try {
      await executeTestSqlFile(upPath);

      const reloadedList = await llmProviderRepo.loadCustomEndpointsForServer(serverId);
      const reloaded = reloadedList.find((e) => e.label === "migration-cycle");
      expect(reloaded).toBeDefined();
      expect(reloaded?.connection_id).toBeDefined();
      expect(reloaded?.endpoint_url).toBe("http://cycle.local:8000/v1");
      expect(reloaded?.requires_auth).toBe(true);
      expect(reloaded?.model_name).toBe("cycle-model");
    } finally {
      // Keep the shared disposable database at the current fresh-install
      // schema after exercising Migration A's legacy coexistence state.
      await testSql`DROP INDEX IF EXISTS idx_custom_endpoint_connections_server_unique`;
      await testSql`DROP INDEX IF EXISTS idx_custom_endpoint_connections_user_unique`;
      await testSql`CREATE UNIQUE INDEX idx_custom_endpoint_connections_server_unique
        ON custom_endpoint_connections(server_id, label, capability)
        WHERE user_id IS NULL`;
      await testSql`CREATE UNIQUE INDEX idx_custom_endpoint_connections_user_unique
        ON custom_endpoint_connections(user_id, label, capability)
        WHERE server_id IS NULL`;
    }
  });
});
