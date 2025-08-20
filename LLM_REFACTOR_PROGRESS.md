# TomoriBot LLM Provider Abstraction Refactor

## Overview
This document tracks the progress of refactoring TomoriBot from a tightly-coupled Gemini implementation to a modular provider architecture that supports multiple LLM providers.

## Completed Tasks ✅

### Phase 1: Provider Abstraction Layer
- ✅ **Created base provider interface** (`src/providers/base/Provider.ts`)
  - Defined `LLMProvider` interface with common methods
  - Created `ProviderConfig`, `StreamResult`, `ProviderInfo` types
  - Implemented `BaseLLMProvider` abstract class
  - Methods: `validateApiKey()`, `streamToDiscord()`, `getTools()`, `createConfig()`

- ✅ **Created provider factory** (`src/providers/ProviderFactory.ts`)
  - Implemented `ProviderFactory` class with singleton pattern
  - Switch statement based on `llm_provider` configuration
  - Support for Google (implemented), OpenAI/Anthropic (planned)
  - Graceful error handling for unsupported providers

### Phase 2: Google Provider Implementation
- ✅ **Refactored Google provider** (`src/providers/google/GoogleProvider.ts`)
  - Implemented `LLMProvider` interface for Google Gemini
  - Extended `GoogleProviderConfig` with Gemini-specific settings
  - Wrapped existing `streamGeminiToDiscord` function
  - Maintained backward compatibility with existing functionality
  - Provider info: supports streaming, function calling, images, videos

### Phase 3: Main Application Updates
- ✅ **Refactored tomoriChat.ts** (`src/events/messageCreate/tomoriChat.ts`)
  - Removed direct Google/Gemini imports
  - Replaced hardcoded provider check with `getProviderForTomori()`
  - Updated streaming calls to use provider interface
  - Converted provider-specific types to generic types
  - Maintained all existing functionality while decoupling from Gemini

## Current Architecture

### Provider Structure
```
src/providers/
├── base/
│   └── Provider.ts          # Base interface and abstract class
├── google/
│   ├── GoogleProvider.ts    # Google implementation
│   ├── gemini.ts           # Original Gemini functions (wrapped)
│   ├── functionCalls.ts    # Google-specific function declarations
│   └── subAgents.ts        # Google-specific sub-agents
└── ProviderFactory.ts       # Provider factory and management
```

### Key Benefits Achieved
1. **Decoupled Architecture**: Main application code no longer directly imports provider-specific modules
2. **Provider Agnostic**: Easy to add new LLM providers (OpenAI, Anthropic, etc.)
3. **Backward Compatibility**: All existing Gemini functionality preserved
4. **Clean Interfaces**: Type-safe provider switching with proper error handling
5. **Extensible**: Framework ready for additional provider features

## Recently Fixed 🔧

- ✅ **Fixed all linting errors** in refactored files
  - Added proper TypeScript types to replace `any` usage
  - Fixed non-null assertions and implicit any issues
  - Converted ProviderFactory from class to namespace (more appropriate)
  - Build now passes without errors

## In Progress Tasks 🚧

- 🚧 **Update setup.ts** to use provider factory for API key validation
- ⏳ **Update apikeyset.ts** to use provider factory  
- ⏳ **Update model.ts** to make model choices dynamic based on provider
- ⏳ **Check contextBuilder.ts** for any provider-specific references

## Pending Tasks ⏳

### Phase 4: Configuration Updates
- ⏳ Update database configuration for dynamic model choices
- ⏳ Make LLM model lists provider-aware instead of hardcoded

### Phase 5: Testing & Validation  
- ⏳ Test basic chat functionality with Google provider
- ⏳ Test function calling (stickers, search, self-teach)
- ⏳ Test streaming behavior
- ⏳ Validate error handling
- ⏳ Test API key validation through provider

## Files Modified

### New Files Created
- `src/providers/base/Provider.ts` - Provider interface definition
- `src/providers/ProviderFactory.ts` - Provider factory implementation  
- `src/providers/google/GoogleProvider.ts` - Google provider implementation

