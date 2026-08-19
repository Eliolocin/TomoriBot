/**
 * McpRepository: manages the `guild_mcp_servers` table.
 *
 * MCP guild config is a distinct integration domain (guild-registered MCP tool servers).
 * Currently one SQL operation (SELECT); isolated here so MCP config management
 * can grow without blurring server-identity concerns in ServerRepository.
 *
 * Export contract: toExportShape returns null: MCP server registrations contain
 * server-specific auth tokens and are not portably exportable.
 */
import type { GuildMcpServerRow } from "@/types/db/schema";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import type { IRepository } from "./IRepository";

export type McpConfigRepositoryReadResult =
  | { status: "fresh"; configs: GuildMcpServerRow[] }
  | { status: "unavailable"; configs: [] };

class McpRepository implements IRepository<null> {
  /**
   * Load all MCP server configs registered for a guild (enabled and disabled).
   * Callers that need only enabled entries should filter in-memory.
   *
   * @param serverId - Internal server DB ID (FK to servers table)
   * @returns Array of GuildMcpServerRow ordered by creation date; empty on error
   */
  async loadGuildMcpConfigs(serverId: number): Promise<GuildMcpServerRow[]> {
    const result = await this.loadGuildMcpConfigsResult(serverId);
    return result.configs;
  }

  /**
   * Loads MCP registrations without collapsing a database failure into an
   * authoritative empty collection.
   */
  async loadGuildMcpConfigsResult(serverId: number): Promise<McpConfigRepositoryReadResult> {
    try {
      const rows = await sql`
        SELECT guild_mcp_id, server_id, name, url, auth_token, key_version,
               is_enabled, server_type, last_discovered_tool_names, created_at, updated_at
        FROM guild_mcp_servers
        WHERE server_id = ${serverId}
        ORDER BY created_at ASC
      `;
      return { status: "fresh", configs: rows as GuildMcpServerRow[] };
    } catch (error) {
      log.error(`McpRepository.loadGuildMcpConfigs: failed for server ${serverId}`, error);
      return { status: "unavailable", configs: [] };
    }
  }

  async toExportShape(_ownerId: string | number): Promise<null> {
    return null;
  }

  async fromExportShape(_ownerId: string | number, _data: null): Promise<boolean> {
    return true;
  }
}

/** Singleton instance: import this in callers. */
export const mcpRepository = new McpRepository();
