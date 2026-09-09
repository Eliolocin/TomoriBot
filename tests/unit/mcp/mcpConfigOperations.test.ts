import { describe, expect, it } from "bun:test";
import type { GuildMcpServerRow } from "@/types/db/schema";
import {
  MAX_MCP_SERVERS_PER_WORKSPACE,
  McpConfigOperations,
  isValidMcpName,
  normalizeMcpName,
  parseMcpServerType,
  sanitizeMcpConnectionError,
  type McpConfigOperationDependencies,
} from "@/utils/mcp/mcpConfigOperations";

function existingRow(id = 1): GuildMcpServerRow {
  return {
    guild_mcp_id: id,
    server_id: 10,
    name: "search",
    url: "https://mcp.example.com/sse",
    auth_token: null,
    key_version: 1,
    is_enabled: true,
    server_type: "web_search",
  };
}

function dependencies(overrides: Partial<McpConfigOperationDependencies> = {}): McpConfigOperationDependencies {
  return {
    read: async () => ({ status: "fresh", configs: [] }),
    validateUrl: async () => ({ valid: true }),
    testConnection: async () => ({ success: true, toolCount: 0, functionNames: [] }),
    insert: async (serverId, name, url) => ({ ...existingRow(2), server_id: serverId, name, url }),
    updateEnabled: async () => true,
    remove: async () => true,
    disconnect: async () => {},
    ...overrides,
  };
}

