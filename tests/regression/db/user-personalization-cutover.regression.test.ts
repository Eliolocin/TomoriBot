/**
 * Regression harness: user_personalization_configs cutover.
 *
 * Covers the Phase 6 follow-up that moved five user-scoped personalization
 * fields from users into user_personalization_configs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { loadUserNaiProfileByDiscordId } from "@/tools/functionCalls/generateImageNaiTool";
import { PrivacyLevel } from "@/types/db/schema";
import { clearUserCache } from "@/utils/cache/userCache";
import { exportRepository, importRepository, userNamingRepository, userRepository } from "@/utils/db/repositories";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

async function executeSqlFile(filePath: string): Promise<void> {
  const sqlText = await readFile(filePath, "utf-8");
  for (const stmt of splitSqlStatements(sqlText)) {
    await testSql.unsafe(stmt);
  }
}

function normalizeExportTimestamp<T extends { exported_at: string }>(exportData: T, exportedAt: string): T {
  return { ...exportData, exported_at: exportedAt };
}

describe.skipIf(!DB_TESTS_AVAILABLE)("User personalization config cutover", () => {
  let refs: FixtureRefs;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
  });

  afterAll(async () => {
    clearUserCache();
    await cleanupFixtures(testSql);
  });

  it("writes physical appearance tags to the split table and reads them through loadByDiscordId", async () => {
    clearUserCache();

    const updated = await userRepository.update(refs.userId, {
      physical_appearance_tags: ["silver hair", "green eyes"],
      nai_char_ref_url: "https://example.invalid/split-profile.png",
    });
    expect(updated?.physical_appearance_tags).toEqual(["silver hair", "green eyes"]);

    const usersMirrorColumns = await testSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'physical_appearance_tags'
    `;
    expect(usersMirrorColumns).toHaveLength(0);

    const [splitRow] = await testSql`
      SELECT physical_appearance_tags
      FROM user_personalization_configs
      WHERE user_id = ${refs.userId}
    `;
    expect(splitRow.physical_appearance_tags).toEqual(["silver hair", "green eyes"]);

    const reloaded = await userRepository.loadByDiscordId(FIXTURE_IDS.userDiscId);
    expect(reloaded?.physical_appearance_tags).toEqual(["silver hair", "green eyes"]);

    const naiProfile = await loadUserNaiProfileByDiscordId(FIXTURE_IDS.userDiscId);
    expect(naiProfile).toEqual({
      tags: ["silver hair", "green eyes"],
      refUrl: "https://example.invalid/split-profile.png",
    });
  });

  it("defaults all five personalization fields and the opt-in fast path when a split row is missing", async () => {
    const userDiscId = "_rt_user_no_personalization_row";
    const registered = await userRepository.register(userDiscId, "_rt_no_split", "en");
    if (!registered?.user_id) throw new Error("Expected registered user to have a user_id");

    await testSql`
      DELETE FROM user_personalization_configs
      WHERE user_id = ${registered.user_id}
    `;
    clearUserCache();

    const loaded = await userRepository.loadByDiscordId(userDiscId);
    expect(loaded?.shortterm_cache_crossserver_opt_in).toBe(false);
    expect(loaded?.physical_appearance_tags).toEqual([]);
    expect(loaded?.nai_char_ref_url).toBeNull();
    expect(loaded?.impersonation_prompt).toBeNull();
    expect(loaded?.personal_dtm).toBe("follow");

    await testSql`
      DELETE FROM user_personalization_configs
      WHERE user_id = ${registered.user_id}
    `;
    clearUserCache();

    const fastPathDefault = await userRepository.getCrossServerShmOptIn(userDiscId);
    expect(fastPathDefault).toBe(false);

    const toggled = await userRepository.toggleCrossServerShmOptIn(userDiscId);
    expect(toggled).toBe(true);

    const [splitRow] = await testSql`
      SELECT shortterm_cache_crossserver_opt_in
      FROM user_personalization_configs
      WHERE user_id = ${registered.user_id}
    `;
    expect(splitRow.shortterm_cache_crossserver_opt_in).toBe(true);
  });

  it("migration 043 overwrites stale split rows with users-table drift", async () => {
    const userDiscId = "_rt_user_personalization_drift";
    const [userRow] = await testSql`
      INSERT INTO users (user_disc_id, language_pref)
      VALUES (${userDiscId}, 'en')
      ON CONFLICT (user_disc_id) DO UPDATE
      SET language_pref = EXCLUDED.language_pref
      RETURNING user_id
    `;
    const userId: number = userRow.user_id;

    await testSql`
      INSERT INTO user_personalization_configs (
        user_id,
        shortterm_cache_crossserver_opt_in,
        physical_appearance_tags,
        nai_char_ref_url,
        impersonation_prompt,
        personal_dtm
      ) VALUES (
        ${userId},
        false,
        ARRAY['stale split']::TEXT[],
        'https://example.invalid/stale.png',
        'stale prompt',
        'off'
      )
      ON CONFLICT (user_id) DO UPDATE
      SET
        shortterm_cache_crossserver_opt_in = EXCLUDED.shortterm_cache_crossserver_opt_in,
        physical_appearance_tags = EXCLUDED.physical_appearance_tags,
        nai_char_ref_url = EXCLUDED.nai_char_ref_url,
        impersonation_prompt = EXCLUDED.impersonation_prompt,
        personal_dtm = EXCLUDED.personal_dtm
    `;

    try {
      await testSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS shortterm_cache_crossserver_opt_in BOOLEAN DEFAULT false`;
      await testSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS physical_appearance_tags TEXT[] DEFAULT ARRAY[]::TEXT[]`;
      await testSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS nai_char_ref_url TEXT`;
      await testSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS impersonation_prompt TEXT`;
      await testSql`ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_dtm TEXT DEFAULT 'follow'`;

      await testSql`
        UPDATE users
        SET
          shortterm_cache_crossserver_opt_in = true,
          physical_appearance_tags = ARRAY['live users']::TEXT[],
          nai_char_ref_url = 'https://example.invalid/live.png',
          impersonation_prompt = 'live prompt',
          personal_dtm = 'on'
        WHERE user_id = ${userId}
      `;

      await executeSqlFile(
        path.join(process.cwd(), "src", "db", "migrations", "043_backfill_user_personalization_drift.sql"),
      );

      const [splitRow] = await testSql`
        SELECT
          shortterm_cache_crossserver_opt_in,
          physical_appearance_tags,
          nai_char_ref_url,
          impersonation_prompt,
          personal_dtm
        FROM user_personalization_configs
        WHERE user_id = ${userId}
      `;

      expect(splitRow.shortterm_cache_crossserver_opt_in).toBe(true);
      expect(splitRow.physical_appearance_tags).toEqual(["live users"]);
      expect(splitRow.nai_char_ref_url).toBe("https://example.invalid/live.png");
      expect(splitRow.impersonation_prompt).toBe("live prompt");
      expect(splitRow.personal_dtm).toBe("on");
    } finally {
      await testSql`ALTER TABLE users DROP COLUMN IF EXISTS shortterm_cache_crossserver_opt_in`;
      await testSql`ALTER TABLE users DROP COLUMN IF EXISTS physical_appearance_tags`;
      await testSql`ALTER TABLE users DROP COLUMN IF EXISTS nai_char_ref_url`;
      await testSql`ALTER TABLE users DROP COLUMN IF EXISTS impersonation_prompt`;
      await testSql`ALTER TABLE users DROP COLUMN IF EXISTS personal_dtm`;
      clearUserCache();
    }
  });

  it("migration 062 preserves moved settings through down and forward migration", async () => {
    const userDiscId = "_rt_user_naming_migration";
    const registered = await userRepository.register(userDiscId, "Sparrow", "en-US");
    if (!registered?.user_id) throw new Error("Expected migration fixture user to have a user_id");
    await userRepository.update(registered.user_id, {
      user_nickname: "Juno",
      timezone_offset: 8,
      personal_deliberate_tool_mode: "on",
    });

    const downPath = path.join(process.cwd(), "src", "db", "migrations", "062_user_info_persona_naming.down.sql");
    const upPath = path.join(process.cwd(), "src", "db", "migrations", "062_user_info_persona_naming.sql");
    try {
      await executeSqlFile(downPath);
      const [legacy] = await testSql`
        SELECT user_nickname, timezone_offset, personal_deliberate_tool_mode
        FROM users
        WHERE user_id = ${registered.user_id}
      `;
      expect(legacy).toMatchObject({
        user_nickname: "Juno",
        timezone_offset: 8,
        personal_deliberate_tool_mode: "on",
      });

      await executeSqlFile(upPath);
      const [moved] = await testSql`
        SELECT user_nickname, timezone_offset, personal_deliberate_tool_mode
        FROM user_personalization_configs
        WHERE user_id = ${registered.user_id}
      `;
      expect(moved).toMatchObject({
        user_nickname: "Juno",
        timezone_offset: 8,
        personal_deliberate_tool_mode: "on",
      });
      const legacyColumns = await testSql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name IN ('user_nickname', 'timezone_offset', 'personal_deliberate_tool_mode')
      `;
      expect(legacyColumns).toHaveLength(0);
    } finally {
      await executeSqlFile(upPath);
      clearUserCache();
    }
  });

  it("personal settings export-import round-trips with byte-identical JSON shape", async () => {
    const sourceUserDiscId = "_rt_user_settings_export_source";
    const targetUserDiscId = "_rt_user_settings_export_target";
    const source = await userRepository.register(sourceUserDiscId, "_rt_settings_source", "en");
    if (!source?.user_id) throw new Error("Expected source user to have a user_id");

    const updated = await userRepository.update(source.user_id, {
      user_nickname: "_rt_settings_source",
      language_pref: "en-US",
      privacy_level: PrivacyLevel.PARTIAL,
      physical_appearance_tags: ["blue hair", "round glasses"],
      nai_char_ref_url: "https://example.invalid/ref.png",
      impersonation_prompt: "Speak as the exported user.",
      personal_dtm: "on",
      personal_deliberate_tool_mode: "off",
      timezone_offset: 9,
      prefix_override: "Captain",
      suffix_override: "Jr.",
      gender_identity: "nonbinary",
      pronouns: "they/them",
      addressing_style: "neutral",
    });
    expect(updated?.physical_appearance_tags).toEqual(["blue hair", "round glasses"]);
    const savedPreference = await userNamingRepository.savePreference(source.user_id, refs.personaLineageId, {
      nickname_override: "Juno",
      prefix_override: "",
      suffix_override: "-senpai",
    });
    expect(savedPreference).not.toBeNull();

    const toggled = await userRepository.toggleCrossServerShmOptIn(sourceUserDiscId);
    expect(toggled).toBe(true);

    const beforeExport = await exportRepository.exportPersonalSettings(sourceUserDiscId);
    expect(beforeExport.success).toBe(true);
    if (!beforeExport.data || beforeExport.data.type !== "personal_settings") {
      throw new Error("Expected personal_settings export data");
    }

    const importResult = await importRepository.importPersonalSettings(targetUserDiscId, beforeExport.data.data);
    expect(importResult.success).toBe(true);

    const afterExport = await exportRepository.exportPersonalSettings(targetUserDiscId);
    expect(afterExport.success).toBe(true);
    if (!afterExport.data || afterExport.data.type !== "personal_settings") {
      throw new Error("Expected personal_settings export data after import");
    }

    expect(JSON.stringify(normalizeExportTimestamp(afterExport.data, beforeExport.data.exported_at))).toBe(
      JSON.stringify(beforeExport.data),
    );
  });

  it("rolls back persona preferences when an atomic user-info batch cannot update its global row", async () => {
    const userDiscId = "_rt_user_info_atomic_rollback";
    const registered = await userRepository.register(userDiscId, "Sparrow", "en-US");
    if (!registered?.user_id) throw new Error("Expected atomic rollback user to have a user_id");
    await testSql`DELETE FROM user_personalization_configs WHERE user_id = ${registered.user_id}`;

    await expect(
      userNamingRepository.applyUserInfoBatch(registered.user_id, {
        global: { pronouns: "they/them" },
        persona: {
          personaLineageId: refs.personaLineageId,
          patch: { nickname_override: "Juno" },
        },
      }),
    ).rejects.toThrow();

    const preferenceRows = await testSql`
      SELECT 1
      FROM user_persona_naming_preferences
      WHERE user_id = ${registered.user_id}
        AND persona_lineage_id = ${refs.personaLineageId}
    `;
    expect(preferenceRows).toHaveLength(0);
  });

  it("legacy full personal export-import still round-trips through sqlImportPersonalData", async () => {
    const sourceUserDiscId = "_rt_user_full_export_source";
    const targetUserDiscId = "_rt_user_full_export_target";
    const source = await userRepository.register(sourceUserDiscId, "_rt_full_source", "en");
    if (!source?.user_id) throw new Error("Expected full export source user to have a user_id");

    const updated = await userRepository.update(source.user_id, {
      user_nickname: "_rt_full_source",
      language_pref: "en-US",
      impersonation_prompt: "Legacy full export prompt.",
    });
    expect(updated?.impersonation_prompt).toBe("Legacy full export prompt.");

    const beforeExport = await exportRepository.exportPersonalData(sourceUserDiscId);
    expect(beforeExport.success).toBe(true);
    if (!beforeExport.data || beforeExport.data.type !== "personal") {
      throw new Error("Expected personal export data");
    }

    const importResult = await importRepository.importPersonalData(targetUserDiscId, beforeExport.data.data);
    expect(importResult.success).toBe(true);

    const afterExport = await exportRepository.exportPersonalData(targetUserDiscId);
    expect(afterExport.success).toBe(true);
    if (!afterExport.data || afterExport.data.type !== "personal") {
      throw new Error("Expected personal export data after import");
    }

    expect(JSON.stringify(normalizeExportTimestamp(afterExport.data, beforeExport.data.exported_at))).toBe(
      JSON.stringify(beforeExport.data),
    );
  });
});
