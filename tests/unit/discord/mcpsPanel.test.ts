import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType } from "discord.js";
import type { GuildMcpServerRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import { buildAddMcpModal, buildMcpsPanelPayload } from "@/utils/discord/ui/mcpsPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function row(id: number, overrides: Partial<GuildMcpServerRow> = {}): GuildMcpServerRow {
  return {
    guild_mcp_id: id,
    server_id: 1,
    name: `server-${id}`,
    url: `https://user:secret@example.com:${id}/private/path?token=secret#fragment`,
    auth_token: Buffer.from("ciphertext"),
    key_version: 9,
    is_enabled: true,
    server_type: null,
    created_at: new Date(id),
    ...overrides,
  };
}

function countComponents(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, child) => total + countComponents(child), 0);
  if (!value || typeof value !== "object") return 0;
  const component = value as { type?: unknown; components?: unknown; component?: unknown };
  return (
    (typeof component.type === "number" ? 1 : 0) +
    countComponents(component.components) +
    countComponents(component.component)
  );
}

function receipt(tone: PanelReceipt["tone"]): PanelReceipt {
  return { tone, heading: `${tone} heading`, detail: `${tone} detail` };
}

describe("MCP collection panel", () => {
  it("renders the compact healthy empty hierarchy and exact count", () => {
    const payload = buildMcpsPanelPayload({
      locale: "en-US",
      scope: "guild",
      configs: [],
      readStatus: "fresh",
      page: { kind: "collection" },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Registered MCPs `(0/5)`");
    expect(serialized).toContain("This server has no MCPs yet.");
    expect(serialized).toContain(`"type":${ComponentType.Separator}`);
    expect(serialized).toContain(
      `"style":${ButtonStyle.Secondary},"customId":"mcps:v1:add-open:en-US","label":"+ Add MCP"`,
    );
    expect(serialized).not.toContain('"label":"Retry"');
    expect(serialized).not.toContain('"label":"Refresh"');
    expect(serialized.indexOf(`"type":${ComponentType.Separator}`)).toBeLessThan(
      serialized.indexOf('"label":"+ Add MCP"'),
    );
    expect(serialized.indexOf('"label":"+ Add MCP"')).toBeLessThan(serialized.indexOf("Only add MCP servers"));
  });

  it("renders every supported row in deterministic order with per-entity actions", () => {
    const configs = [
      row(3, { name: "third", created_at: new Date(10), is_enabled: false, server_type: "url_fetcher" }),
      row(2, { name: "second", created_at: new Date(10), server_type: "web_search", auth_token: null }),
      row(1, { name: "first", created_at: new Date(5) }),
      row(4),
      row(5),
    ];
    const payload = buildMcpsPanelPayload({
      locale: "en-US",
      scope: "dm",
      configs,
      readStatus: "fresh",
      page: { kind: "collection", selectedId: 3, rangeIndex: 8 },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Registered MCPs `(5/5)`");
    expect(serialized.indexOf("first")).toBeLessThan(serialized.indexOf("second"));
    expect(serialized.indexOf("second")).toBeLessThan(serialized.indexOf("third"));
    for (const id of [1, 2, 3, 4, 5]) {
      expect(serialized).toContain(`mcps:v1:remove-prompt:en-US:${id}`);
      expect(serialized).toContain(`mcps:v1:set-enabled:en-US:${id}:`);
    }
    expect(serialized).toContain("- third (`https://example.com:3`)\\n> Disabled URL Fetcher Tool");
    expect(serialized).toContain("- second (`https://example.com:2`)\\n> Enabled Web Search Tool");
    const japanese = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "ja",
        scope: "dm",
        configs: [configs[0] as GuildMcpServerRow],
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(japanese).toContain("> URL取得ツール（無効）");
    expect(serialized).not.toContain("mcps:v1:select");
    expect(serialized).not.toContain("mcps:v1:range");
    expect(serialized).not.toContain(`"type":${ComponentType.StringSelect}`);
    expect(countComponents(payload)).toBeLessThanOrEqual(40);
  });

  it("renders the compact row with a safe endpoint and no secret or auth metadata", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "guild",
        configs: [row(8443)],
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(serialized).toContain("- server\\\\-8443 (`https://example.com:8443`)\\n> Enabled General Purpose Tool");
    expect(serialized).not.toContain("Authentication");
    expect(serialized).not.toContain("Configured");
    expect(serialized).not.toContain("user:secret");
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("Online");
    expect(serialized).not.toContain("Offline");
  });

  it("distinguishes unknown, known-zero, and sanitized persisted tool snapshots without connecting", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "guild",
        configs: [
          row(1, { name: "legacy", last_discovered_tool_names: null }),
          row(2, { name: "zero", last_discovered_tool_names: [] }),
          row(3, { name: "known", last_discovered_tool_names: ["read_wiki", "`open`\nrepo\u0000"] }),
        ],
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(serialized).toContain("Tools: Discovery unknown");
    expect(serialized).toContain("Tools: None discovered");
    expect(serialized).toContain("Tools: `read_wiki`, `'open' repo`");
    expect(serialized).not.toContain("`open`");
  });

  it("disables all writes for stale rows while exposing only read-only Retry recovery", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "guild",
        configs: [row(1)],
        readStatus: "stale",
        page: { kind: "collection" },
      }),
    );
    expect(serialized).toContain("out of date");
    expect(serialized).toContain('"customId":"mcps:v1:set-enabled:en-US:1:0","label":"Disable","disabled":true');
    expect(serialized).toContain('"customId":"mcps:v1:remove-prompt:en-US:1","label":"Remove","disabled":true');
    expect(serialized).toContain('"customId":"mcps:v1:add-open:en-US","label":"+ Add MCP","disabled":true');
    expect(serialized).toContain('"customId":"mcps:v1:retry:en-US:1","label":"Retry"');
    expect(serialized).not.toContain('"label":"Refresh"');
  });

  it("bounds defensive overflow within the 40-component budget", () => {
    const payload = buildMcpsPanelPayload({
      locale: "en-US",
      scope: "guild",
      configs: Array.from({ length: 8 }, (_, index) => row(index + 1)),
      readStatus: "stale",
      page: { kind: "collection", rangeIndex: 99 },
      receipt: receipt("warning"),
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Registered MCPs `(8/5)`");
    expect(serialized).toContain("panel can safely show only 6");
    expect(serialized).toContain("mcps:v1:remove-prompt:en-US:6");
    expect(serialized).not.toContain("mcps:v1:remove-prompt:en-US:7");
    expect(serialized).toContain('"customId":"mcps:v1:add-open:en-US","label":"+ Add MCP","disabled":true');
    expect(countComponents(payload)).toBeLessThanOrEqual(40);
  });

  it("renders receipts as non-interactive top-level containers with semantic accents", () => {
    const accents = { success: 0x57f287, warning: 0xfee75c, error: 0xed4245, info: 0x65c6c5 } as const;
    for (const [tone, accent] of Object.entries(accents) as Array<[PanelReceipt["tone"], number]>) {
      const payload = buildMcpsPanelPayload({
        locale: "en-US",
        scope: "dm",
        configs: [row(1)],
        readStatus: "fresh",
        page: { kind: "collection" },
        receipt: receipt(tone),
      });
      expect(payload.components).toHaveLength(2);
      const serializedReceipt = JSON.stringify(payload.components[0]);
      const serializedPanel = JSON.stringify(payload.components[1]);
      expect(serializedReceipt).toContain(`"accentColor":${accent}`);
      expect(serializedReceipt).toContain(`${tone} heading`);
      expect(serializedReceipt).not.toContain('"type":2');
      expect(serializedPanel).toContain('"accentColor":6670021');
      expect(serializedPanel).toContain("mcps:v1:set-enabled:en-US:1:0");
    }
  });

  it("shows invalid legacy endpoints as unavailable without leaking raw text", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "dm",
        configs: [row(1, { url: "not a URL", auth_token: null })],
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(serialized).toContain("Unavailable");
    expect(serialized).not.toContain("not a URL");
  });

  it("disables Add at the configured limit without disabling entity actions", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "guild",
        configs: Array.from({ length: 5 }, (_, index) => row(index + 1)),
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(serialized).toContain('"customId":"mcps:v1:add-open:en-US","label":"+ Add MCP","disabled":true');
    expect(serialized).toContain('"customId":"mcps:v1:set-enabled:en-US:1:0","label":"Disable","disabled":false');
  });

  it("never converts an absent Remove target into confirmation for a current row", () => {
    const serialized = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "guild",
        configs: [row(1)],
        readStatus: "fresh",
        page: { kind: "remove", entityId: 999 },
      }),
    );
    expect(serialized).toContain("mcps:v1:remove-prompt:en-US:1");
    expect(serialized).not.toContain("mcps:v1:remove-confirm:en-US:1");
  });

  it("distinguishes unavailable reads from an authoritative empty collection", () => {
    const unavailable = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "dm",
        configs: [],
        readStatus: "unavailable",
        page: { kind: "collection" },
      }),
    );
    const empty = JSON.stringify(
      buildMcpsPanelPayload({
        locale: "en-US",
        scope: "dm",
        configs: [],
        readStatus: "fresh",
        page: { kind: "collection" },
      }),
    );
    expect(unavailable).toContain("could not be loaded");
    expect(unavailable).toContain('"label":"Retry"');
    expect(unavailable).not.toContain('"label":"+ Add MCP"');
    expect(empty).toContain("This DM workspace has no MCPs yet.");
    expect(empty).toContain('"label":"+ Add MCP"');
    expect(empty).not.toContain('"label":"Retry"');
  });

  it("builds a nonce-bounded Add modal with required, defaulted server type semantics", () => {
    const serialized = JSON.stringify(buildAddMcpModal("en-US", "12345678"));
    expect(serialized).toContain('"custom_id":"mcps:v1:add-submit:en-US:12345678"');
    expect(serialized).toContain('"custom_id":"name_12345678"');
    expect(serialized).toContain('"custom_id":"url_12345678"');
    expect(serialized).toContain('"custom_id":"auth-token_12345678"');
    expect(serialized).toContain(
      '"label":"Server Type","description":"What this server replaces (disables matching built-in tools)","component":{"type":21,"custom_id":"server-type_12345678","required":true',
    );
    expect(serialized).toContain('"value":"none","label":"General Purpose"');
    expect(serialized).toContain('"default":true');
    expect(serialized).toContain("No built-in tools will be disabled");
    expect(serialized).toContain('"value":"web_search","label":"Web Search"');
    expect(serialized).toContain("Disables built-in Brave and DuckDuckGo search tools");
    expect(serialized).toContain('"value":"url_fetcher","label":"URL Fetcher"');
    expect(serialized).toContain("Disables built-in URL fetch tool");
    expect(serialized).not.toContain('"label":"Server Type (Optional)"');
    expect(JSON.stringify(buildAddMcpModal("ja", "12345678"))).not.toContain('"label":"サーバータイプ（任意）"');
  });
});
