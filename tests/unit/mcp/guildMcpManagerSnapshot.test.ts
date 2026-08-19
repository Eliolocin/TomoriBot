import { describe, expect, it, spyOn } from "bun:test";
import type { GuildMcpServerRow } from "@/types/db/schema";
import type { GuildMCPConnection } from "@/types/tool/mcpTypes";
import { toolRepository } from "@/utils/db/repositories/ToolRepository";
import { getGuildMcpManager } from "@/utils/mcp/guildMcpManager";
import { log } from "@/utils/misc/logger";

interface TestableGuildMcpManager {
  connectServer(config: GuildMcpServerRow): Promise<GuildMCPConnection | null>;
  connectWithFallback(...args: unknown[]): Promise<unknown>;
  disconnectGuildServer(serverId: number, name: string): Promise<void>;
}

function config(id: number, name: string): GuildMcpServerRow {
  return {
    guild_mcp_id: id,
    server_id: 42,
    name,
    url: "https://example.com/mcp",
    auth_token: null,
    key_version: 1,
    is_enabled: true,
    server_type: null,
    last_discovered_tool_names: ["prior_tool"],
  };
}

describe("guild MCP lazy discovery snapshots", () => {
  it("returns the live connection before detached snapshot persistence settles", async () => {
    const manager = getGuildMcpManager() as unknown as TestableGuildMcpManager;
    const row = config(900, "snapshot-refresh-detached");
    const closeCalls: string[] = [];
    const client = {
      listTools: async () => ({ tools: [{ name: "read_wiki" }, { name: "open_repo" }] }),
      close: async () => closeCalls.push("close"),
    };
    let rejectSnapshot!: (reason?: unknown) => void;
    const pendingSnapshot = new Promise<"updated">((_, reject) => {
      rejectSnapshot = reject;
    });
    const decryptSpy = spyOn(toolRepository, "decryptMcpAuthToken").mockResolvedValue(null);
    const updateSpy = spyOn(toolRepository, "updateMcpToolNameSnapshot").mockReturnValue(pendingSnapshot);
    const connectSpy = spyOn(manager, "connectWithFallback").mockResolvedValue(client);
    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});

    try {
      const result = await Promise.race([
        manager.connectServer(row),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]);
      expect(result).not.toBe("blocked");
      expect(result).not.toBeNull();
      if (result === "blocked" || result === null) throw new Error("Expected a live MCP connection");
      expect(result.functionNames).toEqual(["read_wiki", "open_repo"]);
      expect(updateSpy).toHaveBeenCalledWith(42, 900, ["read_wiki", "open_repo"]);
      expect(closeCalls).toEqual([]);

      rejectSnapshot(new Error("metadata persistence secret marker"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(closeCalls).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[GuildMcpManager] Tool-name snapshot refresh threw for MCP server ID 900 " +
          "on server 42; keeping the live connection",
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("secret marker");
    } finally {
      await manager.disconnectGuildServer(42, row.name);
      decryptSpy.mockRestore();
      updateSpy.mockRestore();
      connectSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("keeps the live connection when the best-effort snapshot refresh fails", async () => {
    const manager = getGuildMcpManager() as unknown as TestableGuildMcpManager;
    const row = config(901, "snapshot-refresh-failure");
    const closeCalls: string[] = [];
    const client = {
      listTools: async () => ({ tools: [{ name: "read_wiki" }, { name: "open_repo" }] }),
      close: async () => closeCalls.push("close"),
    };
    const decryptSpy = spyOn(toolRepository, "decryptMcpAuthToken").mockResolvedValue(null);
    const updateSpy = spyOn(toolRepository, "updateMcpToolNameSnapshot").mockResolvedValue("failed");
    const connectSpy = spyOn(manager, "connectWithFallback").mockResolvedValue(client);

    try {
      const connection = await manager.connectServer(row);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(connection?.guildMcpId).toBe(901);
      expect(connection?.functionNames).toEqual(["read_wiki", "open_repo"]);
      expect(updateSpy).toHaveBeenCalledWith(42, 901, ["read_wiki", "open_repo"]);
      expect(closeCalls).toEqual([]);
    } finally {
      await manager.disconnectGuildServer(42, row.name);
      decryptSpy.mockRestore();
      updateSpy.mockRestore();
      connectSpy.mockRestore();
    }
  });

  it("retains the previous snapshot when live tool discovery fails", async () => {
    const manager = getGuildMcpManager() as unknown as TestableGuildMcpManager;
    const row = config(902, "snapshot-discovery-failure");
    const client = {
      listTools: async () => {
        throw new Error("discovery failed");
      },
      close: async () => {},
    };
    const decryptSpy = spyOn(toolRepository, "decryptMcpAuthToken").mockResolvedValue(null);
    const updateSpy = spyOn(toolRepository, "updateMcpToolNameSnapshot");
    const connectSpy = spyOn(manager, "connectWithFallback").mockResolvedValue(client);

    try {
      expect(await manager.connectServer(row)).toBeNull();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(row.last_discovered_tool_names).toEqual(["prior_tool"]);
    } finally {
      await manager.disconnectGuildServer(42, row.name);
      decryptSpy.mockRestore();
      updateSpy.mockRestore();
      connectSpy.mockRestore();
    }
  });
});
