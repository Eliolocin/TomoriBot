import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { USER_IDENTITY_FIELD_MAX_LENGTH } from "@/types/personaNaming";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { userNamingRepository } from "@/utils/db/repositories";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const MODAL_ID = "personal_profile_about_modal";
const GENDER_ID = "gender_identity";
const PRONOUNS_ID = "pronouns";
const STYLE_ID = "addressing_style";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("about").setDescription(localizer("en-US", "commands.personal.profile.about.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel || !userData.user_id) return;
  const result = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MODAL_ID,
      modalTitleKey: "commands.personal.profile.about.modal_title",
      components: [
        {
          customId: GENDER_ID,
          labelKey: "commands.personal.profile.about.gender_label",
          descriptionKey: "commands.personal.profile.about.gender_description",
          style: TextInputStyle.Short,
          required: false,
          maxLength: USER_IDENTITY_FIELD_MAX_LENGTH,
          value: userData.gender_identity ?? "",
        },
        {
          customId: PRONOUNS_ID,
          labelKey: "commands.personal.profile.about.pronouns_label",
          descriptionKey: "commands.personal.profile.about.pronouns_description",
          style: TextInputStyle.Short,
          required: false,
          maxLength: USER_IDENTITY_FIELD_MAX_LENGTH,
          value: userData.pronouns ?? "",
        },
        {
          kind: "radioGroup",
          customId: STYLE_ID,
          labelKey: "commands.personal.profile.about.style_label",
          descriptionKey: "commands.personal.profile.about.style_description",
          required: true,
          options: [
            {
              label: localizer(locale, "commands.personal.profile.about.style_unspecified"),
              value: "unspecified",
              default: !userData.addressing_style,
            },
            {
              label: localizer(locale, "commands.personal.profile.about.style_masculine"),
              value: "masculine",
              default: userData.addressing_style === "masculine",
            },
            {
              label: localizer(locale, "commands.personal.profile.about.style_feminine"),
              value: "feminine",
              default: userData.addressing_style === "feminine",
            },
            {
              label: localizer(locale, "commands.personal.profile.about.style_neutral"),
              value: "neutral",
              default: userData.addressing_style === "neutral",
            },
          ],
        },
      ],
    },
    MessageFlags.Ephemeral,
  );
  if (result.outcome !== "submit" || !result.interaction) {
    log.info(`Personal profile about modal ${result.outcome} for user ${interaction.user.id}`);
    return;
  }

  const clean = (value: string | undefined): string | null => value?.trim() || null;
  const style = result.values?.[STYLE_ID];
  if (!style || !["unspecified", "masculine", "feminine", "neutral"].includes(style)) {
    await replyInfoEmbed(result.interaction, locale, {
      titleKey: "general.errors.invalid_option_title",
      descriptionKey: "general.errors.invalid_option_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    await userNamingRepository.applyUserInfoBatch(userData.user_id, {
      global: {
        gender_identity: clean(result.values?.[GENDER_ID]),
        pronouns: clean(result.values?.[PRONOUNS_ID]),
        addressing_style: style === "unspecified" ? null : (style as "masculine" | "feminine" | "neutral"),
      },
    });
    invalidateUserCache(interaction.user.id);
    await replyInfoEmbed(result.interaction, locale, {
      titleKey: "commands.personal.profile.about.success_title",
      descriptionKey: "commands.personal.profile.about.success_description",
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    log.error("Failed to update personal profile settings", error);
    await replyInfoEmbed(result.interaction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
  }
}
