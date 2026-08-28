/**
 * Regression harness: persona-eligibility batched queries.
 *
 * This is the parity test the eligibility-filter plan requires: for every Class B
 * family, the batched availability query must agree with the loader it filters,
 * over a fixture containing an own-rows persona, an empty persona, a preset-pointer
 * persona, a shared-lineage pair, and a foreign-server persona.
 *
 * Unlike a mocked-SQL shape test, this exercises the real repositories against a
 * disposable Postgres fixture, so a genuine divergence between a batched query and
 * its loader (the exact bug class the filter exists to prevent) fails here.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  personalMemoryRepository,
  personaSpriteRepository,
  serverMemoryRepository,
  userRepository,
} from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const RT_PRESET_LINEAGE = 990_001;
const RT_FOREIGN_SERVER_DISC = "_rt_server_eligibility_foreign";

interface PersonaRef {
  persona_id: number;
  persona_lineage_id: number;
}

async function insertPersona(
  serverId: number,
  nickname: string,
  extra: { isPointer?: boolean; presetLineageId?: number; presetLanguage?: string } = {},
): Promise<PersonaRef> {
  // is_alter = true: the base fixture already owns the single main persona per
  // server (personas_one_main_per_server), and eligibility keys never depend on
  // the alter/main distinction.
  const [row] = await testSql<PersonaRef[]>`
    INSERT INTO personas (server_id, persona_nickname, is_alter, is_pointer, preset_lineage_id, preset_language)
    VALUES (
      ${serverId},
      ${nickname},
      true,
      ${extra.isPointer ?? false},
      ${extra.presetLineageId ?? null},
      ${extra.presetLanguage ?? null}
    )
    RETURNING persona_id, persona_lineage_id
  `;
  return { persona_id: row.persona_id, persona_lineage_id: Number(row.persona_lineage_id) };
}

/**
 * True when a table exists. The RAG schema (`documents`, sprites) is only created
 * when pgvector is installed, so those families skip gracefully on a Postgres
 * without the extension while the base-schema memory families always run.
 */
