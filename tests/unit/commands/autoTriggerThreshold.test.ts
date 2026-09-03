import { describe, expect, it } from "bun:test";
import {
  MAX_THRESHOLD,
  MIN_RANDOM_THRESHOLD,
  MIN_THRESHOLD,
  rollAutochatTarget,
  validateThresholdInput,
} from "@/utils/discord/autoTriggerThreshold";

describe("/server auto-trigger threshold write plan", () => {
  describe("validateThresholdInput", () => {
    it("(0, 0) is valid and identifies as always-reply mode", () => {
      const result = validateThresholdInput(0, 0);
      expect(result.isValid).toBe(true);
      expect(result.isAlwaysReplyMode).toBe(true);
      expect(result.isRangeMode).toBe(false);
    });

    it("(n, n) with n >= 1 is valid fixed mode — not always-reply, not range", () => {
      const result = validateThresholdInput(50, 50);
      expect(result.isValid).toBe(true);
      expect(result.isAlwaysReplyMode).toBe(false);
      expect(result.isRangeMode).toBe(false);
    });

    it("(min, max) with min < max is valid range mode", () => {
      const result = validateThresholdInput(10, 100);
      expect(result.isValid).toBe(true);
      expect(result.isAlwaysReplyMode).toBe(false);
      expect(result.isRangeMode).toBe(true);
    });

    it("boundary: (1, 100) is valid range mode", () => {
      const result = validateThresholdInput(MIN_RANDOM_THRESHOLD, MAX_THRESHOLD);
      expect(result.isValid).toBe(true);
      expect(result.isRangeMode).toBe(true);
    });

    it("boundary: (100, 100) is valid fixed mode", () => {
      const result = validateThresholdInput(100, 100);
      expect(result.isValid).toBe(true);
      expect(result.isAlwaysReplyMode).toBe(false);
    });

    it("(0, 1) is invalid — mixed always-reply threshold with positive max", () => {
      const result = validateThresholdInput(0, 1);
      expect(result.isValid).toBe(false);
      expect(result.isAlwaysReplyMode).toBe(false);
    });

    it("(0, 100) is invalid — zero threshold requires zero max for always-reply mode", () => {
      const result = validateThresholdInput(0, 100);
      expect(result.isValid).toBe(false);
    });

    it("(5, 3) is invalid — max cannot be less than min", () => {
      const result = validateThresholdInput(5, 3);
      expect(result.isValid).toBe(false);
    });

    it("exposed constants match the command's min/max option constraints", () => {
      expect(MIN_THRESHOLD).toBe(0);
      expect(MIN_RANDOM_THRESHOLD).toBe(1);
      expect(MAX_THRESHOLD).toBe(100);
    });
  });

  describe("rollAutochatTarget", () => {
    it("returns the exact value for equal min and max (fixed mode)", () => {
      expect(rollAutochatTarget(42, 42)).toBe(42);
    });

    it("returns 0 when minThreshold is 0 (degenerate guard)", () => {
      expect(rollAutochatTarget(0, 0)).toBe(0);
    });

    it("returns 0 when maxThreshold is 0 (degenerate guard)", () => {
      expect(rollAutochatTarget(5, 0)).toBe(0);
    });

    it("returns a value within [min, max] inclusive for a range", () => {
      for (let i = 0; i < 50; i++) {
        const target = rollAutochatTarget(10, 20);
        expect(target).toBeGreaterThanOrEqual(10);
        expect(target).toBeLessThanOrEqual(20);
      }
    });

    it("returns an integer for a range", () => {
      const target = rollAutochatTarget(1, 100);
      expect(Number.isInteger(target)).toBe(true);
    });
  });
});
