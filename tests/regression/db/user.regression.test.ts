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

  // Deliberately skip this test in normal runs; enable it manually to verify the
  // harness detects regressions. To prove it works: add "WHERE 1=0" to the
  // loadUserRow SELECT and confirm this test fails.
  it.skip("[REGRESSION PROBE] loadUserRow returns the correct row after rename", async () => {
    const user = await userRepository.loadByDiscordId(FIXTURE_IDS.regUserDiscId);
    // If loadUserRow's SELECT were broken (e.g. wrong WHERE), this would be null
    expect(user?.user_nickname).toBe("_rt_renamed");
  });
});
