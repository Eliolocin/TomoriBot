# General Code Rules

## General Rule 1: Documentation Standards
Always document functions using JSDoc-style comments for better developer understanding

- All exported functions should have JSDoc comments
- Include parameters and return type
- Use `@param` and `@returns` consistently

```ts
// ✅ DO
/**
 * Sends a message to a user
 * @param userId - The Discord user ID
 * @param content - The message content
 * @returns Promise<boolean>
 */
async function sendMessage(userId: string, content: string): Promise<boolean> {
  // ...
}

// ❌ DON'T
function msg(u, m) {
  // ???
}
```

## General Rule 2: Runtime and API Preferences
Use Bun-native APIs over Node.js built-ins when possible for better performance and optimization

```ts
// ✅ DO
await Bun.write('log.txt', 'Hello world');

// ❌ DON'T
fs.writeFileSync('log.txt', 'Hello world');
```

## General Rule 3: Text Localization
Use the `localizer` utility for all user-facing text to ensure consistent internationalization

- Import `localizer` from `src/utils/text/localizer.ts`
- Call `localizer(locale, key, variables)` for any text shown to the user
- Use dot notation for keys matching structure in `src/locales/*.json`
- Pass dynamic values using the `variables` object
- Ensure corresponding keys exist in all supported language files

```ts
// ✅ DO (in commands/events)
import { localizer } from "../../utils/textLocalizer";
const userLocale = userData.language_pref || 'en';
const title = localizer(userLocale, "economy.balance.title");
const description = localizer(userLocale, "economy.balance.description", {
  coins: userCoins,
  bank: userBank,
});
embed.setTitle(title).setDescription(description);

// ❌ DON'T
embed.setTitle("Your Balance"); // Hardcoded string
embed.setDescription(`Coins: ${userCoins}\nBank: ${userBank}`); // Manual formatting
```

## General Rule 4: Type Organization
Never declare interfaces within implementation files; only in the /types/ folder for centralized type management

- All interfaces and shared types must be declared in `/src/types/` subdirectories
- Do not declare interfaces or types in utility, command, or event files
- Use `type` for type-only imports to prevent biome linting errors

```ts
// ✅ DO
// src/types/discord/embed.ts
export interface StandardEmbedOptions { ... }

// Import in implementation files
import type { StandardEmbedOptions } from "../types/discord/embed";

// ❌ DON'T
// src/utils/event.ts
interface StandardEmbedOptions { ... }

// ❌ DON'T
import { StandardEmbedOptions } from "../types/discord/embed"; // missing 'type'
```

## General Rule 5: Logging Standards
Use logger for consistent console output with proper categorization

Use the `log` utility from logger.ts for all console output:
- `log.info()` for general information and progress updates
- `log.success()` for successful operations
- `log.warn()` for potential issues or important notices
- `log.error()` for failures and error conditions
- `log.section()` for major process transitions or groups

```ts
// ✅ DO
import { log } from "../utils/misc/logger";

log.info("Processing request...");
await processData();
log.success("Data processed successfully");

// ❌ DON'T
console.log("Processing request..."); // No category or formatting
```

## General Rule 6: Configuration Constants
Place static, configuration-like constants at the top of each file for improved maintainability

- Define constants for static values (timeouts, min/max, placeholder lengths) at the top of the file
- Only use this for values that do not depend on runtime/user input, locale, or database queries
- Name constants in ALL_CAPS with underscores for clarity
- Do not move values to the top if they are only used once and self-explanatory

```ts
// ✅ DO (at the top of the file)
const MODAL_TIMEOUT_MS = 300000;
const HUMANIZER_MIN = 0;
const HUMANIZER_MAX = 3;
const PRESET_PLACEHOLDER_MAX = 50;

// ...later in the file...
if (humanizerValue < HUMANIZER_MIN || humanizerValue > HUMANIZER_MAX) { ... }

// ❌ DON'T (magic numbers in logic)
if (humanizerValue < 0 || humanizerValue > 3) { ... }
```

## General Rule 7: RUG Principle
Use RUG (Repeat Until Good) before abstracting repeated code to enforce intentional abstraction

- Do not immediately extract a block of logic just because it looks similar
- Repeat it at least 3 times with minor variations to confirm it's stable and reusable
- Prefer copy-paste with clear inline comments before trying to DRY the logic
- Only abstract into a function or helper when:
  - The logic is exactly the same or cleanly parameterizable
  - It improves readability, not reduces it
  - The helper is still understandable without needing to jump around files

```ts
// ✅ DO (inline 2–3 times until confident in abstraction)
if (action === "register") {
  await showInfoEmbed(interaction, locale, {
    titleKey: "tool.register.title",
    descriptionKey: "tool.register.success",
    color: ColorCode.SUCCESS,
  });
}

// ❌ DON'T (premature helper makes code less readable)
await doRegisterSuccess(interaction, locale); // what's that do? where's the logic?
```

## General Rule 8: No Placeholder Comments
Avoid placeholder comments like `// TODO:` in committed code to ensure completeness

- Implement the full logic for a feature or step before moving on
- Do not use `// TODO:`, `// FIXME:`, or similar placeholders for incomplete logic in committed code
- If future work is needed after current task is complete, document it in project tracking or design docs
- Break down large tasks into smaller, fully implementable steps

```ts
// ✅ DO (Implement the step fully)
async function handleStep2(interaction: ButtonInteraction) {
    const data = await promptForData(interaction);
    if (!data) return; // Handle cancellation/timeout
    await processData(data);
    await interaction.editReply({ content: "Step 2 Complete!", components: [] });
}

// ❌ DON'T (Leave incomplete logic)
async function handleStep2(interaction: ButtonInteraction) {
    // TODO: Get data from user
    // TODO: Process the data
    await interaction.editReply({ content: "Step 2 Complete!", components: [] });
}
```