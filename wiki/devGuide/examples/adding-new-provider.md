# Adding a New Provider

This tutorial demonstrates how to add a new LLM provider to TomoriBot, using **OpenAI** as an example. You'll learn to implement the complete provider architecture including streaming, tool integration, and error handling.

## Overview

We'll implement an OpenAI provider that:
- Supports GPT-4 and GPT-3.5 models
- Provides streaming responses  
- Integrates with TomoriBot's tool system
- Handles function calling
- Includes comprehensive error handling

## Step 1: Create Provider Implementation

### Base Provider Class

**File**: `src/providers/openai/openaiProvider.ts`

```typescript
/**
 * OpenAI Provider Implementation
 * Integrates OpenAI's GPT models with TomoriBot's modular architecture
 */

import { BaseLLMProvider } from "../../types/provider/interfaces";
import type {
  LLMProvider,
  ProviderInfo,
  ProviderConfig,
  StreamResult,
} from "../../types/provider/interfaces";
import type { TomoriState } from "../../types/db/schema";
import type { StructuredContextItem } from "../../types/misc/context";
import type { StreamingContext } from "../../types/tool/interfaces";
import type { BaseGuildTextChannel, Client, CommandInteraction, Message } from "discord.js";
import { StreamOrchestrator } from "../../utils/discord/streamOrchestrator";
import { OpenAIStreamAdapter, type OpenAIStreamConfig } from "./openaiStreamAdapter";
import { getOpenAIToolAdapter } from "./openaiToolAdapter";
import { ToolRegistry, getAvailableToolsForContext, type ToolStateForContext } from "../../tools/toolRegistry";
import { log } from "../../utils/misc/logger";

// OpenAI-specific configuration interface
export interface OpenAIProviderConfig extends ProviderConfig {
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  tools: Array<Record<string, unknown>>;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

const DEFAULT_MODEL = "gpt-4";
const SUPPORTED_MODELS = [
  "gpt-4",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "gpt-4o",
];

export class OpenAIProvider extends BaseLLMProvider {
  /**
   * Get provider information and capabilities
   */
  getProviderInfo(): ProviderInfo {
    return {
      name: "openai",
      displayName: "OpenAI",
      version: "1.0.0",
      description: "OpenAI GPT models with function calling and streaming support",
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsImageInput: true, // GPT-4V capability
      supportsVideoInput: false,
      supportedModels: SUPPORTED_MODELS,
      websiteUrl: "https://openai.com",
      documentationUrl: "https://platform.openai.com/docs"
    };
  }

  /**
   * Validate OpenAI API key by making a test request
   */
  async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey || apiKey.trim().length < 20) {
      log.warn("OpenAI API key is too short or empty");
      return false;
    }

    if (!apiKey.startsWith('sk-')) {
      log.warn("OpenAI API key format invalid");
      return false;
    }

    try {
      log.info("Validating OpenAI API key...");
      
      // Make a minimal API call to validate the key
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      });

      if (response.ok) {
        log.success("OpenAI API key validation successful");
        return true;
      } else {
        log.error(`OpenAI API key validation failed: ${response.status} ${response.statusText}`);
        return false;
      }
    } catch (error) {
      log.error(`OpenAI API key validation error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Create OpenAI-specific configuration
   */
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<OpenAIProviderConfig> {
    const tools = await this.getTools(tomoriState);

    return {
      model: tomoriState.llm.llm_codename || DEFAULT_MODEL,
      apiKey: apiKey,
      temperature: tomoriState.config.llm_temperature || 0.7,
      maxTokens: 4096,
      tools: tools,
      topP: 0.9,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
    };
  }

  /**
   * Get available tools for OpenAI provider
   */
  async getTools(tomoriState: TomoriState, streamingContext?: StreamingContext): Promise<Array<Record<string, unknown>>> {
    try {
      // Build tool state for context
      const toolStateForContext: ToolStateForContext = {
        server_id: tomoriState.server_id.toString(),
        config: {
          sticker_usage_enabled: tomoriState.config.sticker_usage_enabled,
          google_search_enabled: tomoriState.config.google_search_enabled,
          self_teaching_enabled: tomoriState.config.self_teaching_enabled,
        },
      };

      // Use context-aware tool availability when streaming context is provided
      let availableBuiltInTools;
      if (streamingContext) {
        // Create minimal ToolContext for context-aware availability checking
        const minimalContext = {
          streamContext: streamingContext,
          provider: "openai" as const,
          channel: {} as BaseGuildTextChannel,
          client: {} as Client,
          tomoriState: tomoriState,
          locale: "en-US",
        };
        
        // Filter tools using context-aware availability
        const allTools = ToolRegistry.getAllTools();
        availableBuiltInTools = allTools.filter(tool => {
          const isContextAvailable = 'isAvailableForContext' in tool && typeof tool.isAvailableForContext === 'function'
            ? tool.isAvailableForContext("openai", minimalContext)
            : tool.isAvailableFor("openai");
          
          return isContextAvailable;
        });
      } else {
        // Use standard method when no streaming context
        availableBuiltInTools = getAvailableToolsForContext("openai", toolStateForContext);
      }

      // Convert to OpenAI format using tool adapter
      const openaiAdapter = getOpenAIToolAdapter();
      const allToolsConfig = await openaiAdapter.getAllToolsInOpenAIFormat(availableBuiltInTools);

      log.info(`OpenAI provider tools loaded: ${availableBuiltInTools.length} built-in tools + MCP tools`);

      return allToolsConfig;
    } catch (error) {
      log.error(`Failed to get tools for OpenAI provider: ${tomoriState.llm.llm_codename}`, error as Error);
      return [];
    }
  }

  /**
   * Get default model for OpenAI provider
   */
  getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  /**
   * Stream LLM response to Discord channel
   */
  async streamToDiscord(
    channel: BaseGuildTextChannel,
    client: Client,
    tomoriState: TomoriState,
    config: ProviderConfig,
    contextItems: StructuredContextItem[],
    currentTurnModelParts: Array<Record<string, unknown>>,
    emojiStrings?: string[],
    functionInteractionHistory?: Array<{
      functionCall: { name: string; args: Record<string, unknown> };
      functionResponse: Record<string, unknown>;
    }>,
    initialInteraction?: CommandInteraction,
    replyToMessage?: Message,
    streamingContext?: StreamingContext,
  ): Promise<StreamResult> {
    log.info(`OpenAI Provider: Starting streaming for server ${tomoriState.server_id}, model ${config.model}`);

    try {
      // Convert generic config to OpenAI-specific config
      const openaiConfig = config as OpenAIProviderConfig;

      // Override tools with context-aware tools when streaming context is provided
      if (streamingContext) {
        log.info("OpenAI Provider: Reloading tools with streaming context for context-aware availability");
        const contextAwareTools = await this.getTools(tomoriState, streamingContext);
        openaiConfig.tools = contextAwareTools;
      }

      // Create OpenAI streaming configuration
      const streamConfig: OpenAIStreamConfig = {
        ...openaiConfig,
        // Add OpenAI-specific streaming settings
        stream: true,
        streamOptions: {
          includeUsage: true
        }
      };

      // Create streaming context for StreamOrchestrator
      const streamContext = {
        // Discord context
        channel,
        client,
        initialInteraction,
        replyToMessage,
        
        // Tomori context
        tomoriState,
        contextItems,
        currentTurnModelParts,
        emojiStrings,
        functionInteractionHistory,
        
        // Provider-specific context
        provider: this.getProviderInfo(),
        config: streamConfig,
      };

      // Initialize OpenAI stream adapter
      const streamAdapter = new OpenAIStreamAdapter();
      
      // Use StreamOrchestrator for unified Discord streaming
      const orchestrator = new StreamOrchestrator();
      const result = await orchestrator.streamToDiscord(
        streamAdapter,
        streamConfig,
        streamContext
      );

      log.success(`OpenAI Provider: Streaming completed for server ${tomoriState.server_id}`);
      return result;

    } catch (error) {
      log.error(`OpenAI Provider: Streaming failed for server ${tomoriState.server_id}`, error as Error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown streaming error",
        provider: "openai",
        model: config.model,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      };
    }
  }
}
```

## Step 2: Create Stream Adapter

**File**: `src/providers/openai/openaiStreamAdapter.ts`

```typescript
/**
 * OpenAI Stream Adapter
 * Handles OpenAI-specific streaming logic and chunk processing
 */

