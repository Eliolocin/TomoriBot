import { MessageFlags, type ChatInputCommandInteraction, type Client, type Interaction } from "discord.js";
import { enrichErrorContext, runWithErrorContext } from "@/utils/misc/errorContextStore";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import type { UserRow, ErrorContext } from "../../types/db/schema";
import { DatabaseUnavailableError } from "@/types/errors";
import { cooldownRepository, serverRepository, statRepository, userRepository } from "@/utils/db/repositories";
import {
  loadCommandData,
  ROOT_COMMAND_EXECUTION_KEY,
  type CommandExecutionMap,
  type CommandCooldownMap,
} from "../../utils/discord/commandLoader";
import { resolvePreferredDiscordDisplayName } from "../../utils/discord/displayName";

// Define constants at the top (Rule #20)
const DEFAULT_COOLDOWN = Number.parseInt(process.env.DEFAULT_COMMAND_COOLDOWN || "1600", 10); // Default cooldown for all commands in milliseconds

const COOLDOWN_MAP = new Map<string, number>([
  ["config", Number.parseInt(process.env.COOLDOWN_CONFIG || "3000", 10)],
  ["persona", Number.parseInt(process.env.COOLDOWN_PERSONA || "10000", 10)],
  [
    "memory",
    Number.parseInt(
      process.env.COOLDOWN_MEMORY || process.env.COOLDOWN_TEACH || process.env.COOLDOWN_FORGET || "3000",
      10,
    ),
  ],
  ["server", Number.parseInt(process.env.COOLDOWN_SERVER || "3000", 10)],
  ["personal", Number.parseInt(process.env.COOLDOWN_PERSONAL || "3000", 10)],
  ["scheduled-task", Number.parseInt(process.env.COOLDOWN_PERSONAL || "3000", 10)],
  ["conditioning", Number.parseInt(process.env.COOLDOWN_CONDITIONING || process.env.COOLDOWN_SERVER || "3000", 10)],
]);

// Cache for command execution maps - stored at module level
let executionMap: CommandExecutionMap | null = null;
let cooldownMap: CommandCooldownMap | null = null;

async function checkCooldown(userId: string, category: string): Promise<boolean> {
  return cooldownRepository.hasCommandCategoryCooldown(userId, category);
}

async function getRemainingCooldown(userId: string, category: string): Promise<number> {
  return cooldownRepository.getRemainingCommandCategoryCooldownSeconds(userId, category);
}

async function setCooldown(userId: string, category: string, duration: number): Promise<void> {
  await cooldownRepository.setCommandCategoryCooldown(userId, category, duration);
}

const handler = async (client: Client, interaction: Interaction): Promise<void> => {
  if (!interaction.isChatInputCommand()) return;

  await runWithErrorContext(
    {
      source: "command",
      sourceDetail: interaction.commandName,
      userDiscId: interaction.user.id,
      serverDiscId: interaction.guildId,
      channelDiscId: interaction.channelId,
    },
    () => runChatInputCommand(client, interaction),
  );
};

