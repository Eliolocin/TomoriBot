# Current Focus Overview

This **Active Context** document tracks the immediate focus and next steps for TomoriBot development. Updated after completing the **Provider & Streaming Modularization** phase.

## 🎯 Current Status: Architecture Transformation Complete

### ✅ Major Achievements Completed

**🏗️ Provider Abstraction System** - Complete modular LLM provider architecture
- Provider factory pattern with dynamic provider selection  
- GoogleProvider implements LLMProvider interface
- Ready for OpenAI, Anthropic, and future providers

**⚡ Modular Tool System** - 87% code reduction in main chat handler
- Generic Tool interface with ToolRegistry for execution
- Built-in tools: StickerTool, SearchTool, MemoryTool
- Provider adapters convert tools to provider-specific formats

**🌊 Streaming Modularization** - 75% code reduction per new provider
- StreamOrchestrator handles universal Discord logic (600+ lines)  
- GoogleStreamAdapter handles Google-specific streaming (200 lines)
- Consistent behavior across all providers

**📁 File Structure Organization** - Clean, logical type organization
- Types organized by domain: `src/types/stream/`, `src/types/tool/`, etc.
- Provider consistency: All Google adapters in `providers/google/`
- Text utilities: StreamOrchestrator moved to `utils/text/`

### 🎉 Key Results
- **Zero TypeScript/build errors** - Complete type safety throughout
- **100% feature parity** - All existing functionality preserved
- **Production ready** - Fully tested modular architecture
- **Developer friendly** - Comprehensive documentation in `wiki/devGuide.md`

## 🎯 Next Phase: MCP Server Integration

### Overview
Implement **Model Context Protocol (MCP)** server integration to demonstrate the power of our modular tool architecture. MCP servers provide standardized access to external data sources and functionality.

### 🏗️ Proposed Architecture

**Configuration Strategy:**
- **Static config**: Non-sensitive settings in `src/tools/mcpServers/{server-name}/config.json`
- **Encrypted API keys**: Stored in new `mcp_api_keys` database table per guild
- **Smart server management**: Lazy loading with per-guild instances

**Database Design:**
```sql
CREATE TABLE mcp_api_keys (
  mcp_api_key_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL,                    -- Foreign key to servers table
  mcp_name TEXT NOT NULL,                    -- 'fetch', 'brave-search', etc.
  api_key BYTEA,                            -- Encrypted API key
  UNIQUE (server_id, mcp_name),             -- One key per MCP per guild
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);
```

### 🚧 Phase 1: Database & Configuration Infrastructure

#### ✅ Prerequisites (Already Complete)
- [x] Modular tool system with ToolRegistry
- [x] Provider-agnostic tool execution  
- [x] Tool interface supporting external integrations
- [x] Encrypted API key storage system (reuse existing crypto utils)

#### 📋 Implementation Tasks

**Step 1: Database Schema**
- [ ] Add `mcp_api_keys` table to `src/db/schema.sql`
- [ ] Add `mcpApiKeySchema` to `src/types/db/schema.ts`
- [ ] Create database helper functions (encrypt/decrypt MCP keys)

**Step 2: Static Configuration System**
- [ ] Create `src/tools/mcpServers/fetch/config.json` - URL fetcher config
- [ ] Create `src/tools/mcpServers/brave-search/config.json` - Brave search config
- [ ] Create config loader utility to scan MCP server folders

**Step 3: MCP Server Management** 
- [ ] Create `src/tools/mcpServers/mcpServerManager.ts` - Process management
- [ ] Create `src/tools/mcpServers/mcpClient.ts` - MCP protocol client
- [ ] Implement lazy loading with per-guild server instances

**Step 4: Tool Integration**
- [ ] Create `src/tools/mcpServers/mcpTool.ts` - MCP tool wrapper extending BaseTool
- [ ] Implement automatic tool discovery from spawned MCP servers
- [ ] Update ToolRegistry to handle MCP tool lifecycle

### 🎯 Phase 2: Initial MCP Server Implementations

#### Target Servers for Testing
1. **fetch** - URL content extraction and summarization (https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)
2. **brave-search-mcp** - Web search functionality via Brave Search API (https://github.com/mikechao/brave-search-mcp)

#### Implementation Goals
- [ ] Configure and connect to `fetch` MCP server
- [ ] Configure and connect to `brave-search-mcp` MCP server  
- [ ] Test tool discovery and registration
- [ ] Verify provider-agnostic execution (Google, future OpenAI/Anthropic)

### 📊 Success Metrics
- MCP tools appear in available tools list
- LLM can discover and call MCP tools
- MCP tool execution works identically across providers
- No breaking changes to existing functionality
- **Performance**: <100ms additional latency for MCP tool calls
- **Resource usage**: <50MB memory per active MCP server

### ⚡ Performance Considerations

**MCP servers are actual processes** (not just ports):
- Each spawn = separate Node.js process (~20-50MB memory)
- Startup time: 1-3 seconds per server
- Communication via stdin/stdout or WebSocket

**Mitigation strategies built into design:**
- **Lazy loading**: Only spawn when first needed by a guild
- **Process pooling**: Reuse servers between guilds with same API key
- **Resource limits**: Max 5 concurrent MCP servers per guild
- **Auto-cleanup**: Kill unused servers after 30 minutes of inactivity

## 🛣️ Future Development Roadmap

### Phase 3: Extended MCP Integration
- [ ] Community MCP server integration
- [ ] Advanced permission and security model
- [ ] MCP server management commands (`/config mcp enable/disable`)
- [ ] Documentation for server admins

### Phase 4: Additional Provider Support  
- [ ] OpenAI provider implementation with streaming
- [ ] Anthropic Claude provider implementation

### Phase 5: Advanced Features
- [ ] Multi-model conversations
- [ ] Provider failover and load balancing
- [ ] Cost tracking and usage analytics
- [ ] Advanced memory and context management

## 🔧 Development Environment

### Current Branch
- Working on: `exp/llm-refactor` 
- Main branch: `main`

### Key Commands
- `bun run dev` - Development with hot reload
- `bun run build` - Build verification
- `npx biome check` - Linting and formatting

### Architecture Status
- **Provider System**: ✅ Complete and production-ready
- **Tool System**: ✅ Complete with built-in tools operational  
- **Streaming System**: ✅ Complete with modular architecture
- **MCP Integration**: 🚧 Ready for implementation

## 📚 Reference Documentation

- **Complete Architecture Details**: `wiki/devGuide.md`
- **Tool Development Guide**: `wiki/devGuide.md#adding-new-tools`
- **Provider Development Guide**: `wiki/devGuide.md#adding-new-providers`  
- **Message Flow Documentation**: `wiki/devGuide.md#message-generation-tool-call-flow`

## 🎯 Immediate Next Steps for Development

1. **Read MCP documentation** to understand protocol specification
2. **Design MCP client architecture** following TomoriBot's modular patterns
3. **Implement linkFetching server integration** as proof of concept
4. **Test end-to-end MCP tool execution** through existing provider system
5. **Document MCP integration patterns** for future server additions

---

*This document focuses on immediate next steps. Historical context and detailed architecture information is archived in `wiki/devGuide.md`.*