# Creating Slash Commands

This tutorial walks through creating **Discord slash commands** for TomoriBot, using the comprehensive `/config setup` command as our primary example. You'll learn command registration, subcommands, modals, validation, and internationalization.

## Overview

We'll create a complete slash command system that demonstrates:
- Command and subcommand registration
- Modal interactions for complex input
- User input validation and error handling
- Database integration
- Internationalization support
- Permission checking

## Step 1: Understanding TomoriBot's Command Structure

### Directory Organization

```
src/commands/
├── config/           ← Configuration commands
│   ├── setup.ts      ← Our main example
│   ├── model.ts      ← Simple subcommand
│   └── ...           ← Other config subcommands
├── help/             ← Help commands
├── teach/            ← Teaching/memory commands
├── tool/             ← Utility commands
└── unlearn/          ← Memory removal commands
```

### Command Pattern

TomoriBot uses a **modular subcommand pattern**:
- Each `.ts` file represents a subcommand
- Files export `configureSubcommand` and `execute` functions
- Commands are automatically discovered and registered

## Step 2: Create a Simple Subcommand

Let's start with a basic subcommand before building complex ones:

**File**: `src/commands/config/status.ts`

```typescript
/**
 * Simple status subcommand - shows current server configuration
 */

import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import type { UserRow } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replySummaryEmbed } from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";

/**
 * Configure the subcommand structure
 */
export const configureSubcommand = (
  subcommand: SlashCommandSubcommandBuilder,
) =>
  subcommand
    .setName("status")
    .setDescription("Show current TomoriBot configuration for this server")
    .setDescriptionLocalizations({
      ja: "このサーバーの現在のTomoriBotの設定を表示",
    });

/**
 * Execute the status command
 * @param _client - Discord client instance (unused in this command)
 * @param interaction - Command interaction from Discord
 * @param userData - User data from database
 * @param locale - User's preferred locale
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Ensure command is run in a guild
  if (!interaction.guild) {
    await interaction.reply({
      content: localizer(locale, "general.errors.guild_only_description"),
      ephemeral: true,
    });
    return;
  }

  try {
    // Load current server configuration
    const tomoriState = await loadTomoriState(interaction.guild.id);

    if (!tomoriState) {
      await interaction.reply({
        content: localizer(locale, "commands.config.status.tomori_not_setup"),
        ephemeral: true,
      });
      return;
    }

    // Display configuration as an embed
    await replySummaryEmbed(interaction, locale, {
      titleKey: "commands.config.status.title",
      descriptionKey: "commands.config.status.description",
      color: ColorCode.INFO,
      fields: [
        {
          nameKey: "commands.config.status.provider_field",
          value: tomoriState.llm.llm_provider,
          inline: true,
        },
        {
          nameKey: "commands.config.status.model_field", 
          value: tomoriState.llm.llm_codename,
          inline: true,
        },
        {
          nameKey: "commands.config.status.temperature_field",
          value: tomoriState.config.llm_temperature.toString(),
          inline: true,
        },
        {
          nameKey: "commands.config.status.humanizer_field",
          value: tomoriState.config.humanizer_degree.toString(),
          inline: true,
        },
        {
          nameKey: "commands.config.status.stickers_field",
          value: tomoriState.config.sticker_usage_enabled ? "✅ Enabled" : "❌ Disabled",
          inline: true,
        },
        {
          nameKey: "commands.config.status.search_field",
          value: tomoriState.config.google_search_enabled ? "✅ Enabled" : "❌ Disabled", 
          inline: true,
        },
      ],
    });

    log.info(`Configuration status displayed for server ${interaction.guild.id}`);

  } catch (error) {
    log.error("Error in config status command:", error as Error);
    await interaction.reply({
      content: localizer(locale, "general.errors.unknown_error_description"),
      ephemeral: true,
    });
  }
}
```

## Step 3: Create a Complex Modal Command

Now let's examine the comprehensive `/config setup` command that uses modals:

**File**: `src/commands/config/setup.ts`

