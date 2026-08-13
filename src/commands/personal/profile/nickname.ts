import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { PERSONA_NAMING_VALUE_MAX_LENGTH, USER_NICKNAME_MAX_LENGTH } from "@/types/personaNaming";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { personaRepository, userNamingRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const MODAL_ID = "personal_naming_modal";
const NICKNAME_ID = "nickname";
const PREFIX_MODE_ID = "prefix_mode";
const PREFIX_ID = "prefix";
const SUFFIX_MODE_ID = "suffix_mode";
const SUFFIX_ID = "suffix";
type AffixMode = "inherit" | "none" | "custom";

interface NamingValues {
  nickname: string | null;
  prefix: string | null;
  suffix: string | null;
}

function affixMode(value: string | null | undefined): AffixMode {
  if (value === null || value === undefined) return "inherit";
  return value === "" ? "none" : "custom";
}

function namingModalComponents(locale: string, current: NamingValues) {
  const modeOptions = (selected: AffixMode) => [
    {
      value: "inherit",
      label: localizer(locale, "commands.personal.profile.nickname.inherit_option"),
      description: localizer(locale, "commands.personal.profile.nickname.inherit_description"),
      default: selected === "inherit",
    },
    {
      value: "none",
      label: localizer(locale, "commands.personal.profile.nickname.none_option"),
      description: localizer(locale, "commands.personal.profile.nickname.none_description"),
      default: selected === "none",
    },
    {
      value: "custom",
      label: localizer(locale, "commands.personal.profile.nickname.custom_option"),
      description: localizer(locale, "commands.personal.profile.nickname.custom_description"),
      default: selected === "custom",
    },
  ];
  return [
    {
      customId: NICKNAME_ID,
      labelKey: "commands.personal.profile.nickname.nickname_label",
      descriptionKey: "commands.personal.profile.nickname.nickname_description",
      style: TextInputStyle.Short,
      required: false,
      maxLength: USER_NICKNAME_MAX_LENGTH,
      value: current.nickname ?? "",
    },
    {
      kind: "radioGroup" as const,
      customId: PREFIX_MODE_ID,
      labelKey: "commands.personal.profile.nickname.prefix_mode_label",
      options: modeOptions(affixMode(current.prefix)),
      required: true,
    },
    {
      customId: PREFIX_ID,
      labelKey: "commands.personal.profile.nickname.prefix_label",
      descriptionKey: "commands.personal.profile.nickname.affix_text_description",
      style: TextInputStyle.Short,
      required: false,
      maxLength: PERSONA_NAMING_VALUE_MAX_LENGTH,
      value: current.prefix || "",
    },
    {
      kind: "radioGroup" as const,
      customId: SUFFIX_MODE_ID,
      labelKey: "commands.personal.profile.nickname.suffix_mode_label",
      options: modeOptions(affixMode(current.suffix)),
      required: true,
    },
    {
      customId: SUFFIX_ID,
      labelKey: "commands.personal.profile.nickname.suffix_label",
      descriptionKey: "commands.personal.profile.nickname.affix_text_description",
      style: TextInputStyle.Short,
      required: false,
      maxLength: PERSONA_NAMING_VALUE_MAX_LENGTH,
      value: current.suffix || "",
    },
  ];
}

function parseNamingValues(values: Record<string, string>): NamingValues | null {
  const parseAffix = (modeValue: string | undefined, textValue: string | undefined): string | null | undefined => {
    const text = textValue?.trim() ?? "";
    if (modeValue === "inherit") return null;
    if (modeValue === "none") return "";
    if (modeValue === "custom" && text) return text;
    return undefined;
  };
  const prefix = parseAffix(values[PREFIX_MODE_ID], values[PREFIX_ID]);
  const suffix = parseAffix(values[SUFFIX_MODE_ID], values[SUFFIX_ID]);
  if (prefix === undefined || suffix === undefined) return null;
  return {
    nickname: values[NICKNAME_ID]?.trim() || null,
    prefix: prefix as string | null,
    suffix: suffix as string | null,
  };
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("nickname")
    .setDescription(localizer("en-US", "commands.personal.profile.nickname.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.personal.profile.nickname.scope_description"))
        .setRequired(true)
        .addChoices({ name: "Global", value: "global" }, { name: "Persona", value: "persona" }),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel || !userData.user_id) return;
  const scope = interaction.options.getString("scope", true);
  if (scope === "global") {
    const result = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_ID,
        modalTitleKey: "commands.personal.profile.nickname.modal_title_global",
        components: namingModalComponents(locale, {
          nickname: userData.user_nickname,
          prefix: userData.prefix_override ?? null,
          suffix: userData.suffix_override ?? null,
        }),
      },
      MessageFlags.Ephemeral,
    );
    if (result.outcome !== "submit" || !result.interaction || !result.values) return;
    const next = parseNamingValues(result.values);
    if (!next) {
      await replyInfoEmbed(result.interaction, locale, {
        titleKey: "commands.personal.profile.nickname.invalid_affix_title",
        descriptionKey: "commands.personal.profile.nickname.invalid_affix_description",
        color: ColorCode.ERROR,
      });
      return;
    }
    try {
      await userNamingRepository.applyUserInfoBatch(userData.user_id, {
        global: {
          user_nickname: next.nickname,
          prefix_override: next.prefix,
          suffix_override: next.suffix,
        },
      });
      invalidateUserCache(interaction.user.id);
      await replyInfoEmbed(result.interaction, locale, {
        titleKey: "commands.personal.profile.nickname.success_title",
        descriptionKey: "commands.personal.profile.nickname.success_description_scoped",
        descriptionVars: { scope: localizer(locale, "commands.personal.profile.nickname.global_option") },
        color: ColorCode.SUCCESS,
      });
    } catch (error) {
      log.error("Failed to update global personal naming", error);
      await replyInfoEmbed(result.interaction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
    }
    return;
  }

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const personas = await personaRepository.loadAllForServer(serverDiscId);
  await runPersonaPickerWorkflow(interaction, locale, {
    personas,
    color: ColorCode.INFO,
    onSelected: async (selection) => {
      const lineageId = selection.persona.persona_lineage_id;
      if (lineageId == null) return completePersonaWorkflow();
      const preferences = await userNamingRepository.loadPreferences([
        { userId: userData.user_id as number, personaLineageId: lineageId },
      ]);
      const current = preferences.get(`${userData.user_id}:${lineageId}`);
      const result = await selection.openModal({
        modalCustomId: MODAL_ID,
        modalTitleKey: "commands.personal.profile.nickname.modal_title_persona",
        components: namingModalComponents(locale, {
          nickname: current?.nickname_override ?? null,
          prefix: current?.prefix_override ?? null,
          suffix: current?.suffix_override ?? null,
        }),
      });
      if (result.outcome !== "submitted") {
        return result.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
      }
      const work = await result.phase.beginInPlaceWork();
      const next = parseNamingValues(result.phase.values);
      if (!next) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.personal.profile.nickname.invalid_affix_title",
            descriptionKey: "commands.personal.profile.nickname.invalid_affix_description",
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.ERROR,
          }),
        );
        return retryPersonaWorkflow();
      }
      await userNamingRepository.applyUserInfoBatch(userData.user_id as number, {
        global: {},
        persona: {
          personaLineageId: lineageId,
          patch: {
            nickname_override: next.nickname,
            prefix_override: next.prefix,
            suffix_override: next.suffix,
          },
        },
      });
      invalidateUserCache(interaction.user.id);
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.personal.profile.nickname.success_title",
          descriptionKey: "commands.personal.profile.nickname.success_description_scoped",
          descriptionVars: { scope: selection.persona.persona_nickname },
          color: ColorCode.SUCCESS,
        }),
      );
      return completePersonaWorkflow();
    },
  });
}