describe("canonical MCP config operations", () => {
  it("ships the workspace capacity default at ten when no operator override is present", () => {
    if (process.env.MAX_MCP_SERVERS_PER_GUILD === undefined) expect(MAX_MCP_SERVERS_PER_WORKSPACE).toBe(10);
  });

  it("normalizes names and inserts only after URL validation and connection testing", async () => {
    const calls: string[] = [];
    const operations = new McpConfigOperations(
      dependencies({
        validateUrl: async () => {
          calls.push("validate");
          return { valid: true };
        },
        read: async () => {
          calls.push("read");
          return { status: "fresh", configs: [] };
        },
        testConnection: async () => {
          calls.push("test");
          return { success: true, toolCount: 0, functionNames: [] };
        },
        insert: async (serverId, name, url) => {
          calls.push("insert");
          return { ...existingRow(2), server_id: serverId, name, url };
        },
      }),
    );
    const result = await operations.add({
      serverId: 10,
      serverDiscId: "100",
      name: "my server",
      url: "https://mcp.example.com/sse",
      serverType: "general",
    });
    expect(result.status).toBe("success");
    expect(normalizeMcpName(" my   server ")).toBe("my-server");
    expect(calls).toEqual(["read", "validate", "test", "insert"]);
  });

  it("rejects invalid names, server types, URLs, and unavailable or full reads before testing", async () => {
    let tests = 0;
    const base = dependencies({
      validateUrl: async (url) => (url.includes("bad") ? { valid: false, error: "invalid_url" } : { valid: true }),
      testConnection: async () => {
        tests++;
        return { success: true, toolCount: 0, functionNames: [] };
      },
    });
    const operations = new McpConfigOperations(base);
    expect(isValidMcpName(`a${"b".repeat(31)}`)).toBeTrue();
    expect(isValidMcpName(`a${"b".repeat(32)}`)).toBeFalse();
    expect(parseMcpServerType("other")).toBeNull();
    expect(
      (await operations.add({ serverId: 10, serverDiscId: "100", name: "bad_name", url: "https://ok" })).status,
    ).toBe("invalid-name");
    expect(
      (
        await operations.add({
          serverId: 10,
          serverDiscId: "100",
          name: "valid",
          url: `https://example.com/${"x".repeat(500)}`,
        })
      ).status,
    ).toBe("invalid-input");
    expect(
      (
        await operations.add({
          serverId: 10,
          serverDiscId: "100",
          name: "valid",
          url: "https://ok",
          authToken: "x".repeat(501),
        })
      ).status,
    ).toBe("invalid-input");
    expect(
      (
        await operations.add({
          serverId: 10,
          serverDiscId: "100",
          name: "valid",
          url: "https://ok",
          serverType: "other",
        })
      ).status,
    ).toBe("invalid-type");
    expect(
      (await operations.add({ serverId: 10, serverDiscId: "100", name: "valid", url: "https://bad" })).status,
    ).toBe("invalid-url");

    const unavailable = new McpConfigOperations(
      dependencies({ read: async () => ({ status: "unavailable", configs: [] }) }),
    );
    expect(
      (await unavailable.add({ serverId: 10, serverDiscId: "100", name: "valid", url: "https://ok" })).status,
    ).toBe("unavailable");
    const full = new McpConfigOperations(
      dependencies({
        read: async () => ({
          status: "fresh",
          configs: Array.from({ length: MAX_MCP_SERVERS_PER_WORKSPACE }, (_, index) => existingRow(index + 1)),
        }),
      }),
    );
    expect((await full.add({ serverId: 10, serverDiscId: "100", name: "valid", url: "https://ok" })).status).toBe(
      "limit-reached",
    );
    expect(tests).toBe(0);
  });

  it("does not insert after a failed connection test and returns no secret-bearing public fields", async () => {
    let inserts = 0;
    const operations = new McpConfigOperations(
      dependencies({
        testConnection: async () => ({
          success: false,
          toolCount: 0,
          functionNames: [],
          error: "token top-secret rejected at https://u:p@example.com/path?q=secret",
        }),
        insert: async () => {
          inserts++;
          return existingRow();
        },
      }),
    );
    const result = await operations.add({
      serverId: 10,
      serverDiscId: "100",
      name: "valid",
      url: "https://u:p@example.com/path?q=secret",
      authToken: "top-secret",
    });
    expect(result.status).toBe("connection-failed");
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("q=secret");
    expect(inserts).toBe(0);
  });

  it("passes a trimmed auth token only to connection testing and insertion", async () => {
    const seen: Array<string | undefined> = [];
    const operations = new McpConfigOperations(
      dependencies({
        testConnection: async (_url, authToken) => {
          seen.push(authToken);
          return { success: true, toolCount: 0, functionNames: [] };
        },
        insert: async (_serverId, _name, _url, authToken) => {
          seen.push(authToken);
          return existingRow(2);
        },
      }),
    );
    const result = await operations.add({
      serverId: 10,
      serverDiscId: "100",
      name: "valid",
      url: "https://example.com/mcp",
      authToken: "  top-secret  ",
    });
    expect(seen).toEqual(["top-secret", "top-secret"]);
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  it("passes one normalized discovery snapshot into the registration insert", async () => {
    const discovered = [" read\nwiki\u0000 ", "read wiki", "`open_repo`"];
    let insertedSnapshot: readonly string[] | undefined;
    const operations = new McpConfigOperations(
      dependencies({
        testConnection: async () => ({ success: true, toolCount: discovered.length, functionNames: discovered }),
        insert: async (_serverId, _name, _url, _authToken, _serverType, lastDiscoveredToolNames) => {
          insertedSnapshot = lastDiscoveredToolNames;
          return { ...existingRow(2), last_discovered_tool_names: [...lastDiscoveredToolNames] };
        },
      }),
    );

    const result = await operations.add({
      serverId: 10,
      serverDiscId: "100",
      name: "valid",
      url: "https://example.com/mcp",
    });
    expect(result.status).toBe("success");
    expect(insertedSnapshot).toEqual(["read wiki", "`open_repo`"]);
    expect(discovered).toEqual([" read\nwiki\u0000 ", "read wiki", "`open_repo`"]);
  });

  it("writes before disconnecting when disabling or removing", async () => {
    const calls: string[] = [];
    const operations = new McpConfigOperations(
      dependencies({
        read: async () => ({ status: "fresh", configs: [existingRow()] }),
        updateEnabled: async () => {
          calls.push("write-disable");
          return true;
        },
        remove: async () => {
          calls.push("write-remove");
          return true;
        },
        disconnect: async () => calls.push("disconnect"),
      }),
    );
    await operations.setEnabled({ serverId: 10, serverDiscId: "100", guildMcpId: 1, enabled: false });
    await operations.remove({ serverId: 10, serverDiscId: "100", guildMcpId: 1 });
    expect(calls).toEqual(["write-disable", "disconnect", "write-remove", "disconnect"]);
  });

  it("does not disconnect after a failed or stale-ID write", async () => {
    let disconnects = 0;
    const operations = new McpConfigOperations(
      dependencies({
        read: async () => ({ status: "fresh", configs: [existingRow(2)] }),
        updateEnabled: async () => false,
        disconnect: async () => {
          disconnects++;
        },
      }),
    );
    expect(await operations.setEnabled({ serverId: 10, serverDiscId: "100", guildMcpId: 1, enabled: false })).toEqual({
      status: "not-found",
    });
    expect(await operations.remove({ serverId: 10, serverDiscId: "100", guildMcpId: 1 })).toEqual({
      status: "not-found",
    });
    expect(disconnects).toBe(0);

    const failedWrites = new McpConfigOperations(
      dependencies({
        read: async () => ({ status: "fresh", configs: [existingRow(1)] }),
        updateEnabled: async () => false,
        remove: async () => false,
        disconnect: async () => {
          disconnects++;
        },
      }),
    );
    expect(
      (await failedWrites.setEnabled({ serverId: 10, serverDiscId: "100", guildMcpId: 1, enabled: false })).status,
    ).toBe("write-failed");
    expect((await failedWrites.remove({ serverId: 10, serverDiscId: "100", guildMcpId: 1 })).status).toBe(
      "write-failed",
    );
    expect(disconnects).toBe(0);
  });

  it("keeps enabling lazy, treats desired-state repeats as no-ops, and scopes stable IDs through the read", async () => {
    const calls: string[] = [];
    const disabled = existingRow(7);
    disabled.is_enabled = false;
    const operations = new McpConfigOperations(
      dependencies({
        read: async (serverId) => {
          calls.push(`read-${serverId}`);
          return { status: "fresh", configs: serverId === 10 ? [disabled] : [] };
        },
        updateEnabled: async () => {
          calls.push("write");
          return true;
        },
        disconnect: async () => calls.push("disconnect"),
      }),
    );
    expect(
      (await operations.setEnabled({ serverId: 11, serverDiscId: "101", guildMcpId: 7, enabled: true })).status,
    ).toBe("not-found");
    expect(
      (await operations.setEnabled({ serverId: 10, serverDiscId: "100", guildMcpId: 7, enabled: false })).status,
    ).toBe("unchanged");
    expect(
      (await operations.setEnabled({ serverId: 10, serverDiscId: "100", guildMcpId: 7, enabled: true })).status,
    ).toBe("success");
    expect(calls).toEqual(["read-11", "read-10", "read-10", "write"]);
  });

  it("redacts submitted credentials from connection errors", () => {
    const message = sanitizeMcpConnectionError(
      "failed https://alice:pw@example.com/sse?token=abc with top-secret",
      "https://alice:pw@example.com/sse?token=abc",
      "top-secret",
    );
    expect(message).not.toContain("alice");
    expect(message).not.toContain("pw");
    expect(message).not.toContain("token=abc");
    expect(message).not.toContain("top-secret");
  });
});
