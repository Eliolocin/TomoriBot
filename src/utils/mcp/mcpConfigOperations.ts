import type { GuildMcpServerRow } from "@/types/db/schema";
import { getGuildMcpConfigReadResult, type GuildMcpConfigReadResult } from "@/utils/cache/guildMcpConfigCache";
import { toolRepository } from "@/utils/db/repositories/ToolRepository";
import { getGuildMcpManager } from "@/utils/mcp/guildMcpManager";
import { normalizeMcpToolNameSnapshot } from "@/utils/mcp/mcpToolSnapshot";
import { type RemoteUrlValidationResult, validateRemoteUrl } from "@/utils/security/remoteUrlSecurity";

export const MAX_MCP_SERVERS_PER_WORKSPACE = Number(process.env.MAX_MCP_SERVERS_PER_GUILD) || 5;
export const MCP_SERVER_TYPES = ["general", "web_search", "url_fetcher"] as const;
export type McpServerType = (typeof MCP_SERVER_TYPES)[number];

const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/;

export interface McpConnectionTestResult {
  success: boolean;
  toolCount: number;
  functionNames: string[];
  error?: string;
}

export interface McpConfigOperationDependencies {
  read(serverId: number, options?: { forceRefresh?: boolean }): Promise<GuildMcpConfigReadResult>;
  validateUrl(url: string): Promise<RemoteUrlValidationResult>;
  testConnection(url: string, authToken?: string): Promise<McpConnectionTestResult>;
  insert(
    serverId: number,
    name: string,
    url: string,
    authToken: string | undefined,
    serverType: string | null,
    lastDiscoveredToolNames: readonly string[],
    serverDiscId: string,
  ): Promise<GuildMcpServerRow | null>;
  updateEnabled(serverId: number, guildMcpId: number, enabled: boolean, serverDiscId: string): Promise<boolean>;
  remove(serverId: number, guildMcpId: number, serverDiscId: string): Promise<boolean>;
  disconnect(serverId: number, name: string): Promise<void>;
}

export type AddMcpResult =
  | { status: "success"; row: GuildMcpServerRow; test: McpConnectionTestResult }
  | { status: "invalid-input" }
  | { status: "invalid-name" }
  | { status: "invalid-type" }
  | { status: "invalid-url"; validation: RemoteUrlValidationResult }
  | { status: "unavailable" }
  | { status: "limit-reached"; max: number }
  | { status: "connection-failed"; error: string }
  | { status: "duplicate-or-write-failed"; name: string };

export type McpMutationResult =
  | { status: "success"; row: GuildMcpServerRow }
  | { status: "unchanged"; row: GuildMcpServerRow }
  | { status: "not-found" }
  | { status: "unavailable" }
  | { status: "write-failed"; row: GuildMcpServerRow };

