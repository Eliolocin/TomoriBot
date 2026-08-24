-- Generalize owner-scoped model registrations across shared provider catalogs.

BEGIN;

CREATE TABLE IF NOT EXISTS scoped_model_registrations (
  scoped_model_registration_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  llm_id INT NULL REFERENCES llms(llm_id) ON DELETE CASCADE,
  embedding_model_id INT NULL REFERENCES embedding_models(embedding_model_id) ON DELETE CASCADE,
  diffusion_model_id INT NULL REFERENCES image_diffusion_models(diffusion_model_id) ON DELETE CASCADE,
  video_model_id INT NULL REFERENCES video_generation_models(video_model_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL)),
  CHECK (num_nonnulls(llm_id, embedding_model_id, diffusion_model_id, video_model_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_server_llm
  ON scoped_model_registrations(server_id, llm_id) WHERE user_id IS NULL AND llm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_user_llm
  ON scoped_model_registrations(user_id, llm_id) WHERE server_id IS NULL AND llm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_server_embedding
  ON scoped_model_registrations(server_id, embedding_model_id)
  WHERE user_id IS NULL AND embedding_model_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_user_embedding
  ON scoped_model_registrations(user_id, embedding_model_id)
  WHERE server_id IS NULL AND embedding_model_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_server_diffusion
  ON scoped_model_registrations(server_id, diffusion_model_id)
  WHERE user_id IS NULL AND diffusion_model_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_user_diffusion
  ON scoped_model_registrations(user_id, diffusion_model_id)
  WHERE server_id IS NULL AND diffusion_model_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_server_video
  ON scoped_model_registrations(server_id, video_model_id)
  WHERE user_id IS NULL AND video_model_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_model_registrations_user_video
  ON scoped_model_registrations(user_id, video_model_id)
  WHERE server_id IS NULL AND video_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_server
  ON scoped_model_registrations(server_id);
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_user
  ON scoped_model_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_llm
  ON scoped_model_registrations(llm_id);
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_embedding
  ON scoped_model_registrations(embedding_model_id);
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_diffusion
  ON scoped_model_registrations(diffusion_model_id);
CREATE INDEX IF NOT EXISTS idx_scoped_model_registrations_video
  ON scoped_model_registrations(video_model_id);

DROP TRIGGER IF EXISTS update_scoped_model_registrations_timestamp ON scoped_model_registrations;
CREATE TRIGGER update_scoped_model_registrations_timestamp
  BEFORE UPDATE ON scoped_model_registrations
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DO $$
BEGIN
  IF to_regclass('openrouter_model_registrations') IS NOT NULL THEN
    INSERT INTO scoped_model_registrations (server_id, user_id, llm_id, created_at, updated_at)
    SELECT server_id, user_id, llm_id, created_at, updated_at FROM openrouter_model_registrations
    ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('openrouter_embedding_model_registrations') IS NOT NULL THEN
    INSERT INTO scoped_model_registrations (server_id, user_id, embedding_model_id, created_at, updated_at)
    SELECT server_id, user_id, embedding_model_id, created_at, updated_at
    FROM openrouter_embedding_model_registrations
    ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('openrouter_image_model_registrations') IS NOT NULL THEN
    INSERT INTO scoped_model_registrations (server_id, user_id, diffusion_model_id, created_at, updated_at)
    SELECT server_id, user_id, diffusion_model_id, created_at, updated_at
    FROM openrouter_image_model_registrations
    ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('openrouter_video_model_registrations') IS NOT NULL THEN
    INSERT INTO scoped_model_registrations (server_id, user_id, video_model_id, created_at, updated_at)
    SELECT server_id, user_id, video_model_id, created_at, updated_at
    FROM openrouter_video_model_registrations
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

DROP TABLE IF EXISTS openrouter_model_registrations;
DROP TABLE IF EXISTS openrouter_embedding_model_registrations;
DROP TABLE IF EXISTS openrouter_image_model_registrations;
DROP TABLE IF EXISTS openrouter_video_model_registrations;

COMMIT;