import type { StreamProvider, StreamConfig, RawStreamChunk, ProcessedChunk, FunctionCall } from "../../types/stream/interfaces";
import { log } from "../../utils/misc/logger";

export interface OpenAIStreamConfig extends StreamConfig {
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stream: boolean;
  streamOptions?: {
    includeUsage: boolean;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      function_call?: {
        name?: string;
        arguments?: string;
      };
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIStreamAdapter implements StreamProvider {
  async *startStream(config: StreamConfig): AsyncGenerator<RawStreamChunk> {
    const openaiConfig = config as OpenAIStreamConfig;
    
    try {
      // Prepare OpenAI API request
      const requestBody = {
        model: openaiConfig.model,
        messages: this.buildMessages(config.contextItems),
        temperature: openaiConfig.temperature,
        max_tokens: openaiConfig.maxTokens,
        top_p: openaiConfig.topP,
        frequency_penalty: openaiConfig.frequencyPenalty,
        presence_penalty: openaiConfig.presencePenalty,
        stream: true,
        stream_options: openaiConfig.streamOptions,
        tools: openaiConfig.tools.length > 0 ? openaiConfig.tools : undefined,
        tool_choice: openaiConfig.tools.length > 0 ? "auto" : undefined,
      };

      log.info(`OpenAI StreamAdapter: Starting stream for model ${openaiConfig.model}`);

      // Make streaming request to OpenAI API
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response stream reader");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              try {
                const chunk: OpenAIStreamChunk = JSON.parse(jsonStr);
                yield {
                  raw: chunk,
                  provider: "openai",
                  timestamp: Date.now(),
                };
              } catch (parseError) {
                log.warn(`OpenAI StreamAdapter: Failed to parse chunk: ${jsonStr}`);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

    } catch (error) {
      log.error("OpenAI StreamAdapter: Stream error", error as Error);
      throw error;
    }
  }

  processChunk(chunk: RawStreamChunk): ProcessedChunk {
    const openaiChunk = chunk.raw as OpenAIStreamChunk;
    const choice = openaiChunk.choices?.[0];
    
    if (!choice) {
      return {
        type: "error",
        provider: "openai",
        timestamp: chunk.timestamp,
        error: "No choice in OpenAI chunk"
      };
    }

    // Handle function/tool calls
    if (choice.delta.tool_calls) {
      const toolCall = choice.delta.tool_calls[0];
      if (toolCall?.function) {
        return {
          type: "function_call",
          provider: "openai",
          timestamp: chunk.timestamp,
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments || "{}"),
          }
        };
      }
    }

    // Handle legacy function_call format
    if (choice.delta.function_call) {
      return {
        type: "function_call", 
        provider: "openai",
        timestamp: chunk.timestamp,
        functionCall: {
          name: choice.delta.function_call.name || "",
          args: JSON.parse(choice.delta.function_call.arguments || "{}"),
        }
      };
    }

    // Handle text content
    if (choice.delta.content) {
      return {
        type: "text",
        provider: "openai",
        timestamp: chunk.timestamp,
        text: choice.delta.content
      };
    }

    // Handle stream completion
    if (choice.finish_reason) {
      return {
        type: "done",
        provider: "openai", 
        timestamp: chunk.timestamp,
        finishReason: choice.finish_reason,
        usage: openaiChunk.usage ? {
          promptTokens: openaiChunk.usage.prompt_tokens,
          completionTokens: openaiChunk.usage.completion_tokens,
          totalTokens: openaiChunk.usage.total_tokens,
        } : undefined
      };
    }

    // Unknown chunk type
    return {
      type: "unknown",
      provider: "openai",
      timestamp: chunk.timestamp,
    };
  }