function requireStableId(row: GuildMcpServerRow): number | null {
  const id = row.guild_mcp_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function normalizeMcpName(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

export function isValidMcpName(value: string): boolean {
  return MCP_NAME_PATTERN.test(value);
}

export function parseMcpServerType(value: string | null | undefined): McpServerType | null {
  if (!value || value === "none" || value === "general") return "general";
  return value === "web_search" || value === "url_fetcher" ? value : null;
}

export function toStoredMcpServerType(value: McpServerType): string | null {
  return value === "general" ? null : value;
}

export function safeMcpEndpoint(url: string): string | null {
  try {
    const parsed = new URL(url);
    const defaultPort =
      (parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80");
    return `${parsed.protocol}//${parsed.hostname}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

export function sanitizeMcpConnectionError(error: string, submittedUrl: string, authToken?: string): string {
  let sanitized = error;
  if (authToken) sanitized = sanitized.split(authToken).join("[redacted]");
  sanitized = sanitized.split(submittedUrl).join(safeMcpEndpoint(submittedUrl) ?? "[redacted URL]");
  try {
    const parsed = new URL(submittedUrl);
    for (const secret of [parsed.username, parsed.password, parsed.search]) {
      if (secret) sanitized = sanitized.split(secret).join("[redacted]");
    }
  } catch {}
  return sanitized.slice(0, 500);
}

export class McpConfigOperations {
  public constructor(private readonly dependencies: McpConfigOperationDependencies) {}

  public async add(input: {
    serverId: number;
    serverDiscId: string;
    name: string;
    url: string;
    authToken?: string;
    serverType?: string | null;
  }): Promise<AddMcpResult> {
    const name = normalizeMcpName(input.name);
    const url = input.url.trim();
    const authToken = input.authToken?.trim() || undefined;
    if (!name || !url || url.length > 500 || (authToken?.length ?? 0) > 500) return { status: "invalid-input" };
    if (!isValidMcpName(name)) return { status: "invalid-name" };

    const serverType = parseMcpServerType(input.serverType);
    if (!serverType) return { status: "invalid-type" };

    const current = await this.dependencies.read(input.serverId, { forceRefresh: true });
    if (current.status !== "fresh") return { status: "unavailable" };
    if (current.configs.length >= MAX_MCP_SERVERS_PER_WORKSPACE) {
      return { status: "limit-reached", max: MAX_MCP_SERVERS_PER_WORKSPACE };
    }

    const validation = await this.dependencies.validateUrl(url);
    if (!validation.valid) return { status: "invalid-url", validation };

    const test = await this.dependencies.testConnection(url, authToken);
    if (!test.success) {
      return {
        status: "connection-failed",
        error: sanitizeMcpConnectionError(test.error ?? "Unknown error", url, authToken),
      };
    }

    const row = await this.dependencies.insert(
      input.serverId,
      name,
      url,
      authToken,
      toStoredMcpServerType(serverType),
      normalizeMcpToolNameSnapshot(test.functionNames),
      input.serverDiscId,
    );
    return row ? { status: "success", row, test } : { status: "duplicate-or-write-failed", name };
  }

  public async setEnabled(input: {
    serverId: number;
    serverDiscId: string;
    guildMcpId: number;
    enabled: boolean;
  }): Promise<McpMutationResult> {
    const row = await this.resolveCurrentRow(input.serverId, input.guildMcpId);
    if (row.status !== "success") return row;
    if (row.row.is_enabled === input.enabled) return { status: "unchanged", row: row.row };

    const updated = await this.dependencies.updateEnabled(
      input.serverId,
      input.guildMcpId,
      input.enabled,
      input.serverDiscId,
    );
    if (!updated) return { status: "write-failed", row: row.row };
    if (!input.enabled) await this.dependencies.disconnect(input.serverId, row.row.name);
    return { status: "success", row: { ...row.row, is_enabled: input.enabled } };
  }

  public async remove(input: {
    serverId: number;
    serverDiscId: string;
    guildMcpId: number;
  }): Promise<McpMutationResult> {
    const row = await this.resolveCurrentRow(input.serverId, input.guildMcpId);
    if (row.status !== "success") return row;
    const removed = await this.dependencies.remove(input.serverId, input.guildMcpId, input.serverDiscId);
    if (!removed) return { status: "write-failed", row: row.row };
    await this.dependencies.disconnect(input.serverId, row.row.name);
    return { status: "success", row: row.row };
  }

  private async resolveCurrentRow(
    serverId: number,
    guildMcpId: number,
  ): Promise<{ status: "success"; row: GuildMcpServerRow } | { status: "not-found" } | { status: "unavailable" }> {
    if (!Number.isSafeInteger(guildMcpId) || guildMcpId <= 0) return { status: "not-found" };
    const current = await this.dependencies.read(serverId, { forceRefresh: true });
    if (current.status !== "fresh") return { status: "unavailable" };
    const row = current.configs.find((candidate) => requireStableId(candidate) === guildMcpId);
    return row ? { status: "success", row } : { status: "not-found" };
  }
}

export const mcpConfigOperations = new McpConfigOperations({
  read: getGuildMcpConfigReadResult,
  validateUrl: validateRemoteUrl,
  testConnection: (url, authToken) => getGuildMcpManager().testConnection(url, authToken),
  insert: (serverId, name, url, authToken, serverType, lastDiscoveredToolNames, serverDiscId) =>
    toolRepository.insertMcpServer(serverId, name, url, authToken, serverType, lastDiscoveredToolNames, serverDiscId),
  updateEnabled: (serverId, guildMcpId, enabled, serverDiscId) =>
    toolRepository.updateMcpServerEnabledById(serverId, guildMcpId, enabled, serverDiscId),
  remove: (serverId, guildMcpId, serverDiscId) =>
    toolRepository.deleteMcpServerById(serverId, guildMcpId, serverDiscId),
  disconnect: (serverId, name) => getGuildMcpManager().disconnectGuildServer(serverId, name),
});
