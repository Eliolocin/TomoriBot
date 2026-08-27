-- Rollback 076: drop the personal text model randomizer flag.
--
-- WARNING: dropping this column discards the per-user personal provider randomizer toggle.
-- The column is re-added defaulting OFF on the next forward migration run.

ALTER TABLE user_saved_provider_configs DROP COLUMN IF EXISTS model_randomizer_enabled;
