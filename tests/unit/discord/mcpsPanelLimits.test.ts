import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { GuildMcpServerRow } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { buildMcpsPanelPayload, MAX_MCP_PANEL_PAGE_SIZE } from "@/utils/discord/ui/mcpsPanel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "MCP Action Completed Successfully",
  detail: "The MCP registration was saved and its current discovery snapshot was refreshed.",
  metadata: "trace: mcp-op-987654 | actor: 123456789012345678 | elapsed: 48ms",
};

const READ_STATUSES: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
const RECEIPTS: Array<PanelReceipt | undefined> = [undefined, REALISTIC_RECEIPT];
const BACKTICK_RUNS = [3, 4, 5, 6, 8];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

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

function assertSafePayload(payload: ReturnType<typeof buildMcpsPanelPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);
  for (const content of textDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    const fenceStart = content.indexOf("```markdown\n");
    if (fenceStart === -1) continue;
    const bodyStart = fenceStart + "```markdown\n".length;
    const closingFence = content.lastIndexOf("\n```");
    if (closingFence <= bodyStart) continue;
    expect(content.slice(bodyStart, closingFence), `${label} has an adjacent backtick in a fence`).not.toMatch(/``/u);
  }
}

function row(id: number, overrides: Partial<GuildMcpServerRow> = {}): GuildMcpServerRow {
  return {
    guild_mcp_id: id,
    server_id: 1,
    name: `server-${id}`,
    url: `https://server-${id}.example.invalid/v1/private-path?token=secret`,
    auth_token: Buffer.from("ciphertext"),
    key_version: 9,
    is_enabled: id % 2 === 1,
    server_type: id % 3 === 0 ? "web_search" : null,
    last_discovered_tool_names: [`tool-${id}`, "open_resource"],
    created_at: new Date(id),
    ...overrides,
  };
}

function customIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (typeof record.customId === "string") ids.push(record.customId);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return ids;
}

describe("MCP panel Components V2 limits", () => {
  it("covers both scopes, both page kinds, every read status, receipt state, and collection size", () => {
    const sizes = [
      0,
      1,
      MAX_MCP_PANEL_PAGE_SIZE - 1,
      MAX_MCP_PANEL_PAGE_SIZE,
      MAX_MCP_PANEL_PAGE_SIZE + 1,
      MAX_MCP_PANEL_PAGE_SIZE * 3,
    ];
    for (const locale of RUNTIME_LOCALES) {
      for (const scope of ["guild", "dm"] as const) {
        for (const receipt of RECEIPTS) {
          for (const readStatus of READ_STATUSES) {
            for (const size of sizes) {
              const configs = Array.from({ length: size }, (_, index) => row(index + 1));
              for (const page of [
                { kind: "collection" as const, rangeIndex: 2, selectedId: configs[0]?.guild_mcp_id },
                { kind: "remove" as const, entityId: configs[0]?.guild_mcp_id ?? 1 },
              ]) {
                assertSafePayload(
                  buildMcpsPanelPayload({ locale, scope, configs, readStatus, page, receipt }),
                  `${locale}/${scope}/${readStatus}/size-${size}/${page.kind}`,
                );
              }
            }
          }
        }
      }
    }
  });

  it("bounds MCP names and endpoint inputs across stored, oversized, fenced, and astral shapes", () => {
    const shapes = [
      { name: "N".repeat(32), url: `https://safe-0.example.invalid/${"u".repeat(500)}` },
      { name: "O".repeat(20_000), url: `https://safe-1.example.invalid/${"u".repeat(20_000)}` },
      ...BACKTICK_RUNS.map((length) => ({
        name: `server ${"`".repeat(length)} name`,
        url: `https://safe-${length}.example.invalid/${"`".repeat(length)}`,
      })),
      { name: "🌟".repeat(20_000), url: `https://safe-emoji.example.invalid/${"🌟".repeat(20_000)}` },
    ];
    for (const [index, shape] of shapes.entries()) {
      const config = row(index + 1, {
        name: shape.name,
        url: shape.url,
      });
      for (const page of [
        { kind: "collection" as const, rangeIndex: 0 },
        { kind: "remove" as const, entityId: index + 1 },
      ]) {
        assertSafePayload(
          buildMcpsPanelPayload({
            locale: "en-US",
            scope: "guild",
            configs: [config],
            readStatus: "fresh",
            page,
            receipt: REALISTIC_RECEIPT,
          }),
          `shape-${index}/${page.kind}`,
        );
      }
    }

    // Explicitly test a full page at MAX_MCP_PANEL_PAGE_SIZE with every row carrying oversized content
    const fullPageConfigs = Array.from({ length: MAX_MCP_PANEL_PAGE_SIZE }, (_, i) =>
      row(i + 1, {
        name: "M".repeat(20_000),
        url: `https://safe-${i + 1}.example.invalid/${"u".repeat(20_000)}`,
      }),
    );
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        for (const page of [
          { kind: "collection" as const, rangeIndex: 0 },
          { kind: "remove" as const, entityId: fullPageConfigs[0]?.guild_mcp_id as number },
        ]) {
          assertSafePayload(
            buildMcpsPanelPayload({
              locale,
              scope: "guild",
              configs: fullPageConfigs,
              readStatus: "fresh",
              page,
              receipt,
            }),
            `full-page-oversized/${locale}/${page.kind}/receipt=${Boolean(receipt)}`,
          );
        }
      }
    }
  });

  it("covers every MCP record exactly once across paginated ranges", () => {
    const total = MAX_MCP_PANEL_PAGE_SIZE + 1;
    const configs = Array.from({ length: total }, (_, index) => row(index + 1));
    const seen: string[] = [];
    const rangeCount = Math.ceil(total / MAX_MCP_PANEL_PAGE_SIZE);
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
      seen.push(
        ...customIds(
          buildMcpsPanelPayload({
            locale: "en-US",
            scope: "guild",
            configs,
            readStatus: "fresh",
            page: { kind: "collection", rangeIndex },
          }),
        ).filter((id) => id.includes("mcps:v1:remove-prompt:")),
      );
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen.sort()).toEqual(
      Array.from({ length: total }, (_, index) => `mcps:v1:remove-prompt:en-US:${index + 1}`).sort(),
    );
  });
});
