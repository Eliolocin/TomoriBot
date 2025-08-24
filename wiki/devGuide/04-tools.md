# Tool System

TomoriBot's **modular tool system** provides a unified way to extend functionality across all LLM providers. Tools can be built-in function calls or external MCP (Model Context Protocol) servers, all managed through a central registry with automatic discovery and execution.

## Tool Architecture Overview

### Core Components

- **ToolRegistry** - Central registry and execution engine
- **ToolInitializer** - Automatic tool discovery and registration
- **Provider Adapters** - Convert tools to provider-specific formats
- **MCP Integration** - External server support with behavior handlers

### Tool Interface

All tools implement the same base interface:

```typescript
interface Tool {
    name: string;
    description: string;
    category: ToolCategory;
    parameters: ToolParameterSchema;
    
    // Execution
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    
    // Provider compatibility
    isAvailableFor(provider: string): boolean;
    
    // Optional enhancements
    requiresPermissions?: string[];
    requiresFeatureFlag?: string;
}
```

## Built-in Function Call Tools

Built-in tools extend the `BaseTool` class and are automatically discovered via file system scanning.

### Creating a Built-in Tool

1. **Create tool implementation**:

```typescript
// src/tools/functionCalls/yourTool.ts
export class YourTool extends BaseTool {
    name = "your_tool_name";
    description = "What your tool does";
    category = "utility" as const;
    
    parameters: ToolParameterSchema = {
        type: "object",
        properties: {
            param1: { type: "string", description: "Parameter description" }
        },
        required: ["param1"]
    };
    
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
        // Your tool logic here
        return { success: true, data: { status: "completed" } };
    }
}
```

2. **Export in index**:

```typescript
// src/tools/functionCalls/index.ts
export { YourTool } from "./yourTool";
```

3. **Automatic integration**: The system automatically:
   - Discovers your tool via dynamic imports
   - Converts your schema to provider-specific formats
   - Handles execution through the registry
   - Manages permissions and feature flags

### Current Built-in Tools

**StickerTool** (`stickerTool.ts`)
- Discord sticker selection and sending
- Integrates with server sticker collections
- Context-aware availability based on permissions

**MemoryTool** (`memoryTool.ts`)
- Learning and memory storage (personal and server-wide)
- Encrypted storage with PostgreSQL
- Contextual memory retrieval and management

**YouTubeVideoTool** (`youTubeVideoTool.ts`)
- YouTube video processing using Google's video understanding
- Context-aware availability to prevent hallucination
- Enhanced context restart with video Parts injection

## MCP Server Integration

**Model Context Protocol (MCP)** integration is **completely finalized** with provider-agnostic architecture, full type safety, and zero technical debt!

### MCP Architecture Components

**1. Modular MCP System** - Complete provider-agnostic architecture:
- **MCP Manager** (`src/utils/mcp/mcpManager.ts`) - Server lifecycle management
- **MCP Executor** (`src/utils/mcp/mcpExecutor.ts`) - Universal function execution with behavior handler registry
- **MCP Config Manager** (`src/utils/mcp/mcpConfig.ts`) - JSON configuration loading and validation
- **MCP Type Definitions** (`src/types/tool/mcpTypes.ts`) - Comprehensive TypeScript interfaces (zero `any` types)

**2. Server-Specific Behavior Handlers** - Dedicated logic per MCP server:
- **Brave Search Handler** - Image auto-sending, parameter overrides, web search enhancements
- **Fetch Handler** - URL content processing and markdown conversion
- **DuckDuckGo Handler** - Future free web search (scaffolded)

### MCP Server Configuration

Each MCP server has a configuration file defining its behavior:

```json
// src/tools/mcpServers/brave-search/config.json
{
  "name": "brave-search",
  "displayName": "Brave Search",
  "npmPackage": "@brave/brave-search-mcp-server",
  "description": "Premium web search with image/video/news search",
  "requiredEnvVars": ["BRAVE_API_KEY"],
  "category": "search",
  "transport": "stdio",
  "enabled": true
}
```

### Database Integration

Encrypted API key storage per guild:

```sql
CREATE TABLE mcp_api_keys (
  mcp_api_key_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL,
  mcp_name TEXT NOT NULL,
  api_key BYTEA,  -- Encrypted using pgcrypto
  UNIQUE (server_id, mcp_name)
);
```

### Available MCP Servers

**✅ Brave Search MCP** (Production-Ready)
- Premium web search with automatic image sending to Discord
- Functions: `brave_web_search`, `brave_image_search`, `brave_video_search`, `brave_news_search`, `brave_local_search`, `brave_summarizer`
- Enhanced with fetch capability reminders

**✅ Fetch MCP** (Production-Ready)
- URL content retrieval and markdown conversion
- Function: `fetch` with content length optimization
- Automatic HTML-to-markdown conversion

**🔄 DuckDuckGo Search MCP** (Ready for Integration)
- Free web search alternative
- Handler scaffolded, awaiting server availability

## Tool Registry System

### Unified Execution

All tools execute through the same interface:

```typescript
// MCP tools and built-in tools use identical execution
const result = await ToolRegistry.executeTool(toolName, args, context);
```

### Provider Integration

Tools are automatically converted to provider-specific formats:

```typescript
// Get available tools for a provider
const availableTools = ToolRegistry.getAvailableTools(providerName, context);

// Provider adapters handle format conversion
const providerTools = await toolAdapter.getAllToolsInProviderFormat(availableTools);
```

### Permission Management

Tools can specify permission requirements:

```typescript
export class AdminTool extends BaseTool {
    requiresPermissions = ["ADMINISTRATOR"];
    requiresFeatureFlag = "advanced_admin_tools";
    
    // Tool automatically filtered based on user permissions and server configuration
}
```

## Tool Execution Context

Tools receive rich context for execution:

```typescript
interface ToolContext {
    // Discord context
    channel: BaseGuildTextChannel;
    client: Client;
    message?: Message;
    
    // Tomori context
    tomoriState: TomoriState;
    locale: string;
    
    // Provider context
    provider: string;
    
    // Optional streaming context for advanced features
    streamContext?: StreamingContext;
}
```

## Key Architecture Benefits

**🔄 Single Entry Point**: All tool execution flows through `ToolRegistry.executeTool()`

**🎯 Provider Agnostic**: Same tools work with Google, OpenAI, Anthropic providers

**⚡ Modular Extension**: Tools can be added/removed without changing core logic

**🛡️ Comprehensive Security**: Permission checking, feature flags, and validation

**📊 Consistent Behavior**: Universal error handling, logging, and Discord integration

**🚀 MCP Integration**: External servers work identically to built-in tools

---

**Next**: Learn about [Context-Aware Tools](05-context-aware-tools.md) and advanced dynamic tool management.