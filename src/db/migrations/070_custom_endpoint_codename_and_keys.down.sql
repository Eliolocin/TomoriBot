-- Restore legacy provider keys, synthetic codenames, and URL-sensitive coexistence indexes.

BEGIN;

-- Restore URL-sensitive uniqueness used by the legacy schema.
DROP INDEX IF EXISTS idx_custom_endpoint_connections_server_unique;
DROP INDEX IF EXISTS idx_custom_endpoint_connections_user_unique;

CREATE UNIQUE INDEX idx_custom_endpoint_connections_server_unique
  ON custom_endpoint_connections(server_id, label, capability, api_style, endpoint_url)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX idx_custom_endpoint_connections_user_unique
  ON custom_endpoint_connections(user_id, label, capability, api_style, endpoint_url)
  WHERE server_id IS NULL;

-- Restore saved provider configurations to their legacy provider keys.
CREATE TEMP TABLE tmp_down_connection_keys ON COMMIT DROP AS
SELECT
  cec.connection_id,
  cec.server_id,
  cec.user_id,
  CASE
    WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label
    ELSE 'custom:u' || cec.user_id || ':' || cec.label
  END AS legacy_provider_key,
  'custom:' || cec.connection_id AS current_provider_key
FROM custom_endpoint_connections cec;

INSERT INTO saved_provider_configs (
  server_id,
  provider,
  api_key,
  key_version,
  llm_id,
  diffusion_model_id,
  embedding_model_id,
  nai_diffusion_model_id,
  nai_preset_name,
  vision_llm_id,
  video_model_id,
  llm_max_output_tokens,
  thinking_level,
  llm_temperature,
  llm_top_p,
  llm_top_k,
  llm_frequency_penalty,
  llm_presence_penalty,
  llm_min_p,
  llm_logit_biases,
  llm_disabled_params,
  fallback_model_refs,
  saved_at,
  updated_at
)
SELECT
  k.server_id,
  k.legacy_provider_key,
  spc.api_key,
  spc.key_version,
  spc.llm_id,
  spc.diffusion_model_id,
  spc.embedding_model_id,
  spc.nai_diffusion_model_id,
  spc.nai_preset_name,
  spc.vision_llm_id,
  spc.video_model_id,
  spc.llm_max_output_tokens,
  spc.thinking_level,
  spc.llm_temperature,
  spc.llm_top_p,
  spc.llm_top_k,
  spc.llm_frequency_penalty,
  spc.llm_presence_penalty,
  spc.llm_min_p,
  spc.llm_logit_biases,
  spc.llm_disabled_params,
  spc.fallback_model_refs,
  spc.saved_at,
  CURRENT_TIMESTAMP
FROM tmp_down_connection_keys k
JOIN saved_provider_configs spc ON spc.server_id = k.server_id AND spc.provider = k.current_provider_key
WHERE k.server_id IS NOT NULL
ON CONFLICT (server_id, provider) DO UPDATE SET
  api_key = EXCLUDED.api_key,
  key_version = EXCLUDED.key_version,
  llm_id = EXCLUDED.llm_id,
  diffusion_model_id = EXCLUDED.diffusion_model_id,
  embedding_model_id = EXCLUDED.embedding_model_id,
  nai_diffusion_model_id = EXCLUDED.nai_diffusion_model_id,
  nai_preset_name = EXCLUDED.nai_preset_name,
  vision_llm_id = EXCLUDED.vision_llm_id,
  video_model_id = EXCLUDED.video_model_id,
  llm_max_output_tokens = EXCLUDED.llm_max_output_tokens,
  thinking_level = EXCLUDED.thinking_level,
  llm_temperature = EXCLUDED.llm_temperature,
  llm_top_p = EXCLUDED.llm_top_p,
  llm_top_k = EXCLUDED.llm_top_k,
  llm_frequency_penalty = EXCLUDED.llm_frequency_penalty,
  llm_presence_penalty = EXCLUDED.llm_presence_penalty,
  llm_min_p = EXCLUDED.llm_min_p,
  llm_logit_biases = EXCLUDED.llm_logit_biases,
  llm_disabled_params = EXCLUDED.llm_disabled_params,
  fallback_model_refs = EXCLUDED.fallback_model_refs,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO user_saved_provider_configs (
  user_id,
  provider,
  api_key,
  key_version,
  llm_id,
  diffusion_model_id,
  embedding_model_id,
  nai_diffusion_model_id,
  video_model_id,
  vision_llm_id,
  nai_preset_name,
  llm_max_output_tokens,
  thinking_level,
  llm_temperature,
  llm_top_p,
  llm_top_k,
  llm_frequency_penalty,
  llm_presence_penalty,
  llm_min_p,
  llm_logit_biases,
  llm_disabled_params,
  enabled_capabilities,
  assigned_capabilities,
  saved_at,
  updated_at
)
SELECT
  k.user_id,
  k.legacy_provider_key,
  uspc.api_key,
  uspc.key_version,
  uspc.llm_id,
  uspc.diffusion_model_id,
  uspc.embedding_model_id,
  uspc.nai_diffusion_model_id,
  uspc.video_model_id,
  uspc.vision_llm_id,
  uspc.nai_preset_name,
  uspc.llm_max_output_tokens,
  uspc.thinking_level,
  uspc.llm_temperature,
  uspc.llm_top_p,
  uspc.llm_top_k,
  uspc.llm_frequency_penalty,
  uspc.llm_presence_penalty,
  uspc.llm_min_p,
  uspc.llm_logit_biases,
  uspc.llm_disabled_params,
  uspc.enabled_capabilities,
  uspc.assigned_capabilities,
  uspc.saved_at,
  CURRENT_TIMESTAMP