```typescript
/**
 * Complex setup command with modal interaction
 * Demonstrates: modals, validation, API calls, database operations
 */

import {
  ActionRowBuilder,
  TextInputStyle,
  ModalBuilder,
  TextInputBuilder,
  MessageFlags,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import type {
  SetupConfig,
  TomoriPresetRow,
  UserRow,
} from "../../types/db/schema";
import { setupConfigSchema, tomoriPresetSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
  replyInfoEmbed,
  replySummaryEmbed,
} from "../../utils/discord/interactionHelper";
import { GoogleProvider } from "../../providers/google/googleProvider";
import { encryptApiKey } from "../../utils/security/crypto";
import { setupServer } from "../../utils/db/dbWrite";
import { loadTomoriState } from "@/utils/db/dbRead";

// Constants
const MODAL_TIMEOUT_MS = 300000; // 5 minutes
const HUMANIZER_MIN = 0;
const HUMANIZER_MAX = 3;
const PRESET_PLACEHOLDER_MAX_LENGTH = 100;

/**
 * Configure the setup subcommand
 */
export const configureSubcommand = (
  subcommand: SlashCommandSubcommandBuilder,
) =>
  subcommand
    .setName("setup")
    .setDescription("Initial setup wizard for TomoriBot")
    .setDescriptionLocalizations({
      ja: "TomoriBotの初期設定ウィザード",
    });

/**
 * Execute the setup command with comprehensive modal interaction
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // 1. VALIDATION: Guild-only command
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: localizer(userData.language_pref, "general.errors.guild_only_description"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // 2. CHECK: Prevent duplicate setup
    const existingTomoriState = await loadTomoriState(interaction.guild.id);

    if (existingTomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.setup.already_setup_title",
        descriptionKey: "commands.config.setup.already_setup_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 3. LOAD: Available personality presets
    const presetRows = await sql`
      SELECT tomori_preset_id, tomori_preset_name, tomori_preset_desc, preset_language
      FROM tomori_presets
      WHERE preset_language = ${locale}
      ORDER BY tomori_preset_id
    `;

    const availablePresets: TomoriPresetRow[] = presetRows.map(
      (row: Record<string, unknown>) => tomoriPresetSchema.parse(row),
    );

    if (availablePresets.length === 0) {
      log.warn(`No presets found for locale '${locale}'`);
      await interaction.reply({
        content: localizer(locale, "commands.config.setup.no_presets_found"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 4. BUILD: Dynamic modal with preset options
    const presetPlaceholder = availablePresets
      .map((preset, i) => `${i + 1}. ${preset.tomori_preset_name}`)
      .join("\\n")
      .slice(0, PRESET_PLACEHOLDER_MAX_LENGTH);

    const modal = new ModalBuilder()
      .setCustomId("tomori_setup_modal")
      .setTitle(localizer(locale, "commands.config.setup.modal_title"));

    // Input 1: API Key
    const apiKeyInput = new TextInputBuilder()
      .setCustomId("api_key")
      .setLabel(localizer(locale, "commands.config.setup.api_key_label"))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Enter your Gemini API Key")
      .setRequired(true);

    // Input 2: Personality Preset (with dynamic options)
    const presetInput = new TextInputBuilder()
      .setCustomId("preset_name")
      .setLabel(localizer(locale, "commands.config.setup.preset_label"))
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(presetPlaceholder)
      .setRequired(true);

    // Input 3: Humanizer Setting
    const humanizerInput = new TextInputBuilder()
      .setCustomId("humanizer")
      .setLabel(localizer(locale, "commands.config.setup.humanizer_label"))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Enter a value from 0 to 3")
      .setRequired(true);

    // 5. ASSEMBLE: Modal with all inputs
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(presetInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(humanizerInput),
    );

    // 6. DISPLAY: Show modal to user
    await interaction.showModal(modal);

    // 7. AWAIT: Modal submission with timeout
    const submission = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) =>
        i.customId === "tomori_setup_modal" &&
        i.user.id === interaction.user.id,
    });

    // 8. PROCESS: Handle submission
    await submission.deferReply({ flags: MessageFlags.Ephemeral });

    // Extract and validate inputs
    const apiKey = submission.fields.getTextInputValue("api_key");
    const presetName = submission.fields.getTextInputValue("preset_name");
    const humanizerText = submission.fields.getTextInputValue("humanizer").trim();

    // 9. VALIDATE: API Key length and format
    if (!apiKey || apiKey.length < 10) {
      await submission.editReply({
        content: localizer(locale, "commands.config.setup.api_key_invalid"),
      });
      return;
    }

    // 10. TEST: API Key with actual API call
    await submission.editReply({
      content: localizer(locale, "commands.config.setup.api_key_validating"),
    });

    const googleProvider = new GoogleProvider();
    const isApiKeyValid = await googleProvider.validateApiKey(apiKey);
    if (!isApiKeyValid) {
      await submission.editReply({
        content: localizer(locale, "commands.config.setup.api_key_invalid_api"),
      });
      return;
    }

    // 11. VALIDATE: Personality preset
    const selectedPreset = availablePresets.find(
      (p) =>
        p.tomori_preset_name.toLowerCase() === presetName.trim().toLowerCase(),
    );

    if (!selectedPreset) {
      const presetOptions = availablePresets
        .map((preset) => preset.tomori_preset_name)
        .join(", ");
      
      await submission.editReply({
        content: localizer(locale, "commands.config.setup.preset_invalid", {
          available: presetOptions,
        }),
      });
      return;
    }

    // 12. VALIDATE: Humanizer value
    const humanizerValue = Number.parseInt(humanizerText);
    if (
      Number.isNaN(humanizerValue) ||
      humanizerValue < HUMANIZER_MIN ||
      humanizerValue > HUMANIZER_MAX
    ) {
      await submission.editReply({
        content: localizer(locale, "commands.config.setup.humanizer_invalid"),
      });
      return;
    }

    // 13. ENCRYPT: API key for secure storage
    const encryptedKey = await encryptApiKey(apiKey);

    // 14. CREATE: Setup configuration
    const setupConfig: SetupConfig = {
      serverId: interaction.guild.id,
      encryptedApiKey: encryptedKey,
      presetId: selectedPreset.tomori_preset_id,
      humanizer: humanizerValue,
      tomoriName: locale === "ja"
        ? process.env.DEFAULT_BOTNAME_JP || "ともり"
        : process.env.DEFAULT_BOTNAME || "Tomori",
      locale,
    };

    // 15. VALIDATE: Final configuration with Zod
    try {
      setupConfigSchema.parse(setupConfig);
    } catch (error) {
      log.error("Setup config validation failed:", error);
      await submission.editReply({
        content: localizer(locale, "commands.config.setup.config_invalid"),
      });
      return;
    }

    // 16. EXECUTE: Server setup with database operations
    await setupServer(interaction.guild, setupConfig);

    // 17. SUCCESS: Show confirmation to user
    await replySummaryEmbed(submission, locale, {
      titleKey: "commands.config.setup.success_title",
      descriptionKey: "commands.config.setup.success_desc",
      color: ColorCode.SUCCESS,
      fields: [
        {
          nameKey: "commands.config.setup.preset_field",
          value: selectedPreset.tomori_preset_name,
        },
        {
          nameKey: "commands.config.setup.humanizer_field",
          value: String(humanizerValue),
        },
        {
          nameKey: "commands.config.setup.name_field",
          value: setupConfig.tomoriName,
        },
      ],
    });

    log.info(`Server setup completed for guild ${interaction.guild.id}`);

  } catch (error) {
    // Handle modal timeout specifically
    if (error instanceof Error && error.message.includes("time")) {
      await interaction.followUp({
        content: localizer(locale, "commands.config.setup.modal_timeout"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // General error handling
    log.error("Error during setup process:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
```

