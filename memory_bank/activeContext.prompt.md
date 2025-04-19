# Active Context for Development

## Current Technical Focus
- Migrating all MongoDB/Mongoose code to PostgreSQL using Bun's SQL API.
- Refactoring all interactive Discord flows to use centralized helpers for modals, embeds, and buttons (Rule 10).
- Refactoring all database types and validation to use Zod schemas co-located with inferred types in `src/types/db.ts` (Rule 6).
- Ensuring all user input and external data is validated with Zod (Rule 3).
- Updating all insert, update, and select logic to use Bun's SQL best practices (Rule 4).
- Testing and improving the database seeding process (using either a seed SQL file or a Zod-validated script).
- Building a robust `/setup` onboarding command using Discord modals, embeds, and DRY helper utilities.

## Active Issues
- Some legacy code still references MongoDB models or interfaces.
- Need to ensure all new DB logic is type-safe and DRY.
- Confirm that all Zod schemas match the actual PostgreSQL schema.
- Update all embed code to use ColorScheme from logBeautifier instead of EmbedColors from interactionHelpers.
- Review and update any event handlers to use the new eventHelpers utility.
- Ensure all locale strings are present and up to date for both English and Japanese.

## Recent Changes
- Removed all MongoDB model folders and references.
- Created Zod schemas and inferred types for all major tables in `src/types/db.ts`.
- Used UNLOGGED 'cooldowns' table for command cooldowns.
- Updated project rules to enforce co-located schemas/types and `.partial()` for updates.
- Created eventHelpers.ts for standardized non-interaction embeds.
- Moved color scheme to logBeautifier.ts for better organization.
- Updated Rule 12 to reflect new helper structure and color source.
- Added/updated locale strings for `/setup` and onboarding flows.
- Added centralized interaction helpers for modals, embeds, and confirmation prompts.

## Upcoming Considerations
- Finish `/setup` command which initializes the bot to be able to further test other features.
- Refactor any remaining legacy validation or type patterns to use the new Zod-based approach.
- Add error logging to the database during operations.
- Document all new patterns and rules for future contributors.
- Add more robust tests for all new helper utilities and onboarding flows.
- Consider adding more event helper functions if common patterns emerge.
- Monitor performance of SQL queries and optimize if needed.
- Add a pgcron task that removes all expired Cooldowns