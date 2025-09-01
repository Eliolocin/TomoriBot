# Message Flow

When a user sends a message that triggers TomoriBot, a sophisticated **modular flow** executes that demonstrates how all of TomoriBot's systems work together seamlessly.

## Complete Message Processing Architecture

### Phase 1: Discord Validation & Context (Provider-Agnostic)

```
User Message → Discord Event → tomoriChat.ts
├── 1. Channel & Context Validation (Guild vs DM)
├── 2. Semaphore Lock Acquisition  
├── 3. Tomori State & User Data Loading
├── 4. Message History Fetching
├── 5. Context Assembly (contextBuilder.ts)
└── 6. Trigger Word & Auto-Counter Logic
```

**Key Operations:**
- **Channel Type Validation**: Support Guild text channels and Direct Messages
- **Context Detection**: Use `isDMBased()` for reliable DM identification
- **Server ID Resolution**: Guild ID for servers, User ID for DMs (secure isolation)
- Acquire semaphore lock to prevent concurrent processing
- Load server/DM configuration and user preferences from PostgreSQL
- Fetch message history with reset marker detection
- Build structured context items for LLM processing
- Check trigger words and auto-response counters

#### DM vs Guild Context Handling

**Guild Channels:**
```typescript
const isDMChannel = !interaction.channel.isDMBased();
const serverId = interaction.guild?.id;  // Standard guild ID
// Uses guild-specific configurations, emojis, stickers
```

**Direct Messages:**  
```typescript
const isDMChannel = interaction.channel.isDMBased();
const serverId = interaction.user.id;    // User ID for isolation
// Uses user-specific configurations, limited features
```

**Security Benefits:**
- **User Isolation**: DM contexts use User ID as serverId for complete data separation
- **Memory Protection**: Fixed critical security vulnerabilities in memory tool processing
- **Context Validation**: Proper null checks prevent ID mixing between contexts

#### Supported Channel Types

**✅ Supported:**
- **Guild Text Channels**: Full feature set (emojis, stickers, server memories)
- **Direct Messages**: Core functionality with user-specific configurations

**❌ Unsupported:**
- **Group DMs**: Not supported due to complexity and limited use cases
- **Voice/Stage Channels**: Text-based bot requires text channels only
- **Forum/Thread Channels**: May work but not officially supported

**Error Handling:**
```typescript
// Unsupported channel types receive user-friendly error messages
if (!isSupportedChannelType(channel)) {
  return sendStandardEmbed(channel, locale, {
    titleKey: "general.errors.channel_not_supported_title",
    descriptionKey: "general.errors.channel_not_supported_description",
    color: ColorCode.ERROR
  });
}
```

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
   ├── Semantic Block Detection → Smart Buffer Management
   ├── Chunk Processing → ProcessedChunk normalization
   ├── Natural Stop Detection → User interruption handling
   └── Function Call Detection

9. Semantic Block Processing (Real-time Stream Enhancement)
   ├── Simple Marker Detection → hasSemanticMarkers()
   ├── Break Prevention → Preserve quotes, parentheses, markdown
   ├── Natural Flow Buffering → Continue accumulation
   └── Code Block Isolation → Maintain standalone chunks

10. Text Chunking & Humanization (Post-stream Processing)
    ├── Atomic Block Extraction → Complex boundary detection
    ├── Semantic Block Merging → Natural flow with surrounding text
    ├── Humanization (Degree-dependent) → Case/punctuation transformation
    └── Placeholder Protection → Preserve code integrity

11. Tool Execution Loop (if function calls detected)
    ├── Pre-execution Stop Check → Cancel if user requested stop
    ├── ToolRegistry.executeTool(toolName, args, context)
    ├── Tool Implementation Execution (with timing logs)
    ├── Result Formatting & Discord Integration
    └── Function Result → Back to LLM

12. Natural Stop System (Concurrent with Streaming & Tools)
    ├── Stop Pattern Detection → Natural language phrases in new messages
    ├── Stop Signal & Context Storage → Channel-specific stop requests
    ├── Stream Interruption → Graceful halt of current generation
    ├── Stop Response Generation → Dynamic personality-driven response
    └── Queue Integration → Stop responses bypass normal trigger logic

13. Response Completion
     ├── Final Text Streaming to Discord
     ├── Sticker Sending (if selected)
     ├── Stop Context Processing → Generate stop response if needed
     └── Semaphore Release
