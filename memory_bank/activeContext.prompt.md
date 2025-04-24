# Active Context for Development

## Current Technical Focus
- Migrating all MongoDB/Mongoose code to PostgreSQL using Bun's SQL API.
- Refactoring all interactive Discord flows to use centralized helpers for modals, embeds, and buttons (Rule 10).
- Refactoring all database types and validation to use Zod schemas co-located with inferred types in `src/types/db/schema.ts` (Rule 6).
- Ensuring all user input and external data is validated with Zod (Rule 3).
- Updating all insert, update, and select logic to use Bun's SQL best practices (Rule 4).
- Testing and improving the database seeding process (using either a seed SQL file or a Zod-validated script).
- Building a robust `/setup.ts` onboarding command using Discord modals, embeds, and DRY helper utilities.
- Splitting up monolith `/teach.ts` function and refactoring it to latest codebase standards and patterns.
- Ensuring Tomori's nickname is used consistently in all mention conversions and conversation history.

## Active Issues
- Some legacy code still references MongoDB models or interfaces.
- Need to ensure all new DB logic is type-safe and DRY.
- Confirm that all Zod schemas match the actual PostgreSQL schema.
- Update all embed code to use ColorCode from logger instead of EmbedColors from interactionHelpers.
- Review and update any event handlers to use the new eventHelper.ts helper utility.
- Ensure all locale strings are present and up to date for both English and Japanese.

## Recent Changes
- Removed all MongoDB model folders and references.
- Created Zod schemas and inferred types for all major tables in `src/types/db/schema.ts`.
- Used UNLOGGED 'cooldowns' table for command cooldowns.
- Updated project rules to enforce co-located schemas/types and `.partial()` for updates.
- Created eventHelpers.ts for standardized non-interaction embeds.
- Moved color scheme to logger.ts for better organization.
- Created session management helpers in `src/utils/db/sessionHelper.ts` for state loading.
- Refactored GeminiBot (now `tomoriChat`) to:
  - Use session helpers for all state access
  - Use contextBuilder for mention conversion and context assembly
  - Use Tomori's configured nickname for both mentions and author names in chat history

## TomoriChat Refactoring (Cannot proceed without `setup.ts` and `teach.ts` being updated first)
**Testing Checklist**
   - [ ] Tomori (bot) state loading
   - [ ] User state handling
   - [ ] Counter updates
   - [ ] Blacklist functionality
   - [ ] Memory context assembly
   - [ ] LLM response processing
   - [ ] Provider error/retry handling
   - [ ] Logging output consistency
   - [ ] Tomori nickname handling in mentions and chat history

## Upcoming Considerations
- Finish `/setup` command which initializes the bot to be able to further test other features.
- Finish `/teach` command which initializes the bot to be able to further test other features.
- Refactor any remaining legacy validation or type patterns to use the new Zod-based approach.
- Add error logging to the database during operations.
- Document all new patterns and rules for future contributors.
- Add more robust tests for all new helper utilities and onboarding flows.
- Consider adding more event helper functions if common patterns emerge.
- Monitor performance of SQL queries and optimize if needed.
- Add a pgcron task that removes all expired Cooldowns