FROM tmp_down_connection_keys k
JOIN user_saved_provider_configs uspc ON uspc.user_id = k.user_id AND uspc.provider = k.current_provider_key
WHERE k.user_id IS NOT NULL
ON CONFLICT (user_id, provider) DO UPDATE SET
  api_key = EXCLUDED.api_key,
  key_version = EXCLUDED.key_version,
  llm_id = EXCLUDED.llm_id,
  diffusion_model_id = EXCLUDED.diffusion_model_id,
  embedding_model_id = EXCLUDED.embedding_model_id,
  nai_diffusion_model_id = EXCLUDED.nai_diffusion_model_id,
  video_model_id = EXCLUDED.video_model_id,
  vision_llm_id = EXCLUDED.vision_llm_id,
  nai_preset_name = EXCLUDED.nai_preset_name,
  llm_max_output_tokens = EXCLUDED.llm_max_output_tokens,
  thinking_level = EXCLUDED.thinking_level,
  llm_temperature = EXCLUDED.llm_temperature,
  llm_top_p = EXCLUDED.llm_top_p,
  llm_top_k = EXCLUDED.llm_top_k,
  llm_frequency_penalty = EXCLUDED.llm_frequency_penalty,
  llm_presence_penalty = EXCLUDED.llm_presence_penalty,
  llm_min_p = EXCLUDED.llm_min_p,
  llm_logit_biases = EXCLUDED.llm_logit_biases,
  llm_disabled_params = EXCLUDED.llm_disabled_params,
  enabled_capabilities = EXCLUDED.enabled_capabilities,
  assigned_capabilities = EXCLUDED.assigned_capabilities,
  updated_at = CURRENT_TIMESTAMP;

DELETE FROM saved_provider_configs spc
USING tmp_down_connection_keys k
WHERE k.server_id IS NOT NULL
  AND spc.server_id = k.server_id
  AND spc.provider = k.current_provider_key;
DELETE FROM user_saved_provider_configs uspc
USING tmp_down_connection_keys k
WHERE k.user_id IS NOT NULL
  AND uspc.user_id = k.user_id
  AND uspc.provider = k.current_provider_key;