```

**Key Operations:**
- Stream LLM response with intelligent semantic block awareness
- Prevent breaking inside quotes, parentheses, and markdown formatting
- Process streaming chunks with natural flow preservation
- Apply humanization transformations while protecting code syntax
- Execute tools through unified registry system
- Handle tool results and continue LLM conversation
- Monitor for natural stop triggers during active streaming
- Gracefully interrupt responses and generate personality-driven stop responses
- Complete response with optimal message chunking

## Detailed Flow Example

Let's trace through a complete example to see how the modular systems interact:

### User Input
**User**: `"Tomori, I like "artisan pizza" and **bold flavors**. Search for (gourmet recipes) please!"`

### Phase 1: Context Assembly

1. **Discord Validation**: Message validated as BaseGuildTextChannel
2. **State Loading**: Server config and user preferences loaded from PostgreSQL
   - **Humanizer Degree**: HEAVY (3) - enables advanced text processing
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

### Phase 3: Streaming Execution with Semantic Block Processing

1. **Initial Stream**: Gemini begins processing context and available functions
2. **Semantic Block Detection**: StreamOrchestrator detects semantic markers:
   ```typescript
   // Buffer accumulates: "I like \"artisan pizza\" and **bold"
   hasSemanticMarkers = true; // Contains quotes and markdown
   // Result: No flushing on newlines/periods until complete
   ```
3. **First Function Call**: Gemini calls `remember_this_fact`
   ```typescript
   ToolRegistry.executeTool("remember_this_fact", {
     memory_content: "User likes \"artisan pizza\" and **bold flavors**",
     memory_scope: "target_user", 
     target_user_discord_id: "123456789"
   }, context)
   ```
4. **Memory Storage**: MemoryTool saves to database via encrypted storage
5. **Second Function Call**: Gemini calls `brave_web_search`
   ```typescript
   ToolRegistry.executeTool("brave_web_search", {
     query: "artisan pizza gourmet recipes bold flavors"
   }, context)
   ```
6. **Search Execution**: Brave Search MCP handler processes search with image auto-sending
7. **Final Text Stream**: Gemini generates response with semantic formatting:
   ```
   Raw stream: "I've noted your love for \"artisan pizza\" and **bold flavors**! 
   Here are some (amazing gourmet recipes) I found..."
   ```

### Phase 4: Text Processing Pipeline

1. **Semantic Block Extraction**: Complex boundary detection identifies:
   - `"artisan pizza"` (quoted block)
   - `**bold flavors**` (markdown bold block)  
   - `(amazing gourmet recipes)` (parenthesized block)

2. **Natural Flow Merging**: Semantic blocks merge with surrounding text:
   ```typescript
   // Instead of isolated chunks, creates natural flow:
   "I've noted your love for \"artisan pizza\" and **bold flavors**!"
   "Here are some (amazing gourmet recipes) I found..."
   ```

3. **Humanization (HEAVY Degree)**: Text transformations with protection:
   ```typescript
   // Placeholder protection preserves formatting:
   "i've noted your love for \"artisan pizza\" and **bold flavors**"
   "here are some (amazing gourmet recipes) i found"
   ```

### Result

**TomoriBot**: 
```
i've noted your love for "artisan pizza" and **bold flavors**
here are some (amazing gourmet recipes) i found
[with gourmet recipe images automatically sent]
```

**Key Improvements Demonstrated:**
- ✅ Natural flow: Semantic blocks stay with surrounding text
- ✅ No weird breaks: `"artisan` / `pizza"` splitting prevented  
- ✅ Markdown preserved: Discord formatting maintained
- ✅ Humanization safe: Code and formatting protected during transformations

## Natural Stop Trigger System

TomoriBot features an elegant **natural language stop system** that allows users to interrupt ongoing responses using intuitive phrases, creating a more natural conversational experience.

### Stop Pattern Categories

**English Patterns:**
- **Basic stops**: `"stop"`, `"enough"`, `"chill"`, `"wait"`, `"pause"`, `"quit"`
- **Polite phrases**: `"okay stop"`, `"that's enough"`, `"please stop"`
- **Dismissive**: `"nevermind"`, `"cut it out"`, `"knock it off"`

**Japanese Patterns:** 
- **やめて** (yamete) - "stop it"
- **ストップ** (sutoppu) - "stop" (katakana)
- **もういい** (mou ii) - "that's enough"
- **待って** (matte) - "wait"

### Stop Flow Example

**Scenario**: User interrupts a long response about cooking techniques

```
1. TomoriBot streaming: "There are many ways to prepare pasta. First, you need to..."
2. User types: "stop, I get it"
3. Stop Detection: Pattern matches "stop" during active streaming
4. Stream Interruption: Current response halts gracefully
5. Stop Response: TomoriBot replies naturally based on her personality
   → "Oh! Sorry for going on and on 😅 I got a bit excited about pasta!"
```

### Technical Implementation

**Stop Detection Pipeline:**
```typescript
// 1. Pattern matching during active streaming
const NATURAL_STOP_PATTERNS = createNaturalStopPatterns();
if (isNaturalStopMessage(message.content) && channelIsLocked) {
    StreamOrchestrator.requestStop(channelId, userId, { originalStopMessage, client });
}

