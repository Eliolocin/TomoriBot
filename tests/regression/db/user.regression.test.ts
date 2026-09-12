/**
 * Regression harness: UserRepository domain.
 *
 * Covers: loadUserRow, registerUser, setPrivacyLevel, updateUser,
 * loadUserRowsByNormalizedNickname.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PrivacyLevel } from "@/types/db/schema";
import { userRepository } from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("User — regression", () => {
  beforeAll(async () => {
    await setupTestDb();
    await insertFixtures(testSql);
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  it("loadUserRow returns null for a non-existent user", async () => {
    const result = await userRepository.loadByDiscordId("_rt_nonexistent_9999");
    expect(result).toBeNull();
  });

  it("loadUserRow returns the fixture user", async () => {
    const user = await userRepository.loadByDiscordId(FIXTURE_IDS.userDiscId);
    expect(user).not.toBeNull();
    expect(user?.user_disc_id).toBe(FIXTURE_IDS.userDiscId);
    expect(user?.user_nickname).toBe("_rt_user");
  });

  it("loadUserRowsByNormalizedNickname finds by exact nickname", async () => {
    const results = await userRepository.findByNormalizedNickname("_rt_user");
    const match = results.find((u) => u.user_disc_id === FIXTURE_IDS.userDiscId);
    expect(match).not.toBeUndefined();
  });

  it("registerUser creates a new user row", async () => {
    const user = await userRepository.register(FIXTURE_IDS.regUserDiscId, "_rt_reg_name", "en");
    expect(user).not.toBeNull();
    expect(user?.user_disc_id).toBe(FIXTURE_IDS.regUserDiscId);
    expect(user?.user_nickname).toBeNull();
  });

  it("registerUser is idempotent and does not freeze a later Discord display name", async () => {
    const first = await userRepository.register(FIXTURE_IDS.regUserDiscId, "_rt_reg_name", "en");
    const second = await userRepository.register(FIXTURE_IDS.regUserDiscId, "_rt_different_name", "en");
    expect(second?.user_id).toBe(first?.user_id);
    expect(second?.user_nickname).toBeNull();
  });

  it("setPrivacyLevel updates the row and returns the updated user", async () => {
    const updated = await userRepository.setPrivacyLevel(FIXTURE_IDS.regUserDiscId, PrivacyLevel.PARTIAL);
    expect(updated).not.toBeNull();
    expect(updated?.privacy_level).toBe(PrivacyLevel.PARTIAL);
  });

  it("loadUserRow reflects the privacy level change", async () => {
    const user = await userRepository.loadByDiscordId(FIXTURE_IDS.regUserDiscId);
    expect(user?.privacy_level).toBe(PrivacyLevel.PARTIAL);
  });

  it("updateUser patches arbitrary fields", async () => {
    const userRow = await userRepository.loadByDiscordId(FIXTURE_IDS.regUserDiscId);
    if (!userRow) throw new Error("Expected registered user to exist");
    const updated = await userRepository.update(userRow.user_id, { user_nickname: "_rt_renamed" });
    expect(updated?.user_nickname).toBe("_rt_renamed");
  });

  it("re-registering preserves an explicitly saved nickname", async () => {
    const user = await userRepository.register(FIXTURE_IDS.regUserDiscId, "_rt_live_display_name", "en");
    expect(user?.user_nickname).toBe("_rt_renamed");
  });

  /**
   * `/personal nuke` is the erasure route the Privacy Policy names, so its blast radius is a
   * published promise rather than an implementation detail. This pins all four halves of that
   * promise: personal rows die, server-owned rows survive with authorship severed, reminders go
   * in both directions, and an opt-out outlives the erasure so it cannot silently re-enable
   * collection.
   */
  describe("nukeUser", () => {
    const NUKE_DISC_ID = "_rt_user_nuke_target";
    const OTHER_DISC_ID = "_rt_user_nuke_bystander";

    it("erases personal rows, severs server-owned ones, and keeps the opt-out", async () => {
      const [server] = await testSql<Array<{ server_id: number }>>`
        SELECT server_id FROM servers WHERE server_disc_id = ${FIXTURE_IDS.serverDiscId}
      `;
      const [target] = await testSql<Array<{ user_id: number }>>`
        INSERT INTO users (user_disc_id) VALUES (${NUKE_DISC_ID}) RETURNING user_id
      `;
      const [bystander] = await testSql<Array<{ user_id: number }>>`
        INSERT INTO users (user_disc_id) VALUES (${OTHER_DISC_ID}) RETURNING user_id
      `;

      await testSql`
        INSERT INTO personal_memories (user_id, persona_lineage_id, content)
        VALUES (${target.user_id}, 0, '_rt_personal_fact')
      `;
      const [serverMemory] = await testSql<Array<{ server_memory_id: number }>>`
        INSERT INTO server_memories (server_id, persona_lineage_id, user_id, content)
        VALUES (${server.server_id}, 0, ${target.user_id}, '_rt_server_fact')
        RETURNING server_memory_id
      `;
      await testSql`
        INSERT INTO personalization_blacklist (server_id, user_disc_id)
        VALUES (${server.server_id}, ${NUKE_DISC_ID})
      `;

      // One reminder the target authored, one somebody else aimed at them, and one that touches
      // them not at all. Only the third may survive.
      await testSql`
        INSERT INTO reminders (server_id, channel_disc_id, user_discord_id, user_nickname,
                               reminder_purpose, reminder_time, created_by_user_id)
        VALUES (${server.server_id}, '_rt_chan', ${OTHER_DISC_ID}, '_rt_bystander',
                '_rt_authored_by_target', NOW(), ${target.user_id}),
               (${server.server_id}, '_rt_chan', ${NUKE_DISC_ID}, '_rt_nuke',
                '_rt_aimed_at_target', NOW(), ${bystander.user_id}),
               (${server.server_id}, '_rt_chan', ${OTHER_DISC_ID}, '_rt_bystander',
                '_rt_unrelated', NOW(), ${bystander.user_id})
      `;

      const result = await userRepository.nukeUser(target.user_id);
      expect(result?.userDiscId).toBe(NUKE_DISC_ID);
      expect(result?.remindersDeleted).toBe(2);

      expect(await userRepository.loadByDiscordId(NUKE_DISC_ID)).toBeNull();

      const personal = await testSql`SELECT 1 FROM personal_memories WHERE user_id = ${target.user_id}`;
      expect(personal.length).toBe(0);

      const [survivor] = await testSql<Array<{ user_id: number | null; content: string }>>`
        SELECT user_id, content FROM server_memories WHERE server_memory_id = ${serverMemory.server_memory_id}
      `;
      expect(survivor.content).toBe("_rt_server_fact");
      expect(survivor.user_id).toBeNull();

      const remaining = await testSql<Array<{ reminder_purpose: string }>>`
        SELECT reminder_purpose FROM reminders WHERE channel_disc_id = '_rt_chan'
      `;
      expect(remaining.map((row) => row.reminder_purpose)).toEqual(["_rt_unrelated"]);

      const optOut = await testSql`
        SELECT 1 FROM personalization_blacklist WHERE user_disc_id = ${NUKE_DISC_ID}
      `;
      expect(optOut.length).toBe(1);

      await testSql`DELETE FROM reminders WHERE channel_disc_id = '_rt_chan'`;
      await testSql`DELETE FROM server_memories WHERE server_memory_id = ${serverMemory.server_memory_id}`;
      await testSql`DELETE FROM personalization_blacklist WHERE user_disc_id = ${NUKE_DISC_ID}`;
      await testSql`DELETE FROM users WHERE user_disc_id = ${OTHER_DISC_ID}`;
    });

    it("returns null for a user that does not exist", async () => {
      expect(await userRepository.nukeUser(-1)).toBeNull();
    });
  });

  // Deliberately skip this test in normal runs; enable it manually to verify the
  // harness detects regressions. To prove it works: add "WHERE 1=0" to the
  // loadUserRow SELECT and confirm this test fails.
  it.skip("[REGRESSION PROBE] loadUserRow returns the correct row after rename", async () => {
    const user = await userRepository.loadByDiscordId(FIXTURE_IDS.regUserDiscId);
    // If loadUserRow's SELECT were broken (e.g. wrong WHERE), this would be null
    expect(user?.user_nickname).toBe("_rt_renamed");
  });
});
