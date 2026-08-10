import type { SQL } from "bun";
import { personaSections } from "./personas";
import { str, textArray } from "./sql";
import type { PersonaInput } from "./types";
import { personaNamingConfigSchema, validatePersonaNamingAuthoring } from "@/types/personaNaming";

const OFFICIAL_LINEAGE_IDS = new Set<number>([4, 716, 1770, 3585, 50]); // 1337 (Zaya) pending

const PERSONA_COLUMNS =
  "persona_preset_name, persona_preset_desc, preset_attribute_list, preset_sample_dialogues_in, preset_sample_dialogues_out, preset_language, preset_avatar_path, preset_trigger_words, preset_lineage_id, preset_naming_config";

// Upsert identity is the stable (lineage, language) pair, NOT persona_preset_name.
// The name is a mutable, human-facing catalog label, so keying on it would turn a
// rename into an orphan-plus-duplicate (and collide with the lineage/language unique
// index, aborting the whole batch INSERT). Matching on the lineage pair instead lets a
// name change resolve to the existing row and update the label in place. The arbiter is
// the partial index `idx_persona_presets_lineage_language_unique`, so its WHERE predicate
// must be restated here for inference. persona_preset_name is therefore now a normal
// updated column rather than the conflict target.
const PERSONA_ON_CONFLICT = `ON CONFLICT (preset_lineage_id, preset_language) WHERE preset_lineage_id IS NOT NULL DO UPDATE SET
  persona_preset_name = EXCLUDED.persona_preset_name,
  persona_preset_desc = EXCLUDED.persona_preset_desc,
  preset_attribute_list = EXCLUDED.preset_attribute_list,
  preset_sample_dialogues_in = EXCLUDED.preset_sample_dialogues_in,
  preset_sample_dialogues_out = EXCLUDED.preset_sample_dialogues_out,
  preset_avatar_path = EXCLUDED.preset_avatar_path,
  preset_trigger_words = EXCLUDED.preset_trigger_words,
  preset_naming_config = EXCLUDED.preset_naming_config,
  updated_at = CURRENT_TIMESTAMP`;

const OFFICIAL_ATTRIBUTE_FLAGS_UPDATE = `WITH official_attribute_flags AS (
  SELECT
    pp.persona_preset_id,
    ARRAY(
      SELECT (attr.ord = 1)
      FROM unnest(COALESCE(pp.preset_attribute_list, ARRAY[]::TEXT[]))
        WITH ORDINALITY AS attr(attribute_text, ord)
      ORDER BY attr.ord
    )::BOOLEAN[] AS public_flags
  FROM persona_presets pp
  WHERE pp.preset_lineage_id IN (4, 716, 1770, 3585, 50)
)
UPDATE persona_presets pp
SET
  preset_attribute_public_flags = official_attribute_flags.public_flags,
  updated_at = CURRENT_TIMESTAMP
FROM official_attribute_flags
WHERE pp.persona_preset_id = official_attribute_flags.persona_preset_id
  AND pp.preset_attribute_public_flags IS DISTINCT FROM official_attribute_flags.public_flags`;

function rowsOf(): PersonaInput[] {
  return personaSections.flatMap((section) => section.rows);
}

function renderPersonaTuple(preset: PersonaInput): string {
  return [
    str(preset.name),
    str(preset.desc),
    textArray(preset.attributes),
    textArray(preset.sampleDialoguesIn),
    textArray(preset.sampleDialoguesOut),
    str(preset.language),
    str(preset.avatarPath),
    textArray(preset.triggerWords),
    String(preset.lineageId),
    str(JSON.stringify(preset.namingConfig)),
  ].join(", ");
}

export function validatePersonas(): string[] {
  const errors: string[] = [];
  const rows = rowsOf();
  const seenNames = new Set<string>();
  const seenLineageLanguages = new Set<string>();
  const seenOfficialLineages = new Set<number>();

  for (const preset of rows) {
    // persona_preset_name still carries a UNIQUE constraint, so duplicate labels remain invalid.
    if (seenNames.has(preset.name)) {
      errors.push(`persona_presets: duplicate persona_preset_name ${preset.name}`);
    }
    seenNames.add(preset.name);

    // (lineage, language) is the upsert identity; a collision here would abort the batch
    // INSERT against idx_persona_presets_lineage_language_unique, so fail early and clearly.
    const lineageLanguageKey = `${preset.lineageId}::${preset.language}`;
    if (seenLineageLanguages.has(lineageLanguageKey)) {
      errors.push(
        `persona_presets: duplicate (preset_lineage_id, preset_language) ${preset.lineageId}/${preset.language}`,
      );
    }
    seenLineageLanguages.add(lineageLanguageKey);

    if (preset.sampleDialoguesIn.length !== preset.sampleDialoguesOut.length) {
      errors.push(
        `persona_presets/${preset.name}: preset_sample_dialogues_in length ${preset.sampleDialoguesIn.length} does not match preset_sample_dialogues_out length ${preset.sampleDialoguesOut.length}`,
      );
    }

    const parsedNamingConfig = personaNamingConfigSchema.safeParse(preset.namingConfig);
    if (!parsedNamingConfig.success) {
      errors.push(
        `persona_presets/${preset.name}: invalid naming config: ${parsedNamingConfig.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    } else {
      try {
        validatePersonaNamingAuthoring(parsedNamingConfig.data, [
          preset.desc,
          ...preset.attributes,
          ...preset.sampleDialoguesOut,
        ]);
      } catch (error) {
        errors.push(`persona_presets/${preset.name}: ${(error as Error).message}`);
      }
    }

    if (OFFICIAL_LINEAGE_IDS.has(preset.lineageId)) {
      seenOfficialLineages.add(preset.lineageId);
      if (preset.attributes.length === 0) {
        errors.push(`persona_presets/${preset.name}: official lineage ${preset.lineageId} has no attributes`);
      }
    }
  }

  for (const lineageId of OFFICIAL_LINEAGE_IDS) {
    if (!seenOfficialLineages.has(lineageId)) {
      errors.push(`persona_presets: missing official lineage ${lineageId}`);
    }
  }

  return errors;
}

function buildPersonaSeedStatements(): string[] {
  const rows = rowsOf();

  const backfillValues = rows
    .map((preset) => `  (${str(preset.name)}, CAST(${preset.lineageId} AS BIGINT))`)
    .join(",\n");

  const backfillStatement = `UPDATE persona_presets
SET preset_lineage_id = seed.lineage_id
FROM (VALUES
${backfillValues}
) AS seed(name, lineage_id)
WHERE persona_presets.persona_preset_name = seed.name
  AND persona_presets.preset_lineage_id IS NULL;`;

  const values = rows.map((preset) => `  (${renderPersonaTuple(preset)})`).join(",\n");

  return [
    backfillStatement,
    `INSERT INTO persona_presets (${PERSONA_COLUMNS})\nVALUES\n${values}\n${PERSONA_ON_CONFLICT}`,
    OFFICIAL_ATTRIBUTE_FLAGS_UPDATE,
  ];
}

export async function seedPersonasFromCatalog(client: SQL): Promise<void> {
  const violations = validatePersonas();
  if (violations.length > 0) {
    throw new Error(`Persona catalog invariant violations:\n  - ${violations.join("\n  - ")}`);
  }

  for (const statement of buildPersonaSeedStatements()) {
    await client.unsafe(statement);
  }
}
