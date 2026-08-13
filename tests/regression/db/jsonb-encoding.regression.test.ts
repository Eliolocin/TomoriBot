/**
 * Regression harness: JSONB columns must store objects, not JSON strings.
 *
 * `${JSON.stringify(value)}::jsonb` binds the JSON source as text and the cast then
 * parses it into a JSONB scalar string. Reads masked this because the Zod layer parses
 * a string back into an object, so only SQL-level access (`->`, `->>`, containment,
 * equality against an object literal) saw the wrong shape. Migration 064 repaired the
 * stored rows; these tests keep the writers from reintroducing it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmProviderRepo, userNamingRepository } from "@/utils/db/repositories";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const PROBE_SERVER = "_jsonb_encoding_probe";

describe.skipIf(!DB_TESTS_AVAILABLE)("JSONB encoding", () => {
  let personaId: number;
  let serverId: number;

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
    const [server] = await testSql`
      INSERT INTO servers (server_disc_id) VALUES (${PROBE_SERVER}) RETURNING server_id`;
    serverId = server.server_id;
    const [persona] = await testSql`
      INSERT INTO personas (server_id, persona_nickname, persona_lineage_id)
      VALUES (${serverId}, '_jsonb_probe', 55443322) RETURNING persona_id`;
    personaId = persona.persona_id;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${PROBE_SERVER}`;
  });

  it("stores persona naming config as JSONB objects reachable by SQL operators", async () => {
    await userNamingRepository.savePersonaConfig(personaId, {
      prefixes: { neutral: "Chief" },
      suffixes: { masculine: "-kun" },
      addressTerms: { neutral: "fam" },
    });

    const [row] = await testSql`
      SELECT
        jsonb_typeof(prefixes) AS prefixes_kind,
        jsonb_typeof(suffixes) AS suffixes_kind,
        jsonb_typeof(address_terms) AS address_terms_kind,
        prefixes ->> 'neutral' AS prefix_value
      FROM persona_naming_configs WHERE persona_id = ${personaId}`;

    expect(row.prefixes_kind).toBe("object");
    expect(row.suffixes_kind).toBe("object");
    expect(row.address_terms_kind).toBe("object");
    expect(row.prefix_value).toBe("Chief");
  });

  it("stores custom endpoint extra_config as a JSONB object", async () => {
    await llmProviderRepo.upsertCustomEndpoint({
      serverId,
      userId: null,
      label: "_jsonb_probe_endpoint",
      capability: "text",
      apiStyle: "openai",
      endpointUrl: "https://example.invalid/v1",
      displayName: "JSONB Probe",
      requiresAuth: false,
      extraConfig: { headers: { "x-probe": "1" } },
    });

    const [row] = await testSql`
      SELECT jsonb_typeof(extra_config) AS kind, extra_config #>> '{headers,x-probe}' AS header_value
      FROM custom_endpoints
      WHERE server_id = ${serverId} AND label = '_jsonb_probe_endpoint'`;

    expect(row.kind).toBe("object");
    expect(row.header_value).toBe("1");
  });
});
