# TomoriBot Developer Documentation

Welcome to TomoriBot's comprehensive developer documentation! This guide will help you understand, contribute to, and extend TomoriBot's modular architecture.

## 📚 Documentation Structure

### 🏗️ Core Architecture
- **[01. Project Overview](devGuide/01-project-overview.md)** - Features, goals, and target users
- **[02. Architecture](devGuide/02-architecture.md)** - Tech stack, file structure, and modular design
- **[03. Provider System](devGuide/03-providers.md)** - LLM provider abstraction and implementation
- **[04. Tool System](devGuide/04-tools.md)** - Modular tools, registry, and MCP integration
- **[05. Context-Aware Tools](devGuide/05-context-aware-tools.md)** - Dynamic tool availability system
- **[06. Message Flow](devGuide/06-message-flow.md)** - Complete message processing architecture

### 🔧 Development & Deployment
- **[07. Database](devGuide/07-database.md)** - Schema, migrations, and data architecture
- **[08. Deployment](devGuide/08-deployment.md)** - CI/CD, hosting, and environment setup
- **[09. Contributing](devGuide/09-contributing.md)** - Development workflow and conventions

### 📋 Practical Examples
- **[Creating a New Tool](examples/creating-new-tool.md)** - Step-by-step tool development
- **[Adding a New Provider](examples/adding-new-provider.md)** - Implementing LLM providers
- **[Context-Aware Tool Implementation](examples/implementing-context-aware-tool.md)** - Advanced tool patterns

### 📖 Technical Reference
- **[API Interfaces](reference/api-interfaces.md)** - Complete interface specifications
- **[Configuration Options](reference/configuration-options.md)** - Environment and setup options
- **[Troubleshooting](reference/troubleshooting.md)** - Common issues and solutions

## 🚀 Quick Start Paths

### For New Contributors
1. Start with [Project Overview](devGuide/01-project-overview.md)
2. Understand the [Architecture](devGuide/02-architecture.md)
3. Review [Contributing Guidelines](devGuide/09-contributing.md)

### For Tool Development
1. Read [Tool System](devGuide/04-tools.md)
2. Explore [Context-Aware Tools](devGuide/05-context-aware-tools.md)
3. Follow [Creating a New Tool](examples/creating-new-tool.md) tutorial

### For Provider Development
1. Study [Provider System](devGuide/03-providers.md)
2. Review [Message Flow](devGuide/06-message-flow.md)
3. Follow [Adding a New Provider](examples/adding-new-provider.md) tutorial

## 🛠️ Development Commands

```bash
# Development
bun run dev              # Hot reload development mode
bun run build           # Build the project
bun run check           # TypeScript compilation check
bun run lint            # Biome linting

# Database
bun run seed-db         # Initialize with seed data
bun run nuke-db         # ⚠️ Completely wipe database

# Utilities
bun run clean-dist      # Clean build artifacts
bun run purge-commands  # Remove Discord slash commands
```

## 📞 Getting Help

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/your-repo/TomoriBot/issues)
- **Discussions**: Join development discussions in [GitHub Discussions](https://github.com/your-repo/TomoriBot/discussions)
- **Code Review**: All contributions welcome via pull requests

---

**TomoriBot** - A modular, extensible Discord AI bot built with TypeScript, PostgreSQL, and modern LLM integrations.