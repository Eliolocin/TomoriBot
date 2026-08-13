-- Down-migration 063: return forked official personas to an empty naming config.
--
-- Restores the pre-063 state written by migration 062. A row is only cleared when
-- it still matches its preset exactly, so naming habits edited since the up-migration
-- survive the rollback. That equality test cannot distinguish a fork this migration
-- filled in from one whose owner deliberately chose the same values as the preset;
-- both are cleared. Those are indistinguishable by storage alone, and clearing is
-- what restores the documented pre-063 shape.

UPDATE persona_naming_configs pnc
SET
  prefixes = '{}'::JSONB,
  suffixes = '{}'::JSONB,
  address_terms = '{}'::JSONB,
  updated_at = NOW()
FROM personas p
JOIN persona_presets pp
  ON pp.preset_lineage_id = p.preset_lineage_id
  AND pp.preset_language = p.preset_language
WHERE pnc.persona_id = p.persona_id
  AND p.is_pointer = false
  AND p.preset_lineage_id IS NOT NULL
  AND p.preset_language IS NOT NULL
  AND pnc.prefixes = COALESCE(pp.preset_naming_config -> 'prefixes', '{}'::JSONB)
  AND pnc.suffixes = COALESCE(pp.preset_naming_config -> 'suffixes', '{}'::JSONB)
  AND pnc.address_terms = COALESCE(pp.preset_naming_config -> 'addressTerms', '{}'::JSONB);
