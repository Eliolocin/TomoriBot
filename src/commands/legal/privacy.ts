import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { EmbedBuilder, MessageFlags } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode } from "@/utils/misc/logger";
import { buildLegalDocUrl } from "@/utils/misc/docsUrl";
import { isHostedPolicyEnvironment } from "@/utils/misc/hostedPolicy";
import type { UserRow } from "@/types/db/schema";

/**
 * The Privacy Policy governs the hosted instance only, so a self-hosted bot does not expose
 * this leaf. Registering it anyway would offer a link to a policy that does not apply.
 */
export const isCommandEnabled = (): boolean => isHostedPolicyEnvironment();

/**
 * Configure the 'privacy-policy' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("privacy-policy").setDescription(localizer("en-US", "commands.legal.privacy-policy.description"));

/**
 * Executes the 'privacy-policy' command
 * Shows a link to the Privacy Policy on the docs site with dynamic locale support
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  const docsUrl = buildLegalDocUrl(locale, "privacy-policy");

  const embed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.legal.privacy-policy.title"))
    .setDescription(localizer(locale, "commands.legal.privacy-policy.description_text"))
    .addFields({
      name: localizer(locale, "commands.legal.privacy-policy.link_title"),
      value: docsUrl,
    })
    .setColor(ColorCode.INFO)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}
