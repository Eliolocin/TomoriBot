# TomoriBot System Patterns & Architecture

## 🏗️ Architecture Overview
- **Entry Point:** `src/index.ts` initializes the Discord client, loads environment variables, verifies the PostgreSQL schema and seed, and starts the event handler.
- **Event Handler:** `src/handlers/eventHandler.ts` dynamically loads and attaches all event listeners (guildCreate, interactionCreate, messageCreate, ready, etc.)
- **Slash Command Registration:** `src/events/ready/01_registercommands.ts` compares local and deployed commands, updating, adding, or deleting as needed.
- **Locale Handling:** All user-facing text is localized using the `localizer` utility and JSON files in `src/locales/` (Rule 9).
- **Helper Utilities:**
  - `interactionHelpers.ts`: Command interaction patterns (modals, embeds, buttons)
  - `eventHelpers.ts`: Standardized non-interaction event messages
  - `logBeautifier.ts`: Console logging and global color scheme (used by all visual elements)
- **Database:** PostgreSQL is used for all persistent data, with schemas and types co-located in `src/types/db.ts` (Rule 6).
- **Validation:** Zod is used for all user input and dynamic DB output validation (Rules 3, 5, 6, 7).

## 🧩 Key Systems

### Helper Utilities
#### Interaction Helpers (`src/utils/interactionHelpers.ts`)
- Provides DRY functions for command interactions:
  - `promptWithConfirmation` for yes/no decisions
  - `promptWithModal` for form inputs
  - `showInfoEmbed` for status/info messages
- Used in all slash commands and interaction flows

#### Event Helpers (`src/utils/eventHelpers.ts`)
- Standardizes non-interaction Discord messages:
  - `createStandardEmbed` for event messages
- Used in event handlers like guildCreate, guildMemberAdd

#### Visual Consistency (`src/utils/logBeautifier.ts`)
- Central source for all visual styling via `ColorScheme` enum:
  - INFO (cyan): General information
  - SUCCESS (green): Successful operations
  - WARN (yellow): Confirmations/questions
  - ERROR (red): Errors/cancellations
  - SECTION (purple): Headings/dividers
- Used by both console output and Discord embeds
- Imported by helper utilities for consistent styling

### Event Handler
- Dynamically loads all event files in `src/events/`
- Each event folder can have multiple handlers
- Events use eventHelpers for message consistency
- Example: guildCreate → welcomeBot.ts for setup prompts

### Slash Command Handler
- Dynamic loading from `src/slash_commands/`
- Commands auto-registered on startup
- Uses interactionHelpers for UX consistency
- Type-safe command metadata and callbacks

### Locale Handling
- All text uses `localizer` utility
- Structured key hierarchy (e.g., `tool.setup.title`)
- Full Japanese and English support
- Variables for dynamic content

### Database & Validation
- PostgreSQL with strongly-typed schemas
- SQL queries via Bun template literals
- Zod schemas co-located with types
- Schema validation follows Rules 3-7

## 🧠 Memory System
- Per-server memory tables
- LLM prompt injection system
- Slash command management
- TODO: Document memory flows

## 💃 Personality System
- Preset and custom personalities
- Per-server customization
- Stored in `tomori_presets`
- TODO: Document customization

## 💰 Economy System
- TomoCoins management
- Balance tracking in `users`
- TODO: Document transactions

## ⚙️ Configuration
- Environment via dotenv
- API keys encrypted in DB
- TODO: Document env structure

## 🔌 External Integrations
- LLM APIs (encrypted keys)
- TODO: Document rate limiting

## 🧪 Testing (Planned)
- GitHub Actions pipeline
- Linting and type checks
- TODO: Add helper tests

## 📌 Design Principles
- Bun for modern runtime
- PostgreSQL for reliability
- DRY and modular code
- Consistent styling via helpers
- Type safety with Zod/TypeScript

## 🐛 Known Issues
- Legacy MongoDB cleanup needed
- Large files to modularize
- TODO: Query optimization