  /**
   * Convert StructuredContextItems to OpenAI message format
   */
  private buildMessages(contextItems: any[]): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    for (const item of contextItems) {
      if (item.role === "system") {
        messages.push({
          role: "system",
          content: item.parts.map((part: any) => part.text).join("\n")
        });
      } else if (item.role === "user") {
        const content: any[] = [];
        
        for (const part of item.parts) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "image" && part.uri) {
            content.push({ 
              type: "image_url", 
              image_url: { url: part.uri }
            });
          }
          // Note: OpenAI doesn't support video input yet
        }

        messages.push({
          role: "user",
          content: content.length === 1 && content[0].type === "text" 
            ? content[0].text 
            : content
        });
      } else if (item.role === "model" || item.role === "assistant") {
        messages.push({
          role: "assistant",
          content: item.parts.map((part: any) => part.text).join("\n")
        });
      }
    }

    return messages;
  }
}
```

## Step 3: Create Tool Adapter

**File**: `src/providers/openai/openaiToolAdapter.ts`

```typescript
/**
 * OpenAI Tool Adapter
 * Converts generic tools to OpenAI function calling format
 */

import type { Tool, ToolContext, ToolResult } from "../../types/tool/interfaces";
import type { MCPCapableToolAdapter } from "../../types/tool/interfaces";
import { log } from "../../utils/misc/logger";

