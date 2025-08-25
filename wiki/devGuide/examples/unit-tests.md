# Unit Testing - Quality CI/CD Pipeline

This guide helps contributors write effective unit tests for TomoriBot's CI/CD pipeline. We focus on **quality over quantity** - testing critical paths that ensure reliability and prevent regressions.

## Test Architecture

### Recommended Structure

```
TomoriBot/
├─ src/                           ← Source code
│   ├─ tools/
│   │   ├─ memoryTool.ts
│   │   └─ memoryTool.test.ts     ← Unit tests alongside source
│   └─ providers/
│       └─ google/
│           ├─ googleProvider.ts
│           └─ googleProvider.test.ts
├─ tests/                         ← Integration & E2E tests
│   ├─ integration/
│   │   ├─ database.test.ts
│   │   └─ provider-streaming.test.ts
│   └─ e2e/
│       └─ discord-interactions.test.ts
└─ package.json                   ← Test scripts
```

### Bun Test Configuration

**File**: `package.json` (add test scripts)

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test src/",
    "test:integration": "bun test tests/integration/",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage"
  }
}
```

## Critical Testing Priorities

### 1. Tool Execution (High Priority)

Tools are core functionality - test execution, error handling, and context-aware availability.

**File**: `src/tools/functionCalls/memoryTool.test.ts`

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MemoryTool } from "./memoryTool";
import type { ToolContext } from "../../types/tool/interfaces";

describe("MemoryTool", () => {
  let memoryTool: MemoryTool;
  let mockContext: ToolContext;

  beforeEach(() => {
    memoryTool = new MemoryTool();
    mockContext = createMockToolContext();
  });

  test("should execute successfully with valid parameters", async () => {
    const args = {
      memory_content: "User likes pizza",
      memory_scope: "target_user",
      target_user_discord_id: "123456789"
    };

    const result = await memoryTool.execute(args, mockContext);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  test("should fail with invalid parameters", async () => {
    const args = {}; // Missing required parameters

    const result = await memoryTool.execute(args, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid parameters");
  });

  test("should be available for all providers", () => {
    expect(memoryTool.isAvailableFor("google")).toBe(true);
    expect(memoryTool.isAvailableFor("openai")).toBe(true);
  });

  // Test context-aware availability if implemented
  test("should respect context-aware availability", () => {
    const contextWithDisabled = {
      ...mockContext,
      streamContext: { disableMemoryTools: true }
    };

    if (memoryTool.isAvailableForContext) {
      expect(memoryTool.isAvailableForContext("google", contextWithDisabled)).toBe(false);
    }
  });
});

// Mock helper function
function createMockToolContext(): ToolContext {
  return {
    channel: {} as any,
    client: {} as any,
    tomoriState: {
      server_id: 1,
      discord_server_id: "123",
      config: {},
      llm: { llm_provider: "google" }
    } as any,
    locale: "en-US",
    provider: "google"
  };
}
```

### 2. Provider Streaming (High Priority)

Test provider implementations, especially streaming and function calling.

**File**: `src/providers/google/googleStreamAdapter.test.ts`

```typescript
import { describe, test, expect, mock } from "bun:test";
import { GoogleStreamAdapter } from "./googleStreamAdapter";

describe("GoogleStreamAdapter", () => {
  test("should process text chunks correctly", () => {
    const adapter = new GoogleStreamAdapter();
    const mockChunk = {
      raw: {
        candidates: [{
          content: {
            parts: [{ text: "Hello world" }]
          }
        }]
      },
      provider: "google",
      timestamp: Date.now()
    };

    const processed = adapter.processChunk(mockChunk);

    expect(processed.type).toBe("text");
    expect(processed.text).toBe("Hello world");
  });

  test("should handle function calls", () => {
    const adapter = new GoogleStreamAdapter();
    const mockFunctionChunk = {
      raw: {
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: "remember_this_fact",
                args: { memory_content: "test" }
              }
            }]
          }
        }]
      },
      provider: "google",
      timestamp: Date.now()
    };

    const processed = adapter.processChunk(mockFunctionChunk);

    expect(processed.type).toBe("function_call");
    expect(processed.functionCall?.name).toBe("remember_this_fact");
  });
});
```

### 3. Database Operations (Medium Priority)

Test critical database operations and data integrity.

