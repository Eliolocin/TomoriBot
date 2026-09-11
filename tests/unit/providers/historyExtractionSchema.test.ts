import { describe, expect, test } from "bun:test";
import {
  buildHistoryExtractionResponseSchema,
  HistoryExtractionResultSchema,
} from "@/providers/utils/historyExtractionSchema";

/**
 * Regression guard for collapsed history-extraction entries.
 *
 * `HistoryMemoryEntry` has exactly one required field, and models routinely emit the field's
 * value directly instead of wrapping it: Gemini via OpenRouter returned
 * `memories: ["fact", ...]`, which failed validation for every element and aborted the whole
 * import. The collapsed form is unambiguous, so the schema repairs it.
 */
describe("history extraction schema", () => {
  const restatement = "Eri configured the embedding model to gemini-embedding-2 on this server.";

  test("accepts the documented object form", () => {
    const parsed = HistoryExtractionResultSchema.parse({
      memories: [{ lossless_restatement: restatement }],
    });

    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].lossless_restatement).toBe(restatement);
  });

  test("repairs entries collapsed to bare strings", () => {
    const parsed = HistoryExtractionResultSchema.parse({
      memories: [restatement, `${restatement} Again.`],
    });

    // Both elements normalize to the object form the consumer expects.
    expect(parsed.memories.map((entry) => entry.lossless_restatement)).toEqual([restatement, `${restatement} Again.`]);
  });

  test("accepts a mix of collapsed and object entries", () => {
    const parsed = HistoryExtractionResultSchema.parse({
      memories: [restatement, { lossless_restatement: `${restatement} Second.` }],
    });

    expect(parsed.memories).toHaveLength(2);
    expect(parsed.memories[1].lossless_restatement).toBe(`${restatement} Second.`);
  });

  test("keeps short facts, which are still valid extractions", () => {
    // There is no arbitrary lower bound: "I like Kim" is a real fact.
    const parsed = HistoryExtractionResultSchema.parse({ memories: ["I like Kim"] });

    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].lossless_restatement).toBe("I like Kim");
    expect(parsed.discarded).toBe(0);
  });

  test("discards only the bad entries instead of failing the whole window", () => {
    const parsed = HistoryExtractionResultSchema.parse({
      memories: [restatement, 42, "", "   ", { lossless_restatement: "" }, "I like Kim"],
    });

    // Both valid facts survive; the four unusable entries are counted, not fatal.
    expect(parsed.memories.map((entry) => entry.lossless_restatement)).toEqual([restatement, "I like Kim"]);
    expect(parsed.discarded).toBe(4);
  });

  test("trims surrounding whitespace on kept entries", () => {
    const parsed = HistoryExtractionResultSchema.parse({ memories: ["  I like Kim  "] });

    expect(parsed.memories[0].lossless_restatement).toBe("I like Kim");
  });

  test("still rejects a response whose memories field is not an array", () => {
    // The envelope itself stays strict; only per-entry failures are tolerated.
    expect(() => HistoryExtractionResultSchema.parse({ memories: "not-an-array" })).toThrow();
    expect(() => HistoryExtractionResultSchema.parse({})).toThrow();
  });

  test("wire schema still describes the object form to the provider", () => {
    const schema = buildHistoryExtractionResponseSchema() as {
      properties: { memories: { items: { type: string; required: string[] } } };
    };

    // Coercion is a safety net; the schema sent to the model must stay strict.
    expect(schema.properties.memories.items.type).toBe("object");
    expect(schema.properties.memories.items.required).toContain("lossless_restatement");
  });
});
