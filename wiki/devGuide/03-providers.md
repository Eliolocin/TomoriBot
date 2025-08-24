# Provider System

TomoriBot uses a **modular provider architecture** that abstracts LLM interactions behind a common interface. This allows seamless switching between different AI providers while maintaining consistent functionality across the entire application.

## Core Provider Interface

All LLM providers must implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
    // Provider identification
    getProviderInfo(): ProviderInfo;
    
    // API key validation
    validateApiKey(apiKey: string): Promise<boolean>;
    
    // Configuration creation
    createConfig(tomoriState: TomoriState, apiKey: string): ProviderConfig;
    
    // Tool discovery
    getTools(tomoriState: TomoriState): Tool[];
    
    // Main streaming method
    streamToDiscord(
        channel: BaseGuildTextChannel,
        client: Client, 
        tomoriState: TomoriState,
        config: ProviderConfig,
        contextItems: StructuredContextItem[],
        interaction?: CommandInteraction
    ): Promise<StreamResult>;
}
```

## Provider Factory Pattern

The `ProviderFactory` enables dynamic provider selection based on configuration:

```typescript
// Dynamic provider selection based on configuration
const provider = getProviderForTomori(tomoriState);

// Provider-agnostic usage
const config = provider.createConfig(tomoriState, apiKey);
const result = await provider.streamToDiscord(channel, client, tomoriState, config, contextItems);
```

This abstraction means the core application logic never needs to know which specific LLM provider is being used.

## Current Implementation: Google Gemini

### GoogleProvider
- **Location**: `src/providers/google/googleProvider.ts`
- **Features**: Streaming, function calling, image/video processing
- **Models**: Gemini 2.0 Flash, configurable via environment variables

### Supporting Components

**GoogleStreamAdapter** (`googleStreamAdapter.ts`)
- Handles Gemini-specific streaming logic
- Converts Gemini API responses to normalized chunks
- Manages function call detection and processing

**GoogleToolAdapter** (`googleToolAdapter.ts`)
- Converts generic tools to Google Function Calling format
- Handles parameter schema transformation
- Manages tool result formatting

## Streaming Architecture

TomoriBot uses a **two-layer streaming architecture** that separates concerns:

### Universal Discord Layer (`streamOrchestrator`)
Handles all Discord-specific logic (600+ lines of reusable code):
- Message creation and editing
- Embed generation and updates 
- Function call routing to `ToolRegistry`
- Stream timeout management
- Error recovery and user notifications
- Message chunking and rate limiting
- Typing simulation and humanization

### Provider-Specific Layer (`StreamAdapter`)
Handles LLM-specific streaming (150-200 lines per provider):
- API client management
- Chunk processing and normalization
- Provider-specific error handling

## Adding New Providers

To add a new LLM provider (e.g., OpenAI, Anthropic):

### 1. Create Provider Implementation

```typescript
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
```

### 2. Create Stream Adapter

```typescript
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

### 3. Create Tool Adapter

```typescript
// src/providers/openai/openaiToolAdapter.ts
export class OpenAIToolAdapter implements ToolAdapter {
    convertTool(tool: Tool): OpenAIFunction {
        // Convert generic tool to OpenAI function format
    }
    
    async executeMCPFunction(functionName: string, args: Record<string, unknown>): Promise<ToolResult> {
        // Handle MCP function execution for OpenAI
    }
}
```

### 4. Register in Factory

```typescript
// src/providers/ProviderFactory.ts
case "openai":
    return new OpenAIProvider();
```

## Tool System Integration

All providers use the same **modular tool system**:

### Tool Registry Integration
```typescript
// Tools are automatically discovered and registered at startup
const availableTools = ToolRegistry.getAvailableTools(providerName, context);

// Tools are executed uniformly regardless of provider
const result = await ToolRegistry.executeTool(toolName, args, context);
```

### Provider Tool Adapters
Each provider has an adapter that converts generic tools to provider-specific formats:

```typescript
// Google format conversion
const googleTools = googleToolAdapter.convertToolsArray(genericTools);

// Future: OpenAI format conversion  
const openaiTools = openaiToolAdapter.convertToolsArray(genericTools);
```

## Configuration Management

Providers create their own configuration objects that extend the base `ProviderConfig`:

```typescript
interface GoogleProviderConfig extends ProviderConfig {
    model: string;
    apiKey: string;
    temperature: number;
    maxOutputTokens: number;
    tools: Array<Record<string, unknown>>;
    safetySettings: SafetySetting[];
}
```

This allows each provider to have specific configuration while maintaining interface compatibility.

---

**Next**: Learn about the [Tool System](04-tools.md) and how TomoriBot's modular functionality works.