const runChatInputCommand = async (client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
  // Determine locale early for potential error messages
  const initialLocale = interaction.locale ?? interaction.guildLocale ?? "en-US";

  try {
    // loadCommandData() is single-flight, so an interaction arriving during
    // startup awaits the shared load instead of racing it and triggering module
    // Temporal Dead Zone failures.
    if (!executionMap || !cooldownMap) {
      log.info("Initializing command execution maps...");
      const loadedData = await loadCommandData();

      // Only commit the maps to the module-level cache when the load actually
      // produced commands. An empty execution map signals a catastrophic load
      // failure; caching it would permanently brick every command, so we leave
      // the cache empty and let a subsequent interaction retry the load.
      if (loadedData.executionMap.size > 0) {
        executionMap = loadedData.executionMap;
        cooldownMap = loadedData.cooldownMap;

        if (cooldownMap.size === 0) {
          for (const [category, duration] of COOLDOWN_MAP.entries()) {
            cooldownMap.set(category, duration);
          }
        }

        log.success("Command execution maps initialized.");
      } else {
        log.warn("Command load produced no commands; will retry on next interaction.");
        await replyInfoEmbed(
          interaction,
          initialLocale,
          {
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          },
          MessageFlags.Ephemeral,
        );
        return;
      }
    }

    const commandName = interaction.commandName; // The top-level command (category)
    const groupName = interaction.options.getSubcommandGroup(false); // The subcommand group (null for flat commands)
    const subcommandName = interaction.options.getSubcommand(false); // The specific subcommand (may be null)

    // Guild-only subcommand restrictions are now handled at the Discord registration level
    // Commands in guild-only categories (like "server") are automatically restricted to guilds

    const subcommandMap = executionMap.get(commandName);
    if (!subcommandMap) {
      log.warn(`Command category not found: ${commandName}`);
      await replyInfoEmbed(
        interaction,
        initialLocale,
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
      return;
    }

    const executionKey = subcommandName
      ? groupName
        ? `${groupName}.${subcommandName}`
        : subcommandName
      : ROOT_COMMAND_EXECUTION_KEY;

    const executeFunction = subcommandMap.get(executionKey);
    if (!executeFunction) {
      const fullCommandPath = groupName
        ? `${commandName} ${groupName} ${subcommandName}`
        : subcommandName
          ? `${commandName} ${subcommandName}`
          : commandName;
      log.warn(`Subcommand not found: ${fullCommandPath}`);
      await replyInfoEmbed(
        interaction,
        initialLocale,
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral,
      );
      return;
    }

    const mainLogicPromise = async () => {
      const cooldownDuration =
        // biome-ignore lint/style/noNonNullAssertion: We've checked it's not null before entering this block
        cooldownMap!.get(commandName) ?? DEFAULT_COOLDOWN;

      const isOnCooldown = await checkCooldown(interaction.user.id, commandName);
      if (isOnCooldown) {
        const remainingSeconds = await getRemainingCooldown(interaction.user.id, commandName);
        await replyInfoEmbed(
          interaction,
          initialLocale,
          {
            titleKey: "general.cooldown_title",
            descriptionKey: "general.cooldown",
            descriptionVars: {
              seconds: remainingSeconds,
              category: commandName,
            },
            color: ColorCode.WARN,
          },
          MessageFlags.Ephemeral,
        );
        return;
      }

      await setCooldown(interaction.user.id, commandName, cooldownDuration);

      let userData: UserRow | undefined;
      const existingUser = await userRepository.loadByDiscordId(interaction.user.id);

      if (existingUser) {
        userData = existingUser;
      } else {
        // Get locale to use for new user (works for both guilds and DMs)
        const userLanguage = interaction.locale;
        const memberDisplayName =
          interaction.member && typeof interaction.member === "object"
            ? "displayName" in interaction.member
              ? interaction.member.displayName
              : "nick" in interaction.member && typeof interaction.member.nick === "string"
                ? interaction.member.nick
                : null
            : null;

        // Use the userRepository.register helper (Rule #17) - works for both guild and DM contexts
        const registeredUser = await userRepository.register(
          interaction.user.id,
          resolvePreferredDiscordDisplayName({
            memberDisplayName,
            user: interaction.user,
          }),
          userLanguage,
        );

        if (registeredUser) {
          userData = registeredUser;
        }
      }

      const finalLocale = userData?.language_pref ?? interaction.guildLocale ?? "en-US";

      if (userData) {
        enrichErrorContext({ userId: userData.user_id });
        await executeFunction(client, interaction, userData, finalLocale);

        // Record command usage (fire-and-forget so stat tracking never adds
        // latency to the command response). command_used is persona-agnostic, so
        // it buffers under the lineage-0 sentinel. DM commands have no guild and
        // are skipped (stat_counters.server_id is a NOT NULL FK). The single
        // commandLoader dispatch path covers every slash command for free.
        const statUserId = userData.user_id;
        if (interaction.guildId && statUserId) {
          const guildId = interaction.guildId;
          // Record the full command path (category + optional group + subcommand,
          // space-joined) so stats distinguish subcommands like "config humanizer"
          // from "config message-fetch-limit", so top-level alone is too coarse for
          // underused-command detection.
          const fullCommandName = groupName
            ? `${commandName} ${groupName} ${subcommandName}`
            : subcommandName
              ? `${commandName} ${subcommandName}`
              : commandName;
          void (async () => {
            try {
              const internalServerId = await serverRepository.loadServerIdByDiscId(guildId);
              if (internalServerId) {
                statRepository.recordStat({
                  serverId: internalServerId,
                  userId: statUserId,
                  metric: "command_used",
                  metricKey: fullCommandName,
                });
              }
            } catch (statError) {
              log.warn(`Failed to record command_used stat for ${fullCommandName}: ${statError}`);
            }
          })();
        }
      } else {
        const context: ErrorContext = {
          errorType: "UserDataError",
          metadata: {
            userDiscordId: interaction.user.id,
            command: subcommandName ? `${commandName} ${subcommandName}` : commandName,
          },
        };
        await log.error("User data unavailable for command execution", undefined, context);

        await replyInfoEmbed(interaction, finalLocale, {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        });
      }
    };

    // Execute main command logic
    // Discord handles interaction timeouts natively, and helper functions
    // (awaitModalSubmit, awaitMessageComponent) have their own timeouts
    await mainLogicPromise();
  } catch (error) {
    const context: ErrorContext = {
      errorType: "CommandHandlingError",
      metadata: {
        commandName: interaction.commandName,
        groupName: interaction.options.getSubcommandGroup(false) ?? "none",
        subcommandName: interaction.options.getSubcommand(false),
        userDiscordId: interaction.user.id,
        guildDiscordId: interaction.guild?.id ?? "DM",
      },
    };
    await log.error(`Error in command handler for: ${interaction.commandName}`, error, context);

    // Reply to user with enhanced defensive error handling
    // The improved replyInfoEmbed function can now handle various interaction states more robustly
    try {
      // A pool retirement now reaches here as a typed error rather than as a plausible-looking
      // wrong answer, so the reply can say the run is worth repeating instead of implying the
      // command itself is broken.
      const isDatabaseUnavailable = error instanceof DatabaseUnavailableError;
      // Always attempt to use the helper function - it will handle the interaction state internally
      await replyInfoEmbed(interaction, initialLocale, {
        titleKey: isDatabaseUnavailable
          ? "general.errors.database_unavailable_title"
          : "general.errors.unknown_error_title",
        descriptionKey: isDatabaseUnavailable
          ? "general.errors.database_unavailable_description"
          : "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
    } catch (replyError) {
      log.error(
        "Command handler error reply failed completely:",
        {
          originalError: error,
          replyError: replyError,
          interactionState: {
            id: interaction.id,
            commandName: interaction.commandName,
            deferred: interaction.deferred,
            replied: interaction.replied,
            user: interaction.user.id,
          },
        },
        context,
      );
    }
  }
};

export default handler;
