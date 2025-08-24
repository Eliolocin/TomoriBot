# Architecture

TomoriBot uses a **modular architecture** that separates concerns into distinct, reusable systems. This design enables easy extension, testing, and maintenance while supporting multiple LLM providers and dynamic tool management.

## Tech Stack

- **TypeScript+Zod** for type-checking on compile and runtime
- **Bun** as the runtime and tooling manager
- **Discord.js** for bot-client interaction
- **PostgreSQL** as the primary database
- **LLM API integration** (Google's Gemini, with OpenAI/Anthropic planned)
- **GitHub Actions** for CI/CD pipelines and linting
- **AWS Cloud** for hosting and deployment (soon™)

## Project Structure

```
TomoriBot/
├─ scripts/                     ← CLI helpers and maintenance tools
│   ├─ clean-dist.ts            ← wipe build artifacts
│   ├─ nuke-db.ts               ← drop + recreate dev database
│   ├─ purge-commands.ts        ← bulk-delete Discord slash commands
│   └─ seed-db.ts               ← run schema.sql + seed.sql
└─ src/                         ← **core application code**
    ├─ commands/                ← slash-command implementations
    │   ├─ config/              ← /config sub-commands
    │   ├─ tool/                ← /tool sub-commands
    │   └─ ...                  ← organized by category
    ├─ db/                      ← database definitions
    │   ├─ schema.sql           ← PostgreSQL schema
    │   └─ seed.sql             ← initial data
    ├─ events/                  ← Discord gateway event handlers
    │   ├─ guildCreate/         ← server join events
    │   ├─ messageCreate/       ← message processing
    │   │   └─ tomoriChat.ts    ← **main chat logic**
    │   ├─ ready/               ← bot startup events
    │   └─ ...
    ├─ handlers/                ← event orchestration
    │   └─ eventHandler.ts
    ├─ locales/                 ← internationalization
    │   ├─ en.ts
    │   └─ ja.json
    ├─ providers/               ← **LLM provider abstraction**
    │   └─ google/              ← Google Gemini implementation
    │       ├─ googleProvider.ts
    │       ├─ googleStreamAdapter.ts
    │       ├─ googleToolAdapter.ts
    │       └─ subAgents.ts
    ├─ tools/                   ← **modular tool system**
    │   ├─ toolRegistry.ts      ← central registry & execution
    │   ├─ toolInitializer.ts   ← discovery & registration
    │   ├─ functionCalls/       ← built-in tools
    │   │   ├─ stickerTool.ts
    │   │   ├─ memoryTool.ts
    │   │   └─ youTubeVideoTool.ts
    │   └─ mcpServers/          ← **MCP server integration**
    │       ├─ brave-search/
    │       ├─ fetch/
    │       └─ duckduckgo-search/
    ├─ types/                   ← **organized type system**
    │   ├─ api/                 ← external API types
    │   ├─ db/                  ← database schema types
    │   ├─ discord/             ← Discord-specific types
    │   ├─ provider/            ← provider interfaces
    │   ├─ stream/              ← streaming system types
    │   ├─ tool/                ← tool system types
    │   └─ misc/                ← utility types
    ├─ utils/                   ← domain-organized utilities
    │   ├─ db/                  ← database operations
    │   ├─ discord/             ← Discord utilities
    │   │   └─ streamOrchestrator.ts ← universal streaming
    │   ├─ provider/            ← provider utilities
    │   ├─ mcp/                 ← MCP system utilities
    │   ├─ security/            ← crypto and security
    │   ├─ text/                ← text processing
    │   └─ misc/                ← general utilities
    └─ index.ts                 ← application entry point
```

## Key Architectural Changes

TomoriBot has undergone significant architectural evolution to achieve its current modular design:

### 🏗️ Provider Abstraction System
**Complete refactor from Google-locked to modular LLM providers**

- `ProviderFactory` dynamically selects providers based on configuration
- `GoogleProvider` implements `LLMProvider` interface
- Ready for OpenAI, Anthropic, and future providers
- Provider-agnostic tool execution and streaming

### ⚡ Modular Tool System
**Transformed from 300+ lines of inline code to clean registry**

- Tools implement generic `Tool` interface
- `ToolRegistry` handles discovery, execution, and permission management
- Provider adapters convert tools to provider-specific formats
- Automatic tool discovery via file system scanning

### 🌊 Streaming Modularization
**Universal Discord text streaming logic extracted from provider-specific code**

- `StreamOrchestrator` handles all Discord integration (600+ lines of reusable logic)
- Provider `StreamAdapter`s handle LLM-specific streaming (150-200 lines each)
- Consistent typing simulation, rate limiting, and error recovery

### 📁 Type Organization
**Logical separation of types by domain**

- Stream types in `src/types/stream/`
- Tool types in `src/types/tool/`
- Provider types in `src/types/provider/`
- Runtime validation with Zod schemas

## Core Design Patterns

### Provider Pattern
All LLM integrations implement the same `LLMProvider` interface, enabling seamless switching between different AI services.

### Registry Pattern
Tools and providers are automatically discovered and registered at startup, reducing boilerplate and enabling hot-pluggable functionality.

### Adapter Pattern
Provider-specific adapters convert generic tools and streaming logic to provider-specific formats, maintaining compatibility across different APIs.

### Context Pattern
Rich context objects carry state and configuration through the application, enabling sophisticated features like context-aware tool availability.

---

**Next**: Explore the [Provider System](03-providers.md) and learn how LLM integrations work.