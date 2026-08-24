-- Let a curated image model declare which request modes it supports.
--
-- The columns are nullable with no default on purpose: a NULL keeps the model following its provider's
-- built-in defaults, so an undeclared row is not frozen against a value copied at migration time.

BEGIN;

SELECT add_column_if_not_exists('image_diffusion_models', 'supports_txt2img', 'BOOLEAN');
SELECT add_column_if_not_exists('image_diffusion_models', 'supports_img2img', 'BOOLEAN');
SELECT add_column_if_not_exists('image_diffusion_models', 'supports_inpaint', 'BOOLEAN');
SELECT add_column_if_not_exists('image_diffusion_models', 'supports_negative_prompt', 'BOOLEAN');

COMMIT;
