/**
 * Regression harness: ToolRepository + RagRepository domains.
 *
 * ToolRepository: MCP server config, guild MCP reads.
 * RagRepository: RAG availability detection (schema-level, no pgvector assumed).
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  clearGuildMcpConfigCache,
  getCachedGuildMcpConfigs,
  getGuildMcpConfigCacheStats,
} from "@/utils/cache/guildMcpConfigCache";
import { mcpRepository, toolRepository } from "@/utils/db/repositories";
import { cache as tomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { cleanupFixtures, FIXTURE_IDS, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

describe.skipIf(!DB_TESTS_AVAILABLE)("Tool — regression", () => {
  let refs: FixtureRefs;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
  });

  afterAll(async () => {
    await cleanupFixtures(testSql);
  });

  // getBraveApiKeyStatus is representative of the ToolRepository read path.

  it("getBraveApiKeyStatus reflects brave-search key rows", async () => {
    const hasKey = await toolRepository.getBraveApiKeyStatus(refs.serverId);
    expect(hasKey).toBe(false);

    await testSql`
      INSERT INTO opt_api_keys (server_id, service_name, api_key)
      VALUES (${refs.serverId}, 'brave-search', decode('01', 'hex'))
      ON CONFLICT (server_id, service_name)
      DO UPDATE SET api_key = EXCLUDED.api_key
    `;

    const hasInsertedKey = await toolRepository.getBraveApiKeyStatus(refs.serverId);
    expect(hasInsertedKey).toBe(true);
  });

  // guildMcpDb.ts reads from mcp_server_configs; no config means empty result.

  it("guild MCP config read returns inserted config rows", async () => {
    const beforeInsert = await mcpRepository.loadGuildMcpConfigs(refs.serverId);
    expect(beforeInsert).toEqual([]);

    await testSql`
      INSERT INTO guild_mcp_servers (server_id, name, url, is_enabled, server_type)
      VALUES (${refs.serverId}, '_rt_mcp_search', 'https://mcp.example.invalid/sse', false, 'web_search')
    `;

    const configs = await mcpRepository.loadGuildMcpConfigs(refs.serverId);
    const stableShape = configs.map(
      ({ server_id, name, url, auth_token, key_version, is_enabled, server_type, last_discovered_tool_names }) => ({
        server_id,
        name,
        url,
        auth_token,
        key_version,
        is_enabled,
        server_type,
        last_discovered_tool_names,
      }),
    );

    expect(typeof configs[0]?.guild_mcp_id).toBe("number");
    expect(stableShape).toEqual([
      {
        server_id: refs.serverId,
        name: "_rt_mcp_search",
        url: "https://mcp.example.invalid/sse",
        auth_token: null,
        key_version: 1,
        is_enabled: false,
        server_type: "web_search",
        last_discovered_tool_names: null,
      },
    ]);

    const guildMcpId = configs[0]?.guild_mcp_id;
    expect(typeof guildMcpId).toBe("number");
    if (typeof guildMcpId !== "number") throw new Error("Expected a stable MCP registration ID");

    clearGuildMcpConfigCache();
    expect((await getCachedGuildMcpConfigs(refs.serverId))[0]?.is_enabled).toBe(false);
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(1);
    tomoriStateCache.set(FIXTURE_IDS.serverDiscId, {
      personas: [],
      mainPersona: {} as never,
      cachedAt: Date.now(),
    });
    expect(await toolRepository.updateMcpToolNameSnapshot(refs.serverId + 1, guildMcpId, ["wrong-scope"])).toBe(
      "not-found",
    );
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(1);
    expect(await toolRepository.updateMcpToolNameSnapshot(refs.serverId, guildMcpId, [" read\nwiki\u0000 "])).toBe(
      "updated",
    );
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(0);
    expect(tomoriStateCache.has(FIXTURE_IDS.serverDiscId)).toBe(true);
    expect((await getCachedGuildMcpConfigs(refs.serverId))[0]?.last_discovered_tool_names).toEqual(["read wiki"]);
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(1);
    expect(await toolRepository.updateMcpToolNameSnapshot(refs.serverId, guildMcpId, ["read wiki"])).toBe("unchanged");
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(1);
    expect(
      await toolRepository.updateMcpServerEnabledById(refs.serverId + 1, guildMcpId, true, FIXTURE_IDS.serverDiscId),
    ).toBe(false);
    expect(await toolRepository.deleteMcpServerById(refs.serverId + 1, guildMcpId, FIXTURE_IDS.serverDiscId)).toBe(
      false,
    );
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(1);
    expect(
      await toolRepository.updateMcpServerEnabledById(refs.serverId, guildMcpId, true, FIXTURE_IDS.serverDiscId),
    ).toBe(true);
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(0);
    expect((await getCachedGuildMcpConfigs(refs.serverId))[0]?.is_enabled).toBe(true);
    expect(await toolRepository.deleteMcpServerById(refs.serverId, guildMcpId, FIXTURE_IDS.serverDiscId)).toBe(true);
    expect(getGuildMcpConfigCacheStats().cacheSize).toBe(0);
    expect(await getCachedGuildMcpConfigs(refs.serverId)).toEqual([]);
  });

  it("inserts known-zero and authenticated discovery snapshots atomically", async () => {
    const zero = await toolRepository.insertMcpServer(
      refs.serverId,
      "rt-mcp-zero",
      "https://zero.example.invalid/mcp",
      undefined,
      null,
      [],
      FIXTURE_IDS.serverDiscId,
    );
    expect(zero?.last_discovered_tool_names).toEqual([]);
    expect(zero?.auth_token).toBeNull();

    const authenticated = await toolRepository.insertMcpServer(
      refs.serverId,
      "rt-mcp-auth",
      "https://auth.example.invalid/mcp",
      "disposable-test-secret",
      "url_fetcher",
      [" read\nwiki\u0000 ", "`open_repo`"],
      FIXTURE_IDS.serverDiscId,
    );
    expect(authenticated?.last_discovered_tool_names).toEqual(["read wiki", "`open_repo`"]);
    expect(authenticated?.auth_token).toBeInstanceOf(Buffer);
    if (!authenticated) throw new Error("Expected authenticated MCP registration insert");
    expect(await toolRepository.decryptMcpAuthToken(authenticated)).toBe("disposable-test-secret");
    expect(await mcpRepository.toExportShape(refs.serverId)).toBeNull();
    expect(await toolRepository.toExportShape(FIXTURE_IDS.serverDiscId)).toEqual({
      server_disc_id: FIXTURE_IDS.serverDiscId,
      mcp_servers: [],
    });
  });

  it("does not refresh a same-name recreation through an obsolete stable ID", async () => {
    const [original] = await testSql`
      INSERT INTO guild_mcp_servers (server_id, name, url)
      VALUES (${refs.serverId}, 'rt-mcp-recreated', 'https://old.example.invalid/mcp')
      RETURNING guild_mcp_id
    `;
    const originalId = Number(original?.guild_mcp_id);
    await testSql`DELETE FROM guild_mcp_servers WHERE server_id = ${refs.serverId} AND guild_mcp_id = ${originalId}`;
    const [replacement] = await testSql`
      INSERT INTO guild_mcp_servers (server_id, name, url)
      VALUES (${refs.serverId}, 'rt-mcp-recreated', 'https://new.example.invalid/mcp')
      RETURNING guild_mcp_id
    `;
    expect(Number(replacement?.guild_mcp_id)).not.toBe(originalId);
    expect(await toolRepository.updateMcpToolNameSnapshot(refs.serverId, originalId, ["stale_tool"])).toBe("not-found");
    const [current] = await testSql`
      SELECT last_discovered_tool_names
      FROM guild_mcp_servers
      WHERE server_id = ${refs.serverId} AND guild_mcp_id = ${Number(replacement?.guild_mcp_id)}
    `;
    expect(current?.last_discovered_tool_names).toBeNull();
  });
});

describe.skipIf(!DB_TESTS_AVAILABLE)("RAG — regression", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  // detectRagAvailability probes for the pgvector extension; the expected value
  // depends on the local Postgres image, so compare it to the same catalog query.

  it("detectRagAvailability matches pg_available_extensions for vector", async () => {
    const { detectRagAvailability } = await import("@/utils/db/ragAvailability");
    const [row] = await testSql<Array<{ available: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
      ) AS available
    `;
    const available = await detectRagAvailability(testSql);
    expect(available).toBe(Boolean(row?.available));
  });
});
