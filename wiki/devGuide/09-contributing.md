# Contributing Guidelines

Welcome to TomoriBot development! This guide covers our development workflow, coding standards, and best practices to help you contribute effectively to the project.

## Development Workflow

### Getting Started

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/your-username/TomoriBot.git
   cd TomoriBot
   git remote add upstream https://github.com/original-org/TomoriBot.git
   ```

2. **Set up Environment**:
   ```bash
   bun install
   cp .env.example .env
   # Configure your .env file with required variables
   bun run seed-db
   ```

3. **Create Feature Branch**:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

### Development Process

1. **Make Changes**: Implement your feature or fix
2. **Test Thoroughly**: 
   ```bash
   bun run check    # TypeScript compilation
   bun run lint     # Code formatting and linting
   bun run dev      # Test in development mode
   ```
3. **Commit Changes**: Follow conventional commit format
4. **Create Pull Request**: Submit for review

### Commit Convention

Use **Conventional Commits** format:

```
type(scope): description

[optional body]

[optional footer]
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples**:
```bash
git commit -m "feat(tools): add weather forecast tool"
git commit -m "fix(memory): resolve memory leak in PostgreSQL connections"
git commit -m "docs(providers): update OpenAI provider documentation"
```

## Code Standards

### File Naming Convention

**Use camelCase for all file names**:
```
✅ Good:
- youTubeVideoTool.ts
- memoryTool.ts
- googleStreamAdapter.ts

❌ Bad:
- youtube-video-tool.ts
- memory_tool.ts
- GoogleStreamAdapter.ts
```

### TypeScript Best Practices

#### Type Organization
Place types in appropriate `src/types/` subdirectories:

```typescript
// src/types/tool/interfaces.ts
export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// src/types/provider/interfaces.ts
export interface LLMProvider {
  streamToDiscord(...args): Promise<StreamResult>;
}
```

#### Interface Design
- Use explicit interfaces instead of `any`
- Provide comprehensive JSDoc documentation
- Use generic types for reusable components

```typescript
/**
 * Executes a tool with the given arguments and context
 * @param args - Tool-specific arguments validated against schema
 * @param context - Execution context with Discord and Tomori state
 * @returns Promise resolving to tool execution result
 */
async execute(
  args: Record<string, unknown>, 
  context: ToolContext
): Promise<ToolResult> {
  // Implementation
}
```

#### Error Handling
Always provide comprehensive error handling:

```typescript
try {
  const result = await riskyOperation();
  return { success: true, data: result };
} catch (error) {
  log.error(`Operation failed: ${operation}`, error as Error);
  return { 
    success: false, 
    error: error instanceof Error ? error.message : 'Unknown error',
    message: 'User-friendly error description'
  };
}
```

### Architecture Principles

#### 1. Modularity
New features should use the modular tool/provider systems:

```typescript
// ✅ Good: Extend existing systems
export class WeatherTool extends BaseTool {
  name = "get_weather";
  // ...
}

// ❌ Bad: Hardcode into core logic
if (message.content.includes("weather")) {
  // inline weather logic
}
```

#### 2. Provider Agnostic
Avoid hardcoding specific LLM provider logic in core files:

```typescript
// ✅ Good: Provider abstraction
const provider = getProviderForTomori(tomoriState);
const result = await provider.streamToDiscord(...);

// ❌ Bad: Provider-specific logic
if (tomoriState.provider === 'google') {
  // Google-specific logic in core file
}
```

#### 3. Type Safety
All interfaces should be properly typed with Zod validation:

```typescript
// Define schema
const ToolParameterSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional().default(10)
});

// Runtime validation
const validation = ToolParameterSchema.safeParse(args);
if (!validation.success) {
  return { success: false, error: "Invalid parameters" };
}
```

#### 4. Documentation
JSDoc comments for all public functions and interfaces:

```typescript
/**
 * Context-aware tool availability checker
 * 
 * Allows tools to dynamically hide themselves based on runtime conditions
 * like streaming context, user permissions, or operational modes.
 * 
 * @param provider - LLM provider name (e.g., "google", "openai")
 * @param context - Optional tool context with streaming and user data
 * @returns True if tool should be available for the given context
 * 
 * @example
 * ```typescript
 * // Hide tool during maintenance mode
 * isAvailableForContext(provider: string, context?: ToolContext): boolean {
 *   if (context?.streamContext?.operationMode === 'maintenance') return false;
 *   return this.isAvailableFor(provider);
 * }
 * ```
 */
isAvailableForContext?(provider: string, context?: ToolContext): boolean;
```

