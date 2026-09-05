/**
 * Regression harness: retiring a voice sample clears every persona column that referenced it.
 *
 * Covers: clearPersonaVoiceSampleRefs, removeVoiceSample.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { removeVoiceSample } from "@/utils/db/repositories/SpeechRepository";
import { cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const NICKNAME_PREFIX = "_rt_voice_removal_";

interface VoiceColumns {
  speech_voice_sample_id: number | null;
  speech_voice_id: string | null;
  speech_voice_name: string | null;
  speech_voice_design_prompt: string | null;
}

async function insertPersonaWithVoice(
  serverId: number,
  suffix: string,
  voice: Partial<VoiceColumns> & { speech_voice_sample_id: number | null },
): Promise<number> {
  const [persona] = await testSql<[{ persona_id: number }]>`
    INSERT INTO personas (server_id, persona_nickname, is_alter)
    VALUES (${serverId}, ${`${NICKNAME_PREFIX}${suffix}`}, true)
    RETURNING persona_id
  `;
  await testSql`
    INSERT INTO persona_voice_configs (
      persona_id, speech_voice_sample_id, speech_voice_id, speech_voice_name, speech_voice_design_prompt
    )
    VALUES (
      ${persona.persona_id},
      ${voice.speech_voice_sample_id},
      ${voice.speech_voice_id ?? null},
      ${voice.speech_voice_name ?? null},
      ${voice.speech_voice_design_prompt ?? null}
    )
  `;
  return persona.persona_id;
}

async function readVoiceColumns(personaId: number): Promise<VoiceColumns> {
  const [row] = await testSql<[VoiceColumns]>`
    SELECT speech_voice_sample_id, speech_voice_id, speech_voice_name, speech_voice_design_prompt
    FROM persona_voice_configs
    WHERE persona_id = ${personaId}
  `;
  return row;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Speech voice sample removal — regression", () => {
  let refs: FixtureRefs;
  let removedSampleId: number;
  let survivingSampleId: number;
  let ordinaryPersonaId: number;
  let designPersonaId: number;
  let legacyMixedPersonaId: number;
  let blankDesignPersonaId: number;
  let unrelatedPersonaId: number;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);

    const [removed] = await testSql<[{ sample_id: number }]>`
      INSERT INTO voice_samples (server_id, name, file_path)
      VALUES (${refs.serverId}, '_rt_removed_sample', '/voices/_rt_removed_sample.wav')
      RETURNING sample_id
    `;
    removedSampleId = removed.sample_id;

    const [surviving] = await testSql<[{ sample_id: number }]>`
      INSERT INTO voice_samples (server_id, name, file_path)
      VALUES (${refs.serverId}, '_rt_surviving_sample', '/voices/_rt_surviving_sample.wav')
      RETURNING sample_id
    `;
    survivingSampleId = surviving.sample_id;

    ordinaryPersonaId = await insertPersonaWithVoice(refs.serverId, "ordinary", {
      speech_voice_sample_id: removedSampleId,
      speech_voice_name: "_rt_removed_sample",
    });
    designPersonaId = await insertPersonaWithVoice(refs.serverId, "design", {
      speech_voice_sample_id: removedSampleId,
      speech_voice_name: "_rt_removed_sample",
      speech_voice_design_prompt: "  a warm narrator  ",
    });
    legacyMixedPersonaId = await insertPersonaWithVoice(refs.serverId, "legacy_mixed", {
      speech_voice_sample_id: removedSampleId,
      speech_voice_id: "_rt_provider_voice",
      speech_voice_name: "_rt_removed_sample",
    });
    blankDesignPersonaId = await insertPersonaWithVoice(refs.serverId, "blank_design", {
      speech_voice_sample_id: removedSampleId,
      speech_voice_name: "_rt_removed_sample",
      speech_voice_design_prompt: "   \n\t  ",
    });
    unrelatedPersonaId = await insertPersonaWithVoice(refs.serverId, "unrelated", {
      speech_voice_sample_id: survivingSampleId,
      speech_voice_name: "_rt_surviving_sample",
    });

    await removeVoiceSample({
      serverId: refs.serverId,
      serverDiscId: "_rt_server_001",
      sampleId: removedSampleId,
      filePath: "/voices/_rt_removed_sample.wav",
    });
  });

  afterAll(async () => {
    await testSql`DELETE FROM personas WHERE persona_nickname LIKE ${`${NICKNAME_PREFIX}%`}`;
    await testSql`DELETE FROM voice_samples WHERE name IN ('_rt_removed_sample', '_rt_surviving_sample')`;
    await cleanupFixtures(testSql);
  });

  it("deletes the sample row", async () => {
    const rows = await testSql`SELECT sample_id FROM voice_samples WHERE sample_id = ${removedSampleId}`;
    expect(rows.length).toBe(0);
  });

  it("clears the id and the name when the sample was the only voice source", async () => {
    expect(await readVoiceColumns(ordinaryPersonaId)).toEqual({
      speech_voice_sample_id: null,
      speech_voice_id: null,
      speech_voice_name: null,
      speech_voice_design_prompt: null,
    });
  });

  it("names a surviving design prompt rather than keeping the deleted sample's name", async () => {
    expect(await readVoiceColumns(designPersonaId)).toEqual({
      speech_voice_sample_id: null,
      speech_voice_id: null,
      speech_voice_name: "VoiceDesign",
      speech_voice_design_prompt: "  a warm narrator  ",
    });
  });

  it("leaves a legacy mixed-source row's provider voice usable but nameless", async () => {
    expect(await readVoiceColumns(legacyMixedPersonaId)).toEqual({
      speech_voice_sample_id: null,
      speech_voice_id: "_rt_provider_voice",
      speech_voice_name: null,
      speech_voice_design_prompt: null,
    });
  });

  it("treats a whitespace-only design prompt as absent", async () => {
    expect(await readVoiceColumns(blankDesignPersonaId)).toEqual({
      speech_voice_sample_id: null,
      speech_voice_id: null,
      speech_voice_name: null,
      speech_voice_design_prompt: "   \n\t  ",
    });
  });

  it("leaves personas assigned to a different sample untouched", async () => {
    expect(await readVoiceColumns(unrelatedPersonaId)).toEqual({
      speech_voice_sample_id: survivingSampleId,
      speech_voice_id: null,
      speech_voice_name: "_rt_surviving_sample",
      speech_voice_design_prompt: null,
    });
  });
});
