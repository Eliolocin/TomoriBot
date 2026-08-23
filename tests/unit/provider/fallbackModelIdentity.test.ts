import { describe, expect, it } from "bun:test";
import type { CustomEndpointRow, FallbackModelRef } from "@/types/db/schema";
import {
  buildFallbackModelPersistence,
  getPrimaryFallbackRefKeys,
  prunePrimaryFallbackRefs,
} from "@/utils/provider/fallbackModelIdentity";

const endpoint = {
  custom_endpoint_id: 5,
  connection_id: 1,
  model_ref_id: 42,
} as CustomEndpointRow;

describe("fallback model identity", () => {
  it("treats a custom endpoint and its synthetic LLM as the same model", () => {
    expect([...getPrimaryFallbackRefKeys(42, [endpoint])]).toEqual(["llm:42", "custom_endpoint:5"]);
  });

  it("prunes both representations of the primary without comparing unrelated numeric ids", () => {
    const refs: FallbackModelRef[] = [
      { type: "llm", id: 42 },
      { type: "custom_endpoint", id: 5 },
      { type: "custom_endpoint", id: 42 },
      { type: "llm", id: 7 },
    ];

    expect(prunePrimaryFallbackRefs(refs, 42, [endpoint])).toEqual([
      { type: "custom_endpoint", id: 42 },
      { type: "llm", id: 7 },
    ]);
  });

  it("derives the legacy LLM mirror from the same pruned cross-provider chain", () => {
    const refs: FallbackModelRef[] = [
      { type: "llm", id: 7 },
      { type: "custom_endpoint", id: 9 },
      { type: "llm", id: 42 },
    ];

    expect(buildFallbackModelPersistence(refs, 42)).toEqual({
      fallbackModelRefs: [
        { type: "llm", id: 7 },
        { type: "custom_endpoint", id: 9 },
      ],
      fallbackLlmIds: [7],
    });
  });
});
