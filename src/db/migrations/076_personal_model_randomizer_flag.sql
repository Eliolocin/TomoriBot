-- Migration 076: Personal text model randomizer flag.
--
-- Adds an opt-in, per-personal-provider toggle to `user_saved_provider_configs`.
-- When a user runs their own text model, this flag governs randomizer behavior
-- for their generation turns instead of inheriting the server setting.

SELECT add_column_if_not_exists('user_saved_provider_configs', 'model_randomizer_enabled', 'BOOLEAN', 'false', 'NOT NULL');
