import type { Client } from "discord.js";
import { log } from "@/utils/misc/logger";

/**
 * Registry for caching Discord command IDs and generating command references.
 * Provides plain text command references (e.g., `/config setup`) that work reliably
 * in all contexts, including embed footers where Discord mentions often fail.
 */
class CommandRegistry {
  /** Map of command names to their IDs (format: "commandName" or "commandName:subcommand") */
  private commandIds: Map<string, string> = new Map();

  /** Whether the registry has been initialized */
  private initialized = false;

  /**
   * Initialize the command registry by fetching all registered commands from Discord.
   * This should be called once during bot startup after commands are registered.
   */
  async initialize(client: Client): Promise<void> {
    if (this.initialized) {
      log.warn("CommandRegistry already initialized, skipping");
      return;
    }

    try {
      // Fetch application commands (global commands)
      const commands = await client.application?.commands.fetch();

      if (!commands) {
        log.warn("No application commands found during registry initialization");
        return;
      }

      // Cache command IDs with their names
      for (const [id, command] of commands) {
        // Store base command
        this.commandIds.set(command.name, id);

        // If command has subcommands, store them with format "command:subcommand"
        if (command.options && command.options.length > 0) {
          for (const option of command.options) {
            if (option.type === 1) {
              // Type 1 = SUB_COMMAND
              const subcommandKey = `${command.name}:${option.name}`;
              this.commandIds.set(subcommandKey, id);
            } else if (option.type === 2) {
              // Type 2 = SUB_COMMAND_GROUP
              // For subcommand groups, we need to go one level deeper
              if ("options" in option && option.options) {
                for (const subOption of option.options) {
                  if (subOption.type === 1) {
                    const groupSubcommandKey = `${command.name}:${option.name}:${subOption.name}`;
                    this.commandIds.set(groupSubcommandKey, id);
                  }
                }
              }
            }
          }
        }
      }

      this.initialized = true;
      log.info(`CommandRegistry initialized with ${this.commandIds.size} command entries`);
    } catch (error) {
      log.error("Failed to initialize CommandRegistry", error as Error);
    }
  }

  /**
   * Get a plain text command reference that works reliably in all contexts.
   * Returns the command formatted as inline code (e.g., `/config setup`).
   * This approach is more reliable than Discord mentions, which:
   * - Don't render properly in embed footers
   * - Break when commands are re-registered
   * - May not work for users who haven't cached command IDs
   * @param commandName - The base command name (e.g., "help")
   * @param subcommandOrGroup - Optional subcommand or subcommand group name (e.g., "setup" or "memory")
   * @param subcommand - Optional subcommand when using a group (e.g., "personal" for "/teach memory personal")
   * @returns A plain text command reference like "`/config setup`"
   * @example
   * // Returns: "`/config setup`"
   * getCommandMention("config", "setup");
   *
   * // Returns: "`/teach memory personal`"
   * getCommandMention("teach", "memory", "personal");
   */
  getCommandMention(commandName: string, subcommandOrGroup?: string, subcommand?: string): string {
    let commandString: string;

    if (subcommandOrGroup && subcommand) {
      // Format: "/command group subcommand"
      commandString = `/${commandName} ${subcommandOrGroup} ${subcommand}`;
    } else if (subcommandOrGroup) {
      // Format: "/command subcommand"
      commandString = `/${commandName} ${subcommandOrGroup}`;
    } else {
      // Format: "/command"
      commandString = `/${commandName}`;
    }

    return `\`${commandString}\``;
  }

  /**
   * Check if the registry has been initialized.
   * @returns True if initialized, false otherwise
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get all registered command names (for debugging).
   */
  getRegisteredCommands(): string[] {
    return Array.from(this.commandIds.keys());
  }
}

// Export a singleton instance
export const commandRegistry = new CommandRegistry();
