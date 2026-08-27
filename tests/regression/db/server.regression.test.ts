/**
 * Regression harness: ServerRepository domain.
 *
 * Covers: channel whitelist reads/writes, blacklist, server setup basics.
 * loadTomoriState implicitly tests server row loading; this file focuses on
 * server-scoped operations that don't fit other domain files.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { userRepository } from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("Server — regression", () => {
  let refs: FixtureRefs;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  it("isBlacklisted returns false for a user not in the blacklist", async () => {
    const result = await userRepository.isBlacklisted(FIXTURE_IDS.serverDiscId, FIXTURE_IDS.userDiscId);
    expect(result).toBe(false);
  });

  it("isBlacklisted returns false for a completely unknown server+user pair", async () => {
    const result = await userRepository.isBlacklisted("_rt_unknown_server", "_rt_unknown_user");
    expect(result).toBe(false);
  });

  // ── blacklist write + re-read ─────────────────────────────────────────────
  // The personalization_blacklist table stores server_id (internal) + user_disc_id.
  // We insert directly via testSql to avoid needing full command-flow wiring.

  it("isBlacklisted returns true after inserting a blacklist entry", async () => {
    await testSql`
      INSERT INTO personalization_blacklist (server_id, user_disc_id)
      VALUES (${refs.serverId}, ${FIXTURE_IDS.userDiscId})
      ON CONFLICT DO NOTHING
    `;

    const result = await userRepository.isBlacklisted(FIXTURE_IDS.serverDiscId, FIXTURE_IDS.userDiscId);
    expect(result).toBe(true);
  });

  it("isBlacklisted returns false after removing the blacklist entry", async () => {
    await testSql`
      DELETE FROM personalization_blacklist
      WHERE server_id = ${refs.serverId} AND user_disc_id = ${FIXTURE_IDS.userDiscId}
    `;

    const result = await userRepository.isBlacklisted(FIXTURE_IDS.serverDiscId, FIXTURE_IDS.userDiscId);
    expect(result).toBe(false);
  });

  // ── setup's alter-name collision guard ────────────────────────────────────
  // Exercises the disambiguating UPDATE from sqlSetupServer against the real schema rather
  // than through setup() itself, which needs a Guild and a seeded persona_presets row. What
  // has to hold is that the statement parses, renames only the colliding alter, and leaves
  // idx_personas_server_nickname_ci_unique satisfied for the main persona insert that follows.

  it("setup's guard renames a colliding alter so the default-named main persona can insert", async () => {
    const defaultName = "Tomori";

    const [alter] = await testSql`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${refs.serverId}, ${defaultName}, true)
      RETURNING persona_id
    `;

    await testSql`
      UPDATE personas
      SET persona_nickname = persona_nickname || ' [dup-' || persona_id::TEXT || ']'
      WHERE server_id = ${refs.serverId}
        AND is_alter = true
        AND lower(btrim(persona_nickname)) = lower(btrim(${defaultName}))
    `;

    const [renamed] = await testSql`
      SELECT persona_nickname FROM personas WHERE persona_id = ${alter.persona_id}
    `;
    expect(renamed.persona_nickname).toBe(`${defaultName} [dup-${alter.persona_id}]`);

    // The fixture main persona keeps its own name: the guard is scoped to alters.
    const [mainPersona] = await testSql`
      SELECT persona_nickname FROM personas WHERE persona_id = ${refs.personaId}
    `;
    expect(mainPersona.persona_nickname).toBe("_rt_persona");

    // The name is now free, which is the whole point of the guard.
    const [claimed] = await testSql`
      INSERT INTO personas (server_id, persona_nickname, is_alter)
      VALUES (${refs.serverId}, ${defaultName}, true)
      RETURNING persona_id
    `;
    expect(claimed.persona_id).toBeGreaterThan(0);

    await testSql`
      DELETE FROM personas WHERE persona_id IN (${alter.persona_id}, ${claimed.persona_id})
    `;
  });

  it("setup's guard is a no-op when no alter holds the default name", async () => {
    const [before] = await testSql`
      SELECT count(*)::int AS n FROM personas WHERE server_id = ${refs.serverId}
    `;

    await testSql`
      UPDATE personas
      SET persona_nickname = persona_nickname || ' [dup-' || persona_id::TEXT || ']'
      WHERE server_id = ${refs.serverId}
        AND is_alter = true
        AND lower(btrim(persona_nickname)) = lower(btrim('Tomori'))
    `;

    const [after] = await testSql`
      SELECT count(*)::int AS n FROM personas
      WHERE server_id = ${refs.serverId} AND persona_nickname LIKE '% [dup-%'
    `;
    expect(after.n).toBe(0);
    expect(before.n).toBeGreaterThan(0);
  });
});
