# TomoriBot Code Handbook

This handbook contains coding rules and patterns to follow during development, organized by domain for easy reference.

## Handbook Structure

### [Database Rules](./database.md)
Rules for database interactions, schema validation, SQL patterns, and data persistence:
- Zod validation for external inputs
- Bun SQL template literals usage
- Schema organization and UPSERT patterns
- PostgreSQL best practices and array operations
- Session helpers and error logging

### [Discord & UI Rules](./discord.md) 
Rules for Discord interactions, UI components, and user interface patterns:
- Helper functions for interactive components
- Consistent Discord interaction utilities
- Smart helper usage for embed/modal patterns
- Modal interaction lifecycle management
- Command structure and organization

### [General Code Rules](./general.md)
General coding practices, documentation, and code organization:
- JSDoc documentation standards
- Bun runtime preferences over Node.js
- Text localization with i18n utilities
- Type organization in /types/ folder structure
- Logging standards and configuration constants
- RUG principle and avoiding placeholder comments

### [Architecture Rules](./architecture.md)
Rules for the modular architecture, provider systems, and extensibility:
- LLM provider interface implementation
- Two-layer streaming architecture separation
- Tool system integration and development
- MCP server integration patterns
- Type safety standards and provider-agnostic design
- Modular extensibility principles

## Usage

Each handbook file focuses on a specific domain and provides:
- **Rule Title**: Concise description combining the purpose and reason
- **Code Examples**: ✅ DO and ❌ DON'T patterns with explanations
- **Implementation Guidance**: Specific steps for following the rule

## Key Principles

1. **Modularity**: New features should use the modular tool/provider systems
2. **Provider Agnostic**: Avoid hardcoding specific LLM provider logic in core files  
3. **Type Safety**: All interfaces properly typed with Zod validation
4. **Error Handling**: Comprehensive error logging with context
5. **Documentation**: JSDoc comments for all public functions
6. **Consistency**: Use established helpers and utilities for common patterns