import { describe, expect, it } from "bun:test";
import {
  buildCustomProviderName,
  buildSyntheticCustomModelCodename,
  formatCustomModelDisplay,
  getCustomProviderDisplayName,
  isCustomProvider,
  isValidCustomEndpointLabel,
  normalizeCustomEndpointLabel,
  parseCustomProvider,
  rememberCustomProviderLabel,
} from "@/utils/provider/customProviderUtils";

describe("customProviderUtils", () => {
  describe("isCustomProvider", () => {
    it("recognizes custom provider strings regardless of case or whitespace", () => {
      expect(isCustomProvider("custom:1")).toBe(true);
      expect(isCustomProvider("  CUSTOM:42  ")).toBe(true);
      expect(isCustomProvider("custom:something")).toBe(true);
      expect(isCustomProvider("openrouter")).toBe(false);
      expect(isCustomProvider("google-genai")).toBe(false);
    });
  });

  describe("buildCustomProviderName", () => {
    it("constructs provider string as custom:<connectionId>", () => {
      expect(buildCustomProviderName(1)).toBe("custom:1");
      expect(buildCustomProviderName(42)).toBe("custom:42");
    });
  });

  describe("parseCustomProvider", () => {
    it("parses valid positive integer connection IDs", () => {
      expect(parseCustomProvider("custom:1")).toEqual({
        raw: "custom:1",
        connectionId: 1,
      });
      expect(parseCustomProvider("  CUSTOM:123  ")).toEqual({
        raw: "custom:123",
        connectionId: 123,
      });
    });

    it("rejects non-custom providers and invalid IDs", () => {
      expect(parseCustomProvider("openrouter")).toBeNull();
      expect(parseCustomProvider("custom:")).toBeNull();
      expect(parseCustomProvider("custom:0")).toBeNull();
      expect(parseCustomProvider("custom:-5")).toBeNull();
      expect(parseCustomProvider("custom:abc")).toBeNull();
      expect(parseCustomProvider("custom:1.5")).toBeNull();
      expect(parseCustomProvider("custom:s1:label")).toBeNull();
      expect(parseCustomProvider("custom:u1:label")).toBeNull();
    });
  });

  describe("normalizeCustomEndpointLabel and isValidCustomEndpointLabel", () => {
    it("normalizes and validates labels", () => {
      expect(normalizeCustomEndpointLabel("  My-Endpoint_1  ")).toBe("my-endpoint_1");
      expect(isValidCustomEndpointLabel("my-endpoint_1")).toBe(true);
      expect(isValidCustomEndpointLabel("invalid label with spaces")).toBe(false);
      expect(isValidCustomEndpointLabel("")).toBe(false);
      expect(isValidCustomEndpointLabel("a".repeat(41))).toBe(false);
    });
  });

  describe("getCustomProviderDisplayName", () => {
    it("renders label when provided and falls back to Custom Endpoint", () => {
      expect(getCustomProviderDisplayName("custom:1", "my-label")).toBe("Custom Endpoint: my-label");
      expect(getCustomProviderDisplayName("custom:1", null)).toBe("Custom Endpoint");
      expect(getCustomProviderDisplayName("custom:1")).toBe("Custom Endpoint");
    });

    it("uses the hydrated connection label when a provider picker has only the key", () => {
      rememberCustomProviderLabel("custom:99", "personal-home");
      expect(getCustomProviderDisplayName("custom:99")).toBe("Custom Endpoint: personal-home");
    });
  });

  describe("buildSyntheticCustomModelCodename", () => {
    it("uses literal modelName when provided", () => {
      expect(buildSyntheticCustomModelCodename("my-label", "gpt-4o-mini")).toBe("gpt-4o-mini");
      expect(buildSyntheticCustomModelCodename("my-label", "  deepseek-v3  ")).toBe("deepseek-v3");
    });

    it("falls back to normalized label when modelName is null or empty", () => {
      expect(buildSyntheticCustomModelCodename("My-Label", null)).toBe("my-label");
      expect(buildSyntheticCustomModelCodename("My-Label", "")).toBe("my-label");
      expect(buildSyntheticCustomModelCodename("My-Label", "   ")).toBe("my-label");
    });
  });

  describe("formatCustomModelDisplay", () => {
    it("renders {modelName} ({label})", () => {
      expect(
        formatCustomModelDisplay({
          label: "my-endpoint",
          model_name: "llama-3",
        }),
      ).toBe("llama-3 (my-endpoint)");

      expect(
        formatCustomModelDisplay({
          label: "my-endpoint",
          model_name: null,
        }),
      ).toBe("my-endpoint (my-endpoint)");

      expect(
        formatCustomModelDisplay({
          label: "llama-3",
          model_name: "llama-3",
        }),
      ).toBe("llama-3 (llama-3)");
    });
  });
});
