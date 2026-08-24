-- Restore the four OpenRouter-specific scoped-registration tables.

BEGIN;

CREATE TABLE openrouter_model_registrations (
  openrouter_model_registration_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  llm_id INT NOT NULL REFERENCES llms(llm_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX idx_openrouter_model_registrations_server_llm
  ON openrouter_model_registrations(server_id, llm_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_openrouter_model_registrations_user_llm
  ON openrouter_model_registrations(user_id, llm_id) WHERE server_id IS NULL;
CREATE INDEX idx_openrouter_model_registrations_server ON openrouter_model_registrations(server_id);
CREATE INDEX idx_openrouter_model_registrations_user ON openrouter_model_registrations(user_id);
CREATE INDEX idx_openrouter_model_registrations_llm ON openrouter_model_registrations(llm_id);
CREATE TRIGGER update_openrouter_model_registrations_timestamp
  BEFORE UPDATE ON openrouter_model_registrations
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE openrouter_embedding_model_registrations (
  openrouter_embedding_model_registration_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  embedding_model_id INT NOT NULL REFERENCES embedding_models(embedding_model_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX idx_openrouter_embedding_model_registrations_server_model
  ON openrouter_embedding_model_registrations(server_id, embedding_model_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_openrouter_embedding_model_registrations_user_model
  ON openrouter_embedding_model_registrations(user_id, embedding_model_id) WHERE server_id IS NULL;
CREATE INDEX idx_openrouter_embedding_model_registrations_server
  ON openrouter_embedding_model_registrations(server_id);
CREATE INDEX idx_openrouter_embedding_model_registrations_user
  ON openrouter_embedding_model_registrations(user_id);
CREATE INDEX idx_openrouter_embedding_model_registrations_model
  ON openrouter_embedding_model_registrations(embedding_model_id);
CREATE TRIGGER update_openrouter_embedding_model_registrations_timestamp
  BEFORE UPDATE ON openrouter_embedding_model_registrations
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE openrouter_image_model_registrations (
  openrouter_image_model_registration_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  diffusion_model_id INT NOT NULL REFERENCES image_diffusion_models(diffusion_model_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX idx_openrouter_image_model_registrations_server_model
  ON openrouter_image_model_registrations(server_id, diffusion_model_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_openrouter_image_model_registrations_user_model
  ON openrouter_image_model_registrations(user_id, diffusion_model_id) WHERE server_id IS NULL;
CREATE INDEX idx_openrouter_image_model_registrations_server
  ON openrouter_image_model_registrations(server_id);
CREATE INDEX idx_openrouter_image_model_registrations_user
  ON openrouter_image_model_registrations(user_id);
CREATE INDEX idx_openrouter_image_model_registrations_model
  ON openrouter_image_model_registrations(diffusion_model_id);
CREATE TRIGGER update_openrouter_image_model_registrations_timestamp
  BEFORE UPDATE ON openrouter_image_model_registrations
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE openrouter_video_model_registrations (
  openrouter_video_model_registration_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  video_model_id INT NOT NULL REFERENCES video_generation_models(video_model_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX idx_openrouter_video_model_registrations_server_model
  ON openrouter_video_model_registrations(server_id, video_model_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_openrouter_video_model_registrations_user_model
  ON openrouter_video_model_registrations(user_id, video_model_id) WHERE server_id IS NULL;
CREATE INDEX idx_openrouter_video_model_registrations_server
  ON openrouter_video_model_registrations(server_id);
CREATE INDEX idx_openrouter_video_model_registrations_user
  ON openrouter_video_model_registrations(user_id);
CREATE INDEX idx_openrouter_video_model_registrations_model
  ON openrouter_video_model_registrations(video_model_id);
CREATE TRIGGER update_openrouter_video_model_registrations_timestamp
  BEFORE UPDATE ON openrouter_video_model_registrations
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

INSERT INTO openrouter_model_registrations (server_id, user_id, llm_id, created_at, updated_at)
SELECT smr.server_id, smr.user_id, smr.llm_id, smr.created_at, smr.updated_at
FROM scoped_model_registrations smr
JOIN llms model ON model.llm_id = smr.llm_id
WHERE smr.llm_id IS NOT NULL AND model.llm_provider = 'openrouter';
INSERT INTO openrouter_embedding_model_registrations
  (server_id, user_id, embedding_model_id, created_at, updated_at)
SELECT smr.server_id, smr.user_id, smr.embedding_model_id, smr.created_at, smr.updated_at
FROM scoped_model_registrations smr
JOIN embedding_models model ON model.embedding_model_id = smr.embedding_model_id
WHERE smr.embedding_model_id IS NOT NULL AND model.provider = 'openrouter';
INSERT INTO openrouter_image_model_registrations
  (server_id, user_id, diffusion_model_id, created_at, updated_at)
SELECT smr.server_id, smr.user_id, smr.diffusion_model_id, smr.created_at, smr.updated_at
FROM scoped_model_registrations smr
JOIN image_diffusion_models model ON model.diffusion_model_id = smr.diffusion_model_id
WHERE smr.diffusion_model_id IS NOT NULL AND model.provider = 'openrouter';
INSERT INTO openrouter_video_model_registrations
  (server_id, user_id, video_model_id, created_at, updated_at)
SELECT smr.server_id, smr.user_id, smr.video_model_id, smr.created_at, smr.updated_at
FROM scoped_model_registrations smr
JOIN video_generation_models model ON model.video_model_id = smr.video_model_id
WHERE smr.video_model_id IS NOT NULL AND model.provider = 'openrouter';

DROP TABLE scoped_model_registrations;

COMMIT;
