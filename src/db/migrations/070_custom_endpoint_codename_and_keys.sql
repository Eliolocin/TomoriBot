-- Migration 070 moves custom endpoint identity to durable connection IDs and literal model names.
-- It also preserves coexistence, saved credentials, and telemetry while making labels unique.

BEGIN;

-- Capture old provider keys before label suffixing or dropping them.
CREATE TEMP TABLE tmp_connection_keys ON COMMIT DROP AS
SELECT
  cec.connection_id,
  cec.server_id,
  cec.user_id,
  cec.label,
  cec.capability,
  CASE
    WHEN cec.server_id IS NOT NULL THEN 'custom:s' || cec.server_id || ':' || cec.label
    ELSE 'custom:u' || cec.user_id || ':' || cec.label
  END AS old_provider_key,
  'custom:' || cec.connection_id AS new_provider_key
FROM custom_endpoint_connections cec;

-- Suffix collision labels for distinct connections that share (owner, label, capability)
DO $$
DECLARE
  rec RECORD;
  new_label TEXT;
  suffix INT;
  base_label TEXT;
  max_base_len INT;
BEGIN
  FOR rec IN (
    SELECT connection_id, server_id, user_id, capability, label,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(server_id, -1), COALESCE(user_id, -1), capability, label
             ORDER BY connection_id ASC
           ) AS rn
    FROM custom_endpoint_connections
  ) LOOP
    IF rec.rn > 1 THEN
      suffix := rec.rn;
      LOOP
        max_base_len := 40 - LENGTH('_' || suffix);
        base_label := SUBSTRING(rec.label FROM 1 FOR max_base_len);
        new_label := base_label || '_' || suffix;

        IF NOT EXISTS (
          SELECT 1 FROM custom_endpoint_connections
          WHERE (
            (rec.server_id IS NOT NULL AND server_id = rec.server_id AND user_id IS NULL)
            OR
            (rec.user_id IS NOT NULL AND user_id = rec.user_id AND server_id IS NULL)
          )
          AND capability = rec.capability
          AND label = new_label
        ) THEN
          UPDATE custom_endpoint_connections
          SET label = new_label, updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = rec.connection_id;
          EXIT;
        END IF;
        suffix := suffix + 1;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Replace URL-sensitive uniqueness with owner, label, and capability identity.
DROP INDEX IF EXISTS idx_custom_endpoint_connections_server_unique;
DROP INDEX IF EXISTS idx_custom_endpoint_connections_user_unique;

CREATE UNIQUE INDEX idx_custom_endpoint_connections_server_unique
  ON custom_endpoint_connections(server_id, label, capability)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX idx_custom_endpoint_connections_user_unique
  ON custom_endpoint_connections(user_id, label, capability)
  WHERE server_id IS NULL;

-- Clone and migrate saved provider configurations to connection-keyed providers.
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
  k.new_provider_key,
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
FROM tmp_connection_keys k
JOIN saved_provider_configs spc ON spc.server_id = k.server_id AND spc.provider = k.old_provider_key
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
  k.new_provider_key,
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
FROM tmp_connection_keys k
JOIN user_saved_provider_configs uspc ON uspc.user_id = k.user_id AND uspc.provider = k.old_provider_key
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
USING tmp_connection_keys k
WHERE k.server_id IS NOT NULL
  AND spc.server_id = k.server_id
  AND spc.provider = k.old_provider_key;
DELETE FROM user_saved_provider_configs uspc
USING tmp_connection_keys k
WHERE k.user_id IS NOT NULL
  AND uspc.user_id = k.user_id
  AND uspc.provider = k.old_provider_key;