-- Reverse stat_counters telemetry keys while retaining additive collisions.
CREATE TEMP TABLE tmp_down_stat_key_map (
  metric TEXT NOT NULL,
  current_key TEXT NOT NULL,
  legacy_key TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_down_stat_key_map (metric, current_key, legacy_key)
SELECT DISTINCT ON (m.metric, l.llm_codename)
  m.metric,
  l.llm_codename AS current_key,
  'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-text' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END AS legacy_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN llms l ON ce.model_ref_id = l.llm_id
CROSS JOIN (VALUES ('model_used'), ('tokens_in'), ('tokens_out')) AS m(metric)
WHERE cec.capability = 'text'
ORDER BY m.metric, l.llm_codename, cec.connection_id;

INSERT INTO tmp_down_stat_key_map (metric, current_key, legacy_key)
SELECT DISTINCT ON (idm.codename)
  'image_generated' AS metric,
  idm.codename AS current_key,
  'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-image' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END AS legacy_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN image_diffusion_models idm ON ce.model_ref_id = idm.diffusion_model_id
WHERE cec.capability = 'image'
ORDER BY idm.codename, cec.connection_id;

INSERT INTO tmp_down_stat_key_map (metric, current_key, legacy_key)
SELECT DISTINCT ON (vgm.codename)
  'video_generated' AS metric,
  vgm.codename AS current_key,
  'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-video' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END AS legacy_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN video_generation_models vgm ON ce.model_ref_id = vgm.video_model_id
WHERE cec.capability = 'video'
ORDER BY vgm.codename, cec.connection_id;

CREATE TEMP TABLE tmp_down_migrating_stats ON COMMIT DROP AS
SELECT
  s.server_id,
  s.user_id,
  s.persona_lineage_id,
  s.metric,
  COALESCE(m.legacy_key, s.metric_key) AS target_metric_key,
  s.bucket,
  s.count,
  s.first_at,
  s.last_at,
  s.metric_key AS orig_metric_key
FROM stat_counters s
JOIN tmp_down_stat_key_map m ON s.metric = m.metric AND s.metric_key = m.current_key;

CREATE TEMP TABLE tmp_down_colliding_target_stats ON COMMIT DROP AS
SELECT
  s.server_id,
  s.user_id,
  s.persona_lineage_id,
  s.metric,
  s.metric_key AS target_metric_key,
  s.bucket,
  s.count,
  s.first_at,
  s.last_at
FROM stat_counters s
WHERE EXISTS (
  SELECT 1 FROM tmp_down_migrating_stats t
  WHERE t.server_id = s.server_id
    AND t.user_id = s.user_id
    AND t.persona_lineage_id = s.persona_lineage_id
    AND t.metric = s.metric
    AND t.target_metric_key = s.metric_key
    AND t.bucket = s.bucket
);

DELETE FROM stat_counters s
USING tmp_down_stat_key_map m
WHERE s.metric = m.metric AND s.metric_key = m.current_key;

DELETE FROM stat_counters s
USING tmp_down_colliding_target_stats c
WHERE s.server_id = c.server_id
  AND s.user_id = c.user_id
  AND s.persona_lineage_id = c.persona_lineage_id
  AND s.metric = c.metric
  AND s.metric_key = c.target_metric_key
  AND s.bucket = c.bucket;

INSERT INTO stat_counters (
  server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count, first_at, last_at
)
SELECT
  server_id,
  user_id,
  persona_lineage_id,
  metric,
  target_metric_key AS metric_key,
  bucket,
  SUM(count) AS count,
  MIN(first_at) AS first_at,
  MAX(last_at) AS last_at
FROM (
  SELECT server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket, count, first_at, last_at FROM tmp_down_migrating_stats
  UNION ALL
  SELECT server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket, count, first_at, last_at FROM tmp_down_colliding_target_stats
) combined
GROUP BY server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket;

-- Restore synthetic model catalog keys and codenames.
UPDATE llms l
SET
  llm_provider = CASE WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label ELSE 'custom:u' || cec.user_id || ':' || cec.label END,
  llm_codename = 'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-text' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END,
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = l.llm_id AND cec.capability = 'text';

UPDATE embedding_models em
SET
  provider = CASE WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label ELSE 'custom:u' || cec.user_id || ':' || cec.label END,
  codename = 'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-embedding' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END,
  model_family = 'custom:' || CASE WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label ELSE 'custom:u' || cec.user_id || ':' || cec.label END,
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = em.embedding_model_id AND cec.capability = 'embedding';

UPDATE image_diffusion_models idm
SET
  provider = CASE WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label ELSE 'custom:u' || cec.user_id || ':' || cec.label END,
  codename = 'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-image' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END,
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = idm.diffusion_model_id AND cec.capability = 'image';

UPDATE video_generation_models vgm
SET
  provider = CASE WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label ELSE 'custom:u' || cec.user_id || ':' || cec.label END,
  codename = 'custom-' || CASE WHEN cec.server_id IS NOT NULL THEN 's' || cec.server_id ELSE 'u' || cec.user_id END || '-' || cec.label || '-video' ||
    CASE WHEN ce.model_name IS NOT NULL AND ce.model_name <> '' THEN '-' || REGEXP_REPLACE(LOWER(ce.model_name), '[^a-z0-9_-]+', '-', 'g') ELSE '' END,
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = vgm.video_model_id AND cec.capability = 'video';

COMMIT;
