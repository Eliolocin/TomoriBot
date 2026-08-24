import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { llmModelRepo } from "@/utils/db/repositories";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const PROVIDER = "wave4-image-capabilities";
const CODENAME = "declared-image-model";

async function readDeclarations(): Promise<Record<string, boolean | null>> {
  const [row] = await testSql`
    SELECT supports_txt2img, supports_img2img, supports_inpaint, supports_negative_prompt
    FROM image_diffusion_models
    WHERE provider = ${PROVIDER} AND codename = ${CODENAME}
  `;
  return row as Record<string, boolean | null>;
}

describe.skipIf(!DB_TESTS_AVAILABLE)("Image model capability declarations (migration 074)", () => {
  beforeAll(async () => {
    await setupTestDb();
    await testSql`DELETE FROM image_diffusion_models WHERE provider = ${PROVIDER}`;
  });

  afterAll(async () => {
    await testSql`DELETE FROM image_diffusion_models WHERE provider = ${PROVIDER}`;
  });

  it("leaves an undeclared model NULL so it keeps following its provider defaults", async () => {
    const id = await llmModelRepo.upsertScopedDiffusionModel(CODENAME, PROVIDER);
    expect(id).toBeGreaterThan(0);
    expect(await readDeclarations()).toEqual({
      supports_txt2img: null,
      supports_img2img: null,
      supports_inpaint: null,
      supports_negative_prompt: null,
    });
  });

  it("stores a declaration, including an explicit false", async () => {
    await llmModelRepo.upsertScopedDiffusionModel(CODENAME, PROVIDER, {
      txt2img: true,
      img2img: false,
      inpaint: true,
      negative_prompt: false,
    });
    expect(await readDeclarations()).toEqual({
      supports_txt2img: true,
      supports_img2img: false,
      supports_inpaint: true,
      supports_negative_prompt: false,
    });
  });

  it("does not erase an existing declaration when a later caller declares nothing", async () => {
    // Re-registering the same codename from a path that carries no capability values must not silently
    // reset a model that was already declared.
    await llmModelRepo.upsertScopedDiffusionModel(CODENAME, PROVIDER);
    expect(await readDeclarations()).toEqual({
      supports_txt2img: true,
      supports_img2img: false,
      supports_inpaint: true,
      supports_negative_prompt: false,
    });
  });
});
