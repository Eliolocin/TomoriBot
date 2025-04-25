# TomoriBot System Patterns & Architecture

## 🏗️ Architecture Overview
- **Entry Point:** `src/index.ts` initializes the Discord client, loads environment variables, verifies the PostgreSQL schema and seed, and starts the event handler.
- **Event Handler:** `src/handlers/eventHandler.ts` dynamically loads and attaches all event listeners (guildCreate, interactionCreate, messageCreate, ready, etc.)
- **Slash Command Registration:** `src/events/ready/01_registercommands.ts` compares local and deployed commands, updating, adding, or deleting as needed.
- **Locale Handling:** All user-facing text is localized using the `localizer` utility and JSON files in `src/locales/` (Rule 9).
- **Helper Utilities:**
  - Found in `src/utils/`
  - `configHelper.ts`: Bot and user state management (NEW)
  - `contextBuilder.ts`: Text processing and sanitization (NEW)
  - `interactionHelper.ts`: Command interaction patterns
  - `eventHelper.ts`: Standardized non-interaction event messages
  - `logger.ts`: Console logging and global color scheme (Rule 18, NEW)
- **Database:** PostgreSQL with schemas and types co-located in `src/types/db/schema.ts` (Rule 6).
- **Validation:** Zod for all user input and dynamic DB output validation (Rules 3, 5, 6, 7).

## 🧩 Key Systems

### Helper Utilities

#### Session Helpers (`src/utils/db/configHelper.ts`)
- Centralizes all database state access:
  - `loadTomoriState`: Gets Tomori (bot) instance and config
  - `loadUserRow`: Retrieves user data and preferences
  - `bumpAutoCounter`: Updates auto-chat counters
  - `isBlacklisted`: Checks personalization permissions
- Uses Zod validation for critical state data
- Follows PostgreSQL best practices (Rule #16)

#### Text Processing (`src/utils/text/contextBuilder.ts`)
- Handles text transformations:
  - Mention conversion for Discord IDs (now includes Tomori's nickname for both mentions and author names)
  - Placeholder replacement
  - LLM output sanitization
- Used by both input and output processing

#### Interaction Helpers (`src/utils/discord/interactionHelper.ts`)
- Provides DRY functions for command interactions:
  - `promptWithConfirmation` for yes/no decisions
  - `promptWithModal` for form inputs
  - `replyInfoEmbed` for status/info messages
- Used in all slash commands and interaction flows

#### Event Helpers (`src/utils/discord/eventHelper.ts`)
- Standardizes non-interaction Discord messages:
  - `createStandardEmbed` for event messages
- Used in event handlers like guildCreate, guildMemberAdd

#### Visual Consistency (`src/utils/misc/logger.ts`)
- Central source for all visual styling via `ColorCode` enum:
  - INFO (cyan): General information
  - SUCCESS (green): Successful operations
  - WARN (yellow): Confirmations/questions
  - ERROR (red): Errors/cancellations
  - SECTION (purple): Headings/dividers
- Used by both console output and Discord embeds
- Imported by helper utilities for consistent styling
- **All provider, event, and utility logging must use logger (Rule 18).**

### Database & Validation
- PostgreSQL with strongly-typed schemas
- SQL queries via Bun template literals
- Zod schemas co-located with types
- Schema validation follows Rules 3-7
- All state access through session helpers (Rule 17)
- PostgreSQL patterns follow Rule 16

### Context Assembly
- Segments built from:
  - Server memories
  - User preferences
  - Chat history (with Tomori's nickname handled for both mentions and author lines)
  - Personality traits
- Types defined in `src/types/misc/contextBuilder.ts`
- Validated with Zod schemas

## 🧠 Memory System
- Per-server memory tables
- LLM prompt injection system
- Slash command management
- State loaded via session helpers
- Types and schemas in `src/types/misc/contextBuilder.ts`

## 💃 Personality System
- Preset and custom personalities
- Per-server customization
- Stored in `tomori_presets`
- Zod-validated configurations
- Blacklist support for users

## 💰 Economy System
- TomoCoins management
- Balance tracking in `users`
- Session-based state access
- Transaction validation with Zod

## ⚙️ Configuration
- Environment via dotenv
- API keys encrypted in DB
- Bot configs per server
- Auto-chat channel settings
- Memory/personality toggles

## 🔌 External Integrations
- LLM APIs (encrypted keys)
- Discord.js client hooks
- Event-driven architecture
- Error logging and recovery

## 🧪 Testing & Validation
- Zod schema validation
- SQL query type safety
- Helper utility tests planned
- Error boundary testing

## 📌 Design Principles
1. State Access via Helpers
2. PostgreSQL Best Practices
3. Type Safety with Zod
4. DRY Helper Functions
5. Consistent Error Handling
6. Clean SQL Patterns
7. **Consistent, categorized logging via logger (Rule 18)**

## 🐛 Known Issues
- Some legacy MongoDB cleanup needed
- Query optimization ongoing
- Need more helper tests
- Documentation updates pending