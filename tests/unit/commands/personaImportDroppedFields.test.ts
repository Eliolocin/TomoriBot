import { describe, expect, it } from "bun:test";
import { describeUnmappedCardFields } from "@/commands/persona/import";

/**
 * Dropped-field reporting exists because a successful conversion is not the same
 * as a faithful one. These cases pin which losses are worth naming, so a future
 * field-mapping change either removes a report (the field gained a destination)
 * or fails here.
 */
describe("import dropped-field reporting", () => {
  it("reports nothing for a card whose fields all have a destination", () => {
    expect(
      describeUnmappedCardFields({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "Sparrow",
          description: "An archivist.",
          first_mes: "Hello.",
          extensions: { depth_prompt: { prompt: "Keep replies short.", depth: 4 } },
          character_book: {
            entries: [{ keys: ["k"], content: "c", enabled: true, insertion_order: 1 }],
          },
        },
      }),
    ).toBeNull();
  });

  it("reports nickname, which the converter replaces with name", () => {
    const report = describeUnmappedCardFields({
      spec: "chara_card_v3",
      data: { name: "Sparrow", nickname: "The Archivist" },
    });
    expect(report).toBe("nickname");
  });

  it("reports group_only_greetings, which has no group-chat destination", () => {
    const report = describeUnmappedCardFields({
      spec: "chara_card_v3",
      data: { name: "Sparrow", group_only_greetings: ["A group hello."] },
    });
    expect(report).toBe("group_only_greetings");
  });

  it("ignores an empty array and a blank nickname", () => {
    expect(
      describeUnmappedCardFields({
        spec: "chara_card_v3",
        data: { name: "Sparrow", nickname: "   ", group_only_greetings: [] },
      }),
    ).toBeNull();
  });

  it("counts disabled character book entries, which are skipped rather than mapped", () => {
    const report = describeUnmappedCardFields({
      spec: "chara_card_v3",
      data: {
        name: "Sparrow",
        character_book: {
          entries: [
            { keys: ["a"], content: "kept", enabled: true, insertion_order: 1 },
            { keys: ["b"], content: "skipped", enabled: false, insertion_order: 2 },
            { keys: ["c"], content: "skipped", enabled: false, insertion_order: 3 },
          ],
        },
      },
    });
    expect(report).toBe("2 disabled character_book entr(ies)");
  });

  it("does not report a depth prompt that carries settings but no text", () => {
    // SillyTavern writes exactly this shape into its default export, so reporting
    // it would put noise at the front of every log line for cards where the user
    // set nothing.
    expect(
      describeUnmappedCardFields({
        spec: "chara_card_v3",
        data: { name: "Sparrow", extensions: { depth_prompt: { prompt: "", depth: 4, role: "system" } } },
      }),
    ).toBeNull();
  });

  it("still reports a depth prompt when it carries actual text", () => {
    // The text is mapped into attributes, so this reports nothing either: guard
    // against a future edit that starts flagging a field the converter uses.
    expect(
      describeUnmappedCardFields({
        spec: "chara_card_v3",
        data: { name: "Sparrow", extensions: { depth_prompt: { prompt: "Keep replies short.", depth: 4 } } },
      }),
    ).toBeNull();
  });

  it("collects several losses into one report", () => {
    const report = describeUnmappedCardFields({
      spec: "chara_card_v3",
      data: {
        name: "Sparrow",
        nickname: "The Archivist",
        group_only_greetings: ["A group hello."],
        character_book: { entries: [{ keys: ["b"], content: "skipped", enabled: false, insertion_order: 1 }] },
      },
    });
    expect(report).toContain("nickname");
    expect(report).toContain("group_only_greetings");
    expect(report).toContain("disabled character_book");
  });

  it("reads a root-level v2 card as well as a nested v3 one", () => {
    expect(describeUnmappedCardFields({ name: "Sparrow", nickname: "The Archivist" })).toBe("nickname");
  });

  it("returns null for values that are not plain objects", () => {
    expect(describeUnmappedCardFields(null)).toBeNull();
    expect(describeUnmappedCardFields("Sparrow")).toBeNull();
    expect(describeUnmappedCardFields([{ nickname: "x" }])).toBeNull();
  });

  it("does not crash on hostile shapes", () => {
    expect(describeUnmappedCardFields({ data: [1, 2, 3] })).toBeNull();
    expect(describeUnmappedCardFields({ data: { nickname: 42, group_only_greetings: "not-an-array" } })).toBeNull();
    expect(describeUnmappedCardFields({ data: { extensions: "not-an-object" } })).toBeNull();
    expect(describeUnmappedCardFields({ data: { character_book: { entries: "not-an-array" } } })).toBeNull();
    expect(describeUnmappedCardFields({ data: { character_book: { entries: [null, 7, "x"] } } })).toBeNull();
  });
});
