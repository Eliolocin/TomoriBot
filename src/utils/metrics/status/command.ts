import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { buildPersonalStatusPages, showPersonalStatus } from "@/utils/metrics/status/personalPages";
import { buildPersonaStatusPages } from "@/utils/metrics/status/personaPages";
import { buildServerChannelPages } from "@/utils/metrics/status/serverChannelPages";
import { buildServerConfigPages } from "@/utils/metrics/status/serverConfigPages";
import { buildServerModelPages } from "@/utils/metrics/status/serverModelPages";
import { resolveStatusDashboardCategories } from "@/utils/metrics/status/statusDashboard";
import { renderStatusPageDashboard, type StatusCategory } from "@/utils/metrics/status/statusPageRenderer";

export interface StatusCommandDependencies {
  getCachedAllPersonas: typeof getCachedAllPersonas;
  getCachedTomoriState: typeof getCachedTomoriState;
  replyInfoEmbed: typeof replyInfoEmbed;
  showPersonalStatus: typeof showPersonalStatus;
  buildServerChannelPages: typeof buildServerChannelPages;
  buildServerConfigPages: typeof buildServerConfigPages;
  buildServerModelPages: typeof buildServerModelPages;
  buildPersonalStatusPages: typeof buildPersonalStatusPages;
  buildPersonaStatusPages: typeof buildPersonaStatusPages;
  renderStatusPageDashboard: typeof renderStatusPageDashboard;
}

const defaultStatusCommandDependencies: StatusCommandDependencies = {
  getCachedAllPersonas,
  getCachedTomoriState,
  replyInfoEmbed,
  showPersonalStatus,
  buildServerChannelPages,
  buildServerConfigPages,
  buildServerModelPages,
  buildPersonalStatusPages,
  buildPersonaStatusPages,
  renderStatusPageDashboard,
};

/**
 * Executes the /status command for personal, server, and persona status categories.
 */
export async function executeStatusCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
  dependencies: StatusCommandDependencies = defaultStatusCommandDependencies,
): Promise<void> {
  const serverDiscId = interaction.guildId ?? interaction.user.id;
  const scope: StatusCategory = "persona";

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tomoriState = await dependencies.getCachedTomoriState(serverDiscId);

    if (!tomoriState) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const categories = await resolveStatusDashboardCategories(
      client,
      interaction,
      userData,
      serverDiscId,
      tomoriState,
      locale,
      dependencies,
    );

    const personas = await dependencies.getCachedAllPersonas(serverDiscId);
    const mainPersona = personas.find((persona) => !persona.is_alter) ?? tomoriState;
    const personaPages = await dependencies.buildPersonaStatusPages(mainPersona, userData, locale);
    const personaCategory = categories.find((category) => category.id === "persona");
    if (personaCategory) personaCategory.pages = personaPages;

    await dependencies.renderStatusPageDashboard(interaction, locale, categories, scope, {
      selectedPersonaId: mainPersona.persona_id,
      personas,
    });
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
