-- Drop the per-model image capability declarations, returning every model to its provider defaults.

BEGIN;

ALTER TABLE image_diffusion_models DROP COLUMN IF EXISTS supports_txt2img;
ALTER TABLE image_diffusion_models DROP COLUMN IF EXISTS supports_img2img;
ALTER TABLE image_diffusion_models DROP COLUMN IF EXISTS supports_inpaint;
ALTER TABLE image_diffusion_models DROP COLUMN IF EXISTS supports_negative_prompt;

COMMIT;
