import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmModelRepo } from "@/utils/db/repositories";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const SERVER_A = "_scoped_registration_server_a";
const SERVER_B = "_scoped_registration_server_b";
const USER_A = "_scoped_registration_user_a";
const SHARED_PROVIDER = "wave4-shared";

async function executeMigration(name: string): Promise<void> {
  const sqlText = await readFile(path.join(process.cwd(), "src", "db", "migrations", name), "utf8");
  for (const statement of splitSqlStatements(sqlText)) await testSql.unsafe(statement);
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Scoped model registrations (Migration D)", () => {
  let serverAId: number;
  let serverBId: number;
  let userAId: number;

  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM servers WHERE server_disc_id IN (${SERVER_A}, ${SERVER_B})`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${USER_A}`;
    const [serverA] = await testSql`INSERT INTO servers (server_disc_id) VALUES (${SERVER_A}) RETURNING server_id`;
    const [serverB] = await testSql`INSERT INTO servers (server_disc_id) VALUES (${SERVER_B}) RETURNING server_id`;
    const [userA] = await testSql`INSERT INTO users (user_disc_id) VALUES (${USER_A}) RETURNING user_id`;
    serverAId = Number(serverA.server_id);
    serverBId = Number(serverB.server_id);
    userAId = Number(userA.user_id);
  });

  afterAll(async () => {
    const [shape] = await testSql<[{ scoped: string | null }]>`
      SELECT to_regclass('public.scoped_model_registrations')::text AS scoped
    `;
    if (!shape.scoped) await executeMigration("071_generalize_scoped_model_registrations.sql");
    await testSql`DELETE FROM servers WHERE server_disc_id IN (${SERVER_A}, ${SERVER_B})`;
    await testSql`DELETE FROM users WHERE user_disc_id = ${USER_A}`;
    await testSql`DELETE FROM llms WHERE llm_provider = ${SHARED_PROVIDER}`;
    await testSql`DELETE FROM embedding_models WHERE provider = ${SHARED_PROVIDER}`;
    await testSql`DELETE FROM image_diffusion_models WHERE provider = ${SHARED_PROVIDER}`;
    await testSql`DELETE FROM video_generation_models WHERE provider = ${SHARED_PROVIDER}`;
  });

  it("enforces exactly one owner and one capability foreign key", async () => {
    const constraints = await testSql<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'scoped_model_registrations'::regclass
    `;
    const definitions = constraints.map((constraint) => constraint.definition).join("\n");
    expect(definitions).toContain("(server_id IS NULL) <> (user_id IS NULL)");
    expect(definitions).toContain("num_nonnulls(llm_id, embedding_model_id, diffusion_model_id, video_model_id) = 1");
    expect(definitions.match(/ON DELETE CASCADE/g)).toHaveLength(6);
  });

  it("isolates all four shared-provider capabilities by server and user scope", async () => {
    const [llm] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'scope-text', true) RETURNING llm_id
    `;
    const [embedding] = await testSql<[{ embedding_model_id: number }]>`
      INSERT INTO embedding_models (provider, codename, model_family, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'scope-embedding', 'scope-embedding', true) RETURNING embedding_model_id
    `;
    const [diffusion] = await testSql<[{ diffusion_model_id: number }]>`
      INSERT INTO image_diffusion_models (provider, codename, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'scope-image', true) RETURNING diffusion_model_id
    `;
    const [video] = await testSql<[{ video_model_id: number }]>`
      INSERT INTO video_generation_models (provider, codename, is_scoped_registration)
      VALUES (${SHARED_PROVIDER}, 'scope-video', true) RETURNING video_model_id
    `;
    const llmId = Number(llm.llm_id);
    const embeddingId = Number(embedding.embedding_model_id);
    const diffusionId = Number(diffusion.diffusion_model_id);
    const videoId = Number(video.video_model_id);

    await testSql`INSERT INTO scoped_model_registrations (server_id, llm_id) VALUES (${serverAId}, ${llmId})`;
    await testSql`INSERT INTO scoped_model_registrations (server_id, embedding_model_id)
      VALUES (${serverAId}, ${embeddingId})`;
    await testSql`INSERT INTO scoped_model_registrations (server_id, diffusion_model_id)
      VALUES (${serverAId}, ${diffusionId})`;
    await testSql`INSERT INTO scoped_model_registrations (user_id, video_model_id) VALUES (${userAId}, ${videoId})`;

    const serverScope = { kind: "server" as const, ownerId: serverAId };
    const otherServerScope = { kind: "server" as const, ownerId: serverBId };
    const userScope = { kind: "personal" as const, ownerId: userAId };
    expect(
      (await llmModelRepo.loadAvailableModelsForProvider(SHARED_PROVIDER, false, serverScope))?.map((m) => m.llm_id),
    ).toContain(llmId);
    expect(
      (await llmModelRepo.loadAvailableEmbeddingModels(SHARED_PROVIDER, false, serverScope))?.map(
        (m) => m.embedding_model_id,
      ),
    ).toContain(embeddingId);
    expect(
      (await llmModelRepo.loadAvailableDiffusionModels(SHARED_PROVIDER, false, serverScope))?.map(
        (m) => m.diffusion_model_id,
      ),
    ).toContain(diffusionId);
    expect(
      (await llmModelRepo.loadAvailableVideoGenerationModels(SHARED_PROVIDER, false, userScope))?.map(
        (m) => m.video_model_id,
      ),
    ).toContain(videoId);
    expect(await llmModelRepo.loadAvailableModelsForProvider(SHARED_PROVIDER, false, otherServerScope)).toEqual([]);
    expect(await llmModelRepo.loadAvailableEmbeddingModels(SHARED_PROVIDER, false, otherServerScope)).toEqual([]);
    expect(await llmModelRepo.loadAvailableDiffusionModels(SHARED_PROVIDER, false, otherServerScope)).toEqual([]);
    expect(await llmModelRepo.loadAvailableVideoGenerationModels(SHARED_PROVIDER, false, otherServerScope)).toEqual([]);
  }, 30_000);

  it("keeps custom endpoint catalogs inherently scoped without registration rows", async () => {
    const [connection] = await testSql<[{ connection_id: number }]>`
      INSERT INTO custom_endpoint_connections (
        server_id, label, capability, api_style, endpoint_url, requires_auth
      ) VALUES (${serverAId}, 'scoped-custom', 'text', 'openai-compatible', 'https://example.invalid/v1', false)
      RETURNING connection_id
    `;
    const customProvider = `custom:${connection.connection_id}`;
    await testSql`
      INSERT INTO llms (llm_provider, llm_codename, is_scoped_registration)
      VALUES (${customProvider}, 'private-model', false)
    `;
    const visible = await llmModelRepo.loadAvailableModelsForProvider(customProvider, false, {
      kind: "server",
      ownerId: serverAId,
    });
    expect(visible?.map((model) => model.llm_codename)).toContain("private-model");
  });

  it("migrates legacy OpenRouter data, replays forward, and recovers through down and forward", async () => {
    const [openRouterModel] = await testSql<[{ llm_id: number }]>`
      INSERT INTO llms (llm_provider, llm_codename, is_scoped_registration)
      VALUES ('openrouter', 'wave4/migration-probe', true)
      ON CONFLICT (llm_provider, llm_codename) DO UPDATE SET is_scoped_registration = true
      RETURNING llm_id
    `;
    await testSql`
      INSERT INTO scoped_model_registrations (server_id, llm_id)
      VALUES (${serverAId}, ${openRouterModel.llm_id})
      ON CONFLICT DO NOTHING
    `;

    await executeMigration("071_generalize_scoped_model_registrations.down.sql");
    const [legacy] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM openrouter_model_registrations
      WHERE server_id = ${serverAId} AND llm_id = ${openRouterModel.llm_id}
    `;
    expect(Number(legacy.count)).toBe(1);

    await executeMigration("071_generalize_scoped_model_registrations.sql");
    await executeMigration("071_generalize_scoped_model_registrations.sql");
    const [restored] = await testSql<[{ count: string }]>`
      SELECT COUNT(*) AS count FROM scoped_model_registrations
      WHERE server_id = ${serverAId} AND llm_id = ${openRouterModel.llm_id}
    `;
    expect(Number(restored.count)).toBe(1);
  });
});