**File**: `tests/integration/database.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getTomoriStateByGuildId, addPersonalMemoryByTomori } from "../../src/utils/db/dbRead";

describe("Database Operations", () => {
  const TEST_GUILD_ID = "test-guild-123";
  
  beforeEach(async () => {
    // Set up test data
    await setupTestDatabase();
  });

  afterEach(async () => {
    // Clean up test data
    await cleanupTestDatabase();
  });

  test("should retrieve TomoriState by guild ID", async () => {
    const state = await getTomoriStateByGuildId(TEST_GUILD_ID);
    
    expect(state).not.toBeNull();
    expect(state?.discord_server_id).toBe(TEST_GUILD_ID);
  });

  test("should add personal memory", async () => {
    const userDiscordId = "test-user-123";
    const memoryContent = "Test memory content";

    await expect(
      addPersonalMemoryByTomori(userDiscordId, TEST_GUILD_ID, memoryContent)
    ).resolves.not.toThrow();
  });

  test("should handle invalid guild ID gracefully", async () => {
    const state = await getTomoriStateByGuildId("invalid-guild");
    expect(state).toBeNull();
  });
});

async function setupTestDatabase() {
  // Create test server and user data
  // Implementation depends on your test database setup
}

async function cleanupTestDatabase() {
  // Remove test data
  // Implementation depends on your test database setup
}
```

### 4. Context-Aware Tools (Medium Priority)

Test the sophisticated context-aware availability system.

**File**: `src/tools/functionCalls/youTubeVideoTool.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { YouTubeVideoTool } from "./youTubeVideoTool";
import type { ToolContext } from "../../types/tool/interfaces";

describe("YouTubeVideoTool - Context Awareness", () => {
  test("should be available for Google provider", () => {
    const tool = new YouTubeVideoTool();
    expect(tool.isAvailableFor("google")).toBe(true);
    expect(tool.isAvailableFor("openai")).toBe(false);
  });

  test("should respect YouTube processing disable flag", () => {
    const tool = new YouTubeVideoTool();
    const context: Partial<ToolContext> = {
      streamContext: {
        disableYouTubeProcessing: true
      }
    };

    if (tool.isAvailableForContext) {
      expect(tool.isAvailableForContext("google", context as ToolContext)).toBe(false);
    }
  });

  test("should be available when YouTube processing is enabled", () => {
    const tool = new YouTubeVideoTool();
    const context: Partial<ToolContext> = {
      streamContext: {
        disableYouTubeProcessing: false
      }
    };

    if (tool.isAvailableForContext) {
      expect(tool.isAvailableForContext("google", context as ToolContext)).toBe(true);
    }
  });
});
```

## Mock Strategies

### Discord API Mocking

```typescript
// Mock Discord client and channel
const mockDiscordClient = {
  user: { id: "bot-id" },
  // ... other properties as needed
};

const mockChannel = {
  id: "channel-id",
  send: mock(() => Promise.resolve({ id: "message-id" })),
  // ... other methods as needed
};
```

### External API Mocking

```typescript
// Mock Google AI API
global.fetch = mock(() => 
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ candidates: [] }),
    body: {
      getReader: () => ({
        read: () => Promise.resolve({ done: true, value: null })
      })
    }
  })
);
```

## CI/CD Integration

### GitHub Actions Configuration

**File**: `.github/workflows/test.yml`

```yaml
name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: tomoribot_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      
      - name: Install dependencies
        run: bun install
      
      - name: Run unit tests
        run: bun test:unit
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/tomoribot_test
          CRYPTO_SECRET: test-secret-for-testing-only
      
      - name: Run integration tests
        run: bun test:integration
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/tomoribot_test
```

### Test Coverage Requirements

Set coverage thresholds in `package.json`:

```json
{
  "bun": {
    "test": {
      "coverage": {
        "threshold": {
          "line": 70,
          "function": 70,
          "branch": 60
        }
      }
    }
  }
}
```

## Testing Checklist

### Before Writing Tests
- [ ] Identify critical code paths
- [ ] Understand component dependencies  
- [ ] Plan mock strategies
- [ ] Consider edge cases and error scenarios

### Test Quality Standards
- [ ] **Clear test names** - describe what is being tested
- [ ] **Arrange, Act, Assert** pattern
- [ ] **One assertion per test** (generally)
- [ ] **Mock external dependencies**
- [ ] **Clean up after tests** (database, files, etc.)

### CI/CD Requirements
- [ ] Tests run in isolated environment
- [ ] No hardcoded credentials or secrets
- [ ] Database tests use test database
- [ ] Tests are deterministic (no flaky tests)
- [ ] Reasonable execution time (< 5 minutes total)

## Pro Tips

### Focus on High-Impact Areas
1. **Tool execution logic** - Core bot functionality
2. **Provider streaming** - Complex async operations
3. **Database integrity** - Data consistency
4. **Error handling** - Graceful failure modes
5. **Context-aware availability** - Business logic

### Write Tests That Catch Regressions
Focus on tests that would catch breaking changes during refactoring or new feature development.

### Use Bun's Speed Advantage
Bun's test runner is extremely fast - write comprehensive unit tests without worrying about execution time.

Quality unit tests ensure TomoriBot remains reliable as it grows! 🧪✅

---

**Related**: [Contributing Guidelines](../09-contributing.md) for test submission requirements