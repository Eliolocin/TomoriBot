# Architecture Rules

## Architecture Rule 1: Provider Interface Implementation
All LLM providers must implement the standardized LLMProvider interface for seamless switching

When adding new LLM providers (OpenAI, Anthropic, etc.), follow the modular provider architecture:

```ts
// ✅ DO (Create provider implementation)
// src/providers/openai/OpenAIProvider.ts
export class OpenAIProvider extends BaseLLMProvider {
    getProviderInfo(): ProviderInfo {
        return {
            name: "openai",
            version: "1.0", 
            supportsStreaming: true,
            supportsFunctionCalling: true
        };
    }
    
    async validateApiKey(apiKey: string): Promise<boolean> {
        // OpenAI API key validation logic
    }
    
    // ... implement other required methods
}

// Register in factory
// src/providers/ProviderFactory.ts
case "openai":
    return new OpenAIProvider();
```

## Architecture Rule 2: Streaming Architecture Separation
Use two-layer streaming architecture with universal Discord layer and provider-specific adapters

- **Universal Discord Layer** (`streamOrchestrator`): Handles all Discord-specific logic (message creation/editing, embed generation, function call routing, timeout management)
- **Provider-Specific Layer** (`StreamAdapter`): Handles LLM-specific streaming (API client management, chunk processing, provider-specific errors)

```ts
// ✅ DO (Provider-specific stream adapter)
// src/providers/openai/OpenAIStreamAdapter.ts
export class OpenAIStreamAdapter implements StreamProvider {
    async *startStream(config: StreamConfig): AsyncGenerator<RawStreamChunk> {
        // OpenAI streaming implementation
    }
    
    processChunk(chunk: RawStreamChunk): ProcessedChunk {
        // Convert OpenAI chunks to normalized format
    }
}
```

## Architecture Rule 3: Tool System Integration
All providers use the same modular tool system with automatic discovery and execution

- Tools implement generic `Tool` interface and are automatically discovered at startup
- `ToolRegistry` handles discovery, execution, and permission management uniformly
- Provider adapters convert generic tools to provider-specific formats
- Both built-in function call tools and MCP server tools use same execution flow

```ts
// ✅ DO (Tool registry usage)
// Tools are automatically discovered and registered at startup
const availableTools = ToolRegistry.getAvailableTools(providerName, context);

// Tools are executed uniformly regardless of provider
const result = await ToolRegistry.executeTool(toolName, args, context);

// Provider tool adapters convert formats
const googleTools = googleToolAdapter.convertToolsArray(genericTools);
const openaiTools = openaiToolAdapter.convertToolsArray(genericTools);
```

## Architecture Rule 4: Built-in Tool Development
Create built-in function call tools by extending BaseTool with automatic integration

1. Create tool implementation extending `BaseTool`
2. Export in `src/tools/functionCalls/index.ts`
3. System automatically discovers, converts schemas, handles execution, and manages permissions

```ts
// ✅ DO (src/tools/functionCalls/yourTool.ts)
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

// Export in index
// src/tools/functionCalls/index.ts
export { YourTool } from "./yourTool";
```

## Architecture Rule 5: MCP Server Integration
Use finalized MCP architecture with provider-agnostic design and server-specific behavior handlers

MCP (Model Context Protocol) servers provide standardized access to external functionality:

1. **Server Configuration** in `src/tools/mcpServers/{server-name}/config.json`
2. **Behavior Handler** implementing `MCPServerBehaviorHandler` interface
3. **Automatic Integration** through MCP Manager, Executor, and Config systems

```json
// ✅ DO (Server configuration)
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

```ts
// ✅ DO (Behavior handler)
// src/tools/mcpServers/brave-search/braveSearchHandler.ts
export class BraveSearchBehaviorHandler implements MCPServerBehaviorHandler {
    serverName = "brave-search";
    
    async preprocessParameters(
        functionName: string, 
        originalArgs: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
        // Parameter overrides and enhancements
    }
    
    async postprocessResult(
        functionName: string, 
        result: MCPToolResult, 
        context?: ToolContext
    ): Promise<MCPToolResult> {
        // Result processing and Discord integration
    }
}
```

## Architecture Rule 6: Type Safety Standards
Maintain comprehensive TypeScript interfaces with zero `any` types in architecture components

- Use comprehensive interface definitions in `src/types/` subdirectories
- Provider types in `src/types/provider/`
- Stream types in `src/types/stream/`  
- Tool types in `src/types/tool/`
- MCP types in `src/types/tool/mcpTypes.ts`
- Avoid `any` types - use proper interface definitions

```ts
// ✅ DO (Comprehensive type definitions)
// src/types/provider/interfaces.ts
interface LLMProvider {
    getProviderInfo(): ProviderInfo;
    validateApiKey(apiKey: string): Promise<boolean>;
    createConfig(tomoriState: TomoriState, apiKey: string): ProviderConfig;
    getTools(tomoriState: TomoriState): Tool[];
    streamToDiscord(...args): Promise<StreamResult>;
}

// ❌ DON'T
interface LLMProvider {
    streamToDiscord(...args: any[]): Promise<any>; // Avoid any types
}
```

## Architecture Rule 7: Provider-Agnostic Design
Ensure all architecture components work identically across different LLM providers

- Core message processing flow should be provider-agnostic
- Use `ProviderFactory` for dynamic provider selection
- Tool execution flows through same `ToolRegistry.executeTool()` regardless of provider
- Streaming orchestration handles Discord logic universally
- MCP tools execute through same interface for all providers

```ts
// ✅ DO (Provider-agnostic usage)
const provider = getProviderForTomori(tomoriState);
const config = provider.createConfig(tomoriState, apiKey);
const result = await provider.streamToDiscord(channel, client, tomoriState, config, contextItems);

// MCP tools work identically across providers
interface MCPCapableToolAdapter {
    convertTool(tool: Tool): ProviderSpecificTool;
    executeMCPFunction(functionName: string, args: Record<string, unknown>): Promise<TypedMCPToolResult>;
}
```

## Architecture Rule 8: Modular Extensibility  
Design components to be easily extensible with minimal code changes

- New providers can be added with ~300-500 lines of code (Provider + StreamAdapter + ToolAdapter)
- New built-in tools can be added with ~100-200 lines extending `BaseTool`
- New MCP servers can be integrated with ~100 lines (config.json + behavior handler)
- Use automatic discovery patterns to avoid manual registration
- Follow established patterns for consistent behavior

```ts
// ✅ DO (Extensible patterns)
// Adding new provider requires only implementing interface
export class AnthropicProvider extends BaseLLMProvider {
    // Implement required methods following established patterns
}

// Adding new tool requires only extending base class
export class NewTool extends BaseTool {
    // Implement required methods following established patterns
}
```