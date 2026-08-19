ALTER TABLE guild_mcp_servers
ADD COLUMN IF NOT EXISTS last_discovered_tool_names TEXT[];

COMMENT ON COLUMN guild_mcp_servers.last_discovered_tool_names IS
  'Bounded display-only names from the last successful tool discovery; NULL means unknown';
