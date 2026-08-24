import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmProviderRepo } from "@/utils/db/repositories/LlmProviderRepository";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const SERVER_DISC_ID = "_provider_panel_removal_server";
const USER_DISC_ID = "_provider_panel_removal_user";
const SHARED_PROVIDER = "wave4-removal-provider";

describe.skipIf(!DB_TESTS_AVAILABLE)("Provider panel durable removal", () => {
  let serverId: number;
  let userId: number;

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC_ID}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${USER_DISC_ID}`;
    const [server] = await testSql<[{ server_id: number }]>`
      INSERT INTO servers (server_disc_id) VALUES (${SERVER_DISC_ID}) RETURNING server_id
    `;
    serverId = Number(server.server_id);
    const [user] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_ID}) RETURNING user_id
    `;
    userId = Number(user.user_id);
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC_ID}`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${USER_DISC_ID}`;
    await testSql`DELETE FROM llms WHERE llm_provider = ${SHARED_PROVIDER}`;
  });

  it("removes one curated provider snapshot, rotation pool, and scoped registrations atomically", async () => {
    const [model] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'removal-model', true) RETURNING llm_id
    `;
    await testSql`INSERT INTO saved_provider_configs (server_id, provider) VALUES (${serverId}, ${SHARED_PROVIDER})`;
    await testSql`
      INSERT INTO api_key_rotation (server_id, provider, api_key, is_main_key_pointer)
      VALUES (${serverId}, ${SHARED_PROVIDER}, NULL, true), (${serverId}, ${SHARED_PROVIDER}, NULL, false)
    `;
    await testSql`
      INSERT INTO scoped_model_registrations (server_id, llm_id) VALUES (${serverId}, ${model.llm_id})
    `;

    expect(await llmProviderRepo.deleteServerProviderRegistration(serverId, SHARED_PROVIDER)).toBe(true);
    const [counts] = await testSql<[{ configs: string; keys: string; registrations: string; models: string }]>`
      SELECT
        (SELECT COUNT(*) FROM saved_provider_configs
          WHERE server_id = ${serverId} AND provider = ${SHARED_PROVIDER}) AS configs,
        (SELECT COUNT(*) FROM api_key_rotation
          WHERE server_id = ${serverId} AND provider = ${SHARED_PROVIDER}) AS keys,
        (SELECT COUNT(*) FROM scoped_model_registrations
          WHERE server_id = ${serverId} AND llm_id = ${model.llm_id}) AS registrations,
        (SELECT COUNT(*) FROM llms WHERE llm_id = ${model.llm_id}) AS models
    `;
    expect(counts).toEqual({ configs: "0", keys: "0", registrations: "0", models: "1" });
  });

  it("removes a grouped endpoint, credentials, registrations, and synthetic models", async () => {
    const [textConnection] = await testSql<[{ connection_id: number }]>`
      INSERT INTO custom_endpoint_connections (
        server_id, label, capability, api_style, endpoint_url, requires_auth
      ) VALUES (${serverId}, 'lighthouse', 'text', 'openai-compatible', 'https://example.invalid/v1', true)
      RETURNING connection_id
    `;
    const [imageConnection] = await testSql<[{ connection_id: number }]>`
      INSERT INTO custom_endpoint_connections (
        server_id, label, capability, api_style, endpoint_url, requires_auth
      ) VALUES (${serverId}, 'lighthouse', 'image', 'openai-compatible', 'https://example.invalid/v1', true)
      RETURNING connection_id
    `;
    const textProvider = `custom:${textConnection.connection_id}`;
    const imageProvider = `custom:${imageConnection.connection_id}`;
    const [model] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename) VALUES (${textProvider}, 'private-text') RETURNING llm_id
    `;
    await testSql`
      INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id)
      VALUES (${textConnection.connection_id}, 'private-text', ${model.llm_id})
    `;
    await testSql`
      INSERT INTO saved_provider_configs (server_id, provider)
      VALUES (${serverId}, ${textProvider}), (${serverId}, ${imageProvider})
    `;

    expect(
      await llmProviderRepo.deleteServerCustomEndpointConnectionGroup(serverId, [
        textConnection.connection_id,
        imageConnection.connection_id,
      ]),
    ).toBe(true);
    const [counts] = await testSql<[{ connections: string; configs: string; endpoints: string; models: string }]>`
      SELECT
        (SELECT COUNT(*) FROM custom_endpoint_connections
          WHERE connection_id IN (${textConnection.connection_id}, ${imageConnection.connection_id})) AS connections,
        (SELECT COUNT(*) FROM saved_provider_configs
          WHERE server_id = ${serverId} AND provider IN (${textProvider}, ${imageProvider})) AS configs,
        (SELECT COUNT(*) FROM custom_endpoints WHERE connection_id = ${textConnection.connection_id}) AS endpoints,
        (SELECT COUNT(*) FROM llms WHERE llm_id = ${model.llm_id}) AS models
    `;
    expect(counts).toEqual({ connections: "0", configs: "0", endpoints: "0", models: "0" });
  });

  it("removes only the user's curated snapshot and scoped registrations", async () => {
    const [model] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'personal-removal-model', true) RETURNING llm_id
    `;
    await testSql`INSERT INTO user_saved_provider_configs (user_id, provider) VALUES (${userId}, ${SHARED_PROVIDER})`;
    await testSql`INSERT INTO scoped_model_registrations (user_id, llm_id) VALUES (${userId}, ${model.llm_id})`;

    expect(await llmProviderRepo.deleteUserProviderRegistration(userId, SHARED_PROVIDER)).toBe(true);
    const [counts] = await testSql<[{ configs: string; registrations: string; models: string }]>`
      SELECT
        (SELECT COUNT(*) FROM user_saved_provider_configs
          WHERE user_id = ${userId} AND provider = ${SHARED_PROVIDER}) AS configs,
        (SELECT COUNT(*) FROM scoped_model_registrations
          WHERE user_id = ${userId} AND llm_id = ${model.llm_id}) AS registrations,
        (SELECT COUNT(*) FROM llms WHERE llm_id = ${model.llm_id}) AS models
    `;
    expect(counts).toEqual({ configs: "0", registrations: "0", models: "1" });
  });

  it("removes a user-owned endpoint group without touching server-owned rows", async () => {
    const [connection] = await testSql<[{ connection_id: number }]>`
      INSERT INTO custom_endpoint_connections (
        user_id, label, capability, api_style, endpoint_url, requires_auth
      ) VALUES (${userId}, 'personal-lighthouse', 'text', 'openai-compatible', 'https://example.invalid/v1', true)
      RETURNING connection_id
    `;
    const provider = `custom:${connection.connection_id}`;
    const [model] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename) VALUES (${provider}, 'private-personal-text') RETURNING llm_id
    `;
    await testSql`
      INSERT INTO custom_endpoints (connection_id, model_name, model_ref_id)
      VALUES (${connection.connection_id}, 'private-personal-text', ${model.llm_id})
    `;
    await testSql`
      INSERT INTO user_saved_provider_configs (user_id, provider) VALUES (${userId}, ${provider})
    `;

    expect(await llmProviderRepo.deleteUserCustomEndpointConnectionGroup(userId, [connection.connection_id])).toBe(
      true,
    );
    const [counts] = await testSql<[{ connections: string; configs: string; endpoints: string; models: string }]>`
      SELECT
        (SELECT COUNT(*) FROM custom_endpoint_connections WHERE connection_id = ${connection.connection_id}) AS connections,
        (SELECT COUNT(*) FROM user_saved_provider_configs
          WHERE user_id = ${userId} AND provider = ${provider}) AS configs,
        (SELECT COUNT(*) FROM custom_endpoints WHERE connection_id = ${connection.connection_id}) AS endpoints,
        (SELECT COUNT(*) FROM llms WHERE llm_id = ${model.llm_id}) AS models
    `;
    expect(counts).toEqual({ connections: "0", configs: "0", endpoints: "0", models: "0" });
  });
});
