/**
 * Regression harness - persona preset imports.
 *
 * Covers compatibility with Tomori preset exports created before the schema
 * normalization branch moved trigger_words out of server config tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PresetExportData } from "@/types/preset/presetExport";
import { presetRepository } from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("Preset import - regression", () => {
  let refs: FixtureRefs;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  it("imports normalized main-branch preset trigger words into persona_configs", async () => {
    const presetData: PresetExportData = {
      tomori_nickname: "_rt_imported_persona",
      attribute_list: ["_rt_import_attr"],
      attribute_public_flags: [true],
      sample_dialogues_in: ["_rt_user_line"],
      sample_dialogues_out: ["_rt_persona_line"],
      trigger_words: ['"_rt_legacy_trigger"', "`_rt_legacy_trigger`", "_rt_second_legacy_trigger"],
      persona_prompt: "_rt_persona_prompt",
      persona_lineage_id: refs.personaLineageId,
      physical_appearance_tags: [],
      nai_char_ref_url: null,
      nai_attg_author: null,
      nai_attg_title: null,
      nai_attg_tags: null,
      nai_attg_genre: null,
      nai_attg_stars: null,
    };

    const result = await presetRepository.importPresetData(FIXTURE_IDS.serverDiscId, presetData, "preserve");

    expect(result.success).toBe(true);
    if (result.success) expect(result.mainPersonaIsPointer).toBe(false);

    const [personaConfig] = await testSql<Array<{ trigger_words: string[]; persona_prompt: string | null }>>`
      SELECT trigger_words, persona_prompt
      FROM persona_configs
      WHERE persona_id = ${refs.personaId}
      LIMIT 1
    `;

    expect(personaConfig?.trigger_words).toEqual(["_rt_legacy_trigger", "_rt_second_legacy_trigger"]);
    expect(personaConfig?.persona_prompt).toBe("_rt_persona_prompt");

    const attributeRows = await testSql<Array<{ attribute_text: string; is_public: boolean }>>`
      SELECT attribute_text, is_public
      FROM persona_attributes
      WHERE persona_id = ${refs.personaId}
      ORDER BY attribute_order
    `;

    expect(attributeRows).toEqual([{ attribute_text: "_rt_import_attr", is_public: true }]);

    const exportResult = await presetRepository.exportPresetData(FIXTURE_IDS.serverDiscId);
    expect(exportResult.success).toBe(true);
    if (exportResult.success) {
      expect(exportResult.data.data.attribute_public_flags).toEqual([true]);
    }
  });

  it("re-links an exact official preset import to a pointer", async () => {
    const presetLineageId = 900_002;
    const presetName = "_rt_import_pointer_preset";

    try {
      await testSql`
        INSERT INTO persona_presets (
          persona_preset_name,
          persona_preset_desc,
          preset_lineage_id,
          preset_attribute_list,
          preset_attribute_public_flags,
          preset_sample_dialogues_in,
          preset_sample_dialogues_out,
          preset_language,
          preset_trigger_words,
          preset_avatar_path
        )
        VALUES (
          ${presetName},
          '_rt_import_pointer_prompt',
          ${presetLineageId},
          ARRAY['_rt_import_pointer_attr']::TEXT[],
          ARRAY[true]::BOOLEAN[],
          ARRAY['_rt_import_pointer_in']::TEXT[],
          ARRAY['_rt_import_pointer_out']::TEXT[],
          'en-US',
          ARRAY['_rt_import_pointer_trigger']::TEXT[],
          NULL
        )
        ON CONFLICT (persona_preset_name) DO UPDATE SET
          persona_preset_desc = EXCLUDED.persona_preset_desc,
          preset_lineage_id = EXCLUDED.preset_lineage_id,
          preset_attribute_list = EXCLUDED.preset_attribute_list,
          preset_attribute_public_flags = EXCLUDED.preset_attribute_public_flags,
          preset_sample_dialogues_in = EXCLUDED.preset_sample_dialogues_in,
          preset_sample_dialogues_out = EXCLUDED.preset_sample_dialogues_out,
          preset_language = EXCLUDED.preset_language,
          preset_trigger_words = EXCLUDED.preset_trigger_words
      `;

      const presetData: PresetExportData = {
        tomori_nickname: "_rt_import_pointer_persona",
        attribute_list: ["_rt_import_pointer_attr"],
        attribute_public_flags: [true],
        sample_dialogues_in: ["_rt_import_pointer_in"],
        sample_dialogues_out: ["_rt_import_pointer_out"],
        trigger_words: ["_rt_import_pointer_trigger"],
        persona_prompt: "_rt_import_pointer_prompt",
        persona_lineage_id: presetLineageId,
        preset_lineage_id: presetLineageId,
        physical_appearance_tags: [],
        nai_char_ref_url: null,
        nai_attg_author: null,
        nai_attg_title: null,
        nai_attg_tags: null,
        nai_attg_genre: null,
        nai_attg_stars: null,
      };

      const result = await presetRepository.importPresetData(FIXTURE_IDS.serverDiscId, presetData, "preserve");
      expect(result.success).toBe(true);
      if (result.success) expect(result.mainPersonaIsPointer).toBe(true);

      const [personaRow] = await testSql<
        Array<{
          is_pointer: boolean;
          preset_lineage_id: number | string | bigint | null;
          preset_language: string | null;
        }>
      >`
        SELECT is_pointer, preset_lineage_id, preset_language
        FROM personas
        WHERE persona_id = ${refs.personaId}
      `;

      expect(personaRow.is_pointer).toBe(true);
      expect(Number(personaRow.preset_lineage_id)).toBe(presetLineageId);
      expect(personaRow.preset_language).toBe("en-US");

      const exportResult = await presetRepository.exportPresetData(FIXTURE_IDS.serverDiscId);
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data.data.preset_lineage_id).toBe(presetLineageId);
        expect(exportResult.data.data.attribute_list).toEqual(["_rt_import_pointer_attr"]);
      }
    } finally {
      await testSql`
        UPDATE personas
        SET
          persona_nickname = '_rt_persona',
          attribute_list = ARRAY[]::TEXT[],
          sample_dialogues_in = ARRAY[]::TEXT[],
          sample_dialogues_out = ARRAY[]::TEXT[],
          is_pointer = false,
          preset_lineage_id = NULL,
          preset_language = NULL
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`DELETE FROM persona_attributes WHERE persona_id = ${refs.personaId}`;
      await testSql`
        INSERT INTO persona_configs (persona_id, trigger_words, persona_prompt)
        VALUES (${refs.personaId}, ARRAY['_rt_trigger']::TEXT[], NULL)
        ON CONFLICT (persona_id) DO UPDATE SET
          trigger_words = EXCLUDED.trigger_words,
          persona_prompt = EXCLUDED.persona_prompt
      `;
      await testSql`DELETE FROM persona_presets WHERE persona_preset_name = ${presetName}`;
    }
  });
});
