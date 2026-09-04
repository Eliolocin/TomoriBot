import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, type StringSelectMenuComponentData } from "discord.js";
import type { PersonalMemoryRow, TomoriState } from "@/types/db/schema";
import { PrivacyLevel } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  getDiscordTextLength,
  validateComponentsV2MessageLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import {
  buildPersonalMemoriesPanelPayload,
  MAX_PERSONAL_MEMORY_PAGE_SIZE,
} from "@/utils/discord/ui/personalMemoriesPanel";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Personal Memory Action Completed Successfully",
  detail:
    "Personal memory operation completed. Your memory record #54321 has been updated and indexed with tags: preferences, tone, boundaries.",
  metadata: "trace: pmem-op-123456 | actor: 123456789012345678 | elapsed: 32ms",
};

function makePersona(id: number, lineageId: number, name: string, isAlter = false): TomoriState {
  return {
    persona_id: id,
    persona_lineage_id: lineageId,
    persona_nickname: name,
    is_alter: isAlter,
    server_id: 1,
  } as unknown as TomoriState;
}

function makePersonalMemory(id: number, overrides: Partial<PersonalMemoryRow> = {}): PersonalMemoryRow {
  return {
    personal_memory_id: id,
    user_id: "user-1",
    persona_lineage_id: 100,
    content: `Personal memory sample content #${id} with realistic user context and phrasing.`,
    tags: ["preference", "interaction-style"],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as PersonalMemoryRow;
}

function getTextDisplays(payload: unknown): string[] {
  const contents: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) visit(value);
    }
  };
  visit(payload);
  return contents;
}