## Development Patterns

### Tool Development

Follow the established tool pattern:

```typescript
export class MyNewTool extends BaseTool {
  name = "my_new_tool";
  description = "Clear description of what the tool does";
  category = "utility" as const;
  
  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      param: { type: "string", description: "Parameter description" }
    },
    required: ["param"]
  };
  
  // Optional: Provider compatibility
  isAvailableFor(provider: string): boolean {
    return provider === "google"; // or true for all providers
  }
  
  // Optional: Context-aware availability
  isAvailableForContext(provider: string, context?: ToolContext): boolean {
    if (!this.isAvailableFor(provider)) return false;
    // Add context-specific logic here
    return true;
  }
  
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Validate parameters
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return { success: false, error: "Invalid parameters" };
    }
    
    try {
      // Tool implementation
      const result = await performOperation(args.param as string);
      return { success: true, data: result };
    } catch (error) {
      log.error(`MyNewTool execution failed`, error as Error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : "Unknown error" 
      };
    }
  }
}
```

### Provider Development

Implement the full provider interface:

```typescript
export class MyProvider extends BaseLLMProvider {
  getProviderInfo(): ProviderInfo {
    return {
      name: "myprovider",
      version: "1.0.0",
      supportsStreaming: true,
      supportsFunctionCalling: true
    };
  }
  
  async validateApiKey(apiKey: string): Promise<boolean> {
    // Implementation
  }
  
  async createConfig(tomoriState: TomoriState, apiKey: string): Promise<ProviderConfig> {
    // Implementation
  }
  
  async getTools(tomoriState: TomoriState): Promise<Array<Record<string, unknown>>> {
    // Implementation
  }
  
  async streamToDiscord(...args): Promise<StreamResult> {
    // Implementation using StreamOrchestrator
  }
}
```

## Testing Guidelines

### Manual Testing Checklist

Before submitting a PR, test:

- [ ] **TypeScript Compilation**: `bun run check` passes
- [ ] **Linting**: `bun run lint` passes with no errors
- [ ] **Build Process**: `bun run build` succeeds
- [ ] **Development Mode**: `bun run dev` works without errors
- [ ] **Discord Integration**: Bot connects and responds properly
- [ ] **Database Operations**: No connection leaks or errors
- [ ] **Error Handling**: Graceful handling of edge cases

### Testing New Features

When adding new functionality:

1. **Unit Test Logic**: Test core functionality in isolation
2. **Integration Testing**: Test with Discord and database
3. **Provider Compatibility**: Test with different LLM providers
4. **Error Scenarios**: Test failure cases and recovery
5. **Performance**: Verify no memory leaks or performance regression

## Code Quality

### Biome Configuration

TomoriBot uses Biome for formatting and linting:

```json
// biome.json
{
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  }
}
```

### Quality Standards

- **Zero TypeScript Errors**: All code must compile without errors
- **Zero Linting Issues**: All Biome rules must pass
- **Comprehensive Error Handling**: Every operation should handle failures gracefully
- **Type Safety**: Avoid `any` types; use proper interfaces
- **Documentation**: Public APIs require JSDoc comments

## Pull Request Process

### Before Submitting

1. **Sync with Upstream**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Final Checks**:
   ```bash
   bun run check
   bun run lint
   bun run build
   ```

3. **Clean Commit History**: Squash or organize commits logically

### PR Description Template

```markdown
## Description
Brief description of changes and motivation.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] TypeScript compilation passes
- [ ] Linting passes
- [ ] Manual testing completed
- [ ] Database migrations tested (if applicable)

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or clearly documented)
```

### Review Process

1. **Automated Checks**: CI pipeline must pass
2. **Code Review**: Maintainer review for architecture and quality
3. **Testing**: Functionality verification
4. **Merge**: Squash and merge after approval

## Getting Help

### Resources

- **Documentation**: Check existing docs first
- **Code Examples**: Look at similar implementations
- **Issue Tracker**: Search for related issues

### Communication

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Architecture discussions and questions
- **Pull Request Comments**: Implementation-specific feedback

### Common Questions

**"How do I add a new tool?"**
- See [Creating a New Tool](../examples/creating-new-tool.md)

**"How do I add a new provider?"**
- See [Adding a New Provider](../examples/adding-new-provider.md)

**"How do I implement context-aware tools?"**
- See [Context-Aware Tool Implementation](../examples/implementing-context-aware-tool.md)

---

Thank you for contributing to TomoriBot! Your contributions help make the project better for everyone. 🚀