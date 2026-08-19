import { describe, expect, it } from "bun:test";
import type { GuildMcpServerRow } from "@/types/db/schema";
import { GuildMcpConfigCache } from "@/utils/cache/guildMcpConfigCache";

function row(id: number): GuildMcpServerRow {
  return {
    guild_mcp_id: id,
    server_id: 10,
    name: `server-${id}`,
    url: "https://example.com/mcp",
    auth_token: null,
    key_version: 1,
    is_enabled: true,
    server_type: null,
  };
}

describe("guild MCP config cache read provenance", () => {
  it("returns an authoritative fresh empty collection", async () => {
    let loads = 0;
    const cache = new GuildMcpConfigCache(async () => {
      loads++;
      return { status: "fresh", configs: [] };
    });

    expect(await cache.read(10)).toEqual({ status: "fresh", configs: [] });
    expect(await cache.read(10)).toEqual({ status: "fresh", configs: [] });
    expect(loads).toBe(1);
  });

  it("returns and retains stale cached rows after a failed forced refresh", async () => {
    let available = true;
    const cachedRow = row(1);
    const cache = new GuildMcpConfigCache(async () =>
      available ? { status: "fresh", configs: [cachedRow] } : { status: "unavailable", configs: [] },
    );

    expect(await cache.read(10)).toEqual({ status: "fresh", configs: [cachedRow] });
    available = false;
    expect(await cache.read(10, { forceRefresh: true })).toEqual({ status: "stale", configs: [cachedRow] });
    expect(await cache.read(10)).toEqual({ status: "stale", configs: [cachedRow] });
    available = true;
    expect(await cache.read(10, { forceRefresh: true })).toEqual({ status: "fresh", configs: [cachedRow] });
  });

  it("returns unavailable when a failed read has no cached rows", async () => {
    const cache = new GuildMcpConfigCache(async () => ({ status: "unavailable", configs: [] }));
    expect(await cache.read(10)).toEqual({ status: "unavailable", configs: [] });
  });
});
