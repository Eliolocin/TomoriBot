# Project Overview

TomoriBot is a highly customizable Discord bot powered by Large Language Models (LLMs). Users can personalize her behavior, personality, memory, and language, making her adaptable for both **roleplaying** and **practical use** in community servers thanks to her autonomous tool usage as well.

She is designed to be modular, developer-friendly, and easily deployable—ideal for experimenting with personality-driven AI interaction in social spaces.

## Core Features

- **Slash Command Support** - Modern Discord interaction patterns
- **Server and User-Based Memory Storage** - Persistent learning and context
- **Personality Presets and Editing** - Customizable AI personalities
- **Language Preference per User** - Multi-language support (English, Japanese)
- **Admin-Only Configuration** - Secure model selection and API key management
- **Modular Tool Use and Provider Support** - Extensible functionality system
- **CI/CD Ready** - DevOps-aligned project layout for production deployment

## Target Users

### Discord Server Owners
Server owners who want an interactive, helpful, or roleplay-capable AI bot that adapts to server needs and wants.

### Community Builders
Users interested in customizing AI personalities for social and community interaction, creating unique experiences for their members.

### Developers and Tinkerers
Developers and tinkerers experimenting with LLMs, memory systems, and Chatbot UX. TomoriBot's modular architecture makes it ideal for rapid prototyping and experimentation.

## Architecture Philosophy

TomoriBot is built on three core architectural principles:

### 🔧 **Modularity**
- Provider-agnostic LLM integration
- Pluggable tool system
- Composable components throughout

### 🎯 **Developer Experience**
- TypeScript-first with comprehensive type safety
- Hot-reload development environment
- Comprehensive documentation and examples

### 🚀 **Production Ready**
- Scalable database architecture
- Comprehensive error handling
- CI/CD pipeline integration
- Security-first design patterns

## Technology Highlights

- **Runtime**: Bun for fast TypeScript execution and package management
- **Database**: PostgreSQL with encrypted sensitive data storage
- **Discord Integration**: Modern Discord.js v14 with interaction support
- **AI Integration**: Modular provider system supporting multiple LLM APIs
- **Type Safety**: TypeScript + Zod for compile-time and runtime validation
- **Code Quality**: Biome for formatting and linting with GitHub Actions integration

---

**Next**: Learn about TomoriBot's [Architecture](02-architecture.md) and technical implementation details.