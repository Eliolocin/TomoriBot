import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { EmbedBuilder, MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode } from "@/utils/misc/logger";
import { buildLegalDocUrl } from "@/utils/misc/docsUrl";
import { isHostedPolicyEnvironment } from "@/utils/misc/hostedPolicy";
import type { UserRow } from "@/types/db/schema";

/**
 * The Terms of Service govern the hosted instance only, so a self-hosted bot does not expose
 * this leaf. Registering it anyway would offer a link to terms that do not apply.
 */
export const isCommandEnabled = (): boolean => isHostedPolicyEnvironment();

/**
 * Configure the 'terms-of-service' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("terms-of-service")
    .setDescription(localizer("en-US", "commands.legal.terms-of-service.description"));

/**
 * Executes the 'terms-of-service' command
 * Shows a link to the Terms of Service on the docs site with dynamic locale support
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  const docsUrl = buildLegalDocUrl(locale, "terms-of-service");

  const embed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.legal.terms-of-service.title"))
    .setDescription(localizer(locale, "commands.legal.terms-of-service.description_text"))
    .addFields({
      name: localizer(locale, "commands.legal.terms-of-service.link_title"),
      value: docsUrl,
    })
    .setColor(ColorCode.INFO)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}