-- Backfill stat_counters metric keys from old codenames to literal model names.
CREATE TEMP TABLE tmp_stat_key_map (
  metric TEXT NOT NULL,
  old_key TEXT NOT NULL,
  new_key TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_stat_key_map (metric, old_key, new_key)
SELECT DISTINCT ON (m.metric, l.llm_codename)
  m.metric,
  l.llm_codename AS old_key,
  COALESCE(NULLIF(ce.model_name, ''), cec.label) AS new_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN llms l ON ce.model_ref_id = l.llm_id
CROSS JOIN (VALUES ('model_used'), ('tokens_in'), ('tokens_out')) AS m(metric)
WHERE cec.capability = 'text' AND l.llm_codename <> COALESCE(NULLIF(ce.model_name, ''), cec.label)
ORDER BY m.metric, l.llm_codename, cec.connection_id;

INSERT INTO tmp_stat_key_map (metric, old_key, new_key)
SELECT DISTINCT ON (idm.codename)
  'image_generated' AS metric,
  idm.codename AS old_key,
  COALESCE(NULLIF(ce.model_name, ''), cec.label) AS new_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN image_diffusion_models idm ON ce.model_ref_id = idm.diffusion_model_id
WHERE cec.capability = 'image' AND idm.codename <> COALESCE(NULLIF(ce.model_name, ''), cec.label)
ORDER BY idm.codename, cec.connection_id;

INSERT INTO tmp_stat_key_map (metric, old_key, new_key)
SELECT DISTINCT ON (vgm.codename)
  'video_generated' AS metric,
  vgm.codename AS old_key,
  COALESCE(NULLIF(ce.model_name, ''), cec.label) AS new_key
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
JOIN video_generation_models vgm ON ce.model_ref_id = vgm.video_model_id
WHERE cec.capability = 'video' AND vgm.codename <> COALESCE(NULLIF(ce.model_name, ''), cec.label)
ORDER BY vgm.codename, cec.connection_id;

CREATE TEMP TABLE tmp_migrating_stats ON COMMIT DROP AS
SELECT
  s.server_id,
  s.user_id,
  s.persona_lineage_id,
  s.metric,
  COALESCE(m.new_key, s.metric_key) AS target_metric_key,
  s.bucket,
  s.count,
  s.first_at,
  s.last_at,
  s.metric_key AS orig_metric_key
FROM stat_counters s
JOIN tmp_stat_key_map m ON s.metric = m.metric AND s.metric_key = m.old_key;

CREATE TEMP TABLE tmp_colliding_target_stats ON COMMIT DROP AS
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
  SELECT 1 FROM tmp_migrating_stats t
  WHERE t.server_id = s.server_id
    AND t.user_id = s.user_id
    AND t.persona_lineage_id = s.persona_lineage_id
    AND t.metric = s.metric
    AND t.target_metric_key = s.metric_key
    AND t.bucket = s.bucket
);

DELETE FROM stat_counters s
USING tmp_stat_key_map m
WHERE s.metric = m.metric AND s.metric_key = m.old_key;

DELETE FROM stat_counters s
USING tmp_colliding_target_stats c
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
  SELECT server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket, count, first_at, last_at FROM tmp_migrating_stats
  UNION ALL
  SELECT server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket, count, first_at, last_at FROM tmp_colliding_target_stats
) combined
GROUP BY server_id, user_id, persona_lineage_id, metric, target_metric_key, bucket;

-- Rewrite model tables to literal model codenames and connection-keyed providers.
UPDATE llms l
SET
  llm_provider = 'custom:' || cec.connection_id,
  llm_codename = COALESCE(NULLIF(ce.model_name, ''), cec.label),
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = l.llm_id AND cec.capability = 'text';

UPDATE embedding_models em
SET
  provider = 'custom:' || cec.connection_id,
  codename = COALESCE(NULLIF(ce.model_name, ''), cec.label),
  model_family = 'custom:' || cec.connection_id,
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = em.embedding_model_id AND cec.capability = 'embedding';

UPDATE image_diffusion_models idm
SET
  provider = 'custom:' || cec.connection_id,
  codename = COALESCE(NULLIF(ce.model_name, ''), cec.label),
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = idm.diffusion_model_id AND cec.capability = 'image';

UPDATE video_generation_models vgm
SET
  provider = 'custom:' || cec.connection_id,
  codename = COALESCE(NULLIF(ce.model_name, ''), cec.label),
  updated_at = CURRENT_TIMESTAMP
FROM custom_endpoints ce
JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
WHERE ce.model_ref_id = vgm.video_model_id AND cec.capability = 'video';

COMMIT;
