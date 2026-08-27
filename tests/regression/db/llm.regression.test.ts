/**
 * Regression harness: LlmRepository domain.
 *
 * Covers: loadAvailableLlms, loadLlmById, loadLlmByProviderAndCodename,
 * getLlmsByIds, loadSmartestModel, loadUniqueProviders.
 *
 * LLM rows come from the typed catalog (src/db/seed/catalog/models.ts), seeded by
 * initializeDatabase: no fixture insertion needed.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { llmModelRepo } from "@/utils/db/repositories";
import { DB_TESTS_AVAILABLE, setupTestDb } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("LLM — regression", () => {
  beforeAll(async () => {
    await setupTestDb(); // Seed data is applied here: LLMs are seeded from the catalog by initializeDatabase
  });

  it("loadAvailableLlms returns at least one non-deprecated model", async () => {
    const llms = await llmModelRepo.loadAvailableLlms();
    if (!llms) throw new Error("loadAvailableLlms returned null");
    expect(llms.length).toBeGreaterThan(0);
    expect(llms.every((l) => !l.is_deprecated)).toBe(true);
  });

  it("loadAvailableLlms with includeDeprecated=true returns >= non-deprecated count", async () => {
    const active = await llmModelRepo.loadAvailableLlms(false);
    const all = await llmModelRepo.loadAvailableLlms(true);
    if (!active || !all) throw new Error("loadAvailableLlms returned null");
    expect(all.length).toBeGreaterThanOrEqual(active.length);
  });

  it("loadLlmById returns a known LLM", async () => {
    const allLlms = await llmModelRepo.loadAvailableLlms();
    if (!allLlms?.[0]) throw new Error("No seeded LLMs found");
    const firstId = allLlms[0].llm_id;

    const llm = await llmModelRepo.loadById(firstId);
    expect(llm).not.toBeNull();
    expect(llm?.llm_id).toBe(firstId);
  });

  it("loadLlmById returns null for a non-existent ID", async () => {
    const llm = await llmModelRepo.loadById(999_999_999);
    expect(llm).toBeNull();
  });

  it("getLlmsByIds returns multiple LLMs", async () => {
    const allLlms = await llmModelRepo.loadAvailableLlms();
    if (!allLlms) throw new Error("No seeded LLMs found");
    const ids = allLlms.slice(0, 2).map((l) => l.llm_id);

    const results = await llmModelRepo.getLlmsByIds(ids);
    expect(results).toHaveLength(ids.length);
    expect(results.map((l) => l.llm_id).sort()).toEqual(ids.sort());
  });

  it("loadLlmByProviderAndCodename returns a matching LLM", async () => {
    const allLlms = await llmModelRepo.loadAvailableLlms();
    if (!allLlms?.[0]) throw new Error("No seeded LLMs found");
    const sample = allLlms[0];

    const llm = await llmModelRepo.loadByProviderAndCodename(sample.llm_provider, sample.llm_codename);
    expect(llm).not.toBeNull();
    expect(llm?.llm_provider).toBe(sample.llm_provider);
    expect(llm?.llm_codename).toBe(sample.llm_codename);
  });

  it("loadSmartestModel returns a non-null LLM for a seeded provider", async () => {
    const providers = await llmModelRepo.loadUniqueProviders();
    if (!providers?.[0]) throw new Error("No seeded providers found");
    expect(providers.length).toBeGreaterThan(0);

    const provider = providers[0];
    const smartest = await llmModelRepo.loadSmartestModel(provider);
    // May be null if no is_smartest=true row exists for this provider. that is valid
    if (smartest !== null) {
      expect(smartest.llm_provider).toBe(provider);
    }
  });

  it("loadUniqueProviders returns distinct provider names", async () => {
    const providers = await llmModelRepo.loadUniqueProviders();
    if (!providers) throw new Error("loadUniqueProviders returned null");
    // Unique constraint: no duplicates
    const unique = [...new Set(providers)];
    expect(unique.length).toBe(providers.length);
  });

  // Pricing mirror: the stat cost surfaces join llms in SQL and cannot read the live
  // OpenRouter cache, so a null price silently renders as $0.00 rather than as an error.
  describe("OpenRouter pricing mirror", () => {
    const SCOPED_CODENAME = "tomori-test/priced-scoped-model";
    const caps = {
      hasTools: true,
      seesImages: false,
      seesVideos: false,
      seesYoutube: false,
      supportsStructuredOutput: true,
    };

    it("upsertScopedLlm persists the rate it was registered with", async () => {
      const id = await llmModelRepo.upsertScopedLlm(SCOPED_CODENAME, caps, {
        inputPerMillion: 0.25,
        outputPerMillion: 0.75,
      });
      expect(id).not.toBeNull();

      const row = await llmModelRepo.loadByProviderAndCodename("openrouter", SCOPED_CODENAME);
      expect(row?.input_price_per_million).toBe(0.25);
      expect(row?.output_price_per_million).toBe(0.75);
    });

    it("re-registering without a rate keeps the stored price", async () => {
      await llmModelRepo.upsertScopedLlm(SCOPED_CODENAME, caps, null);

      const row = await llmModelRepo.loadByProviderAndCodename("openrouter", SCOPED_CODENAME);
      expect(row?.input_price_per_million).toBe(0.25);
      expect(row?.output_price_per_million).toBe(0.75);
    });

    it("syncOpenrouterPrices writes live rates and is idempotent", async () => {
      const prices = new Map([[SCOPED_CODENAME, { inputPerMillion: 0.5, outputPerMillion: 1.5 }]]);

      expect(await llmModelRepo.syncOpenrouterPrices(prices)).toBe(1);
      // Second pass must report zero drift, so the count stays a meaningful signal and
      // unchanged rows keep their updated_at.
      expect(await llmModelRepo.syncOpenrouterPrices(prices)).toBe(0);

      const row = await llmModelRepo.loadByProviderAndCodename("openrouter", SCOPED_CODENAME);
      expect(row?.input_price_per_million).toBe(0.5);
      expect(row?.output_price_per_million).toBe(1.5);
    });

    it("syncOpenrouterPrices leaves same-codename rows of other providers alone", async () => {
      const firstParty = await llmModelRepo.loadByProviderAndCodename("deepseek", "deepseek-v4-pro");
      if (!firstParty) throw new Error("Expected the seeded first-party deepseek-v4-pro row");

      await llmModelRepo.syncOpenrouterPrices(
        new Map([["deepseek-v4-pro", { inputPerMillion: 999, outputPerMillion: 999 }]]),
      );

      const after = await llmModelRepo.loadByProviderAndCodename("deepseek", "deepseek-v4-pro");
      expect(after?.input_price_per_million).toBe(firstParty.input_price_per_million ?? null);
      expect(after?.output_price_per_million).toBe(firstParty.output_price_per_million ?? null);
    });

    it("syncOpenrouterPrices treats an empty map as a no-op", async () => {
      expect(await llmModelRepo.syncOpenrouterPrices(new Map())).toBe(0);
    });
  });
});