## Step 4: Command with Options

Create a command that takes slash command options:

**File**: `src/commands/config/temperature.ts`

```typescript
/**
 * Temperature command with slash command options
 * Demonstrates: command options, validation, database updates
 */

import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import type { UserRow } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replySummaryEmbed } from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";

// Temperature constraints
const TEMPERATURE_MIN = 0.1;
const TEMPERATURE_MAX = 2.0;

/**
 * Configure temperature subcommand with options
 */
export const configureSubcommand = (
  subcommand: SlashCommandSubcommandBuilder,
) =>
  subcommand
    .setName("temperature")
    .setDescription("Set the creativity temperature for AI responses")
    .setDescriptionLocalizations({
      ja: "AI応答の創造性温度を設定",
    })
    .addNumberOption((option) =>
      option
        .setName("value")
        .setDescription(`Temperature value (${TEMPERATURE_MIN} to ${TEMPERATURE_MAX})`)
        .setDescriptionLocalizations({
          ja: `温度値 (${TEMPERATURE_MIN} から ${TEMPERATURE_MAX})`,
        })
        .setRequired(true)
        .setMinValue(TEMPERATURE_MIN)
        .setMaxValue(TEMPERATURE_MAX),
    );

/**
 * Execute temperature command
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: localizer(locale, "general.errors.guild_only_description"),
      ephemeral: true,
    });
    return;
  }

  try {
    // Get temperature value from command option
    const temperature = interaction.options.getNumber("value", true);

    // Validate range (Discord should handle this, but double-check)
    if (temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX) {
      await interaction.reply({
        content: localizer(locale, "commands.config.temperature.invalid_range", {
          min: TEMPERATURE_MIN.toString(),
          max: TEMPERATURE_MAX.toString(),
        }),
        ephemeral: true,
      });
      return;
    }

    // Check if server is set up
    const tomoriState = await loadTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await interaction.reply({
        content: localizer(locale, "commands.config.temperature.tomori_not_setup"),
        ephemeral: true,
      });
      return;
    }

    // Update temperature in database
    await sql`
      UPDATE tomori_instances 
      SET llm_config = jsonb_set(
        llm_config,
        '{llm_temperature}',
        to_jsonb(${temperature}::numeric)
      )
      WHERE server_id = ${tomoriState.server_id}
    `;

    // Confirm update to user
    await replySummaryEmbed(interaction, locale, {
      titleKey: "commands.config.temperature.success_title",
      descriptionKey: "commands.config.temperature.success_description",
      color: ColorCode.SUCCESS,
      fields: [
        {
          nameKey: "commands.config.temperature.new_value_field",
          value: temperature.toString(),
          inline: true,
        },
        {
          nameKey: "commands.config.temperature.effect_field",
          value: localizer(locale, 
            temperature < 0.5 
              ? "commands.config.temperature.effect_conservative"
              : temperature > 1.2 
                ? "commands.config.temperature.effect_creative"
                : "commands.config.temperature.effect_balanced"
          ),
          inline: true,
        },
      ],
    });

    log.info(`Temperature updated to ${temperature} for server ${interaction.guild.id}`);

  } catch (error) {
    log.error("Error in temperature command:", error as Error);
    await interaction.reply({
      content: localizer(locale, "general.errors.unknown_error_description"),
      ephemeral: true,
    });
  }
}
```

