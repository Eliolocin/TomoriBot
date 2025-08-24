# Message Flow

When a user sends a message that triggers TomoriBot, a sophisticated **modular flow** executes that demonstrates how all of TomoriBot's systems work together seamlessly.

## Complete Message Processing Architecture

### Phase 1: Discord Validation & Context (Provider-Agnostic)

```
User Message → Discord Event → tomoriChat.ts
├── 1. Channel & Permission Validation
├── 2. Semaphore Lock Acquisition  
├── 3. Tomori State & User Data Loading
├── 4. Message History Fetching
├── 5. Context Assembly (contextBuilder.ts)
└── 6. Trigger Word & Auto-Counter Logic
```

**Key Operations:**
- Validate the message is from a supported channel type
- Acquire semaphore lock to prevent concurrent processing
- Load server configuration and user preferences from PostgreSQL
- Fetch message history with reset marker detection
- Build structured context items for LLM processing
- Check trigger words and auto-response counters

### Phase 2: Provider Selection & Configuration

```
7. Provider Factory → Dynamic Provider Selection
   ├── getProviderForTomori(tomoriState)
   ├── provider.createConfig(tomoriState, apiKey)
   ├── provider.getTools(tomoriState)
   └── Tool Format Conversion (via ToolAdapter)
```

**Key Operations:**
- Dynamically select provider based on server configuration
- Create provider-specific configuration with API keys and settings  
- Load available tools using context-aware filtering
- Convert generic tools to provider-specific function formats

### Phase 3: Streaming & Tool Execution

```
8. StreamOrchestrator.streamToDiscord(provider, config, context)
   ├── Provider StreamAdapter → LLM API Streaming
   ├── Chunk Processing → ProcessedChunk normalization
   └── Function Call Detection

9. Tool Execution Loop (if function calls detected)
   ├── ToolRegistry.executeTool(toolName, args, context)
   ├── Tool Implementation Execution
   ├── Result Formatting & Discord Integration
   └── Function Result → Back to LLM

10. Response Completion
    ├── Final Text Streaming to Discord
    ├── Sticker Sending (if selected)
    └── Semaphore Release
```

**Key Operations:**
- Stream LLM response with real-time Discord message updates
- Process streaming chunks and detect function calls
- Execute tools through unified registry system
- Handle tool results and continue LLM conversation
- Complete response with final text and optional stickers

## Detailed Flow Example

Let's trace through a complete example to see how the modular systems interact:

### User Input
**User**: `"Tomori, remember I like pizza 🍕 and search for pizza recipes"`

### Phase 1: Context Assembly

1. **Discord Validation**: Message validated as BaseGuildTextChannel
2. **State Loading**: Server config and user preferences loaded from PostgreSQL
3. **History Processing**: Recent messages fetched and converted to StructuredContextItem[]
4. **Trigger Detection**: "Tomori" detected as trigger word

### Phase 2: Provider & Tools

1. **Provider Selection**: GoogleProvider selected based on `tomoriState.llm.llm_provider`
2. **Configuration**: GoogleProviderConfig created with Gemini model settings
3. **Tool Discovery**: Available tools loaded:
   - `remember_this_fact` (MemoryTool)
   - `brave_web_search` (Brave Search MCP)
   - `select_sticker_for_response` (StickerTool)
4. **Format Conversion**: Tools converted to Google Function Calling format

### Phase 3: Streaming Execution

1. **Initial Stream**: Gemini begins processing context and available functions
2. **First Function Call**: Gemini calls `remember_this_fact`
   ```typescript
   ToolRegistry.executeTool("remember_this_fact", {
     memory_content: "User likes pizza 🍕",
     memory_scope: "target_user",
     target_user_discord_id: "123456789"
   }, context)
   ```
3. **Memory Storage**: MemoryTool saves to database via encrypted storage
4. **Function Result**: Success result sent back to Gemini
5. **Second Function Call**: Gemini calls `brave_web_search`
   ```typescript
   ToolRegistry.executeTool("brave_web_search", {
     query: "pizza recipes easy homemade"
   }, context)
   ```
6. **Search Execution**: Brave Search MCP handler processes search with image auto-sending
7. **Search Results**: Results processed and images automatically sent to Discord
8. **Final Response**: Gemini generates final text incorporating both actions

### Result

**TomoriBot**: `"I've remembered that you like pizza 🍕! I found some great pizza recipes for you. Here are some easy homemade options..." [with recipe images automatically sent]`

## Key Architectural Benefits

### 🔄 Single Entry Point
All tool execution flows through `ToolRegistry.executeTool()`, providing:
- Consistent error handling and logging
- Unified permission checking
- Standardized result formatting
- Provider-agnostic execution

### 🎯 Provider Agnostic
The same message flow works with Google, OpenAI, Anthropic:
- Provider-specific details handled by adapters
- Core logic remains unchanged
- Easy provider switching via configuration

### ⚡ Modular Tools
Tools can be added/removed without changing core flow:
- Automatic discovery and registration
- Dynamic availability based on context
- Consistent execution interface
- Built-in and MCP tools work identically

### 🛡️ Error Resilience
Comprehensive error handling at every layer:
- Provider API failures gracefully handled
- Tool execution errors don't crash the bot
- User-friendly error messages in Discord
- Detailed logging for debugging

### 📊 Consistent Behavior
Universal timeout, rate limiting, and Discord integration:
- Message chunking respects Discord limits
- Typing simulation provides natural feel
- Embed formatting standardized across tools
- Sticker integration works with all providers

## Advanced Flow Scenarios

### Context-Aware Tool Filtering

```typescript
// During YouTube video processing
streamingContext.disableYouTubeProcessing = true;

// Provider reloads tools with context
const contextAwareTools = await provider.getTools(tomoriState, streamingContext);

// YouTube tool becomes invisible to AI
// Result: Zero hallucination attempts
```

### MCP Server Integration

```typescript
// MCP tools execute identically to built-in tools
const searchResult = await ToolRegistry.executeTool("brave_web_search", args, context);

// Brave Search handler adds images to Discord automatically
// Results processed through same formatting pipeline
```

### Multi-Function Conversations

The system supports complex multi-step interactions:
1. User asks for information and memory storage
2. AI calls memory tool → stores information
3. AI calls search tool → finds relevant data  
4. AI calls sticker tool → selects appropriate reaction
5. AI generates response incorporating all results

## Performance Characteristics

### Concurrent Safety
- Semaphore locks prevent message processing conflicts
- Database transactions ensure data consistency
- Provider API rate limiting respected

### Memory Management
- Streaming responses prevent memory accumulation
- Tool contexts properly garbage collected
- Database connections pooled and managed

### Error Recovery
- Failed tool calls don't interrupt streaming
- Provider errors fall back to error messages
- System continues operation after individual failures

---

**Next**: Learn about the [Database Architecture](07-database.md) and data management systems.