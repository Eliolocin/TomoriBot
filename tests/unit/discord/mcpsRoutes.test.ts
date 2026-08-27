import { beforeAll, describe, expect, it } from "bun:test";
import type { ButtonInteraction, Client, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import type { GuildMcpServerRow } from "@/types/db/schema";
import {
  createMcpsInteractionRoute,
  mcpsInteractionRoute,
  type McpsRouteDependencies,
} from "@/utils/discord/interactions/mcpsRoutes";
import { buildInteractionRouteId } from "@/utils/discord/interactions/routeRegistry";
import { parseMcpsPanelRoute } from "@/utils/discord/mcpsPanelCatalog";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function configuredRow(): GuildMcpServerRow {
  return {
    guild_mcp_id: 1,
    server_id: 10,
    name: "search",
    url: "https://example.com/mcp",
    auth_token: null,
    key_version: 1,
    is_enabled: true,
    server_type: "web_search",
  };
}

function dependencies(calls: string[], overrides: Partial<McpsRouteDependencies> = {}): McpsRouteDependencies {
  return {
    resolveScope: async (_interaction, forceRefresh) => {
      calls.push(forceRefresh ? "load-fresh" : "load");
      return {
        discordId: "100",
        kind: "dm",
        state: { server_id: 10 } as never,
        read: { status: "fresh", configs: [configuredRow()] },
      };
    },
    operations: {
      add: async () => {
        calls.push("add");
        return { status: "invalid-name" };
      },
      setEnabled: async () => {
        calls.push("set-enabled");
        return { status: "success", row: { ...configuredRow(), is_enabled: false } };
      },
      remove: async () => {
        calls.push("remove");
        return { status: "success", row: configuredRow() };
      },
    },
    createNonce: () => "12345678",
    showAddModal: async () => calls.push("showAddModal"),
    takeServerType: () => "none",
    recordAction: overrides.recordAction ?? (() => {}),
    ...overrides,
  };
}

describe("MCP panel routes", () => {
  it("round trips valid state and rejects malformed stable IDs, types, and nonces", () => {
    expect(
      parseMcpsPanelRoute({
        namespace: "mcps",
        version: "v1",
        segments: ["set-enabled", "en-US", "42", "1"],
      }),
    ).toEqual({ action: "set-enabled", locale: "en-US", entityId: 42, enabled: true });
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["set-enabled", "en-US", "0", "1"] }),
    ).toBeNull();
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["add-open", "en-US", "other"] }),
    ).toBeNull();
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["add-submit", "en-US", "general", "x"] }),
    ).toBeNull();
    expect(parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["unknown", "en-US"] })).toBeNull();
    expect(parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["add-type", "xx"] })).toBeNull();
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["set-enabled", "en-US", "1", "2"] }),
    ).toBeNull();
    expect(parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["range", "en-US", "-1"] })).toBeNull();
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["add-type", "en-US", "extra"] }),
    ).toBeNull();
    expect(
      parseMcpsPanelRoute({ namespace: "mcps", version: "v1", segments: ["add-submit", "en-US", "12345678"] }),
    ).toEqual({ action: "add-submit", locale: "en-US", nonce: "12345678" });
    expect(
      parseMcpsPanelRoute({
        namespace: "mcps",
        version: "v1",
        segments: ["add-submit", "en-US", "web_search", "12345678"],
      }),
    ).toEqual({
      action: "add-submit",
      locale: "en-US",
      nonce: "12345678",
      legacyServerType: "web_search",
    });
  });

  it("guards Discord's 100-character custom ID limit", () => {
    expect(() => buildInteractionRouteId("mcps", "v1", "add-submit", "en-US", "x".repeat(90))).toThrow("exceeds 100");
  });

  it("opens the Add modal as the only initial acknowledgement", async () => {
    const calls: string[] = [];
    const route = createMcpsInteractionRoute(dependencies(calls));
    const interaction = {
      customId: "mcps:v1:add-open:en-US",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      reply: async () => calls.push("reply"),
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-open", "en-US"],
    });
    expect(calls).toEqual(["showAddModal"]);
  });

  it("denies a changed guild permission after acknowledging button actions", async () => {
    const calls: string[] = [];
    const interaction = {
      customId: "mcps:v1:refresh:en-US:1",
      guildId: "200",
      user: { id: "100" },
      memberPermissions: { has: () => false },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ButtonInteraction;
    await mcpsInteractionRoute.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["refresh", "en-US", "1"],
    });
    expect(calls).toEqual(["deferUpdate", "editReply"]);
  });

  it("denies Add Form without deferring or opening a modal", async () => {
    const calls: string[] = [];
    const interaction = {
      customId: "mcps:v1:add-open:en-US",
      guildId: "200",
      user: { id: "100" },
      memberPermissions: { has: () => false },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      showModal: async () => calls.push("showModal"),
      deferUpdate: async () => calls.push("deferUpdate"),
      reply: async () => calls.push("reply"),
    } as unknown as ButtonInteraction;
    await mcpsInteractionRoute.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-open", "en-US"],
    });
    expect(calls).toEqual(["reply"]);
  });

  it("acknowledges and denies a guild Add submission after permission is lost", async () => {
    const calls: string[] = [];
    const route = createMcpsInteractionRoute(dependencies(calls));
    const interaction = {
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: "200",
      user: { id: "100" },
      memberPermissions: { has: () => false },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
      fields: { getTextInputValue: () => "must-not-be-read" },
    } as unknown as ModalSubmitInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(calls).toEqual(["deferUpdate", "editReply"]);
  });

  it("acknowledges navigation before loading durable state", async () => {
    const calls: string[] = [];
    const route = createMcpsInteractionRoute(dependencies(calls));
    const interaction = {
      customId: "mcps:v1:retry:en-US:1",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["retry", "en-US", "1"],
    });
    expect(calls).toEqual(["deferUpdate", "load-fresh", "editReply"]);
  });

  it("repaints a missing workspace only after acknowledging the interaction", async () => {
    const calls: string[] = [];
    const route = createMcpsInteractionRoute({
      ...dependencies(calls),
      resolveScope: async () => {
        calls.push("load");
        return null;
      },
    });
    const interaction = {
      customId: "mcps:v1:refresh:en-US:1",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["refresh", "en-US", "1"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
  });

  it("acknowledges modal submission before loading, validating, testing, or writing", async () => {
    const calls: string[] = [];
    const route = createMcpsInteractionRoute(dependencies(calls));
    const interaction = {
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: null,
      user: { id: "100" },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async () => calls.push("editReply"),
      fields: { getTextInputValue: () => "value" },
    } as unknown as ModalSubmitInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "add", "load-fresh", "editReply"]);
  });

  it("reads nonce-bounded Add fields and returns failures to the collection without echoing secrets", async () => {
    const calls: string[] = [];
    let payload = "";
    const base = dependencies(calls);
    const route = createMcpsInteractionRoute({
      ...base,
      takeServerType: () => "web_search",
      operations: {
        ...base.operations,
        add: async (input) => {
          calls.push("add");
          expect(input.serverType).toBe("web_search");
          expect(input.authToken).toBe("disposable-secret");
          return { status: "connection-failed", error: "Connection rejected" };
        },
      },
    });
    const values: Record<string, string> = {
      name_12345678: "search",
      url_12345678: "https://example.com/mcp",
      "auth-token_12345678": "disposable-secret",
    };
    const interaction = {
      id: "submit-1",
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: null,
      user: { id: "100" },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = JSON.stringify(nextPayload);
      },
      fields: { getTextInputValue: (id: string) => values[id] ?? "" },
    } as unknown as ModalSubmitInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "add", "load-fresh", "editReply"]);
    expect(payload).toContain("MCP server was not added");
    expect(payload).toContain("Connection rejected");
    expect(payload).toContain("search");
    expect(payload).not.toContain("disposable-secret");
    expect(payload).not.toContain("server-type_12345678");
  });

  it("rejects a routed Add submission when its required raw server type is missing", async () => {
    const calls: string[] = [];
    const base = dependencies(calls);
    const route = createMcpsInteractionRoute({
      ...base,
      takeServerType: () => undefined,
      operations: {
        ...base.operations,
        add: async (input) => {
          calls.push("add");
          expect(input.serverType).toBe("missing-required-type");
          return { status: "invalid-type" };
        },
      },
    });
    let payload = "";
    const interaction = {
      id: "submit-missing-type",
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: null,
      user: { id: "100" },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = JSON.stringify(nextPayload);
      },
      fields: { getTextInputValue: () => "value" },
    } as unknown as ModalSubmitInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "add", "load-fresh", "editReply"]);
    expect(payload).toContain("Choose a supported MCP server type");
  });

  it("renders bounded, individually coded untrusted tool names in a separate Add success receipt", async () => {
    const calls: string[] = [];
    const base = dependencies(calls);
    const route = createMcpsInteractionRoute({
      ...base,
      operations: {
        ...base.operations,
        add: async () => {
          calls.push("add");
          return {
            status: "success",
            row: configuredRow(),
            test: {
              success: true,
              toolCount: 7,
              functionNames: [
                "read_wiki",
                "`open`\nrepo\u0000",
                "*danger*",
                "long_".repeat(20),
                "five",
                "six-hidden",
                "seven-hidden",
              ],
            },
          };
        },
      },
    });
    let payload: unknown;
    const interaction = {
      id: "submit-tools",
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: null,
      user: { id: "100" },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = nextPayload;
      },
      fields: { getTextInputValue: () => "value" },
    } as unknown as ModalSubmitInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    const typedPayload = payload as {
      components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
    };
    expect(typedPayload.components).toHaveLength(2);
    expect(typedPayload.components[0]?.accentColor).toBe(0x57f287);
    const content = typedPayload.components[0]?.components?.[0]?.content ?? "";
    expect(content).toContain("discovered 7 tool(s)");
    const toolList = content.split("Tools: ")[1] ?? "";
    expect(toolList).toContain("`read_wiki`, `'open' repo`, `*danger*`");
    expect(toolList.match(/`[^`]*`/g)).toHaveLength(5);
    expect(toolList).toEndWith(", …");
    expect(toolList).not.toContain("six-hidden");
    expect(
      Array.from(toolList).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
      }),
    ).toBe(true);
    expect(toolList.length).toBeLessThanOrEqual(180);
    expect(JSON.stringify(typedPayload.components[1])).toContain("mcps:v1:set-enabled:en-US:1:0");
  });

  it("accepts issued select and range routes as read-only compatibility repaints", async () => {
    for (const [action, values] of [
      ["select", ["1"]],
      ["range", []],
    ] as const) {
      const calls: string[] = [];
      const route = createMcpsInteractionRoute(dependencies(calls));
      let payload = "";
      const interaction = {
        customId: `mcps:v1:${action}:en-US:0`,
        guildId: null,
        user: { id: "100" },
        values,
        isButton: () => action === "range",
        isStringSelectMenu: () => action === "select",
        isModalSubmit: () => false,
        deferUpdate: async () => calls.push("deferUpdate"),
        editReply: async (nextPayload: unknown) => {
          calls.push("editReply");
          payload = JSON.stringify(nextPayload);
        },
      } as unknown as ButtonInteraction & StringSelectMenuInteraction;
      await route.execute({} as Client, interaction, {
        namespace: "mcps",
        version: "v1",
        segments: [action, "en-US", "0"],
      });
      expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
      expect(payload).toContain("mcps:v1:set-enabled:en-US:1:0");
      expect(payload).not.toContain("mcps:v1:select");
      expect(payload).not.toContain("mcps:v1:range");
    }
  });

  it("does not turn an absent Remove prompt ID into confirmation for a current row", async () => {
    const calls: string[] = [];
    let payload = "";
    const route = createMcpsInteractionRoute(dependencies(calls));
    const interaction = {
      customId: "mcps:v1:remove-prompt:en-US:999",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = JSON.stringify(nextPayload);
      },
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["remove-prompt", "en-US", "999"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
    expect(payload).toContain("That registration no longer exists");
    expect(payload).toContain("mcps:v1:remove-prompt:en-US:1");
    expect(payload).not.toContain("mcps:v1:remove-confirm:en-US:1");
  });

  it("does not claim an absent Remove target when the read is stale", async () => {
    const calls: string[] = [];
    let payload = "";
    const route = createMcpsInteractionRoute({
      ...dependencies(calls),
      resolveScope: async () => {
        calls.push("load");
        return {
          discordId: "100",
          kind: "dm",
          state: { server_id: 10 } as never,
          read: { status: "stale", configs: [configuredRow()] },
        };
      },
    });
    const interaction = {
      customId: "mcps:v1:remove-prompt:en-US:999",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = JSON.stringify(nextPayload);
      },
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["remove-prompt", "en-US", "999"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "editReply"]);
    expect(payload).toContain("Saved data may be out of date");
    expect(payload).not.toContain("That registration no longer exists");
    expect(payload).not.toContain("mcps:v1:remove-confirm");
  });

  it("renders successful mutation reload failure as unavailable instead of fresh pre-write state", async () => {
    const calls: string[] = [];
    let payload = "";
    let loadCount = 0;
    const route = createMcpsInteractionRoute({
      ...dependencies(calls),
      resolveScope: async (_interaction, forceRefresh) => {
        calls.push(forceRefresh ? "load-fresh" : "load");
        loadCount++;
        if (loadCount > 1) return null;
        return {
          discordId: "100",
          kind: "dm",
          state: { server_id: 10 } as never,
          read: { status: "fresh", configs: [configuredRow()] },
        };
      },
    });
    const interaction = {
      customId: "mcps:v1:set-enabled:en-US:1:0",
      guildId: null,
      user: { id: "100" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => calls.push("deferUpdate"),
      editReply: async (nextPayload: unknown) => {
        calls.push("editReply");
        payload = JSON.stringify(nextPayload);
      },
    } as unknown as ButtonInteraction;
    await route.execute({} as Client, interaction, {
      namespace: "mcps",
      version: "v1",
      segments: ["set-enabled", "en-US", "1", "0"],
    });
    expect(calls).toEqual(["deferUpdate", "load", "set-enabled", "load-fresh", "editReply"]);
    expect(payload).toContain("MCP server disabled");
    expect(payload).toContain("registrations could not be loaded");
    expect(payload).not.toContain("Configured state");
    expect(payload).not.toContain("mcps:v1:set-enabled");
  });

  it("acknowledges enable and remove writes before resolving current scope", async () => {
    for (const [action, extra, write] of [
      ["set-enabled", ["1", "0"], "set-enabled"],
      ["remove-confirm", ["1"], "remove"],
    ] as const) {
      const calls: string[] = [];
      const route = createMcpsInteractionRoute(dependencies(calls));
      const interaction = {
        customId: `mcps:v1:${action}:en-US:${extra.join(":")}`,
        guildId: null,
        user: { id: "100" },
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        deferUpdate: async () => calls.push("deferUpdate"),
        editReply: async () => calls.push("editReply"),
      } as unknown as ButtonInteraction;
      await route.execute({} as Client, interaction, {
        namespace: "mcps",
        version: "v1",
        segments: [action, "en-US", ...extra],
      });
      expect(calls[0]).toBe("deferUpdate");
      expect(calls.indexOf(write)).toBeGreaterThan(calls.indexOf("load"));
      expect(calls.indexOf("load")).toBeGreaterThan(calls.indexOf("deferUpdate"));
    }
  });

  it("records panel_action telemetry on success and skips telemetry on failure or unchanged", async () => {
    const recorded: string[] = [];
    const recordAction = (input: { action: string; serverId: number; userDiscId: string }) => {
      recorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
    };

    const addRoute = createMcpsInteractionRoute({
      ...dependencies([], { recordAction }),
      operations: {
        ...dependencies([]).operations,
        add: async () => ({
          status: "success",
          row: configuredRow(),
          test: { success: true, toolCount: 1, functionNames: ["test_tool"] },
        }),
      },
    });
    const addInteraction = {
      customId: "mcps:v1:add-submit:en-US:12345678",
      guildId: null,
      user: { id: "user-123" },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {},
      editReply: async () => {},
      fields: { getTextInputValue: () => "value" },
    } as unknown as ModalSubmitInteraction;
    await addRoute.execute({} as Client, addInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(recorded).toContain("mcps.workspace.server.add:10:user-123");

    const failedRecorded: string[] = [];
    const failedAddRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          failedRecorded.push(input.action);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        add: async () => ({ status: "connection-failed", error: "fail" }),
      },
    });
    await failedAddRoute.execute({} as Client, addInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["add-submit", "en-US", "12345678"],
    });
    expect(failedRecorded.length).toBe(0);

    const enableRecorded: string[] = [];
    const enableRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          enableRecorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        setEnabled: async () => ({ status: "success", row: configuredRow() }),
      },
    });
    const enableInteraction = {
      customId: "mcps:v1:set-enabled:en-US:1:1",
      guildId: null,
      user: { id: "user-123" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;
    await enableRoute.execute({} as Client, enableInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["set-enabled", "en-US", "1", "1"],
    });
    expect(enableRecorded).toContain("mcps.workspace.server.enable:10:user-123");

    const disableRecorded: string[] = [];
    const disableRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          disableRecorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        setEnabled: async () => ({ status: "success", row: configuredRow() }),
      },
    });
    const disableInteraction = {
      customId: "mcps:v1:set-enabled:en-US:1:0",
      guildId: null,
      user: { id: "user-123" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;
    await disableRoute.execute({} as Client, disableInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["set-enabled", "en-US", "1", "0"],
    });
    expect(disableRecorded).toContain("mcps.workspace.server.disable:10:user-123");

    const unchangedRecorded: string[] = [];
    const unchangedRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          unchangedRecorded.push(input.action);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        setEnabled: async () => ({ status: "unchanged", row: configuredRow() }),
      },
    });
    await unchangedRoute.execute({} as Client, enableInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["set-enabled", "en-US", "1", "1"],
    });
    expect(unchangedRecorded.length).toBe(0);

    const removeRecorded: string[] = [];
    const removeRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          removeRecorded.push(`${input.action}:${input.serverId}:${input.userDiscId}`);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        remove: async () => ({ status: "success", row: configuredRow() }),
      },
    });
    const removeInteraction = {
      customId: "mcps:v1:remove-confirm:en-US:1",
      guildId: null,
      user: { id: "user-123" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;
    await removeRoute.execute({} as Client, removeInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["remove-confirm", "en-US", "1"],
    });
    expect(removeRecorded).toContain("mcps.workspace.server.remove:10:user-123");

    const notFoundRecorded: string[] = [];
    const notFoundRemoveRoute = createMcpsInteractionRoute({
      ...dependencies([], {
        recordAction: (input) => {
          notFoundRecorded.push(input.action);
        },
      }),
      operations: {
        ...dependencies([]).operations,
        remove: async () => ({ status: "not-found" }),
      },
    });
    await notFoundRemoveRoute.execute({} as Client, removeInteraction, {
      namespace: "mcps",
      version: "v1",
      segments: ["remove-confirm", "en-US", "1"],
    });
    expect(notFoundRecorded.length).toBe(0);
  });
});