## Step 5: Command Registration

Commands are automatically registered through TomoriBot's discovery system, but here's how it works:

**File**: `src/handlers/eventHandler.ts` (excerpt)

```typescript
// Command registration happens automatically by scanning the commands directory
// Each subcommand file is dynamically imported and registered

const commandCategories = ['config', 'help', 'teach', 'tool', 'unlearn'];

for (const category of commandCategories) {
  const categoryPath = path.join(__dirname, '../commands', category);
  const files = fs.readdirSync(categoryPath).filter(file => file.endsWith('.ts'));
  
  for (const file of files) {
    const commandModule = await import(path.join(categoryPath, file));
    
    if (commandModule.configureSubcommand && commandModule.execute) {
      // Register the subcommand
      const subcommand = new SlashCommandSubcommandBuilder();
      commandModule.configureSubcommand(subcommand);
      
      // Add to appropriate parent command
      parentCommands[category].addSubcommand(subcommand);
      
      // Store execution handler
      commandHandlers[`${category}_${subcommand.name}`] = commandModule.execute;
    }
  }
}
```

## Step 6: Internationalization Integration

Add localization keys to support multiple languages:

**File**: `src/locales/en.ts` (add new keys)

```typescript
export const enLocale = {
  // ... existing keys
  
  "commands.config.status.title": "Server Configuration",
  "commands.config.status.description": "Current TomoriBot settings for this server",
  "commands.config.status.provider_field": "LLM Provider",
  "commands.config.status.model_field": "Model",
  "commands.config.status.temperature_field": "Temperature",
  "commands.config.status.humanizer_field": "Humanizer",
  "commands.config.status.stickers_field": "Stickers", 
  "commands.config.status.search_field": "Search",
  "commands.config.status.tomori_not_setup": "TomoriBot is not set up for this server. Use `/config setup` to get started.",
  
  "commands.config.temperature.invalid_range": "Temperature must be between {min} and {max}",
  "commands.config.temperature.tomori_not_setup": "Please run `/config setup` first",
  "commands.config.temperature.success_title": "Temperature Updated",
  "commands.config.temperature.success_description": "AI response creativity level has been updated",
  "commands.config.temperature.new_value_field": "New Temperature",
  "commands.config.temperature.effect_field": "Effect",
  "commands.config.temperature.effect_conservative": "Conservative responses",
  "commands.config.temperature.effect_balanced": "Balanced creativity",
  "commands.config.temperature.effect_creative": "Creative responses",
};
```

