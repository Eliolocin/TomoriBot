import { describe, expect, it } from "bun:test";
import { tryRepairIncompleteJson } from "@/utils/text/jsonRepair";

describe("tryRepairIncompleteJson", () => {
  it("drops a value truncated mid-string and keeps the keys that arrived complete", () => {
    // Shape of the incident payload: the stream died inside the second value, so the
    // first key is the only one the model actually finished.
    const raw =
      '{"scene_state": "#master-bedroom, ~1:00 AM Friday. Chu, Evan, Noah on the large bed.", ' +
      '"bodies_and_wardrobe": "Noah: honey-blonde hair messy, amber eyes half-closed';

    expect(tryRepairIncompleteJson(raw)).toEqual({
      scene_state: "#master-bedroom, ~1:00 AM Friday. Chu, Evan, Noah on the large bed.",
    });
  });

  it("keeps nested objects that finished and drops the truncated sibling", () => {
    const raw = '{"a": {"b": 1, "c": [1, 2]}, "d": "unfinished';

    expect(tryRepairIncompleteJson(raw)).toEqual({ a: { b: 1, c: [1, 2] } });
  });

  it("keeps array entries that arrived complete", () => {
    expect(tryRepairIncompleteJson('{"tags": ["one", "two"')).toEqual({ tags: ["one", "two"] });
    expect(tryRepairIncompleteJson('{"tags": ["one", "two",')).toEqual({ tags: ["one", "two"] });
  });

  it("drops a dangling key with no value", () => {
    expect(tryRepairIncompleteJson('{"a": 1, "b"')).toEqual({ a: 1 });
    expect(tryRepairIncompleteJson('{"a": 1, "b":')).toEqual({ a: 1 });
    expect(tryRepairIncompleteJson('{"a": 1, "b": ')).toEqual({ a: 1 });
  });

  it("drops a partially received keyword or number", () => {
    expect(tryRepairIncompleteJson('{"a": 1, "b": tru')).toEqual({ a: 1 });
    expect(tryRepairIncompleteJson('{"a": 1, "b": -')).toEqual({ a: 1 });
    expect(tryRepairIncompleteJson('{"a": 1, "b": nul')).toEqual({ a: 1 });
  });

  it("preserves escaped quotes when scanning past string boundaries", () => {
    const raw = String.raw`{"quoted": "she said \"hi\" and left", "next": "cut`;

    expect(tryRepairIncompleteJson(raw)).toEqual({ quoted: 'she said "hi" and left' });
  });

  it("preserves a value ending in an escaped backslash", () => {
    const raw = String.raw`{"path": "C:\\temp", "next": "cut`;

    expect(tryRepairIncompleteJson(raw)).toEqual({ path: "C:\\temp" });
  });

  it("treats a colon inside a complete string as content, not structure", () => {
    const raw = '{"scene": "1:00 AM, hallway", "who": "unfinished';

    expect(tryRepairIncompleteJson(raw)).toEqual({ scene: "1:00 AM, hallway" });
  });

  it("returns an empty object when the truncation lands before any value finished", () => {
    expect(tryRepairIncompleteJson('{"scene": "unfinished')).toEqual({});
    expect(tryRepairIncompleteJson('{"scene": {"nested": "unfinished')).toEqual({ scene: {} });
  });

  it("returns null for a payload with no object to restore", () => {
    expect(tryRepairIncompleteJson("")).toBeNull();
    expect(tryRepairIncompleteJson('"a bare truncated string')).toBeNull();
    expect(tryRepairIncompleteJson("[1, 2")).toBeNull();
  });

  it("returns null for JSON that is already valid, so callers keep their own path", () => {
    expect(tryRepairIncompleteJson('{"a": 1}')).toBeNull();
    expect(tryRepairIncompleteJson("[1, 2]")).toBeNull();
    expect(tryRepairIncompleteJson("12")).toBeNull();
  });

  it("returns null rather than guessing when the payload is malformed, not truncated", () => {
    expect(tryRepairIncompleteJson('{"a": }')).toBeNull();
    expect(tryRepairIncompleteJson('{"a": 1 "b": 2}')).toBeNull();
    expect(tryRepairIncompleteJson('{"a": [1, 2}')).toBeNull();
    expect(tryRepairIncompleteJson('{"a": 1]')).toBeNull();
    expect(tryRepairIncompleteJson("[1,}")).toBeNull();
    expect(tryRepairIncompleteJson('{"a": 1, "b": 42 hours')).toBeNull();
  });

  it("returns an empty object for an empty payload body", () => {
    expect(tryRepairIncompleteJson("{")).toEqual({});
    expect(tryRepairIncompleteJson('{"a": 1,')).toEqual({ a: 1 });
    expect(tryRepairIncompleteJson('{"a": 1, "b": 2,')).toEqual({ a: 1, b: 2 });
  });

  it("keeps every key that arrived complete across a multi-category payload", () => {
    // Mirrors the shape of a roleplay STM update: several long string categories, stream
    // cut inside the third one. Only the first two were ever finished by the model.
    const raw =
      '{"scene_state": "#master-bedroom, ~1:00 AM Friday. Chu just returned, hugging both consorts.", ' +
      '"bodies_and_wardrobe": "Noah: honey-blonde hair messy, wearing a loose cotton sleep shirt.", ' +
      '"objects_and_environment": "Two mugs on the nightstand, a cracked';

    expect(tryRepairIncompleteJson(raw)).toEqual({
      scene_state: "#master-bedroom, ~1:00 AM Friday. Chu just returned, hugging both consorts.",
      bodies_and_wardrobe: "Noah: honey-blonde hair messy, wearing a loose cotton sleep shirt.",
    });
  });

  it("keeps a complete multi-byte string intact", () => {
    const raw = '{"scene": "部屋は静かだった。", "mood": "落ち着いた';

    expect(tryRepairIncompleteJson(raw)).toEqual({ scene: "部屋は静かだった。" });
  });

  it("never fabricates a value when repairing a truncation of valid JSON", () => {
    // Every prefix of a real payload is a shape a dropped delta can produce. The repair
    // must either refuse it or return a faithful prefix of the original, never a value the
    // model did not write and never something that is not an object.
    const source = {
      scene_state: "hallway, 9:00 PM",
      bodies_and_wardrobe: "Noah: coat still on",
      objects_and_environment: ["mug", "cracked mirror"],
      open_threads: { pending: true, count: 3, ratio: 0.5, empty: null },
    };
    const payload = JSON.stringify(source);

    for (let end = 1; end <= payload.length; end++) {
      const prefix = payload.slice(0, end);
      const repaired = tryRepairIncompleteJson(prefix);

      if (prefix === payload) {
        expect(repaired).toBeNull();
        continue;
      }

      for (const [key, value] of Object.entries(repaired ?? {})) {
        expect(Object.keys(source)).toContain(key);
        // A repaired value must be the original or a faithful prefix of it: a list that was
        // still being written can lose trailing members, never change them, an object can
        // lose trailing keys, never invent one, and a number can lose trailing digits.
        expect(isPrefixOf(value, (source as Record<string, unknown>)[key])).toBe(true);
      }
    }
  });
});

/** True when `value` is `original` or a prefix of it, compared structurally. */
function isPrefixOf(value: unknown, original: unknown): boolean {
  if (Array.isArray(original) && Array.isArray(value)) {
    return value.every((item, index) => isPrefixOf(item, original[index]));
  }
  if (isPlainObject(original) && isPlainObject(value)) {
    // An empty container is what a payload cut open before its first entry can support, so
    // it counts as a prefix even when every key was lost.
    if (Object.keys(value).length === 0) {
      return true;
    }
    // Every key present must match; keys the truncation cut off are simply absent.
    return Object.entries(value).every(([key, item]) => key in original && isPrefixOf(item, original[key]));
  }
  if (typeof original === "number" && typeof value === "number") {
    // A number cut at a token boundary keeps only the leading digits it delivered.
    return String(original).startsWith(String(value));
  }
  return JSON.stringify(value) === JSON.stringify(original);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
