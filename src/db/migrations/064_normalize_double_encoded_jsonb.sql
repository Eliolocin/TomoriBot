-- Migration 064: repair JSONB columns holding a JSON string instead of an object.
--
-- `${JSON.stringify(value)}::jsonb` double-encodes under Bun's driver: the string is
-- bound as text and the cast then parses it into a JSONB *scalar string* whose content
-- is the JSON source. Reads masked it, since the Zod layer parses a string back into an
-- object, so the shape was only wrong at the SQL level: `->`, `->>`, containment, and
-- equality against an object literal all behave differently on a scalar string. The
-- affected writers now bind the object directly.
--
-- Only rows whose text begins with `{` are converted, matching what the affected
-- writers produced. Anything else is left untouched rather than risking a parse error
-- on a value this migration does not recognize.

UPDATE persona_naming_configs
SET
  prefixes = CASE
    WHEN jsonb_typeof(prefixes) = 'string' AND (prefixes #>> '{}') LIKE '{%'
      THEN (prefixes #>> '{}')::JSONB
    ELSE prefixes
  END,
  suffixes = CASE
    WHEN jsonb_typeof(suffixes) = 'string' AND (suffixes #>> '{}') LIKE '{%'
      THEN (suffixes #>> '{}')::JSONB
    ELSE suffixes
  END,
  address_terms = CASE
    WHEN jsonb_typeof(address_terms) = 'string' AND (address_terms #>> '{}') LIKE '{%'
      THEN (address_terms #>> '{}')::JSONB
    ELSE address_terms
  END,
  updated_at = NOW()
WHERE jsonb_typeof(prefixes) = 'string'
   OR jsonb_typeof(suffixes) = 'string'
   OR jsonb_typeof(address_terms) = 'string';

UPDATE custom_endpoints
SET
  extra_config = (extra_config #>> '{}')::JSONB,
  updated_at = CURRENT_TIMESTAMP
WHERE jsonb_typeof(extra_config) = 'string'
  AND (extra_config #>> '{}') LIKE '{%';
