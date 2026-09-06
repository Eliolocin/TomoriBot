/**
 * Regression harness: the atomic server configuration reset.
 *
 * Covers resetRepository.resetServerConfiguration: every accepted singleton returning to its DDL
 * defaults, both preserve sets surviving, all 11 collections emptied, missing split rows repaired,
 * quota usage and short-term-memory data surviving, and rollback leaving no partial state.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  SERVER_COLLECTION_RESET_TABLES,
  SERVER_SINGLETON_RESET_TABLES,
  resetRepository,
} from "@/utils/db/repositories/ResetRepository";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const CONTROL_SERVER_DISC_ID = "_rt_reset_control_001";

let targetServerId = 0;
let personaId = 0;
let userId = 0;
/** A server whose rows the reset created from scratch, holding pristine DDL defaults. */
let controlServerId = 0;
let seedLlmId: number | null = null;

/**
 * Reads one table's classified reset columns for a server.
 *
 * Uses `unsafe` because column and table identifiers cannot be bound as parameters. The identifiers
 * come from the reset classification constant, never from test input, and the server id is still
 * passed as a bound parameter.
 */
async function readResetColumns(
  table: string,
  columns: readonly string[],
  serverId: number,
): Promise<Record<string, unknown> | undefined> {
  const rows = await testSql.unsafe(`SELECT ${columns.join(", ")} FROM ${table} WHERE server_id = $1`, [serverId]);
  return rows[0] as Record<string, unknown> | undefined;
}

async function countRows(table: string, serverId: number): Promise<number> {
  const rows = await testSql.unsafe(`SELECT COUNT(*)::int AS n FROM ${table} WHERE server_id = $1`, [serverId]);
  return (rows[0] as { n: number }).n;
}

