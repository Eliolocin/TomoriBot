import { expect, test } from "bun:test";
import { formatNovelAiUsageDuration, renderUsageMeter } from "@/commands/novelai/usage";

test("renders the NovelAI usage meter within the API percentage bounds", () => {
  expect(renderUsageMeter(-1)).toBe("░░░░░░░░░░");
  expect(renderUsageMeter(55)).toBe("██████░░░░");
  expect(renderUsageMeter(101)).toBe("██████████");
});

test("formats the time until the next usage percentage recovery", () => {
  expect(formatNovelAiUsageDuration(0)).toBe("0s");
  expect(formatNovelAiUsageDuration(61)).toBe("1m 1s");
});
