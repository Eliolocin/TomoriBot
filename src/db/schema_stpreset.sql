-- ─── SillyTavern Preset Schema ────────────────────────────────────────
-- Stores imported SillyTavern presets and their individual prompt nodes.
-- Presets are scoped per-server (server_id FK). Multiple presets can exist
-- per server; only one may be active at a time (is_active flag).
-- ──────────────────────────────────────────────────────────────────────

-- 1. Preset metadata + raw JSON blob
CREATE TABLE IF NOT EXISTS st_presets (
  preset_id    SERIAL PRIMARY KEY,
  server_id    INT NOT NULL,
  preset_name  TEXT NOT NULL,
  raw_json     JSONB NOT NULL,
  is_active    BOOLEAN DEFAULT false,
  description  TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- One active preset name per server
CREATE UNIQUE INDEX IF NOT EXISTS idx_st_presets_server_name
  ON st_presets(server_id, preset_name);

-- 2. Individual toggleable prompt nodes (parsed from raw_json at import)
CREATE TABLE IF NOT EXISTS st_preset_nodes (
  node_id            SERIAL PRIMARY KEY,
  preset_id          INT NOT NULL,
  identifier         TEXT NOT NULL,
  name               TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'system',
  content            TEXT NOT NULL DEFAULT '',
  is_marker          BOOLEAN DEFAULT false,
  is_enabled         BOOLEAN DEFAULT true,
  is_comment         BOOLEAN DEFAULT false,
  node_order         INT NOT NULL,
  injection_position INT DEFAULT 0,
  injection_depth    INT DEFAULT 4,
  injection_order    INT DEFAULT 100,
  FOREIGN KEY (preset_id) REFERENCES st_presets(preset_id) ON DELETE CASCADE
);

-- Fast lookup: all nodes for a preset in order
CREATE INDEX IF NOT EXISTS idx_st_preset_nodes_preset_order
  ON st_preset_nodes(preset_id, node_order);

-- Unique: one node per identifier per preset
CREATE UNIQUE INDEX IF NOT EXISTS idx_st_preset_nodes_preset_identifier
  ON st_preset_nodes(preset_id, identifier);

-- Add is_comment column for existing databases (comment-only nodes now stored rather than filtered)
SELECT add_column_if_not_exists('st_preset_nodes', 'is_comment', 'BOOLEAN', 'false');

-- Add description column for existing databases
SELECT add_column_if_not_exists('st_presets', 'description', 'TEXT');
