import { describe, expect, it } from "bun:test";
import { buildModelSeedStatements } from "@/db/seed/catalog/modelSeed";

// A live curated model must publish globally even when a workspace registered its codename first.
// Deprecated seed rows still leave an explicit scoped registration untouched across restarts.

describe("model seed scoped-registration guard", () => {
  // Map each backing table to the guard clause its ON CONFLICT must contain.
  const expectedGuards: Record<string, string> = {
    llms: "WHERE COALESCE(llms.is_scoped_registration, false) = false",
    image_diffusion_models: "WHERE COALESCE(image_diffusion_models.is_scoped_registration, false) = false",
    video_generation_models: "WHERE COALESCE(video_generation_models.is_scoped_registration, false) = false",
    embedding_models: "WHERE COALESCE(embedding_models.is_scoped_registration, false) = false",
  };

  const statements = buildModelSeedStatements();

  it("guards every backing model table's upsert", () => {
    for (const [table, guard] of Object.entries(expectedGuards)) {
      const statement = statements.find((s) => s.startsWith(`INSERT INTO ${table} `));
      expect(statement, `no seed statement for table ${table}`).toBeDefined();

      expect(statement).toContain("ON CONFLICT");
      expect(statement).toContain(guard);
      expect(statement).toContain("OR EXCLUDED.is_deprecated = false");
    }
  });

  it("never resets is_scoped_registration without the guard", () => {
    // The dangerous combination is `is_scoped_registration = false` in the SET
    // clause without the WHERE guard that confines it to curated rows. If any
    // statement clears the flag, it must also carry its guard.
    for (const statement of statements) {
      if (statement.includes("is_scoped_registration = false")) {
        expect(statement).toContain("WHERE COALESCE(");
        expect(statement).toContain("is_scoped_registration, false) = false");
      }
    }
  });
});
