import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssembledServerConfig, LlmRow, TomoriState, UserSavedProviderConfigUpsert } from "@/types/db/schema";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { buildUserSavedProviderConfigFromExistingOrDefaults } from "@/utils/provider/savedProviderConfig";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const USER_DISC_A = "_rt_randomizer_user_a";
const USER_DISC_B = "_rt_randomizer_user_b";
const SERVER_DISC = "_rt_randomizer_server";

describe.skipIf(!DB_TESTS_AVAILABLE)("Personal model randomizer data layer (migration 076)", () => {
  let userAId: number;
  let userBId: number;
  let serverId: number;
  let sampleLlm: LlmRow;

  beforeAll(async () => {
    await setupTestDb();

    // Clean up any stale fixtures from prior interrupted runs.
    await testSql`DELETE FROM users WHERE user_disc_id IN (${USER_DISC_A}, ${USER_DISC_B})`;
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC}`;

    const [serverRow] = await testSql<[{ server_id: number }]>`
      INSERT INTO servers (server_disc_id) VALUES (${SERVER_DISC}) RETURNING server_id
    `;
    serverId = Number(serverRow.server_id);

    const [userARow] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_A}) RETURNING user_id
    `;
    userAId = Number(userARow.user_id);

    const [userBRow] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_B}) RETURNING user_id
    `;
    userBId = Number(userBRow.user_id);

    const available = await llmModelRepo.loadAvailableLlms();
    if (!available || available.length === 0) {
      throw new Error("No seeded LLMs found in database");
    }
    sampleLlm = available[0];
  });

  afterAll(async () => {
    await testSql`DELETE FROM users WHERE user_disc_id IN (${USER_DISC_A}, ${USER_DISC_B})`;
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC}`;
  });

  function makeBaseConfig(overrides: Partial<AssembledServerConfig> = {}): AssembledServerConfig {
    return {
      server_id: serverId,
      model_randomizer_enabled: false,
      thinking_level: "auto",
      llm_temperature: 0.7,
      llm_top_p: 0.95,
      llm_top_k: 0,
      llm_frequency_penalty: 0.0,
      llm_presence_penalty: 0.0,
      llm_min_p: 0.05,
      llm_disabled_params: [],
      llm_logit_biases: [],
      fallback_llm_ids: [],
      fallback_model_refs: [],
      ...overrides,
    } as unknown as AssembledServerConfig;
  }

  function makeState(randomizerEnabled: boolean): TomoriState {
    return {
      server_id: serverId,
      persona_id: 1,
      persona_lineage_id: 1,
      persona_name: "test-persona",
      persona_nickname: "test",
      is_alter: false,
      llm: sampleLlm,
      config: makeBaseConfig({ model_randomizer_enabled: randomizerEnabled }),
    } as TomoriState;
  }

  it("overrides server true with personal false when an active personal text route has randomizer disabled", async () => {
    // Clear user provider rows before testing overlay.
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id = ${userAId}`;

    const initialConfig = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig: makeBaseConfig({ model_randomizer_enabled: true }),
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });

    const inserted = await llmProviderRepo.upsertUserSavedProviderConfig(userAId, initialConfig);
    expect(inserted).toBe(true);

    const serverState = makeState(true);
    const result = await applyPersonalProviderSelectionsToTomoriState(serverState, userAId);

    expect(result.activeConfigs.text?.model_randomizer_enabled).toBe(false);
    expect(result.tomoriState.config.model_randomizer_enabled).toBe(false);
  });

  it("overrides server false with personal true when an active personal text route has randomizer enabled", async () => {
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id = ${userAId}`;

    const initialConfig = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig: makeBaseConfig({ model_randomizer_enabled: false }),
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });

    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, initialConfig);
    const updated = await llmProviderRepo.updatePersonalModelRandomizer(userAId, "google", true);
    expect(updated).toBe(true);

    const serverState = makeState(false);
    const result = await applyPersonalProviderSelectionsToTomoriState(serverState, userAId);

    expect(result.activeConfigs.text?.model_randomizer_enabled).toBe(true);
    expect(result.tomoriState.config.model_randomizer_enabled).toBe(true);
  });

  it("obeys server flag when no personal text route is active", async () => {
    // Case 1: No personal rows exist for user.
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id = ${userAId}`;

    const serverTrueState = makeState(true);
    const resultNoRowsTrue = await applyPersonalProviderSelectionsToTomoriState(serverTrueState, userAId);
    expect(resultNoRowsTrue.tomoriState.config.model_randomizer_enabled).toBe(true);

    const serverFalseState = makeState(false);
    const resultNoRowsFalse = await applyPersonalProviderSelectionsToTomoriState(serverFalseState, userAId);
    expect(resultNoRowsFalse.tomoriState.config.model_randomizer_enabled).toBe(false);

    // Case 2: Personal row exists with randomizer enabled, but text capability is NOT enabled.
    const nonTextConfig = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig: makeBaseConfig(),
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["image"],
    });
    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, nonTextConfig);
    await llmProviderRepo.updatePersonalModelRandomizer(userAId, "google", true);

    const nonTextResult = await applyPersonalProviderSelectionsToTomoriState(makeState(false), userAId);
    expect(nonTextResult.activeConfigs.text).toBeUndefined();
    expect(nonTextResult.tomoriState.config.model_randomizer_enabled).toBe(false);

    // Case 3: Personal row exists with text capability enabled and randomizer enabled, but llm_id is null.
    const nullModelConfig: UserSavedProviderConfigUpsert = {
      ...nonTextConfig,
      llm_id: null,
      enabled_capabilities: ["text"],
      assigned_capabilities: ["text"],
    };
    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, nullModelConfig);
    await llmProviderRepo.updatePersonalModelRandomizer(userAId, "google", true);

    const nullModelResult = await applyPersonalProviderSelectionsToTomoriState(makeState(false), userAId);
    expect(nullModelResult.activeConfigs.text).toBeUndefined();
    expect(nullModelResult.tomoriState.config.model_randomizer_enabled).toBe(false);
  });

  it("does not reset the model randomizer flag during an unrelated upsert", async () => {
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id = ${userAId}`;

    const baseConfig = makeBaseConfig({ llm_temperature: 0.7 });

    const initial = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig,
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });
    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, initial);

    // Explicitly enable randomizer through focused setter.
    const enabledOk = await llmProviderRepo.updatePersonalModelRandomizer(userAId, "google", true);
    expect(enabledOk).toBe(true);

    const rowBeforeSave = await llmProviderRepo.loadUserSavedProviderConfig(userAId, "google");
    expect(rowBeforeSave?.model_randomizer_enabled).toBe(true);

    // Simulate an unrelated parameter change or model save through buildUserSavedProviderConfigFromExistingOrDefaults.
    const modifiedConfig = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig,
      existingConfig: rowBeforeSave,
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });
    modifiedConfig.llm_temperature = 0.25;

    const upsertOk = await llmProviderRepo.upsertUserSavedProviderConfig(userAId, modifiedConfig);
    expect(upsertOk).toBe(true);

    // Assert the randomizer preference was not clobbered by the general upsert.
    const rowAfterSave = await llmProviderRepo.loadUserSavedProviderConfig(userAId, "google");
    expect(rowAfterSave?.model_randomizer_enabled).toBe(true);
    expect(rowAfterSave?.llm_temperature).toBeCloseTo(0.25, 2);

    // The assertion above passes on the builder's threading alone, so it cannot tell whether the
    // ON CONFLICT list is safe. Upserting a payload that explicitly carries false is what proves the
    // general upsert structurally cannot touch the column, which is the guarantee a future caller
    // built without the existing row depends on.
    const hostilePayload: UserSavedProviderConfigUpsert = { ...modifiedConfig, model_randomizer_enabled: false };
    expect(await llmProviderRepo.upsertUserSavedProviderConfig(userAId, hostilePayload)).toBe(true);

    const rowAfterHostileSave = await llmProviderRepo.loadUserSavedProviderConfig(userAId, "google");
    expect(rowAfterHostileSave?.model_randomizer_enabled).toBe(true);
  });

  it("scopes the setter so updates affect only the targeted user and provider", async () => {
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id IN (${userAId}, ${userBId})`;

    const baseConfig = makeBaseConfig();

    // User A: provider google and openrouter
    const userAGoogle = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig,
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });
    const userAOpenrouter = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userAId,
      provider: "openrouter",
      apiKey: null,
      keyVersion: 1,
      baseConfig,
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });

    // User B: provider google
    const userBGoogle = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userBId,
      provider: "google",
      apiKey: null,
      keyVersion: 1,
      baseConfig,
      llmId: sampleLlm.llm_id,
      enabledCapabilities: ["text"],
    });

    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, userAGoogle);
    await llmProviderRepo.upsertUserSavedProviderConfig(userAId, userAOpenrouter);
    await llmProviderRepo.upsertUserSavedProviderConfig(userBId, userBGoogle);

    // Update only User A's google provider.
    const updated = await llmProviderRepo.updatePersonalModelRandomizer(userAId, "google", true);
    expect(updated).toBe(true);

    const reloadedUserAGoogle = await llmProviderRepo.loadUserSavedProviderConfig(userAId, "google");
    const reloadedUserAOpenrouter = await llmProviderRepo.loadUserSavedProviderConfig(userAId, "openrouter");
    const reloadedUserBGoogle = await llmProviderRepo.loadUserSavedProviderConfig(userBId, "google");

    expect(reloadedUserAGoogle?.model_randomizer_enabled).toBe(true);
    expect(reloadedUserAOpenrouter?.model_randomizer_enabled).toBe(false);
    expect(reloadedUserBGoogle?.model_randomizer_enabled).toBe(false);

    // Non-existent row update returns false.
    const nonExistent = await llmProviderRepo.updatePersonalModelRandomizer(999999, "google", true);
    expect(nonExistent).toBe(false);
  });
});
