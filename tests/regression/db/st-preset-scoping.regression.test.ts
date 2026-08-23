/**
 * Regression harness: SillyTavern preset repository scoping and persistence.
 *
 * Verifies that PresetRepository SQL operations enforce server scoping boundaries,
 * prevent cross-scope writes, and correctly propagate transaction results against
 * a real PostgreSQL database.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import { cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const SECOND_SERVER_DISC_ID = "_rt_server_002";

describe.skipIf(!DB_TESTS_AVAILABLE)("ST preset scoping and persistence - regression", () => {
  let refs: FixtureRefs;
  let server1Id: number;
  let server2Id: number;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
    server1Id = refs.serverId;

    const [secondServerRow] = await testSql<Array<{ server_id: number }>>`
      INSERT INTO servers (server_disc_id)
      VALUES (${SECOND_SERVER_DISC_ID})
      ON CONFLICT (server_disc_id) DO UPDATE SET server_disc_id = EXCLUDED.server_disc_id
      RETURNING server_id
    `;
    server2Id = secondServerRow.server_id;
  });

  afterAll(async () => {
    await testSql`DELETE FROM servers WHERE server_disc_id = ${SECOND_SERVER_DISC_ID}`;
    await cleanupFixtures(testSql);
  });

  it("stores author description when provided, and leaves description null when omitted", async () => {
    const withDescPreset = await presetRepository.insertPresetWithNodes(
      server1Id,
      "_rt_preset_with_desc",
      { prompts: [] },
      [
        {
          identifier: "node_desc",
          name: "Node Desc",
          role: "system",
          content: "Node content",
          is_marker: false,
          is_enabled: true,
          is_comment: false,
          node_order: 0,
          injection_position: 0,
          injection_depth: 4,
          injection_order: 100,
        },
      ],
      "Author-provided description text",
    );

    expect(withDescPreset).not.toBeNull();
    const withDescId = withDescPreset?.preset_id;
    expect(withDescId).toBeDefined();

    const [rowWithDesc] = await testSql<Array<{ description: string | null; preset_name: string }>>`
      SELECT description, preset_name
      FROM st_presets
      WHERE preset_id = ${withDescId}
    `;
    expect(rowWithDesc?.description).toBe("Author-provided description text");

    const noDescPreset = await presetRepository.insertPresetWithNodes(
      server1Id,
      "_rt_preset_no_desc",
      { prompts: [] },
      [
        {
          identifier: "node_nodesc",
          name: "Node No Desc",
          role: "system",
          content: "Node content",
          is_marker: false,
          is_enabled: true,
          is_comment: false,
          node_order: 0,
          injection_position: 0,
          injection_depth: 4,
          injection_order: 100,
        },
      ],
    );

    expect(noDescPreset).not.toBeNull();
    const noDescId = noDescPreset?.preset_id;
    expect(noDescId).toBeDefined();

    const [rowNoDesc] = await testSql<Array<{ description: string | null; preset_name: string }>>`
      SELECT description, preset_name
      FROM st_presets
      WHERE preset_id = ${noDescId}
    `;
    expect(rowNoDesc?.description).toBeNull();
  });

  it("refuses cross-scope setActivePreset and preserves original active preset state", async () => {
    const preset1 = await presetRepository.insertPresetWithNodes(server1Id, "_rt_scope_p1", {}, []);
    const preset2 = await presetRepository.insertPresetWithNodes(server1Id, "_rt_scope_p2", {}, []);
    const preset3 = await presetRepository.insertPresetWithNodes(server2Id, "_rt_scope_p3", {}, []);

    expect(preset1).not.toBeNull();
    expect(preset2).not.toBeNull();
    expect(preset3).not.toBeNull();

    const p1Id = preset1?.preset_id;
    const p2Id = preset2?.preset_id;
    const p3Id = preset3?.preset_id;

    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${p1Id}`;
    await testSql`UPDATE st_presets SET is_active = false WHERE preset_id = ${p2Id}`;
    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${p3Id}`;

    const crossScopeSuccess = await presetRepository.setActivePreset(server2Id, p1Id ?? 0);
    expect(crossScopeSuccess).toBe(false);

    const [server1P1] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${p1Id}
    `;
    expect(server1P1?.is_active).toBe(true);

    const [server1P2] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${p2Id}
    `;
    expect(server1P2?.is_active).toBe(false);

    const [server2P3] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${p3Id}
    `;
    expect(server2P3?.is_active).toBe(true);
  });

  it("activates target preset in-scope, deactivates sibling presets, and leaves other servers untouched", async () => {
    const preset1 = await presetRepository.insertPresetWithNodes(server1Id, "_rt_inscope_p1", {}, []);
    const preset2 = await presetRepository.insertPresetWithNodes(server1Id, "_rt_inscope_p2", {}, []);
    const presetOther = await presetRepository.insertPresetWithNodes(server2Id, "_rt_inscope_other", {}, []);

    const p1Id = preset1?.preset_id;
    const p2Id = preset2?.preset_id;
    const otherId = presetOther?.preset_id;

    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${p1Id}`;
    await testSql`UPDATE st_presets SET is_active = false WHERE preset_id = ${p2Id}`;
    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${otherId}`;

    const activated = await presetRepository.setActivePreset(server1Id, p2Id ?? 0);
    expect(activated).toBe(true);

    const [p1Row] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${p1Id}
    `;
    const [p2Row] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${p2Id}
    `;
    const [otherRow] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${otherId}
    `;

    expect(p1Row?.is_active).toBe(false);
    expect(p2Row?.is_active).toBe(true);
    expect(otherRow?.is_active).toBe(true);
  });

  it("deactivateAllPresets clears active status for target server only", async () => {
    const server1Preset = await presetRepository.insertPresetWithNodes(server1Id, "_rt_deact_s1", {}, []);
    const server2Preset = await presetRepository.insertPresetWithNodes(server2Id, "_rt_deact_s2", {}, []);

    const s1Id = server1Preset?.preset_id;
    const s2Id = server2Preset?.preset_id;

    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${s1Id}`;
    await testSql`UPDATE st_presets SET is_active = true WHERE preset_id = ${s2Id}`;

    const deactivated = await presetRepository.deactivateAllPresets(server1Id);
    expect(deactivated).toBe(true);

    const [s1Row] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${s1Id}
    `;
    const [s2Row] = await testSql<Array<{ is_active: boolean }>>`
      SELECT is_active FROM st_presets WHERE preset_id = ${s2Id}
    `;

    expect(s1Row?.is_active).toBe(false);
    expect(s2Row?.is_active).toBe(true);
  });

  it("refuses cross-scope deletePreset and keeps row intact", async () => {
    const preset = await presetRepository.insertPresetWithNodes(server1Id, "_rt_delete_target", {}, []);
    expect(preset).not.toBeNull();
    const presetId = preset?.preset_id;

    const crossDeleteSuccess = await presetRepository.deletePreset(presetId ?? 0, server2Id);
    expect(crossDeleteSuccess).toBe(false);

    const [row] = await testSql<Array<{ preset_id: number }>>`
      SELECT preset_id FROM st_presets WHERE preset_id = ${presetId}
    `;
    expect(row?.preset_id).toBe(presetId);

    const inScopeDeleteSuccess = await presetRepository.deletePreset(presetId ?? 0, server1Id);
    expect(inScopeDeleteSuccess).toBe(true);

    const [deletedRow] = await testSql<Array<{ preset_id: number }>>`
      SELECT preset_id FROM st_presets WHERE preset_id = ${presetId}
    `;
    expect(deletedRow).toBeUndefined();
  });

  it("refuses cross-scope updateNodeEnabledStates and preserves node enabled states", async () => {
    const preset = await presetRepository.insertPresetWithNodes(server1Id, "_rt_nodes_target", {}, [
      {
        identifier: "node_alpha",
        name: "Alpha",
        role: "system",
        content: "Alpha Content",
        is_marker: false,
        is_enabled: true,
        is_comment: false,
        node_order: 0,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
      },
      {
        identifier: "node_beta",
        name: "Beta",
        role: "system",
        content: "Beta Content",
        is_marker: false,
        is_enabled: false,
        is_comment: false,
        node_order: 1,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 101,
      },
    ]);
    expect(preset).not.toBeNull();
    const presetId = preset?.preset_id;

    const toggleMap = new Map([
      ["node_alpha", false],
      ["node_beta", true],
    ]);

    const crossUpdateSuccess = await presetRepository.updateNodeEnabledStates(presetId ?? 0, toggleMap, server2Id);
    expect(crossUpdateSuccess).toBe(false);

    const nodesAfterCross = await testSql<Array<{ identifier: string; is_enabled: boolean }>>`
      SELECT identifier, is_enabled
      FROM st_preset_nodes
      WHERE preset_id = ${presetId}
      ORDER BY node_order ASC
    `;

    expect(nodesAfterCross).toEqual([
      { identifier: "node_alpha", is_enabled: true },
      { identifier: "node_beta", is_enabled: false },
    ]);

    const inScopeUpdateSuccess = await presetRepository.updateNodeEnabledStates(presetId ?? 0, toggleMap, server1Id);
    expect(inScopeUpdateSuccess).toBe(true);

    const nodesAfterInScope = await testSql<Array<{ identifier: string; is_enabled: boolean }>>`
      SELECT identifier, is_enabled
      FROM st_preset_nodes
      WHERE preset_id = ${presetId}
      ORDER BY node_order ASC
    `;

    expect(nodesAfterInScope).toEqual([
      { identifier: "node_alpha", is_enabled: false },
      { identifier: "node_beta", is_enabled: true },
    ]);
  });
});
