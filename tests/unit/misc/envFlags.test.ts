import { describe, expect, it } from "bun:test";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";

describe("parseIntegerEnvFlag", () => {
  it("returns the parsed value when it is inside the allowed range", () => {
    expect(parseIntegerEnvFlag("250", 5000, 10)).toBe(250);
    expect(parseIntegerEnvFlag("10", 5000, 10)).toBe(10);
  });

  it("falls back to the default when the value is absent or blank", () => {
    expect(parseIntegerEnvFlag(undefined, 5000, 10)).toBe(5000);
    expect(parseIntegerEnvFlag("", 5000, 10)).toBe(5000);
    expect(parseIntegerEnvFlag("   ", 5000, 10)).toBe(5000);
  });

  it("falls back to the default when the value is unparsable", () => {
    // `Number.parseInt` yields NaN here, and every comparison against NaN is false, which
    // would silently disable whatever bound the caller was reading.
    expect(parseIntegerEnvFlag("abc", 5000, 10)).toBe(5000);
    expect(parseIntegerEnvFlag("12abc", 5000, 10)).toBe(12);
  });

  it("raises a value below the minimum instead of disabling the bound", () => {
    expect(parseIntegerEnvFlag("0", 5000, 10)).toBe(10);
    expect(parseIntegerEnvFlag("-5", 5000, 10)).toBe(10);
  });

  it("keeps a value above the minimum exactly", () => {
    expect(parseIntegerEnvFlag("999999", 5000, 10)).toBe(999999);
  });
});
