import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { buildPersonalStatusPages, showPersonalStatus } from "@/utils/metrics/status/personalPages";
import { buildPersonaStatusPages, showPersonaStatus } from "@/utils/metrics/status/personaPages";
import { buildServerChannelPages } from "@/utils/metrics/status/serverChannelPages";
import { buildServerConfigPages } from "@/utils/metrics/status/serverConfigPages";
import { buildServerModelPages } from "@/utils/metrics/status/serverModelPages";
import {
  renderStatusPageDashboard,
  type StatusCategory,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";

export interface StatusCommandDependencies {
  getCachedTomoriState: typeof getCachedTomoriState;
  replyInfoEmbed: typeof replyInfoEmbed;
  showPersonalStatus: typeof showPersonalStatus;
  showPersonaStatus: typeof showPersonaStatus;
  buildServerChannelPages: typeof buildServerChannelPages;
  buildServerConfigPages: typeof buildServerConfigPages;
  buildServerModelPages: typeof buildServerModelPages;
  buildPersonalStatusPages: typeof buildPersonalStatusPages;
  buildPersonaStatusPages: typeof buildPersonaStatusPages;
  renderStatusPageDashboard: typeof renderStatusPageDashboard;
}

const defaultStatusCommandDependencies: StatusCommandDependencies = {
  getCachedTomoriState,
  replyInfoEmbed,
  showPersonalStatus,
  showPersonaStatus,
  buildServerChannelPages,
  buildServerConfigPages,
  buildServerModelPages,
  buildPersonalStatusPages,
  buildPersonaStatusPages,
  renderStatusPageDashboard,
};

/**
 * Executes the /status command for personal, server, and persona status scopes.
 */
export async function executeStatusCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
  dependencies: StatusCommandDependencies = defaultStatusCommandDependencies,
): Promise<void> {
  const serverDiscId = interaction.guildId ?? interaction.user.id;
  const scope = interaction.options.getString("scope", true);

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const validScopes: StatusCategory[] = ["persona", "behavior", "models", "access", "personal"];
    if (!validScopes.includes(scope as StatusCategory)) {
      log.error(`Invalid status scope received: ${scope}`);
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const tomoriState = await dependencies.getCachedTomoriState(serverDiscId);

    if (!tomoriState) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const [configPages, modelPages, channelPages, personalPages] = await Promise.all([
      dependencies.buildServerConfigPages(client, tomoriState, locale),
      dependencies.buildServerModelPages(client, serverDiscId, tomoriState, locale),
      dependencies.buildServerChannelPages(client, serverDiscId, tomoriState, locale),
      dependencies.buildPersonalStatusPages(interaction, userData, locale),
    ]);

    const siblingCategories: StatusPageCategory[] = [
      {
        id: "behavior",
        labelKey: "commands.status.scope_choice_behavior",
        pages: [configPages[0], configPages[3], channelPages[0]],
      },
      {
        id: "models",
        labelKey: "commands.status.scope_choice_models",
        pages: [modelPages[0], modelPages[1], modelPages[3], configPages[4]],
      },
      {
        id: "access",
        labelKey: "commands.status.scope_choice_access",
        pages: [configPages[1], configPages[2], modelPages[2]],
      },
      {
        id: "personal",
        labelKey: "commands.status.scope_choice_personal",
        pages: personalPages,
      },
    ];

    if (scope === "persona") {
      await dependencies.showPersonaStatus(interaction, userData, serverDiscId, locale, siblingCategories);
      return;
    }

    const categories: StatusPageCategory[] = [
      {
        id: "persona",
        labelKey: "commands.status.scope_choice_persona",
        pages: [],
      },
      ...siblingCategories,
    ];

    await dependencies.renderStatusPageDashboard(
      interaction,
      locale,
      categories,
      scope as StatusCategory,
      async (personaButtonInteraction) => {
        await dependencies.showPersonaStatus(
          personaButtonInteraction,
          userData,
          serverDiscId,
          locale,
          siblingCategories,
        );
      },
    );
  } catch (error) {
    log.error(`Error executing status command for scope ${scope}:`, error, {
      errorType: "CommandExecutionError",
      metadata: {
        commandName: "status",
        scope,
        guildDiscordId: serverDiscId,
      },
    });
    await dependencies.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
