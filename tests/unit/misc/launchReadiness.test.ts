import { describe, expect, it } from "bun:test";
import { DEFAULT_PYTHON_HEALTH_TIMEOUT_MS, resolvePositiveTimeoutMs } from "../../../scripts/lib/launchReadiness";

describe("launch readiness timeout", () => {
  it("uses the default for missing or invalid values", () => {
    for (const value of [undefined, "", "nope", "0", "-1", "Infinity"]) {
      expect(resolvePositiveTimeoutMs(value, DEFAULT_PYTHON_HEALTH_TIMEOUT_MS)).toBe(DEFAULT_PYTHON_HEALTH_TIMEOUT_MS);
    }
  });

  it("keeps finite positive overrides usable as whole milliseconds", () => {
    expect(resolvePositiveTimeoutMs("1234", DEFAULT_PYTHON_HEALTH_TIMEOUT_MS)).toBe(1234);
    expect(resolvePositiveTimeoutMs("1.2", DEFAULT_PYTHON_HEALTH_TIMEOUT_MS)).toBe(2);
  });
});