// 2. Comprehensive stop checks throughout streaming pipeline
if (StreamOrchestrator.hasStopRequest(channel.id)) {
    // Interrupt: chunk processing, typing simulation, function calls
}

// 3. Stop response generation after lock release
const systemContext = "[System: The user has requested you to stop your current generation]";
// Uses original stop message as "passport" with isManuallyTriggered: true bypass
```

**Integration Points:**
- **Streaming**: Stop checks during chunk processing and typing simulation
- **Function Calls**: Pre-execution cancellation (⚠️ *Note: Cannot interrupt mid-execution*)  
- **Context Management**: Stop requests stored per-channel with cleanup
- **Response Generation**: Leverages existing queue system and trigger bypass logic

### Function Calling Considerations

**Current Behavior:**
- ✅ **Before execution**: Function calls cancelled if stop requested
- ✅ **Timing logs**: Long-running functions (>5s) generate warnings  
- ⚠️ **During execution**: Functions run to completion (cannot be interrupted mid-execution)

**Example**:
```
User: "search for detailed cooking guides"
→ LLM calls web_search function
→ User says "stop" while search is executing
→ Current search completes, but next function calls are cancelled
→ Stop response generated after search finishes
```

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
- **Smart Message Chunking**: Respects Discord limits while preserving semantic integrity
- **Semantic Block Processing**: Prevents breaking inside quotes, parentheses, and markdown
- **Humanization Control**: Degree-dependent text transformations (0=None, 1=Light, 2=Medium, 3=Heavy)
- **Natural Flow**: Semantic blocks merge with surrounding text instead of forced isolation
- **Typing Simulation**: Provides natural feel with intelligent pausing
- **Embed Formatting**: Standardized across tools with semantic awareness
- **Sticker Integration**: Works with all providers and respects message flow

## Advanced Flow Scenarios

### Semantic Block Processing Activation

```typescript
// Semantic processing activates automatically based on content
const buffer = "I like **bold** text and \"quotes\" here";
const hasSemanticMarkers = streamOrchestrator.hasSemanticMarkers(buffer);
// Returns: true → prevents breaking on newlines/periods

// Humanization degree affects text processing intensity
switch (humanizerDegree) {
  case 0: // NONE - No transformations, semantic blocks still protected
  case 1: // LIGHT - Minimal changes, natural flow maintained  
  case 2: // MEDIUM - Moderate transformations with semantic awareness
  case 3: // HEAVY - Full transformations + sentence splitting, maximum protection needed
}
```

### Context-Aware Tool Filtering

```typescript
// During YouTube video processing
streamingContext.disableYouTubeProcessing = true;

// Provider reloads tools with context
const contextAwareTools = await provider.getTools(tomoriState, streamingContext);

// YouTube tool becomes invisible to AI
// Result: Zero hallucination attempts
```

### MCP Server Integration with Semantic Awareness

```typescript
// MCP tools execute identically to built-in tools
const searchResult = await ToolRegistry.executeTool("brave_web_search", args, context);

// Results may contain markdown that flows naturally
// Example: "Check out **this amazing recipe** from (Food Network)"
// Result: Natural flow maintained, no awkward isolation
```

### Multi-Function Conversations with Smart Chunking

The system supports complex multi-step interactions with intelligent message flow:
1. User asks for information with semantic formatting
2. AI calls memory tool → stores information (preserving original formatting)
3. AI calls search tool → finds relevant data with potential markdown/quotes  
4. AI generates response incorporating all results
5. **Semantic Block Processing** ensures natural flow throughout entire conversation
6. AI calls sticker tool → selects appropriate reaction based on final message tone

## Performance Characteristics

### Concurrent Safety
- Semaphore locks prevent message processing conflicts
- Database transactions ensure data consistency
- Provider API rate limiting respected
- Semantic block processing is thread-safe and stateless

### Memory Management
- Streaming responses prevent memory accumulation
- **Simple Semantic Markers**: Minimal memory overhead in streaming phase
- **Complex Boundary Detection**: Only active during chunking phase
- Tool contexts properly garbage collected
- Database connections pooled and managed

### Processing Efficiency
- **"Streaming Dumb, Chunking Smart"**: Optimal performance distribution
- **Streaming Phase**: Fast marker detection with O(n) complexity
- **Chunking Phase**: Complex parsing only when needed
- **Humanization Pipeline**: Efficient placeholder-based protection system
- **Natural Flow Algorithm**: Intelligent merging with minimal computational cost

### Error Recovery
- Failed tool calls don't interrupt streaming
- Semantic block processing gracefully handles malformed input
- Provider errors fall back to error messages with formatting preserved
- System continues operation after individual failures
- **Incomplete Semantic Blocks**: Automatically handled with safety flush mechanisms

---

**Next**: Learn about the [Database Architecture](07-database.md) and data management systems.