/**
 * Regression harness: atomic personal configuration reset.
 *
 * Covers resetRepository.resetPersonalConfiguration:
 * - Resets language_pref to 'en-US' and privacy_level to 0 in users table.
 * - Preserves registration_locale.
 * - Resets all 13 columns in user_personalization_configs to DDL defaults.
 * - Deletes user_persona_naming_preferences for the user.
 * - Deletes all personal_spotlights for the user across workspaces, cascading to personal_spotlight_personas.
 * - Returns the distinct internal server IDs whose spotlights were deleted.
 * - Proves reminders, user_saved_provider_configs, personal_memories, and personas survive.
 * - Proves missing user_personalization_configs row is repaired with DDL defaults.
 * - Proves atomic rollback when a statement fails mid-transaction.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetRepository } from "@/utils/db/repositories/ResetRepository";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const SERVER_DISC_ID_B = "_rt_server_personal_reset_002";
const CONTROL_USER_DISC_ID = "_rt_user_control_personal_001";
const MISSING_ROW_USER_DISC_ID = "_rt_user_missing_config_001";

let targetUserId = 0;
let targetUserDiscId = "";
let serverIdA = 0;
let serverIdB = 0;
let personaLineageId = 0;
let controlUserId = 0;

async function dirtyPersonalSingletons(userId: number): Promise<void> {
  await testSql`
    UPDATE users
    SET
      language_pref = 'ja',
      privacy_level = 2,
      registration_locale = 'ja-JP',
      updated_at = NOW()
    WHERE user_id = ${userId}
  `;

  await testSql`
    INSERT INTO user_personalization_configs (
      user_id,
      user_nickname,
      shortterm_cache_crossserver_opt_in,
      physical_appearance_tags,
      nai_char_ref_url,
      impersonation_prompt,
      personal_dtm,
      personal_deliberate_tool_mode,
      timezone_offset,
      prefix_override,
      suffix_override,
      gender_identity,
      pronouns,
      addressing_style
    ) VALUES (
      ${userId},
      '_rt_dirty_nickname',
      true,
      ARRAY['tag1', 'tag2']::TEXT[],
      'https://example.com/character.png',
      '_rt_impersonate_prompt',
      'never',
      'never',
      9,
      'pre_',
      '_suf',
      'non-binary',
      'they/them',
      'neutral'
    )
    ON CONFLICT (user_id) DO UPDATE SET
      user_nickname = EXCLUDED.user_nickname,
      shortterm_cache_crossserver_opt_in = EXCLUDED.shortterm_cache_crossserver_opt_in,
      physical_appearance_tags = EXCLUDED.physical_appearance_tags,
      nai_char_ref_url = EXCLUDED.nai_char_ref_url,
      impersonation_prompt = EXCLUDED.impersonation_prompt,
      personal_dtm = EXCLUDED.personal_dtm,
      personal_deliberate_tool_mode = EXCLUDED.personal_deliberate_tool_mode,
      timezone_offset = EXCLUDED.timezone_offset,
      prefix_override = EXCLUDED.prefix_override,
      suffix_override = EXCLUDED.suffix_override,
      gender_identity = EXCLUDED.gender_identity,
      pronouns = EXCLUDED.pronouns,
      addressing_style = EXCLUDED.addressing_style,
      updated_at = NOW()
  `;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Atomic personal configuration reset: regression", () => {
  beforeAll(async () => {
    await setupTestDb();
    const refs = await insertFixtures(testSql);
    targetUserId = refs.userId;
    targetUserDiscId = FIXTURE_IDS.userDiscId;
    serverIdA = refs.serverId;
    personaLineageId = refs.personaLineageId;

    // A second server verifies that spotlight deletion is cross-server and user-scoped.
    const [serverBRow] = await testSql`
      INSERT INTO servers (server_disc_id)
      VALUES (${SERVER_DISC_ID_B})
      ON CONFLICT (server_disc_id) DO UPDATE SET server_disc_id = EXCLUDED.server_disc_id
      RETURNING server_id
    `;
    serverIdB = serverBRow.server_id;

    // Control user provides baseline DDL defaults unpolluted by test writes.
    const [controlRow] = await testSql`
      INSERT INTO users (user_disc_id)
      VALUES (${CONTROL_USER_DISC_ID})
      ON CONFLICT (user_disc_id) DO UPDATE SET user_disc_id = EXCLUDED.user_disc_id
      RETURNING user_id
    `;
    controlUserId = controlRow.user_id;

    await testSql`
      INSERT INTO user_personalization_configs (user_id)
      VALUES (${controlUserId})
      ON CONFLICT (user_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SERVER_DISC_ID_B}`;
    await testSql`DELETE FROM users WHERE user_disc_id IN (${CONTROL_USER_DISC_ID}, ${MISSING_ROW_USER_DISC_ID})`;
    await cleanupFixtures(testSql);
  });

  describe("happy path reset", () => {
    it("restores all personal singletons, deletes spotlights and preferences, and returns affected server IDs", async () => {
      await dirtyPersonalSingletons(targetUserId);

      // Seed naming preferences
      await testSql`
        INSERT INTO user_persona_naming_preferences (user_id, persona_lineage_id, nickname_override)
        VALUES (${targetUserId}, ${personaLineageId}, '_rt_preferred_nick')
        ON CONFLICT (user_id, persona_lineage_id) DO UPDATE SET nickname_override = EXCLUDED.nickname_override
      `;

      // Seed personal spotlights across serverIdA and serverIdB
      await testSql`
        INSERT INTO personal_spotlights (server_id, user_id, channel_disc_id)
        VALUES (${serverIdA}, ${targetUserId}, 'channel_a_1')
        ON CONFLICT (server_id, user_id, channel_disc_id) DO NOTHING
      `;
      await testSql`
        INSERT INTO personal_spotlights (server_id, user_id, channel_disc_id)
        VALUES (${serverIdB}, ${targetUserId}, 'channel_b_1')
        ON CONFLICT (server_id, user_id, channel_disc_id) DO NOTHING
      `;

      // Seed child rows in personal_spotlight_personas to verify cascade
      const [persona] = await testSql<Array<{ persona_id: number }>>`
        SELECT persona_id FROM personas WHERE server_id = ${serverIdA} LIMIT 1
      `;
      expect(persona).toBeDefined();
      await testSql`
        INSERT INTO personal_spotlight_personas (server_id, user_id, channel_disc_id, persona_id)
        VALUES (${serverIdA}, ${targetUserId}, 'channel_a_1', ${persona.persona_id})
        ON CONFLICT (server_id, user_id, channel_disc_id, persona_id) DO NOTHING
      `;
      const [childBefore] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM personal_spotlight_personas WHERE user_id = ${targetUserId}
      `;
      expect(childBefore.count).toBe(1);

      // Seed user-associated data that MUST SURVIVE
      await testSql`
        INSERT INTO reminders (server_id, channel_disc_id, user_discord_id, user_nickname, reminder_purpose, reminder_time, created_by_user_id)
        VALUES (${serverIdA}, 'chan_remind', ${targetUserDiscId}, 'Nick', '_rt_surviving_reminder', NOW() + INTERVAL '1 day', ${targetUserId})
      `;
      await testSql`
        INSERT INTO user_saved_provider_configs (user_id, provider, saved_at, updated_at)
        VALUES (${targetUserId}, 'openrouter', NOW(), NOW())
        ON CONFLICT (user_id, provider) DO NOTHING
      `;
      await testSql`
        INSERT INTO personal_memories (user_id, persona_lineage_id, content, created_at, updated_at)
        VALUES (${targetUserId}, ${personaLineageId}, '_rt_surviving_personal_memory', NOW(), NOW())
      `;

      // Execute personal reset
      const result = await resetRepository.resetPersonalConfiguration(targetUserId);

      expect(result).not.toBeNull();
      expect(result?.userDiscId).toBe(targetUserDiscId);
      expect(result?.affectedServerIds.sort()).toEqual([serverIdA, serverIdB].sort());

      // Verify users table reset and preserve
      const [userRow] = await testSql<
        Array<{ language_pref: string; privacy_level: number; registration_locale: string | null }>
      >`
        SELECT language_pref, privacy_level, registration_locale
        FROM users
        WHERE user_id = ${targetUserId}
      `;
      expect(userRow.language_pref).toBe("en-US");
      expect(userRow.privacy_level).toBe(0);
      expect(userRow.registration_locale).toBe("ja-JP"); // Preserved!

      // Verify user_personalization_configs reset to DDL defaults
      const [configRow] = await testSql<Array<Record<string, unknown>>>`
        SELECT
          user_nickname,
          shortterm_cache_crossserver_opt_in,
          physical_appearance_tags,
          nai_char_ref_url,
          impersonation_prompt,
          personal_dtm,
          personal_deliberate_tool_mode,
          timezone_offset,
          prefix_override,
          suffix_override,
          gender_identity,
          pronouns,
          addressing_style
        FROM user_personalization_configs
        WHERE user_id = ${targetUserId}
      `;

      expect(configRow.user_nickname).toBeNull();
      expect(configRow.shortterm_cache_crossserver_opt_in).toBe(false);
      expect(configRow.physical_appearance_tags).toEqual([]);
      expect(configRow.nai_char_ref_url).toBeNull();
      expect(configRow.impersonation_prompt).toBeNull();
      expect(configRow.personal_dtm).toBe("follow");
      expect(configRow.personal_deliberate_tool_mode).toBe("follow");
      expect(configRow.timezone_offset).toBeNull();
      expect(configRow.prefix_override).toBeNull();
      expect(configRow.suffix_override).toBeNull();
      expect(configRow.gender_identity).toBeNull();
      expect(configRow.pronouns).toBeNull();
      expect(configRow.addressing_style).toBeNull();

      // Verify user_persona_naming_preferences deleted
      const [namingCount] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM user_persona_naming_preferences WHERE user_id = ${targetUserId}
      `;
      expect(namingCount.count).toBe(0);

      // Verify personal_spotlights and cascade deleted
      const [spotlightCount] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM personal_spotlights WHERE user_id = ${targetUserId}
      `;
      expect(spotlightCount.count).toBe(0);

      const [childCount] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM personal_spotlight_personas WHERE user_id = ${targetUserId}
      `;
      expect(childCount.count).toBe(0);

      // Verify surviving tables
      const [reminder] = await testSql<Array<{ reminder_purpose: string }>>`
        SELECT reminder_purpose FROM reminders WHERE user_discord_id = ${targetUserDiscId}
      `;
      expect(reminder?.reminder_purpose).toBe("_rt_surviving_reminder");

      const [providerRow] = await testSql<Array<{ provider: string }>>`
        SELECT provider FROM user_saved_provider_configs WHERE user_id = ${targetUserId}
      `;
      expect(providerRow?.provider).toBe("openrouter");

      const [memory] = await testSql<Array<{ content: string }>>`
        SELECT content FROM personal_memories WHERE user_id = ${targetUserId}
      `;
      expect(memory?.content).toBe("_rt_surviving_personal_memory");

      const [survivingPersona] = await testSql<Array<{ persona_id: number; persona_nickname: string }>>`
        SELECT persona_id, persona_nickname FROM personas WHERE persona_id = ${persona.persona_id}
      `;
      expect(survivingPersona).toBeDefined();
      expect(survivingPersona.persona_nickname).toBe("_rt_persona");
    });

    it("proves user_saved_provider_configs, personal_memories, and reminders are never written, while spotlight reset is reported", async () => {
      // Seed user-associated records that must survive reset
      const [reminderInsert] = await testSql<Array<{ reminder_id: number }>>`
        INSERT INTO reminders (server_id, channel_disc_id, user_discord_id, user_nickname, reminder_purpose, reminder_time, created_by_user_id)
        VALUES (${serverIdA}, 'chan_remind_unwritten', ${targetUserDiscId}, 'Nick', '_rt_surviving_reminder_unwritten', NOW() + INTERVAL '1 day', ${targetUserId})
        RETURNING reminder_id
      `;
      await testSql`
        INSERT INTO user_saved_provider_configs (user_id, provider, saved_at, updated_at)
        VALUES (${targetUserId}, 'openrouter', NOW(), NOW())
        ON CONFLICT (user_id, provider) DO UPDATE SET updated_at = NOW()
      `;
      const [memoryInsert] = await testSql<Array<{ personal_memory_id: number }>>`
        INSERT INTO personal_memories (user_id, persona_lineage_id, content, created_at, updated_at)
        VALUES (${targetUserId}, ${personaLineageId}, '_rt_surviving_personal_memory_unwritten', NOW(), NOW())
        RETURNING personal_memory_id
      `;

      // Seed spotlight to verify report and deletion
      await testSql`
        INSERT INTO personal_spotlights (server_id, user_id, channel_disc_id)
        VALUES (${serverIdA}, ${targetUserId}, 'channel_unwritten_test')
        ON CONFLICT (server_id, user_id, channel_disc_id) DO NOTHING
      `;

      // Snapshot full row state prior to reset
      const [preReminder] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM reminders WHERE reminder_id = ${reminderInsert.reminder_id}
      `;
      const [preProvider] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM user_saved_provider_configs WHERE user_id = ${targetUserId} AND provider = 'openrouter'
      `;
      const [preMemory] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM personal_memories WHERE personal_memory_id = ${memoryInsert.personal_memory_id}
      `;
      const [preSpotlight] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM personal_spotlights WHERE user_id = ${targetUserId} AND channel_disc_id = 'channel_unwritten_test'
      `;
      expect(preSpotlight.count).toBe(1);

      const result = await resetRepository.resetPersonalConfiguration(targetUserId);

      // Proves spotlight reset is reported and rows deleted
      expect(result).not.toBeNull();
      expect(result?.affectedServerIds).toContain(serverIdA);

      const [postSpotlight] = await testSql<Array<{ count: number }>>`
        SELECT COUNT(*)::int as count FROM personal_spotlights WHERE user_id = ${targetUserId} AND channel_disc_id = 'channel_unwritten_test'
      `;
      expect(postSpotlight.count).toBe(0);

      // Proves user_saved_provider_configs, personal_memories, and reminders were completely untouched
      const [postReminder] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM reminders WHERE reminder_id = ${reminderInsert.reminder_id}
      `;
      expect(postReminder).toEqual(preReminder);

      const [postProvider] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM user_saved_provider_configs WHERE user_id = ${targetUserId} AND provider = 'openrouter'
      `;
      expect(postProvider).toEqual(preProvider);

      const [postMemory] = await testSql<Array<Record<string, unknown>>>`
        SELECT * FROM personal_memories WHERE personal_memory_id = ${memoryInsert.personal_memory_id}
      `;
      expect(postMemory).toEqual(preMemory);
    });
  });

  describe("missing row repair", () => {
    it("creates user_personalization_configs with DDL defaults if it was missing", async () => {
      const [missingRowUser] = await testSql`
        INSERT INTO users (user_disc_id)
        VALUES (${MISSING_ROW_USER_DISC_ID})
        ON CONFLICT (user_disc_id) DO UPDATE SET user_disc_id = EXCLUDED.user_disc_id
        RETURNING user_id
      `;
      const missingUserId: number = missingRowUser.user_id;

      // Ensure no personalization config exists
      await testSql`DELETE FROM user_personalization_configs WHERE user_id = ${missingUserId}`;

      const result = await resetRepository.resetPersonalConfiguration(missingUserId);
      expect(result).not.toBeNull();
      expect(result?.userDiscId).toBe(MISSING_ROW_USER_DISC_ID);

      const [config] = await testSql<Array<{ personal_dtm: string; shortterm_cache_crossserver_opt_in: boolean }>>`
        SELECT personal_dtm, shortterm_cache_crossserver_opt_in
        FROM user_personalization_configs
        WHERE user_id = ${missingUserId}
      `;
      expect(config).toBeDefined();
      expect(config.personal_dtm).toBe("follow");
      expect(config.shortterm_cache_crossserver_opt_in).toBe(false);
    });
  });

  describe("rollback", () => {
    it("leaves no partial state when a statement fails mid-transaction", async () => {
      await dirtyPersonalSingletons(targetUserId);

      await testSql.unsafe(`
        CREATE OR REPLACE FUNCTION _rt_personal_reset_injected_failure() RETURNS TRIGGER AS $fn$
        BEGIN RAISE EXCEPTION '_rt injected personal reset failure'; END;
        $fn$ LANGUAGE plpgsql;
      `);

      await testSql.unsafe(`
        CREATE TRIGGER _rt_personal_reset_injected_failure_trg
        BEFORE DELETE ON user_persona_naming_preferences
        FOR EACH STATEMENT EXECUTE FUNCTION _rt_personal_reset_injected_failure();
      `);

      try {
        await expect(resetRepository.resetPersonalConfiguration(targetUserId)).rejects.toThrow(
          "_rt injected personal reset failure",
        );

        // Transaction failure must leave dirty user state unchanged.
        const [userRow] = await testSql<Array<{ language_pref: string; privacy_level: number }>>`
          SELECT language_pref, privacy_level FROM users WHERE user_id = ${targetUserId}
        `;
        expect(userRow.language_pref).toBe("ja");
        expect(userRow.privacy_level).toBe(2);

        // Transaction failure must leave dirty personalization columns unchanged.
        const [configRow] = await testSql<Array<{ user_nickname: string | null }>>`
          SELECT user_nickname FROM user_personalization_configs WHERE user_id = ${targetUserId}
        `;
        expect(configRow.user_nickname).toBe("_rt_dirty_nickname");
      } finally {
        await testSql.unsafe(
          "DROP TRIGGER IF EXISTS _rt_personal_reset_injected_failure_trg ON user_persona_naming_preferences;",
        );
        await testSql.unsafe("DROP FUNCTION IF EXISTS _rt_personal_reset_injected_failure();");
      }
    });
  });
});
