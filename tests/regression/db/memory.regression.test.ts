/**
 * Regression harness: Memory repositories domain.
 *
 * Covers: ServerMemoryRepository (addServerMemoryByTomori),
 * PersonalMemoryRepository (addPersonalMemoryByTomori, loadPersonalMemoriesForUserLineage),
 * ConditioningMemoryRepository.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  personalMemoryRepository,
  personaRepository,
  serverMemoryRepository,
  userRepository,
} from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("Memory — regression", () => {
  let refs: FixtureRefs;
  let altUserId: number;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
    const altUser = await userRepository.register(FIXTURE_IDS.altUserDiscId, "_rt_alt_user", "en");
    if (!altUser) throw new Error("Failed to register alt test user");
    altUserId = altUser.user_id;
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  it("addServerMemoryByTomori inserts a server memory", async () => {
    const memory = await serverMemoryRepository.add(
      refs.serverId,
      refs.personaId,
      refs.personaLineageId,
      refs.userId,
      "regression test server memory content",
    );
    expect(memory).not.toBeNull();
    expect(memory?.content).toBe("regression test server memory content");
    expect(memory?.server_id).toBe(refs.serverId);
  });

  it("loadTomoriState reflects the new server memory", async () => {
    const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
    const hasMemory = state?.server_memories.some((m) => m.includes("regression test server memory content"));
    expect(hasMemory).toBe(true);
  });

  /**
   * A count query passes every mocked unit test and still fails in production, which is why the
   * sibling `PersonalMemoryRepository.memoryCountsByLineage` carries a case here too. The panel
   * renders this number as authoritative, so an omitted lineage must stay omitted rather than
   * inviting the caller to substitute a guess.
   */
  it("memoryCountsByLineage agrees with the scoped loader and omits lineages with no memories", async () => {
    const [alter] = await testSql<Array<{ persona_id: number; persona_lineage_id: string | number }>>`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${refs.serverId}, '_rt_counts_alter', true)
      RETURNING persona_id, persona_lineage_id
    `;
    const alterLineageId = Number(alter.persona_lineage_id);
    expect(alterLineageId).not.toBe(refs.personaLineageId);

    await testSql`
      INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
      VALUES (${refs.serverId}, ${alter.persona_id}, ${alterLineageId}, ${altUserId}, '_rt_count_alter_a', ARRAY[]::TEXT[])
    `;
    await testSql`
      INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
      VALUES (${refs.serverId}, ${alter.persona_id}, ${alterLineageId}, ${refs.userId}, '_rt_count_alter_b', ARRAY[]::TEXT[])
    `;

    const counts = await serverMemoryRepository.memoryCountsByLineage(refs.serverId);
    const scoped = await serverMemoryRepository.loadServerMemoriesScoped(refs.serverId, alterLineageId);
    expect(counts.get(alterLineageId)).toBe(scoped.length);
    expect(counts.get(alterLineageId)).toBe(2);

    // A lineage nobody has taught is absent, never zero.
    const [empty] = await testSql<Array<{ persona_lineage_id: string | number }>>`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${refs.serverId}, '_rt_counts_empty', true)
      RETURNING persona_lineage_id
    `;
    expect(counts.has(Number(empty.persona_lineage_id))).toBe(false);

    // The owner filter narrows the count exactly as it narrows the loader a non-manager sees.
    const ownerCounts = await serverMemoryRepository.memoryCountsByLineage(refs.serverId, altUserId);
    const ownerScoped = await serverMemoryRepository.loadServerMemoriesScoped(refs.serverId, alterLineageId, altUserId);
    expect(ownerCounts.get(alterLineageId)).toBe(ownerScoped.length);
    expect(ownerCounts.get(alterLineageId)).toBe(1);
  });

  it("addServerMemoryByTomori rejects empty content", async () => {
    const memory = await serverMemoryRepository.add(
      refs.serverId,
      refs.personaId,
      refs.personaLineageId,
      refs.userId,
      "",
    );
    expect(memory).toBeNull();
  });

  it("addPersonalMemoryByTomori inserts a personal memory", async () => {
    const memory = await personalMemoryRepository.add(
      altUserId,
      refs.personaLineageId,
      "regression test personal memory content",
    );
    expect(memory).not.toBeNull();
    expect(memory?.content).toBe("regression test personal memory content");
    expect(memory?.user_id).toBe(altUserId);
  });

  it("loadPersonalMemoriesForUserLineage returns the inserted personal memory", async () => {
    const memories = await personalMemoryRepository.loadForUserLineage(altUserId, refs.personaLineageId);
    const found = memories.some((m) => m.content === "regression test personal memory content");
    expect(found).toBe(true);
  });

  it("loadPersonalMemoriesForUserLineage returns empty array for unknown user", async () => {
    const memories = await personalMemoryRepository.loadForUserLineage(999_999_999, refs.personaLineageId);
    expect(memories).toHaveLength(0);
  });
});
