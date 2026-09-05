import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { ConditioningAggregateEntry } from "@/utils/discord/conditioningPanelCatalog";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { buildConditioningPanelPayload } from "@/utils/discord/ui/conditioningPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const BACKTICK_RUNS = [3, 4, 5, 6, 8];

function textDisplays(value: unknown): string[] {
  const contents: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return contents;
}

function assertSafePayload(payload: ReturnType<typeof buildConditioningPanelPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);

  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);

    const fenceStart = content.indexOf("```markdown\n");
    if (fenceStart === -1) continue;

    const bodyStart = fenceStart + "```markdown\n".length;
    const closingFence = content.lastIndexOf("\n```");
    expect(closingFence, `${label} fence is not properly closed`).toBeGreaterThan(bodyStart);

    const fenceBody = content.slice(bodyStart, closingFence);
    expect(fenceBody, `${label} has an adjacent backtick inside a fence`).not.toMatch(/``/u);
  }
}

function createEntry(id: number, reason: string): ConditioningAggregateEntry {
  return {
    serverId: 1,
    personaName: `Persona_${id}`,
    personaLineageId: 200 + id,
    conditioningType: id % 2 === 0 ? "reward" : "punish",
    actionKey: `action_${id}`,
    reasonText: reason,
    reasonNormalized: reason.toLowerCase(),
    actionText: null,
    totalCount: id + 1,
    updatedAt: new Date(1700000000000 + id * 1000),
    userDiscIds: ["123456789012345678"],
    conditioningIds: [id],
  };
}

describe("conditioning panel Components V2 limits and fence safety", () => {
  it("validates empty, single, and multiple normal entries", () => {
    assertSafePayload(buildConditioningPanelPayload({ locale: "en-US", entries: [] }), "empty entries");
    assertSafePayload(
      buildConditioningPanelPayload({ locale: "en-US", entries: [createEntry(1, "normal reason")] }),
      "single entry",
    );
    assertSafePayload(
      buildConditioningPanelPayload({
        locale: "en-US",
        entries: Array.from({ length: 15 }, (_, i) => createEntry(i + 1, `Normal reason ${i + 1}`)),
      }),
      "multi-page entries",
    );
  });

  it("handles backtick runs of 3, 4, 5, 6, and 8 without breaking the code fence", () => {
    for (const runLength of BACKTICK_RUNS) {
      const backticks = "`".repeat(runLength);
      const reason = `Prefix ${backticks} text inside run ${backticks} suffix`;
      const payload = buildConditioningPanelPayload({
        locale: "en-US",
        entries: [createEntry(1, reason)],
      });
      assertSafePayload(payload, `backtick run of ${runLength}`);
    }
  });

  it("handles astral-plane emojis without surrogate corruption or fence breakout", () => {
    const astralEmojis = "🩵 🎭 🦄 🚀 ✨ 🌟 💡 🔮 👑 💎";
    const reason = `Testing astral characters: ${astralEmojis} repeated ${astralEmojis.repeat(20)}`;
    const payload = buildConditioningPanelPayload({
      locale: "en-US",
      entries: [createEntry(1, reason)],
    });
    assertSafePayload(payload, "astral emojis");
  });

  it("bounds stored-maximum length and deliberately oversized reasons within text budgets", () => {
    const storedMaxLength = "A".repeat(2000);
    const oversizedLength = "B".repeat(10000);

    assertSafePayload(
      buildConditioningPanelPayload({
        locale: "en-US",
        entries: [createEntry(1, storedMaxLength)],
      }),
      "stored-maximum reason",
    );

    assertSafePayload(
      buildConditioningPanelPayload({
        locale: "en-US",
        entries: [createEntry(2, oversizedLength)],
      }),
      "deliberately oversized reason",
    );
  });

  it("safely renders a diverse sweep of varied content shapes on a single page", () => {
    const variedEntries: ConditioningAggregateEntry[] = [
      createEntry(1, "Simple short reason"),
      createEntry(2, "Reason with 3 backticks: ```"),
      createEntry(3, "Reason with 4 backticks: ````"),
      createEntry(4, "Reason with 5 backticks: ````` and 6 backticks: ``````"),
      createEntry(5, "Reason with 8 backticks: ```````` in between text"),
      createEntry(6, "Astral emoji mix: 🩵 🎭 🦄 🚀 ```code``` 🌟"),
      createEntry(7, `Multiline reason:\nLine 1\nLine 2\nLine 3\n${"`".repeat(4)}`),
      createEntry(8, "X".repeat(2000)),
      createEntry(9, "Y".repeat(10000)),
      createEntry(
        10,
        `Special markdown *bold* _italic_ ~strike~ [link](http://example.com) \`inline\` ${"`".repeat(3)}`,
      ),
    ];

    const payload = buildConditioningPanelPayload({
      locale: "en-US",
      entries: variedEntries,
      rangeIndex: 0,
    });

    assertSafePayload(payload, "varied content shape sweep");
  });
});
