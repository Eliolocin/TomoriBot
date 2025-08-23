# Discord & UI Rules

## Discord Rule 1: Helper Functions for Interactive Components
Use helper functions for common interactive component patterns to promote DRY principle and consistency

- Identify repeating patterns for creating embeds, adding components, setting up collectors
- Create reusable `async` functions within the command file or shared utility
- Functions should accept parameters for specific content and return collected data or outcome
- Main command logic should `await` these helper functions for each step

```ts
// ✅ DO (Using helper function)
async function promptWithConfirmation(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    locale: string,
    options: { /* ... embed, button details ... */ }
): Promise<{ outcome: 'continue' | 'cancel' | 'timeout'; interaction?: ButtonInteraction }> {
    // ... logic to show embed+buttons and await interaction ...
    // ... return { outcome: '...', interaction: buttonInteraction } ...
}

// In the command callback:
const step1Result = await promptWithConfirmation(interaction, locale, { /* ... */ });
if (step1Result.outcome === 'continue') {
    // biome-ignore lint/style/noNonNullAssertion: Outcome guarantees interaction is present
    const buttonInteraction = step1Result.interaction!;
    // Proceed using buttonInteraction
}

// ❌ DON'T (Repeating boilerplate in each step)
const embed1 = new EmbedBuilder()...;
const buttons1 = new ActionRowBuilder<ButtonBuilder>()...;
await interaction.editReply({ embeds: [embed1], components: [buttons1] });
try {
    const collected1 = await interaction.channel.awaitMessageComponent({ filter, time });
    if (collected1.customId === 'continue1') { /* ... */ }
} catch (e) { /* timeout */ }
```

## Discord Rule 2: Helper Utilities for Consistent Discord Interactions
Use helper utilities for consistent Discord interaction and event handling

- Use helper functions from utils folder:
  - `interaction.ts` for command interactions: `promptWithConfirmation`, `promptWithModal`, `showInfoEmbed`
  - `event.ts` for non-interaction contexts: `createStandardEmbed`
  - Use `ColorCode` from `logger.ts` for all color needs:
    - INFO (cyan) for general information
    - SUCCESS (green) for successful operations  
    - WARN (yellow) for confirmations/questions
    - ERROR (red) for errors/cancellations
    - SECTION (purple) for section headers

```ts
// ✅ DO (Command interaction)
import { showInfoEmbed } from "../../utils/interactionHelpers";
import { ColorCode } from "../../utils/logger";

await showInfoEmbed(interaction, locale, {
  titleKey: "tool.ping.title",
  descriptionKey: "tool.ping.description",
  color: ColorCode.INFO
});

// ✅ DO (Event message)
import { createStandardEmbed } from "../../utils/eventHelpers";
import { ColorCode } from "../../utils/logger";

const embed = createStandardEmbed(locale, {
  titleKey: "events.welcome.title",
  descriptionKey: "events.welcome.description",
  color: ColorCode.WARN
});
await channel.send({ embeds: [embed] });

// ❌ DON'T
const embed = new EmbedBuilder()
  .setColor("#3498DB") // Hard-coded colors
  .setTitle("Welcome!") // Hard-coded text
  .setDescription("Thanks for adding me!");
```

## Discord Rule 3: Smart Helper Usage
Use helpers for simple, repeatable patterns; build complex or unique components inline for readability balance

- Use helpers for info/error embeds, confirmation modals, and simple repeated UI patterns
- Build complex or highly customized modals/embeds inline within the function
- If a complex component is used in 2+ places, refactor it into a helper
- Prefer readability and clarity over strict DRY for unique, one-off UI components

```ts
// ✅ DO: Use showInfoEmbed for simple messages
await showInfoEmbed(interaction, locale, {
  titleKey: "tool.ping.title",
  descriptionKey: "tool.ping.description",
  color: ColorCode.INFO,
});

// ✅ DO: Build complex, one-off modals inline
const modal = new ModalBuilder()
  .setCustomId("tomori_setup_modal")
  .setTitle(localizer(locale, "tool.setup.modal_title"))
  .addComponents(
    // ...multiple custom fields...
  );
await interaction.showModal(modal);

// ❌ DON'T: Try to use generic helper for complex, one-off setup
await createStandardEmbed(locale, {
  titleKey: "...",
  descriptionKey: "...",
  color: ColorCode.SECTION,
  fields: [...], // 8+ complex fields
  footer: "...",
  image: "...",
});
```

## Discord Rule 4: Modal Interaction Pattern
Handle Discord modal interactions with consistent pattern for precise response timing

When working with modals, always follow this exact sequence:
1. Show the modal as the very first response to the original interaction
2. When handling modal submission, capture the modal submission interaction  
3. Immediately defer the modal submission interaction if doing any async work
4. Use the modal submission interaction for all subsequent replies

```ts
// ✅ DO
// 1. Show modal first (before any deferReply on original interaction)
const modalResult = await promptWithModal(interaction, locale, {...});

// 2. Handle non-submit cases
if (modalResult.outcome !== "submit") {
    return;
}

// 3. Capture and immediately defer the submission interaction
const modalSubmitInteraction = modalResult.interaction!;
await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

// 4. Use modalSubmitInteraction for subsequent replies
await replyInfoEmbed(modalSubmitInteraction, locale, {...});

// ❌ DON'T
// Don't defer the original interaction before showing modal
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
const modalResult = await promptWithModal(interaction, locale, {...});

// Don't fail to defer the modal submission interaction
const modalSubmitInteraction = modalResult.interaction!;
// Missing deferral here!
await doSomethingAsync();

// Don't use the original interaction for replies after modal submission
await replyInfoEmbed(interaction, locale, {...});
```

## Discord Rule 5: Command Structure
Structure command files with `configureSubcommand` function and `execute` async function exports

Each command file must export:
- `configureSubcommand`: Function that takes a `SlashCommandSubcommandBuilder` and configures the subcommand
- `execute`: Async function `(client: Client, interaction: ChatInputCommandInteraction, userData: UserRow) => Promise<void>`
- Category folders determine top-level command name, files define subcommands
- Use `SlashCommandSubcommandBuilder` methods for names, descriptions, options, and localizations

```ts
// ✅ DO (src/commands/tool/ping.ts)
import type { SlashCommandSubcommandBuilder } from 'discord.js';
import { localizer } from '../../utils/text/localizer';

// Define how the subcommand is configured
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) => 
  subcommand
    .setName('ping')
    .setDescription(localizer('en', 'commands.tool.ping.description'))
    .setDescriptionLocalizations({
      ja: localizer('ja', 'commands.tool.ping.description'),
    });

// Command logic
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow
): Promise<void> {
  // ... command logic ...
}

// ❌ DON'T (Old structure)
export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check the bot\'s ping')
  .toJSON();
```