-- Migration 077: Split personal image capability into Standard and NovelAI Image.
--
-- Backfills image_nai into assigned_capabilities and enabled_capabilities for rows
-- that own an image capability and have a configured NovelAI diffusion model.
-- The legacy image token is preserved in both arrays.

-- Rows with a configured NovelAI model inherit dedicated NAI capability assignment from the legacy image assignment.
UPDATE user_saved_provider_configs
SET assigned_capabilities = array_append(assigned_capabilities, 'image_nai')
WHERE nai_diffusion_model_id IS NOT NULL
  AND 'image' = ANY(assigned_capabilities)
  AND NOT ('image_nai' = ANY(assigned_capabilities));

-- Active NAI routing activates only when the legacy image capability was actively enabled for the provider.
UPDATE user_saved_provider_configs
SET enabled_capabilities = array_append(enabled_capabilities, 'image_nai')
WHERE nai_diffusion_model_id IS NOT NULL
  AND 'image' = ANY(enabled_capabilities)
  AND NOT ('image_nai' = ANY(enabled_capabilities));
