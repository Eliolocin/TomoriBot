import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType, type StringSelectMenuComponentData } from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  getDiscordTextLength,
  validateComponentsV2MessageLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import {
  buildMemoriesPanelPayload,
  MAX_DOCUMENT_PAGE_SIZE,
  MAX_SERVER_MEMORY_PAGE_SIZE,
  MAX_STM_MANAGEABLE_ENTRIES,
  MAX_STM_OPTIONS_PER_GROUP,
} from "@/utils/discord/ui/memoriesPanel";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Server Memory Action Completed Successfully",
  detail:
    "Memory operation completed. The memory content has been saved and vectorized for persona lineage 100 with active tags: schedule, rules, guidelines.",
  metadata: "trace: mem-op-987654 | actor: 123456789012345678 | elapsed: 48ms",
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

function makeMemory(id: number, overrides: Partial<ServerMemoryRow> = {}): ServerMemoryRow {
  return {
    server_memory_id: id,
    server_id: 1,
    persona_lineage_id: 100,
    user_id: "user-1",
    content: `Server memory sample content #${id} with realistic length and context.`,
    tags: ["important", "guidelines"],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as ServerMemoryRow;
}

function makeDocument(id: number, overrides: Partial<DocumentListRow> = {}): DocumentListRow {
  return {
    document_id: id,
    document_name: `Document ${id}.pdf`,
    first_chunk: `First chunk preview of document #${id}`,
    channel_ids: ["123456789012345678"],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChunk(documentId: number, chunkIndex: number): DocumentChunkRow {
  return {
    chunk_id: documentId * 100 + chunkIndex,
    document_id: documentId,
    chunk_index: chunkIndex,
    content: `Document #${documentId} chunk content at index ${chunkIndex}. Detailed textual data.`,
    channel_ids: ["123456789012345678"],
    created_at: new Date().toISOString(),
  };
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

describe("MemoriesPanel Limits & Boundary Sweeps", () => {
  it("conforms to Discord Components V2 protocol limits across the full state axis sweep", () => {
    const memorySizes = [
      0,
      1,
      MAX_SERVER_MEMORY_PAGE_SIZE - 1,
      MAX_SERVER_MEMORY_PAGE_SIZE,
      MAX_SERVER_MEMORY_PAGE_SIZE + 1,
      MAX_SERVER_MEMORY_PAGE_SIZE * 3,
    ];
    const personaSizes = [0, 1, 24, 25, 26, 75];
    const documentSizes = [
      0,
      1,
      MAX_DOCUMENT_PAGE_SIZE - 1,
      MAX_DOCUMENT_PAGE_SIZE,
      MAX_DOCUMENT_PAGE_SIZE + 1,
      MAX_DOCUMENT_PAGE_SIZE * 3,
    ];
    const stmSizes = [
      0,
      1,
      MAX_STM_OPTIONS_PER_GROUP - 1,
      MAX_STM_OPTIONS_PER_GROUP,
      MAX_STM_OPTIONS_PER_GROUP + 1,
      MAX_STM_MANAGEABLE_ENTRIES + 10,
    ];

    const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of receipts) {
        for (const readStatus of readStatuses) {
          // Sweep Memories category across memory collection sizes and page kinds
          for (const size of memorySizes) {
            const memories = Array.from({ length: size }, (_, i) => makeMemory(i + 1));
            const personas = [makePersona(1, 100, "Main Persona")];

            // Test page: main
            const mainPayload = buildMemoriesPanelPayload({
              locale,
              category: "memories",
              selectedLineageId: 100,
              personas,
              memories,
              canManage: true,
              readStatus,
              page: { kind: "main" },
              receipt,
            });
            const mainResult = validateComponentsV2MessageLimits(mainPayload);
            if (!mainResult.valid) {
              throw new Error(
                `Memories main (locale: ${locale}, status: ${readStatus}, size: ${size}) violations: ${JSON.stringify(mainResult.violations)}`,
              );
            }
            expect(mainResult.valid).toBe(true);

            // Test page: remove
            const firstMemory = memories[0];
            if (firstMemory) {
              const removePayload = buildMemoriesPanelPayload({
                locale,
                category: "memories",
                selectedLineageId: 100,
                personas,
                memories,
                canManage: true,
                readStatus,
                page: { kind: "remove", memoryId: firstMemory.server_memory_id },
                receipt,
              });
              const removeResult = validateComponentsV2MessageLimits(removePayload);
              if (!removeResult.valid) {
                throw new Error(
                  `Memories remove (locale: ${locale}, status: ${readStatus}) violations: ${JSON.stringify(removeResult.violations)}`,
                );
              }
              expect(removeResult.valid).toBe(true);

              // Test page: vectorize
              const vectorizePayload = buildMemoriesPanelPayload({
                locale,
                category: "memories",
                selectedLineageId: 100,
                personas,
                memories,
                canManage: true,
                readStatus,
                page: { kind: "vectorize", memoryId: firstMemory.server_memory_id, personaId: 1 },
                receipt,
              });
              const vectorizeResult = validateComponentsV2MessageLimits(vectorizePayload);
              if (!vectorizeResult.valid) {
                throw new Error(
                  `Memories vectorize (locale: ${locale}, status: ${readStatus}) violations: ${JSON.stringify(vectorizeResult.violations)}`,
                );
              }
              expect(vectorizeResult.valid).toBe(true);
            }
          }

          // Sweep personas collection sizes
          for (const pSize of personaSizes) {
            const personas = Array.from({ length: pSize }, (_, i) => makePersona(i + 1, 100 + i, `Persona ${i + 1}`));
            const payload = buildMemoriesPanelPayload({
              locale,
              category: "memories",
              selectedLineageId: personas[0]?.persona_lineage_id ?? 100,
              personas,
              memories: [makeMemory(1, { persona_lineage_id: personas[0]?.persona_lineage_id ?? 100 })],
              canManage: true,
              readStatus,
              page: { kind: "main" },
              receipt,
            });
            const result = validateComponentsV2MessageLimits(payload);
            if (!result.valid) {
              throw new Error(
                `Memories persona sizes (locale: ${locale}, pSize: ${pSize}) violations: ${JSON.stringify(result.violations)}`,
              );
            }
            expect(result.valid).toBe(true);
          }

          // Sweep Documents category
          for (const docSize of documentSizes) {
            const docs = Array.from({ length: docSize }, (_, i) => makeDocument(i + 1));
            const personas = [makePersona(1, 100, "Main Persona")];
            const firstDoc = docs[0];
            const chunks = firstDoc ? [makeChunk(firstDoc.document_id, 0), makeChunk(firstDoc.document_id, 1)] : [];

            const docPayload = buildMemoriesPanelPayload({
              locale,
              category: "documents",
              selectedLineageId: 100,
              selectedDocumentPersonaId: 1,
              personas,
              memories: [],
              documents: docs,
              documentCount: docSize,
              documentChunks: chunks,
              canManage: true,
              readStatus,
              page: { kind: "documents", selectedDocumentId: firstDoc?.document_id },
              receipt,
            });
            const docResult = validateComponentsV2MessageLimits(docPayload);
            if (!docResult.valid) {
              throw new Error(
                `Documents main (locale: ${locale}, docSize: ${docSize}) violations: ${JSON.stringify(docResult.violations)}`,
              );
            }
            expect(docResult.valid).toBe(true);

            if (firstDoc) {
              // document-remove
              const docRemovePayload = buildMemoriesPanelPayload({
                locale,
                category: "documents",
                selectedLineageId: 100,
                selectedDocumentPersonaId: 1,
                personas,
                memories: [],
                documents: docs,
                documentCount: docSize,
                canManage: true,
                readStatus,
                page: { kind: "document-remove", documentId: firstDoc.document_id, historyOnly: false },
                receipt,
              });
              const docRemoveResult = validateComponentsV2MessageLimits(docRemovePayload);
              if (!docRemoveResult.valid) {
                throw new Error(`Document remove violations: ${JSON.stringify(docRemoveResult.violations)}`);
              }
              expect(docRemoveResult.valid).toBe(true);

              // document-chunk-remove
              const chunkRemovePayload = buildMemoriesPanelPayload({
                locale,
                category: "documents",
                selectedLineageId: 100,
                selectedDocumentPersonaId: 1,
                personas,
                memories: [],
                documents: docs,
                documentChunks: chunks,
                canManage: true,
                readStatus,
                page: {
                  kind: "document-chunk-remove",
                  documentId: firstDoc.document_id,
                  chunkIdx: 0,
                },
                receipt,
              });
              const chunkRemoveResult = validateComponentsV2MessageLimits(chunkRemovePayload);
              if (!chunkRemoveResult.valid) {
                throw new Error(`Document chunk remove violations: ${JSON.stringify(chunkRemoveResult.violations)}`);
              }
              expect(chunkRemoveResult.valid).toBe(true);
            }
          }

          // Sweep STM category
          for (const stmSize of stmSizes) {
            const stmEntries = Array.from({ length: stmSize }, (_, i) => ({
              personaName: `Persona ${i + 1}`,
              channelId: `12345678901234567${i}`,
            }));
            const stmPayload = buildMemoriesPanelPayload({
              locale,
              category: "stm",
              selectedLineageId: 100,
              personas: [makePersona(1, 100, "Main Persona")],
              memories: [],
              stmCount: stmSize,
              stmEntries,
              canManage: true,
              readStatus,
              page: { kind: "main" },
              receipt,
            });
            const stmResult = validateComponentsV2MessageLimits(stmPayload);
            if (!stmResult.valid) {
              throw new Error(`STM violations (stmSize: ${stmSize}): ${JSON.stringify(stmResult.violations)}`);
            }
            expect(stmResult.valid).toBe(true);
          }
        }
      }
    }
  });

  it("covers every record in the union of paginated pages without dropping overflow", () => {
    // Test collection with MAX_SERVER_MEMORY_PAGE_SIZE + 1 items
    const totalMemories = MAX_SERVER_MEMORY_PAGE_SIZE + 1;
    const memories = Array.from({ length: totalMemories }, (_, i) => makeMemory(i + 1, { persona_lineage_id: 100 }));
    const personas = [makePersona(1, 100, "Main Persona")];

    // Page 0
    const page0Payload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories,
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main", rangeIndex: 0 },
    });

    // Page 1
    const page1Payload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories,
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main", rangeIndex: 1 },
    });

    function extractMemoryIds(payload: ReturnType<typeof buildMemoriesPanelPayload>): number[] {
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

    expect(idsPage0.length).toBe(MAX_SERVER_MEMORY_PAGE_SIZE);
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

    function checkPayload(payload: ReturnType<typeof buildMemoriesPanelPayload>, label: string): void {
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

    for (const runLen of [3, 4, 5, 6, 8]) {
      const content = `Prefix \`${"`".repeat(runLen - 1)} middle \`${"`".repeat(runLen - 1)} suffix`;
      const memory = makeMemory(1, { content });

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [memory],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `server memories backtick run ${runLen}`,
      );
    }

    const lengthsToTest = [limits.maxMemoryLength, 4000, 20000, 100000];
    for (const len of lengthsToTest) {
      const content = "M".repeat(len);
      const memory = makeMemory(1, { content });

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [memory],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `server memories main (len ${len})`,
      );

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [memory],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "remove", memoryId: 1 },
        }),
        `server memories remove (len ${len})`,
      );

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [memory],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "vectorize", memoryId: 1, personaId: 1 },
        }),
        `server memories vectorize (len ${len})`,
      );

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "documents",
          selectedLineageId: 100,
          selectedDocumentPersonaId: 1,
          personas,
          memories: [],
          documents: [makeDocument(1)],
          documentCount: 1,
          documentChunks: [
            {
              chunk_id: 1,
              document_id: 1,
              chunk_index: 0,
              content,
              channel_ids: [],
              created_at: new Date().toISOString(),
            },
          ],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "documents", selectedDocumentId: 1 },
        }),
        `server document chunk (len ${len})`,
      );
    }

    for (const len of [4000, 20000, 100000]) {
      // 🌟 is \uD83C\uDF1F (2 UTF-16 units, 1 codepoint)
      const content = "🌟".repeat(len);
      const memory = makeMemory(1, { content });

      checkPayload(
        buildMemoriesPanelPayload({
          locale: "en-US",
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [memory],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "main" },
        }),
        `server memories astral emoji (len ${len})`,
      );
    }
  });

  // Tightness tolerance for measured dynamic memory & document preview content:
  // Cutting stops within 3 characters of available budget when truncated.
  const MEMORIES_TIGHTNESS_TOLERANCE = 3;

  it("proves dynamic memory and document pages are tight when truncated at stored maxima", () => {
    const personas = [makePersona(1, 100, "Main Persona")];
    const receipts: (PanelReceipt | undefined)[] = [undefined, REALISTIC_RECEIPT];

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of receipts) {
        // Main page with oversized memory
        const mainPayload = buildMemoriesPanelPayload({
          locale,
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [makeMemory(1, { content: "M".repeat(10_000) })],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "main" },
          receipt,
        });
        const mainDisplays = getTextDisplays(mainPayload);
        const mainTotal = mainDisplays.reduce((sum, t) => sum + getDiscordTextLength(t), 0);
        expect(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - mainTotal).toBeLessThanOrEqual(MEMORIES_TIGHTNESS_TOLERANCE);

        const removePayload = buildMemoriesPanelPayload({
          locale,
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [makeMemory(1, { content: "M".repeat(10_000) })],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "remove", memoryId: 1 },
          receipt,
        });
        const removeDisplays = getTextDisplays(removePayload);
        const removeTotal = removeDisplays.reduce((sum, t) => sum + getDiscordTextLength(t), 0);
        expect(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - removeTotal).toBeLessThanOrEqual(MEMORIES_TIGHTNESS_TOLERANCE);

        const vectorizePayload = buildMemoriesPanelPayload({
          locale,
          category: "memories",
          selectedLineageId: 100,
          personas,
          memories: [makeMemory(1, { content: "M".repeat(10_000) })],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "vectorize", memoryId: 1, personaId: 1 },
          receipt,
        });
        const vectorizeDisplays = getTextDisplays(vectorizePayload);
        const vectorizeTotal = vectorizeDisplays.reduce((sum, t) => sum + getDiscordTextLength(t), 0);
        expect(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - vectorizeTotal).toBeLessThanOrEqual(
          MEMORIES_TIGHTNESS_TOLERANCE,
        );

        const docPayload = buildMemoriesPanelPayload({
          locale,
          category: "documents",
          selectedLineageId: 100,
          selectedDocumentPersonaId: 1,
          personas,
          memories: [],
          documents: [makeDocument(1)],
          documentCount: 1,
          documentChunks: [
            {
              chunk_id: 1,
              document_id: 1,
              chunk_index: 0,
              content: "D".repeat(10_000),
              channel_ids: [],
              created_at: new Date().toISOString(),
            },
          ],
          canManage: true,
          readStatus: "fresh",
          page: { kind: "documents", selectedDocumentId: 1 },
          receipt,
        });
        const docDisplays = getTextDisplays(docPayload);
        const docTotal = docDisplays.reduce((sum, t) => sum + getDiscordTextLength(t), 0);
        expect(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - docTotal).toBeLessThanOrEqual(MEMORIES_TIGHTNESS_TOLERANCE);
      }
    }
  });
});