describe("PersonalMemoriesPanel Limits & Boundary Sweeps", () => {
  it("conforms to Discord Components V2 protocol limits across the full state axis sweep", () => {
    const memorySizes = [
      0,
      1,
      MAX_PERSONAL_MEMORY_PAGE_SIZE - 1,
      MAX_PERSONAL_MEMORY_PAGE_SIZE,
      MAX_PERSONAL_MEMORY_PAGE_SIZE + 1,
      MAX_PERSONAL_MEMORY_PAGE_SIZE * 3,
    ];
    const personaSizes = [0, 1, 24, 25, 26, 75];
    const stmCounts = [0, 1, 10, 50];
    const categories: PersonalMemoriesCategory[] = ["global", "persona"];
    const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];
    const privacyLevels = [PrivacyLevel.MINIMAL, PrivacyLevel.FULL];

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of receipts) {
        for (const readStatus of readStatuses) {
          for (const category of categories) {
            for (const privacyLevel of privacyLevels) {
              // Sweep memory collection sizes
              for (const size of memorySizes) {
                const memories = Array.from({ length: size }, (_, i) =>
                  makePersonalMemory(i + 1, { persona_lineage_id: category === "global" ? 0 : 100 }),
                );
                const personas = [makePersona(1, 100, "Main Persona")];

                // Page: main
                const mainPayload = buildPersonalMemoriesPanelPayload({
                  locale,
                  category,
                  selectedLineageId: category === "global" ? 0 : 100,
                  personas,
                  memories,
                  stmCount: 3,
                  privacyLevel,
                  readStatus,
                  page: { kind: "main" },
                  receipt,
                });
                const mainResult = validateComponentsV2MessageLimits(mainPayload);
                if (!mainResult.valid) {
                  throw new Error(
                    `Personal memories main (locale: ${locale}, cat: ${category}, status: ${readStatus}, size: ${size}) violations: ${JSON.stringify(mainResult.violations)}`,
                  );
                }
                expect(mainResult.valid).toBe(true);

                // Page: remove
                const firstMemory = memories[0];
                if (firstMemory) {
                  const removePayload = buildPersonalMemoriesPanelPayload({
                    locale,
                    category,
                    selectedLineageId: category === "global" ? 0 : 100,
                    personas,
                    memories,
                    stmCount: 3,
                    privacyLevel,
                    readStatus,
                    page: { kind: "remove", memoryId: firstMemory.personal_memory_id },
                    receipt,
                  });
                  const removeResult = validateComponentsV2MessageLimits(removePayload);
                  if (!removeResult.valid) {
                    throw new Error(`Personal memories remove violations: ${JSON.stringify(removeResult.violations)}`);
                  }
                  expect(removeResult.valid).toBe(true);
                }
              }

              // Sweep persona collection sizes (when category === "persona")
              if (category === "persona") {
                for (const pSize of personaSizes) {
                  const personas = Array.from({ length: pSize }, (_, i) =>
                    makePersona(i + 1, 100 + i, `Persona ${i + 1}`),
                  );
                  const payload = buildPersonalMemoriesPanelPayload({
                    locale,
                    category: "persona",
                    selectedLineageId: personas[0]?.persona_lineage_id ?? 100,
                    personas,
                    memories: [
                      makePersonalMemory(1, {
                        persona_lineage_id: personas[0]?.persona_lineage_id ?? 100,
                      }),
                    ],
                    stmCount: 2,
                    privacyLevel,
                    readStatus,
                    page: { kind: "main" },
                    receipt,
                  });
                  const result = validateComponentsV2MessageLimits(payload);
                  if (!result.valid) {
                    throw new Error(
                      `Personal memories persona size violations (pSize: ${pSize}): ${JSON.stringify(result.violations)}`,
                    );
                  }
                  expect(result.valid).toBe(true);
                }
              }

              // Sweep stmCount values
              for (const stmCount of stmCounts) {
                const payload = buildPersonalMemoriesPanelPayload({
                  locale,
                  category,
                  selectedLineageId: category === "global" ? 0 : 100,
                  personas: [makePersona(1, 100, "Main Persona")],
                  memories: [makePersonalMemory(1)],
                  stmCount,
                  privacyLevel,
                  readStatus,
                  page: { kind: "main" },
                  receipt,
                });
                const result = validateComponentsV2MessageLimits(payload);
                if (!result.valid) {
                  throw new Error(
                    `Personal memories stmCount violations (count: ${stmCount}): ${JSON.stringify(result.violations)}`,
                  );
                }
                expect(result.valid).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("covers every record in the union of paginated pages without dropping overflow", () => {
    // Test collection with MAX_PERSONAL_MEMORY_PAGE_SIZE + 1 items
    const totalMemories = MAX_PERSONAL_MEMORY_PAGE_SIZE + 1;
    const memories = Array.from({ length: totalMemories }, (_, i) =>
      makePersonalMemory(i + 1, { persona_lineage_id: 0 }),
    );

    // Page 0
    const page0Payload = buildPersonalMemoriesPanelPayload({
      locale: "en-US",
      category: "global",
      selectedLineageId: 0,
      personas: [],
      memories,
      stmCount: 0,
      privacyLevel: PrivacyLevel.MINIMAL,
      readStatus: "fresh",
      page: { kind: "main", rangeIndex: 0 },
    });

    // Page 1
    const page1Payload = buildPersonalMemoriesPanelPayload({
      locale: "en-US",
      category: "global",
      selectedLineageId: 0,
      personas: [],
      memories,
      stmCount: 0,
      privacyLevel: PrivacyLevel.MINIMAL,
      readStatus: "fresh",
      page: { kind: "main", rangeIndex: 1 },
    });

    function extractMemoryIds(payload: ReturnType<typeof buildPersonalMemoriesPanelPayload>): number[] {
      const ids: number[] = [];
      for (const topComp of payload.components) {
        if ("components" in topComp && Array.isArray(topComp.components)) {
          for (const inner of topComp.components) {
            if ("components" in inner && Array.isArray(inner.components)) {
              for (const elem of inner.components) {
                if (elem.type === ComponentType.StringSelect) {
                  const select = elem as StringSelectMenuComponentData;
                  if (select.customId?.includes(":select:")) {
                    for (const opt of select.options) {
                      if (!opt.value.startsWith("action:")) {
                        ids.push(Number(opt.value));
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      return ids;
    }

    const idsPage0 = extractMemoryIds(page0Payload);
    const idsPage1 = extractMemoryIds(page1Payload);

    expect(idsPage0.length).toBe(MAX_PERSONAL_MEMORY_PAGE_SIZE);
    expect(idsPage1.length).toBe(1);

    const unionIds = [...idsPage0, ...idsPage1];
    expect(unionIds.length).toBe(totalMemories);

    const expectedIds = Array.from({ length: totalMemories }, (_, i) => i + 1);
    expect(unionIds.sort((a, b) => a - b)).toEqual(expectedIds);
  });

  it("handles oversized content, backtick runs, and astral emoji across pages", () => {
    const personas = [makePersona(1, 100, "Main Persona")];
    const limits = getMemoryLimits();

    function assertFenceRuns(content: string): void {
      if (!content.startsWith("```markdown\n")) return;
      const closingIdx = content.lastIndexOf("\n```");
      if (closingIdx === -1) return;
      const inner = content.slice("```markdown\n".length, closingIdx);
      expect(inner.includes("```")).toBe(false);
      expect(inner.includes("``")).toBe(false);
    }

    function assertNoLoneSurrogates(content: string): void {
      const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(loneSurrogate.test(content)).toBe(false);
    }

    function checkPayload(payload: ReturnType<typeof buildPersonalMemoriesPanelPayload>, label: string): void {
      const result = validateComponentsV2MessageLimits(payload);
      if (!result.valid) {
        throw new Error(`${label} limits violation: ${JSON.stringify(result.violations)}`);
      }
      expect(result.valid).toBe(true);

      for (const comp of payload.components) {
        if ("components" in comp && Array.isArray(comp.components)) {
          for (const inner of comp.components) {
            if ("content" in inner && typeof inner.content === "string") {
              assertFenceRuns(inner.content);
              assertNoLoneSurrogates(inner.content);
            }
          }
        }
      }
    }

    const lengthsToTest = [limits.maxMemoryLength, 4000, 20000, 100000];
    for (const len of lengthsToTest) {
      const content = "P".repeat(len);

      checkPayload(
        buildPersonalMemoriesPanelPayload({
          locale: "en-US",
          category: "global",
          selectedLineageId: 0,
          personas: [],
          memories: [makePersonalMemory(1, { persona_lineage_id: 0, content })],
          stmCount: 0,
          privacyLevel: PrivacyLevel.FULL,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `personal global main (len ${len})`,
      );

      checkPayload(
        buildPersonalMemoriesPanelPayload({
          locale: "en-US",
          category: "persona",
          selectedLineageId: 100,
          personas,
          memories: [makePersonalMemory(1, { persona_lineage_id: 100, content })],
          stmCount: 0,
          privacyLevel: PrivacyLevel.FULL,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `personal persona main (len ${len})`,
      );

      checkPayload(
        buildPersonalMemoriesPanelPayload({
          locale: "en-US",
          category: "persona",
          selectedLineageId: 100,
          personas,
          memories: [makePersonalMemory(1, { persona_lineage_id: 100, content })],
          stmCount: 0,
          privacyLevel: PrivacyLevel.MINIMAL,
          readStatus: "fresh",
          page: { kind: "remove", memoryId: 1 },
        }),
        `personal remove (len ${len})`,
      );
    }

    for (const runLen of [3, 4, 5, 6, 8]) {
      const content = `Prefix \`${"`".repeat(runLen - 1)} middle \`${"`".repeat(runLen - 1)} suffix`;

      checkPayload(
        buildPersonalMemoriesPanelPayload({
          locale: "en-US",
          category: "global",
          selectedLineageId: 0,
          personas: [],
          memories: [makePersonalMemory(1, { persona_lineage_id: 0, content })],
          stmCount: 0,
          privacyLevel: PrivacyLevel.MINIMAL,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `personal global backtick run ${runLen}`,
      );
    }

    for (const len of [4000, 20000, 100000]) {
      // 🌟 is \uD83C\uDF1F (2 UTF-16 units, 1 codepoint)
      const content = "🌟".repeat(len);

      checkPayload(
        buildPersonalMemoriesPanelPayload({
          locale: "en-US",
          category: "global",
          selectedLineageId: 0,
          personas: [],
          memories: [makePersonalMemory(1, { persona_lineage_id: 0, content })],
          stmCount: 0,
          privacyLevel: PrivacyLevel.MINIMAL,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `personal global astral emoji (len ${len})`,
      );
    }
  });

  // Tightness tolerance for measured dynamic personal memory preview content:
  // Cutting stops within 3 characters of available budget when truncated.
  const PERSONAL_MEMORIES_TIGHTNESS_TOLERANCE = 3;

  it("proves dynamic personal memory pages are tight when truncated at stored maxima", () => {
    const personas = [makePersona(1, 100, "Main Persona")];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of receipts) {
        for (const kind of ["main", "remove"] as const) {
          const page = kind === "main" ? { kind: "main" as const } : { kind: "remove" as const, memoryId: 1 };
          for (const category of ["global", "persona"] as const) {
            const payload = buildPersonalMemoriesPanelPayload({
              locale,
              category,
              selectedLineageId: category === "global" ? 0 : 100,
              personas: category === "persona" ? personas : [],
              memories: [
                makePersonalMemory(1, {
                  persona_lineage_id: category === "global" ? 0 : 100,
                  content: "M".repeat(10_000),
                }),
              ],
              stmCount: 0,
              privacyLevel: PrivacyLevel.MINIMAL,
              readStatus: "fresh",
              page,
              receipt,
            });
            const displays = getTextDisplays(payload);
            const total = displays.reduce((sum, t) => sum + getDiscordTextLength(t), 0);
            expect(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - total).toBeLessThanOrEqual(
              PERSONAL_MEMORIES_TIGHTNESS_TOLERANCE,
            );
          }
        }
      }
    }
  });
});
