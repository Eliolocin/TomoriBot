import type { GuildMcpServerRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

function getMcpServerTypeLabel(serverType: string | null | undefined, locale: string): string {
  switch (serverType) {
    case "web_search":
      return localizer(locale, "commands.status.mcp_server_type_web_search");
    case "url_fetcher":
      return localizer(locale, "commands.status.mcp_server_type_url_fetcher");
    default:
      return localizer(locale, "commands.status.mcp_server_type_custom");
  }
}

export function formatMcpServers(servers: GuildMcpServerRow[], locale: string): string {
  if (servers.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return servers
    .map((server, index) => {
      const enabledLabel = server.is_enabled
        ? localizer(locale, "commands.choices.enabled")
        : localizer(locale, "commands.choices.disabled");
      const typeLabel = getMcpServerTypeLabel(server.server_type, locale);
      const authLabel = server.auth_token
        ? localizer(locale, "commands.status.mcp_server_auth_present")
        : localizer(locale, "commands.status.mcp_server_auth_absent");
      const serverName = server.name.length > 32 ? `${server.name.substring(0, 32)}...` : server.name;
      return `${index + 1}. **${serverName}** · ${enabledLabel} · ${typeLabel} · ${authLabel}`;
    })
    .join("\n");
}