### Modified Files
- `src/events/messageCreate/tomoriChat.ts` - Main chat handler refactored
  - Removed direct Gemini imports
  - Added provider factory usage
  - Updated function call handling
  - Converted provider-specific types

### Files Pending Updates
- `src/commands/config/setup.ts` - API key validation
- `src/commands/config/apikeyset.ts` - API key validation
- `src/commands/config/model.ts` - Dynamic model choices
- `src/utils/text/contextBuilder.ts` - Check for provider references

## Testing Strategy

Before continuing with remaining tasks, we should test:

1. **Basic Chat Functionality**
   - Start TomoriBot and test basic chat responses
   - Verify streaming still works properly
   - Check that provider selection works correctly

2. **Function Calling**
   - Test sticker selection function
   - Test Google search function  
   - Test self-teaching memory function

3. **Error Handling**
   - Test with invalid provider configuration
   - Test provider factory error cases
   - Verify graceful degradation

## Next Steps

1. **Immediate Testing**: Test current refactored chat functionality
2. **Complete Remaining Files**: Update setup.ts, apikeyset.ts, model.ts
3. **Dynamic Configuration**: Make model choices provider-aware
4. **Future Providers**: Add OpenAI/Anthropic when ready

## TomoriChat Flow Architecture

### Complete Flow Diagram

```mermaid
flowchart TD
    A[Discord Message Received] --> B{Guild Channel?}
    B -->|No| C[Send DM Error & Exit]
    B -->|Yes| D[Check Permissions]
    D --> E{Has Send Permission?}
    E -->|No| F[Exit Silently]
    E -->|Yes| G[**SEMAPHORE**: Check Channel Lock]
    
    G --> H{Channel Locked?}
    H -->|Yes| I[Load Early Tomori State]
    I --> J{Would Tomori Reply?}
    J -->|Yes| K[Enqueue Message & Send Busy Notice]
    J -->|No| L[Ignore Message]
    K --> M[Exit - Wait for Processing]
    L --> M
    H -->|No| N[**ACQUIRE LOCK** for Channel]
    
    N --> O[Load Tomori State & User Data]
    O --> P{Tomori Setup?}
    P -->|No| Q[Exit - Not Setup]
    P -->|Yes| R[Check Trigger Words/Reply]
    R --> S{Direct Trigger?}
    S -->|Yes| T[Validate API Key Exists]
    S -->|No| U[Continue to Auto-Counter]
    T --> V{API Key Valid?}
    V -->|No| W[Send Error & Exit]
    V -->|Yes| U
    
    U[Update Auto-Counter] --> X[shouldBotReply Check]
    X --> Y{Should Reply?}
    Y -->|No| Z[Exit]
    Y -->|Yes| AA[Fetch Message History]
    AA --> BB[Build Context Items]
    BB --> CC[Load Emojis & Memories]
    
    %% THIS IS WHERE MODULARITY BEGINS (Step 12)
    CC --> DD[**🎯 GET PROVIDER**<br/>getProviderForTomori]
    DD --> EE{Provider Supported?}
    EE -->|No| FF[Send Provider Error & Exit]
    EE -->|Yes| GG[**🎯 CREATE CONFIG**<br/>provider.createConfig]
    
    GG --> HH[**🎯 START STREAMING**<br/>provider.streamToDiscord]
    HH --> II[Function Call Loop]
    II --> JJ{Function Called?}
    JJ -->|No| KK[Stream Text to Discord]
    JJ -->|Yes| LL[Execute Function Locally]
    LL --> MM{Function Type?}
    MM -->|Sticker| NN[Find & Select Sticker]
    MM -->|Search| OO[Execute Google Search SubAgent]
    MM -->|Memory| PP[Save to Database]
    NN --> QQ[Add to Function History]
    OO --> QQ
    PP --> QQ
    QQ --> II
    
    KK --> RR{Stream Complete?}
    RR -->|No| II
    RR -->|Yes| SS[Send Selected Sticker]
    SS --> TT[**RELEASE LOCK**]
    TT --> UU[Process Next in Queue]
    
    %% Error paths
    FF --> TT
    W --> TT
    Q --> TT
    Z --> TT

    %% Styling
    classDef modular fill:#e1f5fe
    classDef semaphore fill:#fff3e0
    classDef provider fill:#f3e5f5
    
    class DD,GG,HH modular
    class G,H,N,TT semaphore
    class MM,NN,OO,PP provider
```

