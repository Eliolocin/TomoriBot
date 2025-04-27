# Active Context for Development

## Current Technical Focus
- Reviewing of codebase to reduce overly abstract code as well as optimize inefficiencies, reinforcing KISS (Keep It Simple, Stupid) while also keeping it DRY (Don't Repeat Yourself)
- Creation of `/teach` and `/config `slash commands that adjust TomoriBot's configurations
  - Personal memories and self nicknames adjustments are allowed for everyone
  - Server memories adjustments can either be allowed for everyone or only server managers
  - Autoch, Humanizer, Setup, Tomori's nickname, and etc. related are allowed only for server managers
- Usage of centralized helpers for modals, embeds, and buttons (Rule 10), but also keeping complex modals/embeds that won't be reused inline instead to avoid over-abstraction (Rule 19).
- Refactoring all log.warn() function calls to also include context when appropriate (Rule 22)

## Active Issues
- Some locale strings are still missing, ensure all locale strings are present and up to date. (focus on only EN for now)
- Personalities need rework

## Recent Changes
- Updated command registering and handling

## Upcoming Considerations
- Document all new patterns and rules for future contributors.
- Consider adding more helper functions if common patterns emerge.
- Monitor performance of SQL queries and optimize if needed.