/** Writes a non-default value into every singleton the reset claims to restore. */
async function dirtyEverySingleton(serverId: number): Promise<void> {
  await testSql`
    INSERT INTO server_chat_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      humanizer_degree = 3, message_fetch_limit = 12, send_message_limit = 7, match_limit = 9,
      cascade_limit = 8, timezone_offset = 5, self_debug_enabled = true,
      model_randomizer_enabled = true, system_prompt = '_rt_authored_prompt',
      context_note = '_rt_authored_note', context_note_depth = 4,
      llm_stop_strings = ARRAY['_rt_stop']::TEXT[], llm_stop_speaker_pattern_enabled = true,
      llm_max_output_tokens = 321, llm_top_p = 0.11, llm_top_k = 42, llm_frequency_penalty = 0.7,
      llm_presence_penalty = 0.6, llm_min_p = 0.33, llm_logit_biases = '[{"_rt":1}]'::JSONB,
      fallback_model_refs = '[{"_rt":"ref"}]'::JSONB
  `;
  await testSql`
    INSERT INTO server_model_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      llm_temperature = 1.9, thinking_level = 'high',
      llm_disabled_params = ARRAY['_rt_param']::TEXT[],
      fallback_llm_ids = '[99]'::JSONB, hide_respond_embed = true
  `;
  await testSql`
    INSERT INTO server_member_permissions_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      server_memteaching_enabled = true, attribute_memteaching_enabled = true,
      sampledialogue_memteaching_enabled = true, self_teaching_enabled = false,
      personal_memories_enabled = false, hide_impersonation_embeds = true,
      prompt_snapshot_enabled = true
  `;
  await testSql`
    INSERT INTO server_capabilities_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      emoji_usage_enabled = false, sticker_usage_enabled = false, web_search_enabled = false,
      manage_message_enabled = false, thread_creation_enabled = false, imagegen_enabled = false,
      videogen_enabled = true, voice_message_enabled = false, user_blocking_enabled = false,
      time_awareness_enabled = false, tool_use_enabled = false, short_term_memory_enabled = false,
      verbatim_tool_calling_enabled = true, user_info_updates_enabled = false
  `;
  await testSql`
    INSERT INTO server_notice_embeds_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET tool_notice_hidden_keys = ARRAY['_rt_key']::TEXT[]
  `;
  await testSql`
    INSERT INTO server_nsfw_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      uncensor_injection_enabled = true, uncensor_unicode_space_enabled = true,
      uncensor_sanitize_enabled = true
  `;
  await testSql`
    INSERT INTO server_speech_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      voice_transcript_chat_mode = false, chatterbox_turbo_enabled = false,
      chatterbox_cfg_weight = 0.9, chatterbox_exaggeration = 0.8
  `;
  await testSql`
    INSERT INTO server_auto_trigger_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      autoch_disc_ids = ARRAY['_rt_channel']::TEXT[], autoch_threshold = 15,
      autoch_threshold_max = 30
  `;
  await testSql`
    INSERT INTO server_channel_scope_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      rp_channel_ids = ARRAY['_rt_rp']::TEXT[], private_channel_ids = ARRAY['_rt_priv']::TEXT[],
      crosschannel_blocklist_ids = ARRAY['_rt_block']::TEXT[], stm_privacy_bypass = true,
      thought_log_channel_disc_id = '_rt_thought'
  `;
  await testSql`
    INSERT INTO server_trigger_behavior_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      always_reply_enabled = true, deliberate_trigger_mode = true, deliberate_tool_mode = true,
      deliberate_tool_context_turns = 6, deliberate_tool_triggers = '{"_rt":true}'::JSONB,
      cooldown_type = 2, cooldown_length = 45
  `;
  await testSql`
    INSERT INTO server_novelai_imagegen_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      nai_preset_name = '_rt_preset',
      image_default_positive_tags = ARRAY['_rt_pos']::TEXT[],
      image_default_negative_tags = ARRAY['_rt_neg']::TEXT[],
      nai_sampler = '_rt_sampler', nai_steps = 41, nai_scale = 9.5,
      nai_noise_schedule = '_rt_schedule', nai_cfg_rescale = 0.9
  `;
  await testSql`
    INSERT INTO server_byok_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET user_byok_mode = true
  `;
  await testSql`
    INSERT INTO server_memory_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      memory_tagging_enabled = true, channel_memory_enabled = true
  `;
  await testSql`
    INSERT INTO server_stm_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      refresh_cadence = 17, render_mode = 'supersede', crude_message_count = 19,
      tool_description_override = '_rt_tool_override',
      update_nudge_override = '_rt_nudge_override',
      nudge_injection_depth = 7, content_injection_depth = 8
  `;
  await testSql`
    INSERT INTO server_welcome_configs (server_id) VALUES (${serverId})
    ON CONFLICT (server_id) DO UPDATE SET
      welcome_channel_disc_id = '_rt_welcome', welcome_prompt = '_rt_authored_welcome',
      welcome_persona_id = ${personaId}
  `;
  for (const table of ["image_quota_configs", "text_quota_configs", "video_quota_configs"]) {
    await testSql.unsafe(
      `INSERT INTO ${table} (server_id) VALUES ($1)
       ON CONFLICT (server_id) DO UPDATE SET
         daily_user_quota = 11, serverwide_quota = 222, serverwide_quota_resets_in = 33,
         enabled = true`,
      [serverId],
    );
  }
}

