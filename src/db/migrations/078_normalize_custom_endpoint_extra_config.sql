-- Earlier writes passed JSON.stringify(extraConfig) to Bun SQL, which serialized it
-- a second time and stored a JSON string instead of the expected JSON object.
UPDATE custom_endpoints
SET extra_config = (extra_config #>> '{}')::jsonb
WHERE jsonb_typeof(extra_config) = 'string'
  AND left(ltrim(extra_config #>> '{}'), 1) = '{';