async function tableExists(name: string): Promise<boolean> {
  const [row] = await testSql<Array<{ exists: boolean }>>`
    SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS exists
  `;
  return row?.exists === true;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Persona eligibility batched queries — regression parity", () => {
  let serverId: number;
  let userId: number;
  let altUserId: number;
  // RAG-schema availability (pgvector-gated). Document/sprite parity is asserted
  // only where the tables exist; the assertions below early-return otherwise.
  let hasDocuments = false;
  let hasSprites = false;

  let pOwn: PersonaRef; // own upload + history document, sprites, memories
  let pEmpty: PersonaRef; // nothing
  let pPointer: PersonaRef; // preset pointer, zero own sprite rows
  let pShareA: PersonaRef; // shares a lineage with pShareB
  let pShareB: PersonaRef;

  beforeAll(async () => {
    await setupTestDb();
    const refs = await insertFixtures(testSql);
    serverId = refs.serverId;
    userId = refs.userId;

    const altUser = await userRepository.register(FIXTURE_IDS.altUserDiscId, "_rt_alt_user", "en");
    if (!altUser) throw new Error("Failed to register alt test user");
    altUserId = altUser.user_id;

    hasDocuments = await tableExists("documents");
    hasSprites = (await tableExists("persona_sprites")) && (await tableExists("preset_sprites"));

    if (hasSprites) {
      // Preset sprite set the pointer persona resolves to (no persona_sprites rows).
      await testSql`
        INSERT INTO preset_sprites (preset_lineage_id, preset_language, sprite_name, sprite_key, avatar_url)
        VALUES (${RT_PRESET_LINEAGE}, 'en', '_rt_preset_sprite', 'happy', 'http://example.test/preset.png')
      `;
    }

    pOwn = await insertPersona(serverId, "_rt_p_own");
    pEmpty = await insertPersona(serverId, "_rt_p_empty");
    pPointer = await insertPersona(serverId, "_rt_p_pointer", {
      isPointer: true,
      presetLineageId: RT_PRESET_LINEAGE,
      presetLanguage: "en",
    });
    pShareA = await insertPersona(serverId, "_rt_p_share_a");
    pShareB = await insertPersona(serverId, "_rt_p_share_b");
    await testSql`
      UPDATE personas SET persona_lineage_id = ${pShareA.persona_lineage_id} WHERE persona_id = ${pShareB.persona_id}
    `;
    pShareB.persona_lineage_id = pShareA.persona_lineage_id;

    if (hasDocuments) {
      // Foreign server + persona with a document, to prove server scoping.
      const [fsvr] = await testSql<Array<{ server_id: number }>>`
        INSERT INTO servers (server_disc_id)
        VALUES (${RT_FOREIGN_SERVER_DISC})
        ON CONFLICT (server_disc_id) DO UPDATE SET server_disc_id = EXCLUDED.server_disc_id
        RETURNING server_id
      `;
      const foreignServerId = fsvr.server_id;
      const pForeign = await insertPersona(foreignServerId, "_rt_p_foreign");
      await testSql`
        INSERT INTO documents (server_id, persona_id, document_name, text_content)
        VALUES (${foreignServerId}, ${pForeign.persona_id}, '_rt_foreign_doc', 'x')
      `;

      // pOwn has an upload AND a history doc; pShareA has an upload only (proves
      // the history filter distinguishes them).
      await testSql`
        INSERT INTO documents (server_id, persona_id, document_name, text_content)
        VALUES (${serverId}, ${pOwn.persona_id}, '_rt_own_upload', 'x')
      `;
      await testSql`
        INSERT INTO documents (server_id, persona_id, document_name, text_content, source_type)
        VALUES (${serverId}, ${pOwn.persona_id}, '_rt_own_history', 'x', 'history')
      `;
      await testSql`
        INSERT INTO documents (server_id, persona_id, document_name, text_content)
        VALUES (${serverId}, ${pShareA.persona_id}, '_rt_share_upload', 'x')
      `;
    }

    // Server memories: shared lineage owned by the manager (userId); pOwn lineage
    // owned by the alt (non-manager) user.
    await testSql`
      INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
      VALUES (${serverId}, ${pShareA.persona_id}, ${pShareA.persona_lineage_id}, ${userId}, '_rt_sm_shared', ARRAY[]::TEXT[])
    `;
    await testSql`
      INSERT INTO server_memories (server_id, persona_id, persona_lineage_id, user_id, content, tags)
      VALUES (${serverId}, ${pOwn.persona_id}, ${pOwn.persona_lineage_id}, ${altUserId}, '_rt_sm_own', ARRAY[]::TEXT[])
    `;

    await testSql`
      INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
      VALUES (${altUserId}, ${pOwn.persona_lineage_id}, '_rt_pm_own', ARRAY[]::TEXT[])
    `;
    await testSql`
      INSERT INTO personal_memories (user_id, persona_lineage_id, content, tags)
      VALUES (${altUserId}, 0, '_rt_pm_global', ARRAY[]::TEXT[])
    `;

    if (hasSprites) {
      await testSql`
        INSERT INTO persona_sprites (persona_id, sprite_name, sprite_key, avatar_url)
        VALUES (${pOwn.persona_id}, '_rt_own_sprite', 'happy', 'http://example.test/own.png')
      `;
    }
  });

  afterAll(async () => {
    await testSql`DELETE FROM personal_memories WHERE user_id = ${altUserId}`;
    if (hasSprites) await testSql`DELETE FROM preset_sprites WHERE preset_lineage_id = ${RT_PRESET_LINEAGE}`;
    if (hasDocuments) await testSql`DELETE FROM servers WHERE server_disc_id = ${RT_FOREIGN_SERVER_DISC}`;
    await cleanupFixtures(testSql);
  });

  it("personaIdsWithDocuments agrees with loadDocuments on every fixture persona", async () => {
    if (!hasDocuments) return; // RAG schema absent (no pgvector), so skip document parity
    const batch = await serverMemoryRepository.personaIdsWithDocuments(serverId);
    for (const persona of [pOwn, pEmpty, pPointer, pShareA, pShareB]) {
      const loaderNonEmpty = (await serverMemoryRepository.loadDocuments(serverId, persona.persona_id)).length > 0;
      expect(batch.has(persona.persona_id)).toBe(loaderNonEmpty);
    }
    expect([...batch].sort()).toEqual([pOwn.persona_id, pShareA.persona_id].sort());
  });

  it("personaIdsWithHistoryDocuments agrees with loadHistoryDocuments and excludes upload-only personas", async () => {
    if (!hasDocuments) return; // RAG schema absent (no pgvector), so skip history parity
    const batch = await serverMemoryRepository.personaIdsWithHistoryDocuments(serverId);
    for (const persona of [pOwn, pEmpty, pPointer, pShareA, pShareB]) {
      const loaderNonEmpty =
        (await serverMemoryRepository.loadHistoryDocuments(serverId, persona.persona_id)).length > 0;
      expect(batch.has(persona.persona_id)).toBe(loaderNonEmpty);
    }
    // Only pOwn has a history document; pShareA's upload-only doc must not count.
    expect([...batch]).toEqual([pOwn.persona_id]);
    expect(batch.has(pShareA.persona_id)).toBe(false);
  });

  it("lineageIdsWithServerMemories agrees with the loader and differs by permission scope", async () => {
    const lineages = [pOwn.persona_lineage_id, pShareA.persona_lineage_id, pEmpty.persona_lineage_id];

    const managerBatch = await serverMemoryRepository.lineageIdsWithServerMemories(serverId);
    for (const lineage of lineages) {
      const loaderNonEmpty = (await serverMemoryRepository.loadServerMemoriesScoped(serverId, lineage)).length > 0;
      expect(managerBatch.has(lineage)).toBe(loaderNonEmpty);
    }

    const altBatch = await serverMemoryRepository.lineageIdsWithServerMemories(serverId, altUserId);
    for (const lineage of lineages) {
      const loaderNonEmpty =
        (await serverMemoryRepository.loadServerMemoriesScoped(serverId, lineage, altUserId)).length > 0;
      expect(altBatch.has(lineage)).toBe(loaderNonEmpty);
    }

    // A manager sees both lineages; the alt user only sees the memory they own.
    expect(managerBatch.has(pOwn.persona_lineage_id)).toBe(true);
    expect(managerBatch.has(pShareA.persona_lineage_id)).toBe(true);
    expect(altBatch.has(pOwn.persona_lineage_id)).toBe(true);
    expect(altBatch.has(pShareA.persona_lineage_id)).toBe(false);
    expect([...managerBatch].sort()).not.toEqual([...altBatch].sort());
  });

  it("shared-lineage personas are eligible together for server memories", async () => {
    const managerBatch = await serverMemoryRepository.lineageIdsWithServerMemories(serverId);
    expect(pShareA.persona_lineage_id).toBe(pShareB.persona_lineage_id);
    expect(managerBatch.has(pShareA.persona_lineage_id)).toBe(managerBatch.has(pShareB.persona_lineage_id));
  });

  it("lineageIdsWithMemories agrees with loadForUserLineage and excludes lineage 0", async () => {
    const batch = await personalMemoryRepository.lineageIdsWithMemories(altUserId);
    for (const lineage of [pOwn.persona_lineage_id, pShareA.persona_lineage_id, 0]) {
      const loaderNonEmpty = (await personalMemoryRepository.loadForUserLineage(altUserId, lineage, false)).length > 0;
      // Contract: lineage 0 is the global branch and never marks a persona eligible.
      const expected = loaderNonEmpty && lineage !== 0;
      expect(batch.has(lineage)).toBe(expected);
    }
    expect(batch.has(0)).toBe(false);
    expect(batch.has(pOwn.persona_lineage_id)).toBe(true);
  });

  it("memoryCountsByLineage agrees with loadForUserLineage and omits empty lineages", async () => {
    const counts = await personalMemoryRepository.memoryCountsByLineage(altUserId);
    for (const lineage of [pOwn.persona_lineage_id, pShareA.persona_lineage_id, pEmpty.persona_lineage_id]) {
      const loaded = await personalMemoryRepository.loadForUserLineage(altUserId, lineage, false);
      // Absent rather than zero: the selector has to read a missing entry as none.
      expect(counts.get(lineage) ?? 0).toBe(loaded.length);
    }
    expect(counts.has(0)).toBe(false);
    expect(counts.get(pOwn.persona_lineage_id)).toBeGreaterThan(0);
    expect(counts.has(pEmpty.persona_lineage_id)).toBe(false);
  });

  it("personaIdsWithSprites agrees with listForPersona, including the zero-own-row preset pointer", async () => {
    if (!hasSprites) return; // RAG/sprite schema absent (no pgvector), so skip sprite parity
    const personas = [pOwn, pEmpty, pPointer, pShareA, pShareB];
    const batch = await personaSpriteRepository.personaIdsWithSprites(personas.map((p) => p.persona_id));
    for (const persona of personas) {
      const loaderNonEmpty = (await personaSpriteRepository.listForPersona(persona.persona_id)).length > 0;
      expect(batch.has(persona.persona_id)).toBe(loaderNonEmpty);
    }
    expect([...batch].sort()).toEqual([pOwn.persona_id, pPointer.persona_id].sort());
    expect(batch.has(pEmpty.persona_id)).toBe(false);
  });
});
