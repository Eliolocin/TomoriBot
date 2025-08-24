# Context-Aware Tool Availability

TomoriBot features a **sophisticated context-aware tool system** that allows tools to dynamically show/hide themselves based on runtime conditions. This enables advanced functionality like preventing tool hallucination, managing user permissions, and adapting tool availability to different operational modes.

## Architecture Overview

The system uses a **two-tier availability checking** pattern:

1. **Basic Availability** (`isAvailableFor`): Static provider compatibility check
2. **Context-Aware Availability** (`isAvailableForContext`): Dynamic runtime condition check

```typescript
interface Tool {
    // Required: Basic provider compatibility  
    isAvailableFor(provider: string): boolean;
    
    // Optional: Context-aware dynamic availability
    isAvailableForContext?(provider: string, context?: ToolContext): boolean;
}
```

## Implementation Pattern

### Tool Registry Integration

The tool registry automatically uses context-aware checking when available:

```typescript
// Tool registry automatically uses context-aware checking when available
const isToolAvailable = 'isAvailableForContext' in tool && typeof tool.isAvailableForContext === 'function'
    ? tool.isAvailableForContext(provider, context)
    : tool.isAvailableFor(provider);
```

### Provider Integration

Providers can reload tools with streaming context for dynamic availability:

```typescript
// Providers can reload tools with streaming context for dynamic availability
async getTools(tomoriState: TomoriState, streamingContext?: StreamingContext): Promise<Tool[]> {
    if (streamingContext) {
        // Filter tools using context-aware availability
        return tools.filter(tool => 
            tool.isAvailableForContext?.(provider, { streamContext: streamingContext }) ?? 
            tool.isAvailableFor(provider)
        );
    }
    // Standard tool loading
}
```

## Real-World Example: YouTube Tool

The YouTube video processing tool demonstrates the full power of this architecture:

```typescript
export class YouTubeVideoTool extends BaseTool {
    // Basic availability: Google provider only
    isAvailableFor(provider: string): boolean {
        return provider === "google";
    }
    
    // Context-aware: Hide during enhanced context restart to prevent hallucination
    isAvailableForContext(provider: string, context?: ToolContext): boolean {
        if (!this.isAvailableFor(provider)) return false;
        
        // Completely hide tool during enhanced context restart
        if (context?.streamContext?.disableYouTubeProcessing) {
            log.info("YouTubeVideoTool: Temporarily disabled during enhanced context restart");
            return false;
        }
        
        return true;
    }
}
```

**Result**: During enhanced context restart, the YouTube tool becomes **completely invisible** to the AI, preventing hallucination attempts entirely.

## Advanced Use Cases

### 1. User Permission Levels

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    const userLevel = context?.streamContext?.userPermissionLevel;
    if (this.requiresPremium && userLevel !== 'premium') return false;
    return this.isAvailableFor(provider);
}
```

### 2. Safety Modes

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    if (context?.streamContext?.safeMode && this.category === 'experimental') return false;
    return this.isAvailableFor(provider);
}
```

### 3. Operation-Specific Tool Hiding

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    // Prevent search tools during search operations to avoid recursion
    if (context?.streamContext?.disableSearchDuringProcessing && this.category === 'search') {
        return false;
    }
    return this.isAvailableFor(provider);
}
```

### 4. Time-Based Availability

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    const currentHour = new Date().getHours();
    if (this.requiresDaytime && (currentHour < 6 || currentHour > 22)) return false;
    return this.isAvailableFor(provider);
}
```

### 5. Resource-Based Availability

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    const systemLoad = context?.streamContext?.systemLoad;
    if (this.isResourceIntensive && systemLoad === 'high') return false;
    return this.isAvailableFor(provider);
}
```

## Streaming Context Architecture

The `StreamingContext` interface enables rich contextual information:

```typescript
interface StreamingContext {
    // Current implementation
    disableYouTubeProcessing: boolean;
    
    // Future extensibility examples:
    // disableSearchTools?: boolean;
    // userPermissionLevel?: 'basic' | 'premium' | 'admin';
    // safeMode?: boolean;
    // operationMode?: 'normal' | 'debugging' | 'maintenance';
    // resourceConstraints?: 'low' | 'normal' | 'high';
    // systemLoad?: 'low' | 'normal' | 'high';
    // timeRestrictions?: TimeRestriction[];
}
```

## Implementation Flow

### 1. Context Creation
```typescript
// Streaming context is created at the top level
const streamingContext = {
    disableYouTubeProcessing: false,
    userPermissionLevel: getUserPermissionLevel(userId),
    safeMode: tomoriState.config.safe_mode_enabled,
};
```

### 2. Provider Tool Loading
```typescript
// Provider reloads tools with context when available
if (streamingContext) {
    log.info("GoogleProvider: Reloading tools with streaming context for context-aware availability");
    const contextAwareTools = await this.getTools(tomoriState, streamingContext);
    streamConfig.tools = contextAwareTools;
}
```

### 3. Dynamic Context Updates
```typescript
// Context can be updated during operation
if (detectYouTubeProcessingStart()) {
    streamingContext.disableYouTubeProcessing = true;
    // Tools are automatically filtered on next provider interaction
}
```

## Key Benefits

### 🎯 Prevents AI Hallucination
Tools can be completely hidden when inappropriate, eliminating failed function call attempts entirely.

### 🔐 Dynamic Permissions
Tools can adapt to user roles, subscription levels, or operational contexts without code changes.

### ⚡ Performance Optimization
Resource-intensive tools can be disabled during high-load periods or based on system constraints.

### 🛡️ Safety Controls
Potentially dangerous tools can be context-sensitively restricted based on safety modes or user trust levels.

### 🔄 Operational Modes
Tools can adapt to maintenance, debugging, or safe-mode operations automatically.

### 📈 Highly Extensible
New context conditions can be added without modifying existing tools - the pattern scales infinitely.

## Best Practices

### 1. Graceful Degradation
Always call the base `isAvailableFor` method first:
```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    if (!this.isAvailableFor(provider)) return false;
    // Additional context checks here
}
```

### 2. Clear Logging
Log availability decisions for debugging:
```typescript
if (context?.streamContext?.disableYouTubeProcessing) {
    log.info("YouTubeVideoTool: Temporarily disabled during enhanced context restart");
    return false;
}
```

### 3. Fail-Safe Defaults
When context is unavailable, default to basic availability:
```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
    // If no context, fall back to basic availability
    if (!context?.streamContext) return this.isAvailableFor(provider);
    
    // Context-aware logic here
}
```

## Architecture Impact

This architecture transforms static tool availability into a **dynamic, context-aware system** that enables sophisticated operational control while maintaining clean, modular code organization. It's a foundational pattern that enables:

- **Zero-hallucination tool management**
- **Dynamic permission systems**  
- **Intelligent resource management**
- **Advanced safety controls**
- **Operational mode adaptation**

The system is designed to be **highly extensible** - new context conditions can be added without modifying existing tools, making it a future-proof foundation for sophisticated AI tool management.

---

**Next**: Understand the complete [Message Flow](06-message-flow.md) and how all these systems work together.