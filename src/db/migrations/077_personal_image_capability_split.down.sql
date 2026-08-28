-- Down-migration 077: Remove image_nai from personal provider capabilities.
--
-- Reverts assigned_capabilities and enabled_capabilities by removing image_nai.
-- The legacy image token and all model columns remain untouched.

UPDATE user_saved_provider_configs
SET assigned_capabilities = array_remove(assigned_capabilities, 'image_nai')
WHERE 'image_nai' = ANY(assigned_capabilities);

UPDATE user_saved_provider_configs
SET enabled_capabilities = array_remove(enabled_capabilities, 'image_nai')
WHERE 'image_nai' = ANY(enabled_capabilities);
