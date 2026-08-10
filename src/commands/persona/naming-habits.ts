import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, PermissionsBitField, TextInputStyle } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import {
  PERSONA_NAMING_VALUE_MAX_LENGTH,
  personaNamingConfigSchema,
  validatePersonaNamingAuthoring,
  type AddressingStyle,
  type PersonaNamingConfig,
} from "@/types/personaNaming";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const MODAL_ID = "persona_naming_habits_modal";
const PREFIX_ID = "prefix";
const SUFFIX_ID = "suffix";
const TERM_ID = "address_term";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("naming-habits")
    .setDescription(localizer("en-US", "commands.persona.naming-habits.description"))
    .addStringOption((option) =>
      option
        .setName("style")
        .setDescription(localizer("en-US", "commands.persona.naming-habits.style_description"))
        .setRequired(true)
        .addChoices(
          { name: "Masculine", value: "masculine" },
          { name: "Feminine", value: "feminine" },
          { name: "Neutral", value: "neutral" },
        ),
    );

function updatedMap(
  source: PersonaNamingConfig["prefixes"],
  style: AddressingStyle,
  value: string,
): PersonaNamingConfig["prefixes"] {
  const next = { ...source };
  if (value) next[style] = value;
  else delete next[style];
  return next;
}

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) return;
  if (interaction.guild && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.persona.naming-habits.no_permission_title",
      descriptionKey: "commands.persona.naming-habits.no_permission_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const style = interaction.options.getString("style", true) as AddressingStyle;
  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const personas = await personaRepository.loadAllForServer(serverDiscId);
  await runPersonaPickerWorkflow(interaction, locale, {
    personas,
    color: ColorCode.INFO,
    onSelected: async (selection) => {
      const personaId = selection.persona.persona_id;
      if (!personaId) return completePersonaWorkflow();
      const current = selection.persona.naming_config;
      const modal = await selection.openModal({
        modalCustomId: MODAL_ID,
        modalTitleKey: "commands.persona.naming-habits.modal_title",
        components: [
          {
            customId: PREFIX_ID,
            labelKey: "commands.persona.naming-habits.prefix_label",
            descriptionKey: "commands.persona.naming-habits.prefix_description",
            style: TextInputStyle.Short,
            required: false,
            maxLength: PERSONA_NAMING_VALUE_MAX_LENGTH,
            value: current.prefixes[style] ?? "",
          },
          {
            customId: SUFFIX_ID,
            labelKey: "commands.persona.naming-habits.suffix_label",
            descriptionKey: "commands.persona.naming-habits.suffix_description",
            style: TextInputStyle.Short,
            required: false,
            maxLength: PERSONA_NAMING_VALUE_MAX_LENGTH,
            value: current.suffixes[style] ?? "",
          },
          {
            customId: TERM_ID,
            labelKey: "commands.persona.naming-habits.address_term_label",
            descriptionKey: "commands.persona.naming-habits.address_term_description",
            style: TextInputStyle.Short,
            required: false,
            maxLength: PERSONA_NAMING_VALUE_MAX_LENGTH,
            value: current.addressTerms[style] ?? "",
          },
        ],
      });
      if (modal.outcome !== "submitted") {
        return modal.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
      }
      const work = await modal.phase.beginInPlaceWork();
      const config = {
        prefixes: updatedMap(current.prefixes, style, modal.phase.values[PREFIX_ID]?.trim() ?? ""),
        suffixes: updatedMap(current.suffixes, style, modal.phase.values[SUFFIX_ID]?.trim() ?? ""),
        addressTerms: updatedMap(current.addressTerms, style, modal.phase.values[TERM_ID]?.trim() ?? ""),
      };
      const parsed = personaNamingConfigSchema.safeParse(config);
      const validatedConfig = parsed.success ? parsed.data : null;
      let validationFailed = !parsed.success;
      if (parsed.success) {
        try {
          validatePersonaNamingAuthoring(parsed.data, [
            selection.persona.persona_prompt ?? "",
            ...(selection.persona.attribute_list ?? []),
            ...(selection.persona.sample_dialogues_in ?? []),
            ...(selection.persona.sample_dialogues_out ?? []),
          ]);
        } catch {
          validationFailed = true;
        }
      }
      if (validationFailed) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.persona.naming-habits.neutral_required_title",
            descriptionKey: "commands.persona.naming-habits.neutral_required_description",
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.ERROR,
          }),
        );
        return retryPersonaWorkflow();
      }
      if (!validatedConfig) return retryPersonaWorkflow();
      const saved = await personaRepository.updateNamingConfig(personaId, validatedConfig);
      if (!saved) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.update_failed_title",
            descriptionKey: "general.errors.update_failed_description",
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.ERROR,
          }),
        );
        return retryPersonaWorkflow();
      }
      invalidateTomoriStateCache(serverDiscId);
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.persona.naming-habits.success_title",
          descriptionKey: "commands.persona.naming-habits.success_description",
          descriptionVars: { persona: selection.persona.persona_nickname, style },
          color: ColorCode.SUCCESS,
        }),
      );
      return completePersonaWorkflow();
    },
  });
}