interface OpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

class OpenAIToolAdapter implements MCPCapableToolAdapter {
  /**
   * Convert a single tool to OpenAI function format
   */
  convertTool(tool: Tool): OpenAIFunction {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }
    };
  }

  /**
   * Convert array of tools to OpenAI format
   */
  convertToolsArray(tools: Tool[]): OpenAIFunction[] {
    return tools.map(tool => this.convertTool(tool));
  }

  /**
   * Get all tools in OpenAI format (built-in + MCP)
   */
  async getAllToolsInOpenAIFormat(availableBuiltInTools: Tool[]): Promise<OpenAIFunction[]> {
    const openaiTools: OpenAIFunction[] = [];

    // Add built-in tools
    for (const tool of availableBuiltInTools) {
      openaiTools.push(this.convertTool(tool));
    }

    // TODO: Add MCP tools integration
    // const mcpTools = await this.getMCPToolsInOpenAIFormat();
    // openaiTools.push(...mcpTools);

    log.info(`OpenAI ToolAdapter: Converted ${openaiTools.length} tools to OpenAI format`);
    return openaiTools;
  }

  /**
   * Execute MCP function (for future MCP integration)
   */
  async executeMCPFunction(
    functionName: string, 
    args: Record<string, unknown>, 
    context?: ToolContext
  ): Promise<ToolResult> {
    // TODO: Implement MCP function execution for OpenAI
    log.warn(`OpenAI MCP function execution not yet implemented: ${functionName}`);
    return {
      success: false,
      error: "MCP functions not yet supported for OpenAI provider"
    };
  }
}

// Singleton instance
let openaiToolAdapterInstance: OpenAIToolAdapter | null = null;

/**
 * Get singleton OpenAI tool adapter instance
 */
export function getOpenAIToolAdapter(): OpenAIToolAdapter {
  if (!openaiToolAdapterInstance) {
    openaiToolAdapterInstance = new OpenAIToolAdapter();
  }
  return openaiToolAdapterInstance;
}
```

## Step 4: Register Provider in Factory

**File**: `src/utils/provider/providerFactory.ts`

```typescript
// Add import
import { OpenAIProvider } from "../../providers/openai/openaiProvider";

// Add to getProviderForTomori function
export function getProviderForTomori(tomoriState: TomoriState): LLMProvider | null {
  const providerName = tomoriState.llm.llm_provider;

  switch (providerName) {
    case "google":
      return new GoogleProvider();
    
    // Add OpenAI provider
    case "openai":
      return new OpenAIProvider();
    
    default:
      log.error(`Unsupported LLM provider: ${providerName}`);
      return null;
  }
}

// Update supported providers list
export const SUPPORTED_PROVIDERS = [
  "google",
  "openai", // Add this
] as const;
```

## Step 5: Environment Configuration

Add OpenAI configuration to your environment:

**File**: `.env`

```bash
# Add OpenAI API configuration
OPENAI_API_KEY=sk-your-openai-api-key-here

# Optional: Default OpenAI model
OPENAI_DEFAULT_MODEL=gpt-4
```

## Step 6: Database Configuration

Update server configuration to support OpenAI:

**In your database seeding or admin commands, add OpenAI as an option**:

```sql
-- Update server configuration to support OpenAI
UPDATE servers SET config = jsonb_set(
  config,
  '{available_providers}',
  '["google", "openai"]'
) WHERE discord_server_id = 'your_server_id';

