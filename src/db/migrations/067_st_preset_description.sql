ALTER TABLE st_presets
ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN st_presets.description IS
  'Optional author-written description for the preset; NULL when omitted';
