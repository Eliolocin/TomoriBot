/**
 * Regression harness: atomic server setup transactions across provider modes.
 *
 * Covers:
 * - All three provider modes: catalog, user-byok, custom-endpoint
 * - Refusal of custom endpoint API styles without text capability
 * - Built-in null versus preset string system prompts
 * - Late-transaction failure rollback preserving pre-existing configs and undoing orphan cleanup
 * - Orphan recovery preserving alter personas and duplicate name suffixing
 * - Absence of cache invalidation during repository setup writes
 *
 * Requires: a local Postgres connection (see docs/en/contributing/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Guild } from "discord.js";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import * as cacheStore from "@/utils/cache/tomoriStateCacheStore";
import { encryptApiKey } from "@/utils/security/crypto";
import { cleanupFixtures, insertFixtures } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const CATALOG_SERVER_ID = "_rt_setup_catalog_001";
const BYOK_SERVER_ID = "_rt_setup_byok_001";
const CUSTOM_SERVER_ID = "_rt_setup_custom_001";
const PROMPT_SERVER_ID = "_rt_setup_prompt_001";
const ORPHAN_SERVER_ID = "_rt_setup_orphan_001";
const ROLLBACK_SERVER_ID = "_rt_setup_rollback_001";
const CACHE_SERVER_ID = "_rt_setup_cache_001";

describe.skipIf(!DB_TESTS_AVAILABLE)("Server setup transaction regression", () => {
  let presetId = 1;
  let catalogProvider = "openai";

  beforeAll(async () => {
    await setupTestDb();
    await insertFixtures(testSql);

    const presetRows = await testSql<Array<{ persona_preset_id: number }>>`
      SELECT persona_preset_id FROM persona_presets ORDER BY persona_preset_id ASC LIMIT 1
    `;
    if (presetRows[0]) {
      presetId = presetRows[0].persona_preset_id;
    }

    const llmRows = await testSql<Array<{ llm_provider: string }>>`
      SELECT llm_provider FROM llms WHERE is_default = true AND is_deprecated = false ORDER BY llm_id ASC LIMIT 1
    `;
    if (llmRows[0]) {
      catalogProvider = llmRows[0].llm_provider;
    }
  });

  afterAll(async () => {
    await testSql`
      DELETE FROM servers
      WHERE server_disc_id IN (
        ${CATALOG_SERVER_ID},
        ${BYOK_SERVER_ID},
        ${CUSTOM_SERVER_ID},
        ${PROMPT_SERVER_ID},
        ${ORPHAN_SERVER_ID},
        ${ROLLBACK_SERVER_ID},
        ${CACHE_SERVER_ID}
      )
    `;
    await cleanupFixtures(testSql);
  });

  it("sets up a workspace in catalog mode with default models and saved provider config", async () => {
    const { encrypted, version } = await encryptApiKey("test-catalog-key");

    await serverRepository.setup(null, {
      serverId: CATALOG_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriCatalog",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "catalog",
        provider: catalogProvider,
        encryptedApiKey: encrypted,
        keyVersion: version,
      },
      systemPrompt: null,
    });

    const [modelConfig] = await testSql<Array<{ llm_id: number | null; api_key: Buffer | null }>>`
      SELECT mc.llm_id, mc.api_key
      FROM server_model_configs mc
      JOIN servers s ON s.server_id = mc.server_id
      WHERE s.server_disc_id = ${CATALOG_SERVER_ID}
    `;
    expect(modelConfig).toBeDefined();
    expect(modelConfig.llm_id).toBeGreaterThan(0);
    expect(modelConfig.api_key).not.toBeNull();

    const [byokConfig] = await testSql<Array<{ user_byok_mode: boolean }>>`
      SELECT bc.user_byok_mode
      FROM server_byok_configs bc
      JOIN servers s ON s.server_id = bc.server_id
      WHERE s.server_disc_id = ${CATALOG_SERVER_ID}
    `;
    expect(byokConfig.user_byok_mode).toBe(false);

    const [savedConfig] = await testSql<Array<{ provider: string; llm_id: number | null }>>`
      SELECT spc.provider, spc.llm_id
      FROM saved_provider_configs spc
      JOIN servers s ON s.server_id = spc.server_id
      WHERE s.server_disc_id = ${CATALOG_SERVER_ID} AND spc.provider = ${catalogProvider}
    `;
    expect(savedConfig).toBeDefined();
    expect(savedConfig.llm_id).toBe(modelConfig.llm_id);
  });

  it("sets up a workspace in user-byok mode without creating server provider rows", async () => {
    await serverRepository.setup(null, {
      serverId: BYOK_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriByok",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "user-byok",
      },
      systemPrompt: null,
    });

    const [byokConfig] = await testSql<Array<{ user_byok_mode: boolean }>>`
      SELECT bc.user_byok_mode
      FROM server_byok_configs bc
      JOIN servers s ON s.server_id = bc.server_id
      WHERE s.server_disc_id = ${BYOK_SERVER_ID}
    `;
    expect(byokConfig.user_byok_mode).toBe(true);

    const [modelConfig] = await testSql<Array<{ llm_id: number | null; api_key: Buffer | null }>>`
      SELECT mc.llm_id, mc.api_key
      FROM server_model_configs mc
      JOIN servers s ON s.server_id = mc.server_id
      WHERE s.server_disc_id = ${BYOK_SERVER_ID}
    `;
    expect(modelConfig.llm_id).toBeNull();
    expect(modelConfig.api_key).toBeNull();

    const savedRows = await testSql<Array<{ provider: string }>>`
      SELECT spc.provider
      FROM saved_provider_configs spc
      JOIN servers s ON s.server_id = spc.server_id
      WHERE s.server_disc_id = ${BYOK_SERVER_ID}
    `;
    expect(savedRows.length).toBe(0);
  });

  it("sets up a workspace in custom-endpoint mode with connection, synthetic model, and scoped registration", async () => {
    await serverRepository.setup(null, {
      serverId: CUSTOM_SERVER_ID,
      presetId,
      humanizer: 2,
      tomoriName: "TomoriCustom",
      timezoneOffset: 1,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "_rt_custom_ep",
          apiStyle: "openai-compatible",
          endpointUrl: "http://localhost:11434/v1",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "llama-3.3-70b",
          numCtx: 8192,
          capabilities: ["tools", "vision"],
        },
      },
      systemPrompt: null,
    });

    const [conn] = await testSql<Array<{ connection_id: number; endpoint_url: string }>>`
      SELECT cec.connection_id, cec.endpoint_url
      FROM custom_endpoint_connections cec
      JOIN servers s ON s.server_id = cec.server_id
      WHERE s.server_disc_id = ${CUSTOM_SERVER_ID}
    `;
    expect(conn).toBeDefined();
    expect(conn.endpoint_url).toBe("http://localhost:11434/v1");

    const customProvider = `custom:${conn.connection_id}`;
    const [syntheticModel] = await testSql<Array<{ llm_id: number; has_tools: boolean; sees_images: boolean }>>`
      SELECT llm_id, has_tools, sees_images
      FROM llms
      WHERE llm_provider = ${customProvider} AND llm_codename = 'llama-3.3-70b'
    `;
    expect(syntheticModel).toBeDefined();
    expect(syntheticModel.has_tools).toBe(true);
    expect(syntheticModel.sees_images).toBe(true);

    const [scopedReg] = await testSql<Array<{ scoped_model_registration_id: number }>>`
      SELECT smr.scoped_model_registration_id
      FROM scoped_model_registrations smr
      JOIN servers s ON s.server_id = smr.server_id
      WHERE s.server_disc_id = ${CUSTOM_SERVER_ID} AND smr.llm_id = ${syntheticModel.llm_id}
    `;
    expect(scopedReg).toBeDefined();

    const [ep] = await testSql<Array<{ model_ref_id: number | null; num_ctx: number | null }>>`
      SELECT ce.model_ref_id, ce.num_ctx
      FROM custom_endpoints ce
      WHERE ce.connection_id = ${conn.connection_id}
    `;
    expect(ep).toBeDefined();
    expect(ep.model_ref_id).toBe(syntheticModel.llm_id);
    expect(ep.num_ctx).toBe(8192);

    const [modelConfig] = await testSql<Array<{ llm_id: number | null; api_key: Buffer | null }>>`
      SELECT mc.llm_id, mc.api_key
      FROM server_model_configs mc
      JOIN servers s ON s.server_id = mc.server_id
      WHERE s.server_disc_id = ${CUSTOM_SERVER_ID}
    `;
    expect(modelConfig.llm_id).toBe(syntheticModel.llm_id);
    expect(modelConfig.api_key).not.toBeNull();
  });

  it("refuses a custom endpoint API style that lacks text capability", async () => {
    const call = serverRepository.setup(null, {
      serverId: "_rt_setup_invalid_style",
      presetId,
      humanizer: 1,
      tomoriName: "TomoriInvalid",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "_rt_invalid_ep",
          apiStyle: "comfyui",
          endpointUrl: "http://localhost:8188",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "sd-checkpoint",
        },
      },
      systemPrompt: null,
    });

    await expect(call).rejects.toThrow("does not support text capability");
  });

  it("writes NULL for built-in system prompt and custom string for preset prompt", async () => {
    await serverRepository.setup(null, {
      serverId: PROMPT_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriPrompt",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "user-byok",
      },
      systemPrompt: "You are a specialized mathematical tutor.",
    });

    const [chatConfig] = await testSql<Array<{ system_prompt: string | null }>>`
      SELECT cc.system_prompt
      FROM server_chat_configs cc
      JOIN servers s ON s.server_id = cc.server_id
      WHERE s.server_disc_id = ${PROMPT_SERVER_ID}
    `;
    expect(chatConfig.system_prompt).toBe("You are a specialized mathematical tutor.");

    const [byokChatConfig] = await testSql<Array<{ system_prompt: string | null }>>`
      SELECT cc.system_prompt
      FROM server_chat_configs cc
      JOIN servers s ON s.server_id = cc.server_id
      WHERE s.server_disc_id = ${BYOK_SERVER_ID}
    `;
    expect(byokChatConfig.system_prompt).toBeNull();
  });

  it("preserves alter personas and renames duplicates during orphan recovery", async () => {
    const [orphanServer] = await testSql<Array<{ server_id: number }>>`
      INSERT INTO servers (server_disc_id)
      VALUES (${ORPHAN_SERVER_ID})
      RETURNING server_id
    `;

    const [collidingAlter] = await testSql<Array<{ persona_id: number }>>`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${orphanServer.server_id}, 'TomoriDuplicate', true)
      RETURNING persona_id
    `;

    await serverRepository.setup(null, {
      serverId: ORPHAN_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriDuplicate",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "user-byok",
      },
      systemPrompt: null,
    });

    const personas = await testSql<Array<{ persona_nickname: string; is_alter: boolean }>>`
      SELECT persona_nickname, is_alter
      FROM personas
      WHERE server_id = ${orphanServer.server_id}
      ORDER BY is_alter ASC
    `;
    expect(personas.length).toBe(2);
    expect(personas[0].is_alter).toBe(false);
    expect(personas[0].persona_nickname).toBe("TomoriDuplicate");
    expect(personas[1].is_alter).toBe(true);
    expect(personas[1].persona_nickname).toBe(`TomoriDuplicate [dup-${collidingAlter.persona_id}]`);
  });

  it("rolls back every earlier write including orphan cleanup deletes upon late failure", async () => {
    const [server] = await testSql<Array<{ server_id: number }>>`
      INSERT INTO servers (server_disc_id)
      VALUES (${ROLLBACK_SERVER_ID})
      RETURNING server_id
    `;

    await testSql`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${server.server_id}, 'SurvivingAlter', true)
    `;

    // Seed pre-existing config rows representing the state before setup was retried.
    await testSql`
      INSERT INTO server_chat_configs (server_id, context_note)
      VALUES (${server.server_id}, '_rt_must_survive_rollback')
      ON CONFLICT (server_id) DO UPDATE SET context_note = EXCLUDED.context_note
    `;

    // A mock guild whose emoji collection contains an entry with a null identifier.
    // This trips a not-null database constraint on server_emojis at the very end of the transaction.
    const failingGuild = {
      emojis: {
        cache: new Map([["broken", { id: null as unknown as string, name: "boom", animated: false }]]),
      },
      stickers: {
        cache: new Map(),
      },
    } as unknown as Guild;

    const setupPromise = serverRepository.setup(failingGuild, {
      serverId: ROLLBACK_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriFails",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "user-byok",
      },
      systemPrompt: null,
    });

    await expect(setupPromise).rejects.toThrow();

    // Verify orphan cleanup was rolled back: the pre-existing config row remains intact.
    const [preservedChat] = await testSql<Array<{ context_note: string | null }>>`
      SELECT context_note FROM server_chat_configs WHERE server_id = ${server.server_id}
    `;
    expect(preservedChat).toBeDefined();
    expect(preservedChat.context_note).toBe("_rt_must_survive_rollback");

    // Verify no main persona was committed.
    const mainPersonas = await testSql<Array<{ persona_id: number }>>`
      SELECT persona_id FROM personas WHERE server_id = ${server.server_id} AND is_alter = false
    `;
    expect(mainPersonas.length).toBe(0);
  });

  it("never invalidates state cache during setup write transaction", async () => {
    const invalidateSpy = spyOn(cacheStore, "invalidateTomoriStateCache");

    await serverRepository.setup(null, {
      serverId: CACHE_SERVER_ID,
      presetId,
      humanizer: 1,
      tomoriName: "TomoriCacheCheck",
      timezoneOffset: 0,
      locale: "en-US",
      registrationLocale: "en-US",
      providerAccess: {
        mode: "user-byok",
      },
      systemPrompt: null,
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });
});