-- Set OpenAI as provider for a server
UPDATE tomori_instances SET llm_config = jsonb_set(
  llm_config,
  '{llm_provider}',
  '"openai"'
) WHERE server_id = your_server_id;

-- Set OpenAI model
UPDATE tomori_instances SET llm_config = jsonb_set(
  llm_config, 
  '{llm_codename}',
  '"gpt-4"'
) WHERE server_id = your_server_id;
```

## Step 7: Testing Your Provider

### Development Testing

1. **API Key Setup**:
   ```bash
   # Add to your .env file
   OPENAI_API_KEY=sk-your-api-key-here
   ```

2. **Start Development**:
   ```bash
   bun run dev
   ```

3. **Test in Discord**:
   ```
   # Switch to OpenAI provider (via admin command)
   /config set-provider openai
   
   # Test basic functionality
   @TomoriBot hello, how are you?
   
   # Test tool calling
   @TomoriBot remember that I like chocolate
   ```

### Testing Checklist

- [ ] **API Key Validation**: Invalid keys are rejected properly
- [ ] **Basic Streaming**: Text responses stream correctly
- [ ] **Tool Integration**: Tools are discovered and executed
- [ ] **Function Calling**: AI can call available functions
- [ ] **Error Handling**: API errors are handled gracefully
- [ ] **Context Awareness**: Context-aware tools work properly
- [ ] **Performance**: No memory leaks or excessive API calls

## Step 8: Advanced Features

### Add Model Selection Support

```typescript
// In openaiProvider.ts, add model validation
private validateModel(model: string): boolean {
  return SUPPORTED_MODELS.includes(model);
}

async createConfig(tomoriState: TomoriState, apiKey: string): Promise<OpenAIProviderConfig> {
  let model = tomoriState.llm.llm_codename || DEFAULT_MODEL;
  
  // Validate model exists
  if (!this.validateModel(model)) {
    log.warn(`Invalid OpenAI model ${model}, falling back to ${DEFAULT_MODEL}`);
    model = DEFAULT_MODEL;
  }

  // Rest of config creation...
}
```

### Add Image Input Support

```typescript
// In openaiStreamAdapter.ts, enhance buildMessages
private buildMessages(contextItems: any[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const item of contextItems) {
    if (item.role === "user") {
      const content: any[] = [];
      
      for (const part of item.parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image" && part.uri) {
          // Support both base64 and URL images
          const imageUrl = part.uri.startsWith('data:') 
            ? part.uri 
            : part.uri;
            
          content.push({ 
            type: "image_url", 
            image_url: { 
              url: imageUrl,
              detail: "auto" // or "low", "high"
            }
          });
        }
      }

      messages.push({
        role: "user",
        content: content.length === 1 && content[0].type === "text" 
          ? content[0].text 
          : content
      });
    }
    // ... rest of message building
  }

  return messages;
}
```

### Add Usage Tracking

```typescript
// In openaiProvider.ts, add usage tracking
private logUsage(usage: any, model: string): void {
  log.info(`OpenAI Usage - Model: ${model}, Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
  
  // Optional: Store usage in database for analytics
  // await storeProviderUsage('openai', model, usage);
}
```

## Common Issues & Solutions

### API Rate Limiting
```typescript
// Add retry logic with exponential backoff
private async makeRequestWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        // Rate limited - wait and retry
        const retryAfter = parseInt(response.headers.get('retry-after') || '1');
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      
      return response;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
  
  throw new Error("Max retries exceeded");
}
```

### Token Limit Handling
```typescript
// Add token counting and context truncation
private async truncateContextIfNeeded(messages: any[], maxTokens: number): Promise<any[]> {
  // Implement token counting logic
  // Truncate older messages if context is too long
  // Always preserve system message and recent messages
}
```

Your OpenAI provider is now ready to integrate with TomoriBot! The modular architecture ensures it works seamlessly with all existing tools and features. 🚀

---

**Related Guides**:
- [Creating a New Tool](creating-new-tool.md)
- [Context-Aware Tool Implementation](implementing-context-aware-tool.md)