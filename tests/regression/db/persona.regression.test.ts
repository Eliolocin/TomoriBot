/**
 * Regression harness: PersonaRepository domain.
 *
 * Covers: loadTomoriState, loadAllPersonasForServer, loadPersonaConfigRow,
 * updateTomori.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { forkPointerForAvatarChange } from "@/utils/persona/pointerFork";
import { personaRepository } from "@/utils/db/repositories";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

async function executeMigrationFile(fileName: string): Promise<void> {
  const sqlText = await readFile(join(import.meta.dir, "..", "..", "..", "src", "db", "migrations", fileName), "utf-8");
  for (const statement of splitSqlStatements(sqlText)) {
    await testSql.unsafe(statement);
  }
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Persona — regression", () => {
  let refs: FixtureRefs;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  it("loadTomoriState returns null for unknown server", async () => {
    const state = await personaRepository.loadState("_rt_unknown_server_9999");
    expect(state).toBeNull();
  });

  it("loadTomoriState assembles a valid TomoriState for the fixture server", async () => {
    const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
    expect(state).not.toBeNull();
    expect(state?.persona_id).toBe(refs.personaId);
    // Config should load the server-scoped row
    expect(state?.config).not.toBeNull();
    expect(state?.llm).not.toBeNull();
  });

  it("loadTomoriState includes a server_memories array for a fresh persona", async () => {
    const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
    expect(Array.isArray(state?.server_memories)).toBe(true);
  });

  it("loadTomoriState and loadAllPersonasForServer read persona config from split tables", async () => {
    try {
      await personaRepository.setContextNote(refs.personaId, "_rt_note_from_setter", 4);
      await personaRepository.setVoiceConfig(refs.personaId, {
        speech_voice_sample_id: null,
        speech_voice_id: "_rt_voice_from_setter",
        speech_voice_name: "_rt_voice_name_from_setter",
        speech_voice_design_prompt: "_rt_voice_prompt_from_setter",
      });
      await personaRepository.setPhysicalAppearanceTags(refs.personaId, ["_rt_tag_from_setter"]);
      await personaRepository.setNaiCharRef(refs.personaId, "_rt_ref_from_setter");
      await personaRepository.setNaiAttg(refs.personaId, {
        nai_attg_author: "_rt_author_from_setter",
        nai_attg_title: "_rt_title_from_setter",
        nai_attg_tags: "_rt_tags_from_setter",
        nai_attg_genre: "_rt_genre_from_setter",
        nai_attg_stars: 3,
      });

      await testSql`
        UPDATE persona_context_note_configs
        SET context_note = '_rt_note_from_split', context_note_depth = 9
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_voice_configs
        SET
          speech_voice_id = '_rt_voice_from_split',
          speech_voice_name = '_rt_voice_name_from_split',
          speech_voice_design_prompt = '_rt_voice_prompt_from_split'
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_imagegen_configs
        SET physical_appearance_tags = ARRAY['_rt_tag_from_split']::TEXT[], nai_char_ref_url = '_rt_ref_from_split'
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_textgen_configs
        SET
          nai_attg_author = '_rt_author_from_split',
          nai_attg_title = '_rt_title_from_split',
          nai_attg_tags = '_rt_tags_from_split',
          nai_attg_genre = '_rt_genre_from_split',
          nai_attg_stars = 5
        WHERE persona_id = ${refs.personaId}
      `;

      const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
      expect(state?.context_note).toBe("_rt_note_from_split");
      expect(state?.context_note_depth).toBe(9);
      expect(state?.speech_voice_id).toBe("_rt_voice_from_split");
      expect(state?.speech_voice_name).toBe("_rt_voice_name_from_split");
      expect(state?.speech_voice_design_prompt).toBe("_rt_voice_prompt_from_split");
      expect(state?.physical_appearance_tags).toEqual(["_rt_tag_from_split"]);
      expect(state?.nai_char_ref_url).toBe("_rt_ref_from_split");
      expect(state?.nai_attg_author).toBe("_rt_author_from_split");
      expect(state?.nai_attg_title).toBe("_rt_title_from_split");
      expect(state?.nai_attg_tags).toBe("_rt_tags_from_split");
      expect(state?.nai_attg_genre).toBe("_rt_genre_from_split");
      expect(state?.nai_attg_stars).toBe(5);

      const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      const loaded = personas.find((persona) => persona.persona_id === refs.personaId);
      expect(loaded?.context_note).toBe("_rt_note_from_split");
      expect(loaded?.speech_voice_id).toBe("_rt_voice_from_split");
      expect(loaded?.physical_appearance_tags).toEqual(["_rt_tag_from_split"]);
      expect(loaded?.nai_attg_author).toBe("_rt_author_from_split");
    } finally {
      await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_voice_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${refs.personaId}`;
    }
  });

  it("loadTomoriState tolerates missing persona split rows", async () => {
    await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${refs.personaId}`;
    await testSql`DELETE FROM persona_voice_configs WHERE persona_id = ${refs.personaId}`;
    await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${refs.personaId}`;
    await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${refs.personaId}`;

    const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
    expect(state).not.toBeNull();
    expect(state?.context_note).toBeNull();
    expect(state?.context_note_depth).toBe(0);
    expect(state?.speech_voice_sample_id).toBeNull();
    expect(state?.speech_voice_id).toBeNull();
    expect(state?.speech_voice_name).toBeNull();
    expect(state?.speech_voice_design_prompt).toBeNull();
    expect(state?.physical_appearance_tags).toEqual([]);
    expect(state?.nai_char_ref_url).toBeNull();
    expect(state?.nai_attg_author).toBeNull();
    expect(state?.nai_attg_stars).toBeNull();
  });

  it("createAlterPersona seeds persona imagegen and textgen split rows", async () => {
    const alterName = `_rt_split_seed_alter_${Date.now()}`;
    let alterPersonaId: number | null = null;

    try {
      const alter = await personaRepository.createAlterPersona({
        serverId: refs.serverId,
        nickname: alterName,
        attributes: ["_rt_seed_attr"],
        sampleDialoguesIn: ["_rt_seed_in"],
        sampleDialoguesOut: ["_rt_seed_out"],
        physicalAppearanceTags: ["_rt_seed_tag"],
        naiCharRefUrl: "_rt_seed_ref",
        naiAttgAuthor: "_rt_seed_author",
        naiAttgTitle: "_rt_seed_title",
        naiAttgTags: "_rt_seed_tags",
        naiAttgGenre: "_rt_seed_genre",
        naiAttgStars: 4,
      });
      alterPersonaId = alter?.persona_id ?? null;
      expect(alterPersonaId).not.toBeNull();

      const [imagegenRow] = await testSql<Array<{ physical_appearance_tags: string[]; nai_char_ref_url: string }>>`
        SELECT physical_appearance_tags, nai_char_ref_url
        FROM persona_imagegen_configs
        WHERE persona_id = ${alterPersonaId}
      `;
      expect(imagegenRow.physical_appearance_tags).toEqual(["_rt_seed_tag"]);
      expect(imagegenRow.nai_char_ref_url).toBe("_rt_seed_ref");

      const [textgenRow] = await testSql<Array<{ nai_attg_author: string; nai_attg_stars: number }>>`
        SELECT nai_attg_author, nai_attg_stars
        FROM persona_textgen_configs
        WHERE persona_id = ${alterPersonaId}
      `;
      expect(textgenRow.nai_attg_author).toBe("_rt_seed_author");
      expect(textgenRow.nai_attg_stars).toBe(4);

      const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      const loadedAlter = personas.find((persona) => persona.persona_id === alterPersonaId);
      expect(loadedAlter?.physical_appearance_tags).toEqual(["_rt_seed_tag"]);
      expect(loadedAlter?.nai_char_ref_url).toBe("_rt_seed_ref");
      expect(loadedAlter?.nai_attg_author).toBe("_rt_seed_author");
      expect(loadedAlter?.nai_attg_stars).toBe(4);
    } finally {
      if (alterPersonaId !== null) {
        await testSql`DELETE FROM personas WHERE persona_id = ${alterPersonaId}`;
      } else {
        await testSql`DELETE FROM personas WHERE server_id = ${refs.serverId} AND persona_nickname = ${alterName}`;
      }
    }
  });

  it("migration 045 backfills missing split rows and lets mirror values win drift", async () => {
    let missingSplitPersonaId: number | null = null;

    try {
      await executeMigrationFile("046_drop_persona_mirror_columns.down.sql");

      const [missingSplitPersona] = await testSql<Array<{ persona_id: number }>>`
        INSERT INTO personas (server_id, persona_nickname, is_alter)
        VALUES (${refs.serverId}, '_rt_045_missing_split', true)
        RETURNING persona_id
      `;
      missingSplitPersonaId = missingSplitPersona.persona_id;

      await testSql`
        UPDATE personas
        SET
          context_note = '_rt_045_mirror_note',
          context_note_depth = 8,
          speech_voice_id = '_rt_045_mirror_voice',
          speech_voice_name = '_rt_045_mirror_voice_name',
          speech_voice_design_prompt = '_rt_045_mirror_prompt',
          physical_appearance_tags = ARRAY['_rt_045_mirror_tag']::TEXT[],
          nai_char_ref_url = '_rt_045_mirror_ref',
          nai_attg_author = '_rt_045_mirror_author',
          nai_attg_title = '_rt_045_mirror_title',
          nai_attg_tags = '_rt_045_mirror_tags',
          nai_attg_genre = '_rt_045_mirror_genre',
          nai_attg_stars = 2
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        INSERT INTO persona_context_note_configs (persona_id, context_note, context_note_depth)
        VALUES (${refs.personaId}, '_rt_045_old_note', 1)
        ON CONFLICT (persona_id) DO UPDATE SET
          context_note = EXCLUDED.context_note,
          context_note_depth = EXCLUDED.context_note_depth
      `;
      await testSql`
        INSERT INTO persona_voice_configs (
          persona_id, speech_voice_id, speech_voice_name, speech_voice_design_prompt
        )
        VALUES (${refs.personaId}, '_rt_045_old_voice', '_rt_045_old_voice_name', '_rt_045_old_prompt')
        ON CONFLICT (persona_id) DO UPDATE SET
          speech_voice_id = EXCLUDED.speech_voice_id,
          speech_voice_name = EXCLUDED.speech_voice_name,
          speech_voice_design_prompt = EXCLUDED.speech_voice_design_prompt
      `;
      await testSql`
        INSERT INTO persona_imagegen_configs (persona_id, physical_appearance_tags, nai_char_ref_url)
        VALUES (${refs.personaId}, ARRAY['_rt_045_old_tag']::TEXT[], '_rt_045_old_ref')
        ON CONFLICT (persona_id) DO UPDATE SET
          physical_appearance_tags = EXCLUDED.physical_appearance_tags,
          nai_char_ref_url = EXCLUDED.nai_char_ref_url
      `;
      await testSql`
        INSERT INTO persona_textgen_configs (
          persona_id, nai_attg_author, nai_attg_title, nai_attg_tags, nai_attg_genre, nai_attg_stars
        )
        VALUES (
          ${refs.personaId},
          '_rt_045_old_author',
          '_rt_045_old_title',
          '_rt_045_old_tags',
          '_rt_045_old_genre',
          1
        )
        ON CONFLICT (persona_id) DO UPDATE SET
          nai_attg_author = EXCLUDED.nai_attg_author,
          nai_attg_title = EXCLUDED.nai_attg_title,
          nai_attg_tags = EXCLUDED.nai_attg_tags,
          nai_attg_genre = EXCLUDED.nai_attg_genre,
          nai_attg_stars = EXCLUDED.nai_attg_stars
      `;

      await testSql`
        UPDATE personas
        SET
          context_note = '_rt_045_missing_note',
          context_note_depth = 6,
          physical_appearance_tags = ARRAY['_rt_045_missing_tag']::TEXT[],
          nai_attg_author = '_rt_045_missing_author'
        WHERE persona_id = ${missingSplitPersonaId}
      `;
      await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${missingSplitPersonaId}`;
      await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${missingSplitPersonaId}`;
      await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${missingSplitPersonaId}`;

      await executeMigrationFile("045_backfill_persona_split_configs.sql");

      const [contextRow] = await testSql<Array<{ context_note: string; context_note_depth: number }>>`
        SELECT context_note, context_note_depth
        FROM persona_context_note_configs
        WHERE persona_id = ${refs.personaId}
      `;
      expect(contextRow.context_note).toBe("_rt_045_mirror_note");
      expect(contextRow.context_note_depth).toBe(8);

      const [imageRow] = await testSql<Array<{ physical_appearance_tags: string[]; nai_char_ref_url: string }>>`
        SELECT physical_appearance_tags, nai_char_ref_url
        FROM persona_imagegen_configs
        WHERE persona_id = ${refs.personaId}
      `;
      expect(imageRow.physical_appearance_tags).toEqual(["_rt_045_mirror_tag"]);
      expect(imageRow.nai_char_ref_url).toBe("_rt_045_mirror_ref");

      const [voiceRow] = await testSql<Array<{ speech_voice_id: string; speech_voice_design_prompt: string }>>`
        SELECT speech_voice_id, speech_voice_design_prompt
        FROM persona_voice_configs
        WHERE persona_id = ${refs.personaId}
      `;
      expect(voiceRow.speech_voice_id).toBe("_rt_045_mirror_voice");
      expect(voiceRow.speech_voice_design_prompt).toBe("_rt_045_mirror_prompt");

      const [textRow] = await testSql<Array<{ nai_attg_author: string; nai_attg_stars: number }>>`
        SELECT nai_attg_author, nai_attg_stars
        FROM persona_textgen_configs
        WHERE persona_id = ${refs.personaId}
      `;
      expect(textRow.nai_attg_author).toBe("_rt_045_mirror_author");
      expect(textRow.nai_attg_stars).toBe(2);

      const [createdMissingRow] = await testSql<Array<{ context_note: string }>>`
        SELECT context_note
        FROM persona_context_note_configs
        WHERE persona_id = ${missingSplitPersonaId}
      `;
      expect(createdMissingRow.context_note).toBe("_rt_045_missing_note");
    } finally {
      if (missingSplitPersonaId !== null) {
        await testSql`DELETE FROM personas WHERE persona_id = ${missingSplitPersonaId}`;
      }
      await executeMigrationFile("046_drop_persona_mirror_columns.sql");
      await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_voice_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${refs.personaId}`;
    }
  });

  it("migration 046 rollback restores mirror columns from split tables", async () => {
    try {
      await executeMigrationFile("046_drop_persona_mirror_columns.sql");
      await personaRepository.setContextNote(refs.personaId, "_rt_046_note", 7);
      await personaRepository.setVoiceConfig(refs.personaId, {
        speech_voice_sample_id: null,
        speech_voice_id: "_rt_046_voice",
        speech_voice_name: "_rt_046_voice_name",
        speech_voice_design_prompt: "_rt_046_prompt",
      });
      await personaRepository.setPhysicalAppearanceTags(refs.personaId, ["_rt_046_tag"]);
      await personaRepository.setNaiCharRef(refs.personaId, "_rt_046_ref");
      await personaRepository.setNaiAttg(refs.personaId, {
        nai_attg_author: "_rt_046_author",
        nai_attg_title: "_rt_046_title",
        nai_attg_tags: "_rt_046_tags",
        nai_attg_genre: "_rt_046_genre",
        nai_attg_stars: 5,
      });

      await executeMigrationFile("046_drop_persona_mirror_columns.down.sql");

      const [row] = await testSql<
        Array<{
          context_note: string;
          context_note_depth: number;
          speech_voice_id: string;
          speech_voice_design_prompt: string;
          physical_appearance_tags: string[];
          nai_char_ref_url: string;
          nai_attg_author: string;
          nai_attg_stars: number;
        }>
      >`
        SELECT
          context_note,
          context_note_depth,
          speech_voice_id,
          speech_voice_design_prompt,
          physical_appearance_tags,
          nai_char_ref_url,
          nai_attg_author,
          nai_attg_stars
        FROM personas
        WHERE persona_id = ${refs.personaId}
      `;

      expect(row.context_note).toBe("_rt_046_note");
      expect(row.context_note_depth).toBe(7);
      expect(row.speech_voice_id).toBe("_rt_046_voice");
      expect(row.speech_voice_design_prompt).toBe("_rt_046_prompt");
      expect(row.physical_appearance_tags).toEqual(["_rt_046_tag"]);
      expect(row.nai_char_ref_url).toBe("_rt_046_ref");
      expect(row.nai_attg_author).toBe("_rt_046_author");
      expect(row.nai_attg_stars).toBe(5);
    } finally {
      await executeMigrationFile("046_drop_persona_mirror_columns.sql");
      await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_voice_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${refs.personaId}`;
    }
  });

  it("persona config export/import round-trips through split tables", async () => {
    try {
      await personaRepository.setContextNote(refs.personaId, "_rt_export_note", 3);
      await personaRepository.setVoiceConfig(refs.personaId, {
        speech_voice_sample_id: null,
        speech_voice_id: "_rt_export_voice",
        speech_voice_name: "_rt_export_voice_name",
        speech_voice_design_prompt: "_rt_export_prompt",
      });
      await personaRepository.setPhysicalAppearanceTags(refs.personaId, ["_rt_export_tag"]);
      await personaRepository.setNaiCharRef(refs.personaId, "_rt_export_ref");
      await personaRepository.setNaiAttg(refs.personaId, {
        nai_attg_author: "_rt_export_author",
        nai_attg_title: "_rt_export_title",
        nai_attg_tags: "_rt_export_tags",
        nai_attg_genre: "_rt_export_genre",
        nai_attg_stars: 4,
      });

      const exported = await personaRepository.toExportShape(FIXTURE_IDS.serverDiscId);
      expect(exported).not.toBeNull();
      if (!exported) {
        throw new Error("Expected persona export shape for fixture server.");
      }

      await testSql`
        UPDATE persona_context_note_configs
        SET context_note = '_rt_export_mutated', context_note_depth = 1
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_voice_configs
        SET speech_voice_id = '_rt_export_mutated_voice'
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_imagegen_configs
        SET physical_appearance_tags = ARRAY['_rt_export_mutated_tag']::TEXT[]
        WHERE persona_id = ${refs.personaId}
      `;
      await testSql`
        UPDATE persona_textgen_configs
        SET nai_attg_author = '_rt_export_mutated_author'
        WHERE persona_id = ${refs.personaId}
      `;

      expect(await personaRepository.fromExportShape(FIXTURE_IDS.serverDiscId, exported)).toBe(true);

      const state = await personaRepository.loadState(FIXTURE_IDS.serverDiscId);
      expect(state?.context_note).toBe("_rt_export_note");
      expect(state?.context_note_depth).toBe(3);
      expect(state?.speech_voice_id).toBe("_rt_export_voice");
      expect(state?.physical_appearance_tags).toEqual(["_rt_export_tag"]);
      expect(state?.nai_attg_author).toBe("_rt_export_author");
    } finally {
      await testSql`DELETE FROM persona_context_note_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_voice_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_imagegen_configs WHERE persona_id = ${refs.personaId}`;
      await testSql`DELETE FROM persona_textgen_configs WHERE persona_id = ${refs.personaId}`;
    }
  });

  it("loadAllPersonasForServer returns at least the main persona", async () => {
    const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
    expect(personas.length).toBeGreaterThanOrEqual(1);
    const mainPersona = personas.find((p) => !p.is_alter);
    expect(mainPersona).not.toBeUndefined();
    expect(mainPersona?.persona_id).toBe(refs.personaId);
  });

  it("loadAllPersonasForServer returns empty array for unknown server", async () => {
    const personas = await personaRepository.loadAllForServer("_rt_unknown_server_9999");
    expect(personas).toHaveLength(0);
  });

  it("swapPersona promotes the alter row without mixing persona details", async () => {
    const alterName = `_rt_swap_alter_${Date.now()}`;
    const mainAttribute = "_rt_main_attr";
    const alterAttribute = "_rt_alter_attr";
    let alterPersonaId: number | null = null;

    await testSql`
      UPDATE personas
      SET
        attribute_list = ARRAY[${mainAttribute}]::TEXT[],
        sample_dialogues_in = ARRAY['_rt_main_in']::TEXT[],
        sample_dialogues_out = ARRAY['_rt_main_out']::TEXT[]
      WHERE persona_id = ${refs.personaId}
    `;

    const [alterRow] = await testSql<Array<{ persona_id: number }>>`
      INSERT INTO personas (
        server_id,
        persona_nickname,
        attribute_list,
        sample_dialogues_in,
        sample_dialogues_out,
        is_alter
      )
      VALUES (
        ${refs.serverId},
        ${alterName},
        ARRAY[${alterAttribute}]::TEXT[],
        ARRAY['_rt_alter_in']::TEXT[],
        ARRAY['_rt_alter_out']::TEXT[],
        true
      )
      RETURNING persona_id
    `;
    alterPersonaId = alterRow.persona_id;

    try {
      const swapped = await personaRepository.swapPersona(refs.personaId, alterPersonaId);
      expect(swapped).toBe(true);

      const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      const promotedAlter = personas.find((persona) => persona.persona_id === alterPersonaId);
      const formerMain = personas.find((persona) => persona.persona_id === refs.personaId);

      expect(promotedAlter?.is_alter).toBe(false);
      expect(promotedAlter?.persona_nickname).toBe(alterName);
      expect(promotedAlter?.attribute_list).toContain(alterAttribute);
      expect(promotedAlter?.sample_dialogues_in).toContain("_rt_alter_in");
      expect(promotedAlter?.sample_dialogues_out).toContain("_rt_alter_out");

      expect(formerMain?.is_alter).toBe(true);
      expect(formerMain?.persona_nickname).toBe("_rt_persona");
      expect(formerMain?.attribute_list).toContain(mainAttribute);
      expect(formerMain?.sample_dialogues_in).toContain("_rt_main_in");
      expect(formerMain?.sample_dialogues_out).toContain("_rt_main_out");
    } finally {
      if (alterPersonaId !== null) {
        await personaRepository.swapPersona(alterPersonaId, refs.personaId);
        await testSql`DELETE FROM personas WHERE persona_id = ${alterPersonaId}`;
      }

      await testSql`
        UPDATE personas
        SET
          attribute_list = ARRAY[]::TEXT[],
          sample_dialogues_in = ARRAY[]::TEXT[],
          sample_dialogues_out = ARRAY[]::TEXT[]
        WHERE persona_id = ${refs.personaId}
      `;
    }
  });

  it("addSampleDialoguePair appends TEXT[] dialogue arrays", async () => {
    await testSql`
      UPDATE personas
      SET
        sample_dialogues_in = ARRAY[]::TEXT[],
        sample_dialogues_out = ARRAY[]::TEXT[]
      WHERE persona_id = ${refs.personaId}
    `;

    const added = await personaRepository.addSampleDialoguePair(refs.personaId, ["_rt_added_in"], ["_rt_added_out"]);
    expect(added).toBe(true);

    const [row] = await testSql<Array<{ sample_dialogues_in: string[]; sample_dialogues_out: string[] }>>`
      SELECT sample_dialogues_in, sample_dialogues_out
      FROM personas
      WHERE persona_id = ${refs.personaId}
    `;

    expect(row.sample_dialogues_in).toEqual(["_rt_added_in"]);
    expect(row.sample_dialogues_out).toEqual(["_rt_added_out"]);
  });

  it("attribute helpers keep persona_attributes and attribute_list mirrored", async () => {
    try {
      expect(
        await personaRepository.replaceAttributes(refs.personaId, ["_rt_private", "_rt_public"], [false, true]),
      ).toBe(true);

      let personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      let persona = personas.find((item) => item.persona_id === refs.personaId);
      expect(persona?.attribute_list).toEqual(["_rt_private", "_rt_public"]);
      expect(persona?.persona_attributes.map((attribute) => attribute.is_public)).toEqual([false, true]);

      expect(await personaRepository.addAttributes(refs.personaId, ["_rt_added_public"], true)).toBe(true);
      expect(await personaRepository.editAttributeAt(refs.personaId, 1, "_rt_private_edited", true)).toBe(true);
      expect(await personaRepository.removeAttributeAt(refs.personaId, 2)).toBe(true);

      personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      persona = personas.find((item) => item.persona_id === refs.personaId);
      expect(persona?.attribute_list).toEqual(["_rt_private_edited", "_rt_added_public"]);
      expect(persona?.persona_attributes.map((attribute) => attribute.is_public)).toEqual([true, true]);

      const [mirrorRow] = await testSql<Array<{ attribute_list: string[] }>>`
        SELECT attribute_list
        FROM personas
        WHERE persona_id = ${refs.personaId}
      `;
      expect(mirrorRow.attribute_list).toEqual(["_rt_private_edited", "_rt_added_public"]);
    } finally {
      await personaRepository.replaceAttributes(refs.personaId, []);
    }
  });

  it("preset pointers resolve live preset content and fork on first content edit", async () => {
    const presetLineageId = 900_001;
    const presetName = "_rt_pointer_preset";

    try {
      const [preset] = await testSql`
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
          '_rt_pointer_prompt_v1',
          ${presetLineageId},
          ARRAY['_rt_pointer_attr_v1']::TEXT[],
          ARRAY[true]::BOOLEAN[],
          ARRAY['_rt_pointer_in_v1']::TEXT[],
          ARRAY['_rt_pointer_out_v1']::TEXT[],
          'en-US',
          ARRAY['_rt_pointer_trigger_v1']::TEXT[],
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
        RETURNING *
      `;

      const applied = await personaRepository.applyPresetPointerToPersona({
        personaId: refs.personaId,
        nickname: "_rt_pointer_persona",
        preset,
        personaLineageId: presetLineageId,
      });
      expect(applied?.is_pointer).toBe(true);

      await testSql`
        UPDATE persona_presets
        SET
          persona_preset_desc = '_rt_pointer_prompt_v2',
          preset_attribute_list = ARRAY['_rt_pointer_attr_v2']::TEXT[],
          preset_attribute_public_flags = ARRAY[false]::BOOLEAN[],
          preset_sample_dialogues_in = ARRAY['_rt_pointer_in_v2']::TEXT[],
          preset_sample_dialogues_out = ARRAY['_rt_pointer_out_v2']::TEXT[],
          preset_trigger_words = ARRAY['_rt_pointer_trigger_v2']::TEXT[]
        WHERE persona_preset_name = ${presetName}
      `;

      let personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      let persona = personas.find((item) => item.persona_id === refs.personaId);
      expect(persona?.is_pointer).toBe(true);
      expect(persona?.attribute_list).toEqual(["_rt_pointer_attr_v2"]);
      expect(persona?.persona_attributes.map((attribute) => attribute.is_public)).toEqual([false]);
      expect(persona?.sample_dialogues_in).toEqual(["_rt_pointer_in_v2"]);
      expect(persona?.trigger_words).toEqual(["_rt_pointer_trigger_v2"]);
      expect(persona?.persona_prompt).toBe("_rt_pointer_prompt_v2");

      expect(await personaRepository.addAttributes(refs.personaId, ["_rt_after_fork"], false)).toBe(true);

      const [forkedRow] = await testSql<Array<{ is_pointer: boolean; persona_lineage_id: number | string | bigint }>>`
        SELECT is_pointer, persona_lineage_id
        FROM personas
        WHERE persona_id = ${refs.personaId}
      `;
      expect(forkedRow.is_pointer).toBe(false);
      expect(Number(forkedRow.persona_lineage_id)).toBe(presetLineageId);

      await testSql`
        UPDATE persona_presets
        SET preset_attribute_list = ARRAY['_rt_pointer_attr_v3']::TEXT[]
        WHERE persona_preset_name = ${presetName}
      `;

      personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      persona = personas.find((item) => item.persona_id === refs.personaId);
      expect(persona?.attribute_list).toEqual(["_rt_pointer_attr_v2", "_rt_after_fork"]);
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

  it("/server avatar materializes a pointer persona before avatar customization", async () => {
    const presetLineageId = 900_002;
    const personaLineageId = 900_102;
    const presetName = "_rt_avatar_pointer_preset";
    const alterName = `_rt_avatar_pointer_alter_${Date.now()}`;
    let alterPersonaId: number | null = null;

    try {
      const [preset] = await testSql`
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
          '_rt_avatar_pointer_prompt',
          ${presetLineageId},
          ARRAY['_rt_avatar_pointer_attr']::TEXT[],
          ARRAY[true]::BOOLEAN[],
          ARRAY['_rt_avatar_pointer_in']::TEXT[],
          ARRAY['_rt_avatar_pointer_out']::TEXT[],
          'en-US',
          ARRAY['_rt_avatar_pointer_trigger']::TEXT[],
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
        RETURNING *
      `;

      const alter = await personaRepository.createPresetPointerAlterPersona({
        serverId: refs.serverId,
        nickname: alterName,
        preset,
        personaLineageId,
      });
      alterPersonaId = alter?.persona_id ?? null;
      expect(alterPersonaId).not.toBeNull();
      expect(alter?.is_pointer).toBe(true);

      const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
      const selectedPersona = personas.find((item) => item.persona_id === alterPersonaId);
      expect(selectedPersona?.is_pointer).toBe(true);
      if (!selectedPersona || alterPersonaId === null) {
        throw new Error("Expected pointer alter persona to exist before avatar update.");
      }

      expect(await forkPointerForAvatarChange(selectedPersona)).toBe(true);
      expect(await personaRepository.setAvatar(alterPersonaId, "_rt_avatar_pointer_url")).toBe(true);

      const [forkedRow] = await testSql<
        Array<{ is_pointer: boolean; persona_lineage_id: number | string | bigint; webhook_avatar_url: string | null }>
      >`
        SELECT is_pointer, persona_lineage_id, webhook_avatar_url
        FROM personas
        WHERE persona_id = ${alterPersonaId}
      `;

      expect(forkedRow.is_pointer).toBe(false);
      expect(Number(forkedRow.persona_lineage_id)).toBe(personaLineageId);
      expect(forkedRow.webhook_avatar_url).toBe("_rt_avatar_pointer_url");
    } finally {
      if (alterPersonaId !== null) {
        await testSql`DELETE FROM personas WHERE persona_id = ${alterPersonaId}`;
      } else {
        await testSql`DELETE FROM personas WHERE server_id = ${refs.serverId} AND persona_nickname = ${alterName}`;
      }
      await testSql`DELETE FROM persona_presets WHERE persona_preset_name = ${presetName}`;
    }
  });

  it("loadPersonaConfigRow returns the fixture persona_config row", async () => {
    const config = await personaRepository.loadPersonaConfig(refs.personaId);
    expect(config).not.toBeNull();
    expect(config?.persona_id).toBe(refs.personaId);
    expect(config?.trigger_words).toContain("_rt_trigger");
  });

  it("loadPersonaConfigRow returns null for unknown persona", async () => {
    const config = await personaRepository.loadPersonaConfig(999_999_999);
    expect(config).toBeNull();
  });

  it("trigger config writes strip surrounding quote characters", async () => {
    const originalConfig = await personaRepository.loadPersonaConfig(refs.personaId);
    const originalTriggers = [...(originalConfig?.trigger_words ?? [])];

    try {
      const added = await personaRepository.addTrigger(refs.personaId, [
        '"_rt_quoted_trigger"',
        "`_rt_quoted_trigger`",
        "'_rt_second_quoted_trigger'",
      ]);
      expect(added).toBe(true);

      const config = await personaRepository.loadPersonaConfig(refs.personaId);
      expect(config?.trigger_words).toContain("_rt_quoted_trigger");
      expect(config?.trigger_words).toContain("_rt_second_quoted_trigger");
      expect(config?.trigger_words).not.toContain('"_rt_quoted_trigger"');
      expect(config?.trigger_words).not.toContain("`_rt_quoted_trigger`");
    } finally {
      await personaRepository.removeTrigger(refs.personaId, originalTriggers);
    }
  });

  it("updateTomori mutates the nickname and returns the updated row", async () => {
    const updated = await personaRepository.update(refs.personaId, { persona_nickname: "_rt_persona_renamed" });
    expect(updated).not.toBeNull();
    expect(updated?.persona_nickname).toBe("_rt_persona_renamed");
  });

  it("loadAllPersonasForServer reflects the nickname change", async () => {
    const personas = await personaRepository.loadAllForServer(FIXTURE_IDS.serverDiscId);
    const main = personas.find((p) => p.persona_id === refs.personaId);
    expect(main?.persona_nickname).toBe("_rt_persona_renamed");
  });
});
