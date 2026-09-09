-- Migration 080: Repair bare endpoint URLs stored for OpenAI-versioned API styles.
--
-- Storage normalization now extends a bare origin with /v1 for openai-compatible,
-- openai-compatible-transcription, and ollama-native styles. Rows saved before that
-- change can still hold a bare URL, which every request adapter treats as missing its
-- version prefix and requests to /chat/completions or the STT path 404. A bare origin
-- never worked, so repairing it cannot break a working setup.
--
-- Rows with an explicit path are left untouched: a path such as /api/v1 or a gateway
-- prefix is intentional and must not gain an extra /v1 segment.

UPDATE custom_endpoint_connections
SET
  endpoint_url = rtrim(endpoint_url, '/') || '/v1',
  updated_at = CURRENT_TIMESTAMP
WHERE api_style IN ('openai-compatible', 'openai-compatible-transcription', 'ollama-native')
  AND endpoint_url ~ '^https?://[^/]+/?$';
