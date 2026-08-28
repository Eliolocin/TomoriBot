import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { splitSqlStatements } from "@/utils/db/sqlSplitter";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const USER_DISC_1 = "_split_reg_user_1";
const USER_DISC_2 = "_split_reg_user_2";
const USER_DISC_3 = "_split_reg_user_3";
const USER_DISC_4 = "_split_reg_user_4";

async function executeMigration(name: string): Promise<void> {
  const sqlText = await readFile(path.join(process.cwd(), "src", "db", "migrations", name), "utf8");
  for (const statement of splitSqlStatements(sqlText)) {
    await testSql.unsafe(statement);
  }
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Personal image capability split data migration (077)", () => {
  let user1Id: number;
  let user2Id: number;
  let user3Id: number;
  let user4Id: number;

  beforeAll(async () => {
    await setupTestDb();

    // Clean up any stale fixtures from prior runs
    await testSql`DELETE FROM users WHERE user_disc_id IN (${USER_DISC_1}, ${USER_DISC_2}, ${USER_DISC_3}, ${USER_DISC_4})`;

    const [u1] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_1}) RETURNING user_id
    `;
    user1Id = Number(u1.user_id);

    const [u2] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_2}) RETURNING user_id
    `;
    user2Id = Number(u2.user_id);

    const [u3] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_3}) RETURNING user_id
    `;
    user3Id = Number(u3.user_id);

    const [u4] = await testSql<[{ user_id: number }]>`
      INSERT INTO users (user_disc_id) VALUES (${USER_DISC_4}) RETURNING user_id
    `;
    user4Id = Number(u4.user_id);
  });

  afterAll(async () => {
    // Ensure migration 077 is applied on exit so database is left in up state
    await executeMigration("077_personal_image_capability_split.sql");
    await testSql`DELETE FROM users WHERE user_disc_id IN (${USER_DISC_1}, ${USER_DISC_2}, ${USER_DISC_3}, ${USER_DISC_4})`;
  });

  it("proves enabled and disabled ownership cases, idempotent replay, rollback, and subset invariant", async () => {
    // Seed test rows simulating pre-077 state:
    // User 1: Owned and enabled image with NovelAI model
    // User 2: Owned but disabled image with NovelAI model
    // User 3: Owned and enabled image without NovelAI model
    // User 4: Owned text only with NovelAI model (no image ownership)
    await testSql`DELETE FROM user_saved_provider_configs WHERE user_id IN (${user1Id}, ${user2Id}, ${user3Id}, ${user4Id})`;

    await testSql`
      INSERT INTO user_saved_provider_configs
        (user_id, provider, assigned_capabilities, enabled_capabilities, diffusion_model_id, nai_diffusion_model_id)
      VALUES
        (${user1Id}, 'novelai', ARRAY['image']::TEXT[], ARRAY['image']::TEXT[], 10, 20),
        (${user2Id}, 'novelai', ARRAY['image']::TEXT[], ARRAY[]::TEXT[], 11, 21),
        (${user3Id}, 'openrouter', ARRAY['image']::TEXT[], ARRAY['image']::TEXT[], 12, NULL),
        (${user4Id}, 'google', ARRAY['text']::TEXT[], ARRAY['text']::TEXT[], NULL, 23)
    `;

    await executeMigration("077_personal_image_capability_split.sql");

    const rowsAfterUp = await testSql<
      Array<{
        user_id: number;
        provider: string;
        assigned_capabilities: string[];
        enabled_capabilities: string[];
        diffusion_model_id: number | null;
        nai_diffusion_model_id: number | null;
      }>
    >`
      SELECT user_id, provider, assigned_capabilities, enabled_capabilities, diffusion_model_id, nai_diffusion_model_id
      FROM user_saved_provider_configs
      WHERE user_id IN (${user1Id}, ${user2Id}, ${user3Id}, ${user4Id})
      ORDER BY user_id ASC
    `;

    const u1Row = rowsAfterUp.find((r) => r.user_id === user1Id);
    const u2Row = rowsAfterUp.find((r) => r.user_id === user2Id);
    const u3Row = rowsAfterUp.find((r) => r.user_id === user3Id);
    const u4Row = rowsAfterUp.find((r) => r.user_id === user4Id);

    expect(u1Row).toBeDefined();
    expect(u2Row).toBeDefined();
    expect(u3Row).toBeDefined();
    expect(u4Row).toBeDefined();
    if (!u1Row || !u2Row || !u3Row || !u4Row) return;

    // User 1: image_nai added to both assigned and enabled capabilities
    expect(u1Row.assigned_capabilities).toContain("image");
    expect(u1Row.assigned_capabilities).toContain("image_nai");
    expect(u1Row.enabled_capabilities).toContain("image");
    expect(u1Row.enabled_capabilities).toContain("image_nai");
    expect(u1Row.diffusion_model_id).toBe(10);
    expect(u1Row.nai_diffusion_model_id).toBe(20);

    // User 2: image_nai added to assigned only, enabled remains empty
    expect(u2Row.assigned_capabilities).toContain("image");
    expect(u2Row.assigned_capabilities).toContain("image_nai");
    expect(u2Row.enabled_capabilities).toEqual([]);
    expect(u2Row.diffusion_model_id).toBe(11);
    expect(u2Row.nai_diffusion_model_id).toBe(21);

    // User 3: no NovelAI model, so image_nai is not added
    expect(u3Row.assigned_capabilities).toEqual(["image"]);
    expect(u3Row.enabled_capabilities).toEqual(["image"]);
    expect(u3Row.diffusion_model_id).toBe(12);
    expect(u3Row.nai_diffusion_model_id).toBeNull();

    // User 4: no image ownership, so image_nai is not added
    expect(u4Row.assigned_capabilities).toEqual(["text"]);
    expect(u4Row.enabled_capabilities).toEqual(["text"]);
    expect(u4Row.diffusion_model_id).toBeNull();
    expect(u4Row.nai_diffusion_model_id).toBe(23);

    // Invariant: enabled_capabilities is a subset of assigned_capabilities across all rows
    for (const row of rowsAfterUp) {
      const assignedSet = new Set(row.assigned_capabilities);
      for (const cap of row.enabled_capabilities) {
        expect(assignedSet.has(cap)).toBe(true);
      }
    }

    // Idempotent replay: running up again produces identical state
    await executeMigration("077_personal_image_capability_split.sql");

    const rowsAfterReplay = await testSql<
      Array<{
        user_id: number;
        assigned_capabilities: string[];
        enabled_capabilities: string[];
      }>
    >`
      SELECT user_id, assigned_capabilities, enabled_capabilities
      FROM user_saved_provider_configs
      WHERE user_id IN (${user1Id}, ${user2Id}, ${user3Id}, ${user4Id})
      ORDER BY user_id ASC
    `;

    expect(rowsAfterReplay[0].assigned_capabilities).toEqual(u1Row.assigned_capabilities);
    expect(rowsAfterReplay[0].enabled_capabilities).toEqual(u1Row.enabled_capabilities);
    expect(rowsAfterReplay[1].assigned_capabilities).toEqual(u2Row.assigned_capabilities);
    expect(rowsAfterReplay[1].enabled_capabilities).toEqual(u2Row.enabled_capabilities);

    // Rollback: down migration removes image_nai from both arrays without touching models or legacy image
    await executeMigration("077_personal_image_capability_split.down.sql");

    const rowsAfterDown = await testSql<
      Array<{
        user_id: number;
        assigned_capabilities: string[];
        enabled_capabilities: string[];
        diffusion_model_id: number | null;
        nai_diffusion_model_id: number | null;
      }>
    >`
      SELECT user_id, assigned_capabilities, enabled_capabilities, diffusion_model_id, nai_diffusion_model_id
      FROM user_saved_provider_configs
      WHERE user_id IN (${user1Id}, ${user2Id}, ${user3Id}, ${user4Id})
      ORDER BY user_id ASC
    `;

    const u1Down = rowsAfterDown.find((r) => r.user_id === user1Id);
    const u2Down = rowsAfterDown.find((r) => r.user_id === user2Id);

    expect(u1Down).toBeDefined();
    expect(u2Down).toBeDefined();
    if (!u1Down || !u2Down) return;

    expect(u1Down.assigned_capabilities).toEqual(["image"]);
    expect(u1Down.enabled_capabilities).toEqual(["image"]);
    expect(u1Down.diffusion_model_id).toBe(10);
    expect(u1Down.nai_diffusion_model_id).toBe(20);

    expect(u2Down.assigned_capabilities).toEqual(["image"]);
    expect(u2Down.enabled_capabilities).toEqual([]);
    expect(u2Down.diffusion_model_id).toBe(11);
    expect(u2Down.nai_diffusion_model_id).toBe(21);
  });
});