### Architectural Change: Before vs After

```mermaid
graph TB
    subgraph "BEFORE: Tightly Coupled Architecture"
        A1[tomoriChat.ts] --> B1[Direct @google/genai imports]
        A1 --> C1[Direct streamGeminiToDiscord call]
        A1 --> D1[Hardcoded if provider !== 'google']
        A1 --> E1[Hard-typed GeminiConfig]
    end
    
    subgraph "AFTER: Modular Provider Architecture"
        A2[tomoriChat.ts] --> F2[ProviderFactory.getProvider]
        F2 --> G2{Switch on llm_provider}
        G2 -->|google| H2[GoogleProvider]
        G2 -->|openai| I2[OpenAIProvider<br/>🚧 Future]
        G2 -->|anthropic| J2[AnthropicProvider<br/>🚧 Future]
        
        A2 --> K2[provider.createConfig]
        A2 --> L2[provider.streamToDiscord]
        
        H2 --> M2[Wraps existing streamGeminiToDiscord]
        I2 --> N2[Future: OpenAI streaming]
        J2 --> O2[Future: Claude streaming]
    end

    classDef old fill:#ffebee
    classDef new fill:#e8f5e8
    classDef future fill:#fff3e0
    
    class A1,B1,C1,D1,E1 old
    class A2,F2,K2,L2 new
    class I2,J2,N2,O2 future
```

### Key Process Phases

#### Phase 1: Discord & Security Layer (Steps 1-11)
**Provider Agnostic - No Changes Needed**
- Message validation and permissions
- Channel locking/semaphore system
- User authentication and rate limiting
- Context building and message history

#### Phase 2: LLM Provider Layer (Step 12+) 
**🎯 This is where our refactoring transformed the architecture**

**BEFORE:**
```typescript
// Hard-coded provider check
if (tomoriState.llm_provider !== "google") return;

// Direct Gemini configuration
const geminiConfig: GeminiConfig = { /* hardcoded */ };

// Direct function call
await streamGeminiToDiscord(config, ...);
```

**AFTER:**
```typescript
// Dynamic provider selection
const provider = getProviderForTomori(tomoriState);

// Provider-agnostic configuration
const config = provider.createConfig(tomoriState, apiKey);

// Interface-based streaming
const result = await provider.streamToDiscord(config, ...);
```

#### Phase 3: Function Execution Layer
**Abstracted but Provider-Aware**
- Function calls (stickers, search, memory) are executed locally
- Results are passed back to the provider in their expected format
- Provider handles the LLM communication details

### Critical Modularity Boundary

**Line 770-774 in tomoriChat.ts is the exact point where modularity begins:**

```typescript
// 12. Generate Response - Get provider instance
// Get the appropriate provider based on TomoriState configuration  
let provider: LLMProvider;
try {
    provider = getProviderForTomori(tomoriState);  // 🎯 MODULARITY STARTS HERE
```

**Everything before this line:** Provider-agnostic application logic
**Everything after this line:** Uses provider interface methods

## Notes

- All existing Gemini functionality has been preserved through the GoogleProvider wrapper
- Provider factory uses singleton pattern for efficiency  
- Error handling includes proper logging with context
- Type safety maintained throughout the refactor
- **The semaphore system ensures only one message processes per channel at a time**
- **Function calling happens locally, with results fed back to the provider**
- Ready for immediate testing of core chat functionality