/** Puts one row in each of the 11 collections the reset empties. */
async function fillEveryCollection(serverId: number): Promise<void> {
  await testSql`
    INSERT INTO server_auto_trigger_persona_overrides (server_id, channel_disc_id, persona_id)
    VALUES (${serverId}, '_rt_ch_override', ${personaId})
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO stm_categories (server_id, position, label, description)
    VALUES (${serverId}, 0, '_rt_label', '_rt_description')
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO random_triggers (
      server_id, channel_disc_id, timer_hours, chance_percent, next_trigger_at
    ) VALUES (${serverId}, '_rt_ch_trigger', 4, 50, NOW() + INTERVAL '1 day')
  `;
  if (seedLlmId !== null) {
    await testSql`
      INSERT INTO channel_llm_overrides (server_id, channel_disc_id, llm_id)
      VALUES (${serverId}, '_rt_ch_llm', ${seedLlmId})
      ON CONFLICT DO NOTHING
    `;
  }
  await testSql`
    INSERT INTO channel_prompt_overrides (server_id, channel_disc_id, channel_prompt)
    VALUES (${serverId}, '_rt_ch_prompt', '_rt_prompt')
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO channel_context_notes (server_id, channel_disc_id, context_note)
    VALUES (${serverId}, '_rt_ch_note', '_rt_note')
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO personalization_blacklist (server_id, user_disc_id)
    VALUES (${serverId}, ${FIXTURE_IDS.userDiscId})
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO persona_user_blocks (
      server_id, persona_id, user_disc_id, block_type, reason, expires_at
    ) VALUES (
      ${serverId}, ${personaId}, ${FIXTURE_IDS.userDiscId}, 'mute', '_rt_reason',
      NOW() + INTERVAL '1 day'
    )
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO channel_whitelist (server_id, channel_disc_id)
    VALUES (${serverId}, '_rt_ch_white')
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO role_whitelist (server_id, role_disc_id)
    VALUES (${serverId}, '_rt_role_white')
    ON CONFLICT DO NOTHING
  `;
  await testSql`
    INSERT INTO channel_persona_whitelist (server_id, channel_disc_id, persona_id)
    VALUES (${serverId}, '_rt_ch_persona', ${personaId})
    ON CONFLICT DO NOTHING
  `;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Server configuration reset: regression", () => {
  beforeAll(async () => {
    await setupTestDb();
    const refs = await insertFixtures(testSql);
    targetServerId = refs.serverId;
    personaId = refs.personaId;
    userId = refs.userId;

    const [llmRow] = await testSql<Array<{ llm_id: number }>>`
      SELECT llm_id FROM llms ORDER BY llm_id LIMIT 1
    `;
    seedLlmId = llmRow?.llm_id ?? null;

    const [controlRow] = await testSql<Array<{ server_id: number }>>`
      INSERT INTO servers (server_disc_id) VALUES (${CONTROL_SERVER_DISC_ID})
      ON CONFLICT (server_disc_id) DO UPDATE SET server_disc_id = EXCLUDED.server_disc_id
      RETURNING server_id
    `;
    controlServerId = controlRow.server_id;

    // The control server has no config rows at all, so the reset creates them through its INSERT
    // branch. Comparing against it exercises a different branch from the target's ON CONFLICT
    // path, which is what makes a missing `= DEFAULT` visible.
    await resetRepository.resetServerConfiguration(controlServerId);

    await dirtyEverySingleton(targetServerId);
    await fillEveryCollection(targetServerId);
    await testSql`
      UPDATE server_model_configs
      SET api_key = '\\x5f7274'::BYTEA, key_version = 4, llm_id = ${seedLlmId},
          custom_endpoint_url = '_rt_endpoint', custom_model_name = '_rt_model',
          custom_num_ctx = 4096, other_model_codename = '_rt_codename',
          other_model_capabilities = '{"_rt":true}'::JSONB,
          other_model_capabilities_fetched_at = NOW()
      WHERE server_id = ${targetServerId}
    `;
    await testSql`
      INSERT INTO server_memories (server_id, persona_lineage_id, user_id, content)
      SELECT ${targetServerId}, persona_lineage_id, ${userId}, '_rt_surviving_memory'
      FROM personas WHERE persona_id = ${personaId}
    `;
    await testSql`
      INSERT INTO short_term_memories (server_disc_id, channel_disc_id, scope_kind, summary)
      VALUES (${FIXTURE_IDS.serverDiscId}, '_rt_ch_stm', 'server', '_rt_surviving_stm')
    `;
    await testSql`
      INSERT INTO image_quotas (server_id, user_disc_id, usage_count, quota_date)
      VALUES (${targetServerId}, ${FIXTURE_IDS.userDiscId}, 17, CURRENT_DATE)
      ON CONFLICT DO NOTHING
    `;
    await testSql`
      INSERT INTO image_serverwide_quotas (server_id, usage_count, quota_period_end)
      VALUES (${targetServerId}, 23, NOW() + INTERVAL '30 days')
      ON CONFLICT (server_id) DO UPDATE SET usage_count = EXCLUDED.usage_count
    `;

    await resetRepository.resetServerConfiguration(targetServerId);
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${CONTROL_SERVER_DISC_ID}`;
    await cleanupFixtures(testSql);
  });

  describe("singleton defaults", () => {
    for (const entry of SERVER_SINGLETON_RESET_TABLES) {
      it(`restores every classified reset column of ${entry.table}`, async () => {
        const target = await readResetColumns(entry.table, entry.reset, targetServerId);
        const control = await readResetColumns(entry.table, entry.reset, controlServerId);
        expect(target).toBeDefined();
        expect(control).toBeDefined();
        const drifted = entry.reset.filter(
          (column) => JSON.stringify(target?.[column]) !== JSON.stringify(control?.[column]),
        );
        expect(drifted).toEqual([]);
      });
    }

    it("restores the temperature the legacy reset got wrong", async () => {
      const [row] = await testSql<Array<{ llm_temperature: number }>>`
        SELECT llm_temperature FROM server_model_configs WHERE server_id = ${targetServerId}
      `;
      expect(row.llm_temperature).toBeCloseTo(1.0, 5);
    });

    it("clears authored prompts, notes and tag lists", async () => {
      const [chat] = await testSql<Array<{ system_prompt: string | null; context_note: string | null }>>`
        SELECT system_prompt, context_note FROM server_chat_configs WHERE server_id = ${targetServerId}
      `;
      expect(chat.system_prompt).toBeNull();
      expect(chat.context_note).toBeNull();

      const [welcome] = await testSql<Array<{ welcome_prompt: string | null }>>`
        SELECT welcome_prompt FROM server_welcome_configs WHERE server_id = ${targetServerId}
      `;
      expect(welcome.welcome_prompt).toBeNull();

      const [stm] = await testSql<
        Array<{ tool_description_override: string | null; update_nudge_override: string | null }>
      >`
        SELECT tool_description_override, update_nudge_override
        FROM server_stm_configs WHERE server_id = ${targetServerId}
      `;
      expect(stm.tool_description_override).toBeNull();
      expect(stm.update_nudge_override).toBeNull();
    });
  });

  describe("preserve sets", () => {
    it("preserves model identity, credentials and endpoint identity", async () => {
      const [row] = await testSql<
        Array<{
          api_key: Uint8Array | null;
          key_version: number;
          llm_id: number | null;
          custom_endpoint_url: string | null;
          custom_model_name: string | null;
          custom_num_ctx: number | null;
          other_model_codename: string | null;
          other_model_capabilities: unknown;
          other_model_capabilities_fetched_at: Date | null;
        }>
      >`
        SELECT api_key, key_version, llm_id, custom_endpoint_url, custom_model_name,
               custom_num_ctx, other_model_codename, other_model_capabilities,
               other_model_capabilities_fetched_at
        FROM server_model_configs WHERE server_id = ${targetServerId}
      `;
      expect(row.api_key).not.toBeNull();
      expect(row.key_version).toBe(4);
      expect(row.llm_id).toBe(seedLlmId);
      expect(row.custom_endpoint_url).toBe("_rt_endpoint");
      expect(row.custom_model_name).toBe("_rt_model");
      expect(row.custom_num_ctx).toBe(4096);
      expect(row.other_model_codename).toBe("_rt_codename");
      expect(row.other_model_capabilities).not.toBeNull();
      expect(row.other_model_capabilities_fetched_at).not.toBeNull();
    });

    it("preserves the selected NovelAI diffusion model", async () => {
      await testSql`
        UPDATE server_novelai_imagegen_configs
        SET nai_diffusion_model_id = (SELECT diffusion_model_id FROM image_diffusion_models LIMIT 1)
        WHERE server_id = ${targetServerId}
      `;
      const [before] = await testSql<Array<{ nai_diffusion_model_id: number | null }>>`
        SELECT nai_diffusion_model_id FROM server_novelai_imagegen_configs
        WHERE server_id = ${targetServerId}
      `;
      await resetRepository.resetServerConfiguration(targetServerId);
      const [after] = await testSql<Array<{ nai_diffusion_model_id: number | null }>>`
        SELECT nai_diffusion_model_id FROM server_novelai_imagegen_configs
        WHERE server_id = ${targetServerId}
      `;
      expect(after.nai_diffusion_model_id).toBe(before.nai_diffusion_model_id);
    });
  });

  describe("collections", () => {
    for (const table of SERVER_COLLECTION_RESET_TABLES) {
      it(`empties ${table} for the server`, async () => {
        expect(await countRows(table, targetServerId)).toBe(0);
      });
    }

    it("filled every collection before the reset, so the assertions above are not vacuous", async () => {
      await fillEveryCollection(controlServerId);
      const counts = await Promise.all(
        SERVER_COLLECTION_RESET_TABLES.map((table) => countRows(table, controlServerId)),
      );
      // channel_llm_overrides is only fillable when the seeded llm catalog is present.
      const expected = seedLlmId === null ? 10 : 11;
      expect(counts.filter((count) => count > 0)).toHaveLength(expected);
    });
  });

  describe("survival", () => {
    it("preserves server memories", async () => {
      const [row] = await testSql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM server_memories
        WHERE server_id = ${targetServerId} AND content = '_rt_surviving_memory'
      `;
      expect(row.n).toBe(1);
    });

    it("preserves short-term memory data while clearing its categories", async () => {
      const [stm] = await testSql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM short_term_memories
        WHERE server_disc_id = ${FIXTURE_IDS.serverDiscId} AND summary = '_rt_surviving_stm'
      `;
      expect(stm.n).toBe(1);
      expect(await countRows("stm_categories", targetServerId)).toBe(0);
    });

    it("preserves recorded quota usage while resetting quota settings", async () => {
      const [perUser] = await testSql<Array<{ usage_count: number }>>`
        SELECT usage_count FROM image_quotas
        WHERE server_id = ${targetServerId} AND user_disc_id = ${FIXTURE_IDS.userDiscId}
      `;
      expect(perUser.usage_count).toBe(17);

      const [serverwide] = await testSql<Array<{ usage_count: number }>>`
        SELECT usage_count FROM image_serverwide_quotas WHERE server_id = ${targetServerId}
      `;
      expect(serverwide.usage_count).toBe(23);

      const [config] = await testSql<Array<{ daily_user_quota: number; enabled: boolean }>>`
        SELECT daily_user_quota, enabled FROM image_quota_configs
        WHERE server_id = ${targetServerId}
      `;
      expect(config.daily_user_quota).toBe(0);
      expect(config.enabled).toBe(false);
    });
  });

  describe("missing row repair", () => {
    it("recreates a split row that setup never seeded", async () => {
      await testSql`DELETE FROM server_stm_configs WHERE server_id = ${targetServerId}`;
      await testSql`DELETE FROM server_chat_configs WHERE server_id = ${targetServerId}`;
      await resetRepository.resetServerConfiguration(targetServerId);

      const [stm] = await testSql<Array<{ refresh_cadence: number }>>`
        SELECT refresh_cadence FROM server_stm_configs WHERE server_id = ${targetServerId}
      `;
      expect(stm).toBeDefined();
      expect(stm.refresh_cadence).toBe(5);

      const [chat] = await testSql<Array<{ humanizer_degree: number }>>`
        SELECT humanizer_degree FROM server_chat_configs WHERE server_id = ${targetServerId}
      `;
      expect(chat).toBeDefined();
      expect(chat.humanizer_degree).toBe(1);
    });
  });

  describe("rollback", () => {
    it("leaves no partial state when a statement fails", async () => {
      await testSql`
        UPDATE server_chat_configs SET humanizer_degree = 3, system_prompt = '_rt_rollback_prompt'
        WHERE server_id = ${targetServerId}
      `;
      await testSql.unsafe(`
        CREATE OR REPLACE FUNCTION _rt_reset_injected_failure() RETURNS TRIGGER AS $fn$
        BEGIN RAISE EXCEPTION '_rt injected reset failure'; END;
        $fn$ LANGUAGE plpgsql;
      `);
      // Statement-level so it fires even when the table holds no rows for this server; a row-level
      // trigger would silently never run and the rollback assertion would prove nothing.
      await testSql.unsafe(`
        CREATE TRIGGER _rt_reset_injected_failure_trg
        BEFORE DELETE ON channel_persona_whitelist
        FOR EACH STATEMENT EXECUTE FUNCTION _rt_reset_injected_failure();
      `);

      try {
        await expect(resetRepository.resetServerConfiguration(targetServerId)).rejects.toThrow();

        const [row] = await testSql<Array<{ humanizer_degree: number; system_prompt: string | null }>>`
          SELECT humanizer_degree, system_prompt FROM server_chat_configs
          WHERE server_id = ${targetServerId}
        `;
        expect(row.humanizer_degree).toBe(3);
        expect(row.system_prompt).toBe("_rt_rollback_prompt");
      } finally {
        await testSql.unsafe("DROP TRIGGER IF EXISTS _rt_reset_injected_failure_trg ON channel_persona_whitelist;");
        await testSql.unsafe("DROP FUNCTION IF EXISTS _rt_reset_injected_failure();");
      }
    });
  });
});