## Step 7: Advanced Features

### Permission Checking

```typescript
// Add to any command that requires specific permissions
import { PermissionFlagsBits } from "discord.js";

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Check user permissions
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: localizer(locale, "general.errors.insufficient_permissions"),
      ephemeral: true,
    });
    return;
  }
  
  // Command logic here...
}
```

### Choice Options

```typescript
// For commands with predefined choices
export const configureSubcommand = (
  subcommand: SlashCommandSubcommandBuilder,
) =>
  subcommand
    .setName("provider")
    .setDescription("Set the LLM provider")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Choose LLM provider")
        .setRequired(true)
        .addChoices(
          { name: "Google Gemini", value: "google" },
          { name: "OpenAI GPT", value: "openai" },
          { name: "Anthropic Claude", value: "anthropic" },
        ),
    );
```

### Conditional Logic

```typescript
// Commands that behave differently based on current state
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const tomoriState = await loadTomoriState(interaction.guild.id);
  
  if (tomoriState?.llm.llm_provider === 'google') {
    // Google-specific logic
  } else if (tomoriState?.llm.llm_provider === 'openai') {
    // OpenAI-specific logic
  }
}
```

## Testing Your Commands

### Development Testing

1. **Register commands** (happens automatically on bot startup)
2. **Test in Discord**:
   ```
   /config status
   /config setup
   /config temperature value:0.8
   ```
3. **Check logs** for proper execution and error handling
4. **Test edge cases**: invalid inputs, missing permissions, etc.

### Command Testing Checklist

- [ ] **Basic Execution**: Command executes without errors
- [ ] **Validation**: Invalid inputs are handled gracefully  
- [ ] **Permissions**: Permission checks work correctly
- [ ] **Localization**: All text displays in correct language
- [ ] **Database**: Data is properly stored/retrieved
- [ ] **Error Handling**: Errors produce user-friendly messages
- [ ] **Modal Interactions**: Modals display and submit correctly
- [ ] **Ephemeral Responses**: Sensitive data uses ephemeral replies

## Best Practices

### 1. **Always Validate Input**
```typescript
// Validate all user input, even when Discord should handle it
if (!value || value.length < 1 || value.length > 100) {
  await interaction.reply({ content: "Invalid input", ephemeral: true });
  return;
}
```

### 2. **Use Ephemeral Replies for Errors**
```typescript
// Keep error messages private
await interaction.reply({
  content: localizer(locale, "error.message"),
  ephemeral: true,
});
```

### 3. **Comprehensive Error Handling**
```typescript
try {
  // Command logic
} catch (error) {
  log.error("Command error:", error as Error);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({ content: "Error occurred", ephemeral: true });
  } else {
    await interaction.followUp({ content: "Error occurred", ephemeral: true });
  }
}
```

### 4. **Use Constants for Magic Numbers**
```typescript
const TIMEOUT_MS = 300000; // Better than hardcoded 300000
const MIN_LENGTH = 1;
const MAX_LENGTH = 100;
```

Your slash commands are now ready to provide rich, interactive experiences for TomoriBot users! 🎯

---

**Related Guides**:
- [Working with Database](working-with-database.md)
- [Internationalization](i18n-localization.md)