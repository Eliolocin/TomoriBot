-- Migration 063: give pre-062 forks of official personas their catalog naming config.
--
-- Migration 062 backfilled every existing persona with an empty naming config,
-- including personas that had already been materialized out of a preset pointer.
-- For those forks the emptiness records no user choice: the column did not exist
-- when they forked, so there was nothing to opt out of. The visible result is two
-- copies of the same official persona addressing people differently, with no
-- setting a server owner can inspect to explain the difference.
--
-- Live pointers are excluded because they hold no naming config of their own:
-- they resolve persona_presets.preset_naming_config at load time and already
-- track the catalog.
--
-- Only an all-empty config is replaced, so naming habits set through
-- `/persona naming-habits` after 062 are preserved.
--
-- Migrations run after catalog seeding (see initializeDatabase), so
-- persona_presets already holds the current catalog values when this executes.

UPDATE persona_naming_configs pnc
SET
  prefixes = COALESCE(pp.preset_naming_config -> 'prefixes', '{}'::JSONB),
  suffixes = COALESCE(pp.preset_naming_config -> 'suffixes', '{}'::JSONB),
  address_terms = COALESCE(pp.preset_naming_config -> 'addressTerms', '{}'::JSONB),
  updated_at = NOW()
FROM personas p
JOIN persona_presets pp
  ON pp.preset_lineage_id = p.preset_lineage_id
  AND pp.preset_language = p.preset_language
WHERE pnc.persona_id = p.persona_id
  AND p.is_pointer = false
  AND p.preset_lineage_id IS NOT NULL
  AND p.preset_language IS NOT NULL
  AND pnc.prefixes = '{}'::JSONB
  AND pnc.suffixes = '{}'::JSONB
  AND pnc.address_terms = '{}'::JSONB
  AND (
    COALESCE(pp.preset_naming_config -> 'prefixes', '{}'::JSONB) <> '{}'::JSONB
    OR COALESCE(pp.preset_naming_config -> 'suffixes', '{}'::JSONB) <> '{}'::JSONB
    OR COALESCE(pp.preset_naming_config -> 'addressTerms', '{}'::JSONB) <> '{}'::JSONB
  );
