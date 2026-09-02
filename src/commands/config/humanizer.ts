/**
 * Command: /config humanizer
 * Sets how 'human-like' Tomori's response delivery is (streaming, typing
 * simulation, sentence chunking, casual text).
 *
 * Scopes:
 * - global (default): server-wide value stored in server_chat_configs.humanizer_degree
 * - persona: per-persona override stored in persona_configs.humanizer_degree
 *   (persona picker shown first; the modal's "Inherit" choice clears the override)
 *
 * At runtime the persona override is overlaid onto config.humanizer_degree when
 * the persona's TomoriState is assembled, so the answering persona always speaks
 * at its own degree while everyone else inherits the global setting.
 */

import type {
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository, personaRepository } from "@/utils/db/repositories";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed, promptWithRawModal } from "@/utils/discord/interactionHelper";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import {
  createHumanizerOptions,
  HUMANIZER_DEFAULT,
  HUMANIZER_INHERIT_VALUE,
  HUMANIZER_MAX,
  HUMANIZER_MIN,
} from "@/utils/discord/humanizerOptions";

const MODAL_CUSTOM_ID = "config_humanizer_modal";
const HUMANIZER_SELECT_ID = "humanizer_select";

const INHERIT_VALUE = HUMANIZER_INHERIT_VALUE;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("humanizer")
    .setDescription(localizer("en-US", "commands.config.humanizer.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.config.humanizer.scope_description"))
        .setRequired(false)
        .addChoices(
          {
            name: localizer("en-US", "commands.config.humanizer.global_option"),
            value: "global",
          },
          {
            name: localizer("en-US", "commands.config.humanizer.persona_option"),
            value: "persona",
          },
        ),
    );

/**
 * Configures the humanizer degree setting for Tomori.
 * Has 4 levels, each stacking upon each other:
 * 0 = Active system prompt + aggregated visible delivery per tool-free phase
 * 1 = Active system prompt + live discrete streaming
 * 2 = 1 + typing simulation and pauses between messages
 * 3 = 2 + sentence-level chunking and casual text humanization
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  // Declare interaction handles outside try-catch for fallback error replies
  const modalHost = interaction;
  let modalSubmitInteraction: ModalSubmitInteraction | undefined;
  const workflowState: { message: PersonaWorkflowMessageController | null } = { message: null };
  const scope = (interaction.options.getString("scope") ?? "global") as "global" | "persona";

  try {
    if (scope === "persona") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    const tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Persona scope is fully owned by the anchor picker workflow.
    if (scope === "persona") {
      const allPersonas = await personaRepository.loadAllForServer(serverDiscId);

      if (allPersonas.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.config.humanizer.no_personas_title",
          descriptionKey: "commands.config.humanizer.no_personas_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        async onSelected(selection) {
          workflowState.message = selection.message;
          const selectedPersona = selection.persona;
          const personaId = selectedPersona.persona_id;
          if (personaId == null) {
            const work = await selection.beginInPlaceWork();
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.unknown_error_title",
                descriptionKey: "general.errors.unknown_error_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          try {
            const currentOverride = selectedPersona.humanizer_degree_override ?? null;
            const preselectedValue = currentOverride === null ? INHERIT_VALUE : String(currentOverride);
            const modalResult = await selection.openModal({
              modalCustomId: MODAL_CUSTOM_ID,
              modalTitleKey: "commands.config.humanizer.modal_title",
              components: [
                {
                  kind: "radioGroup" as const,
                  customId: HUMANIZER_SELECT_ID,
                  labelKey: "commands.config.humanizer.select_label",
                  descriptionKey: "commands.config.humanizer.select_description",
                  required: true,
                  options: createHumanizerOptions(locale, preselectedValue, true),
                },
              ],
            });
            if (modalResult.outcome !== "submitted") {
              log.info(`Humanizer degree selection modal ${modalResult.outcome} for user ${userData.user_id}`);
              return completePersonaWorkflow();
            }

            const work = await modalResult.phase.beginInPlaceWork();
            const selectedValue = modalResult.phase.values[HUMANIZER_SELECT_ID] ?? "";
            const humanizerValue = selectedValue === INHERIT_VALUE ? null : Number.parseInt(selectedValue, 10);
            if (
              humanizerValue !== null &&
              (Number.isNaN(humanizerValue) || humanizerValue < HUMANIZER_MIN || humanizerValue > HUMANIZER_MAX)
            ) {
              await work.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "general.errors.operation_failed_title",
                  descriptionKey: "commands.config.humanizer.invalid_value_description",
                  descriptionVars: { min: String(HUMANIZER_MIN), max: String(HUMANIZER_MAX) },
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            if (humanizerValue === currentOverride) {
              await work.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "commands.config.humanizer.already_set_title",
                  descriptionKey: "commands.config.humanizer.persona_already_set_description",
                  descriptionVars: {
                    value: getHumanizerLabel(locale, humanizerValue),
                    persona: selectedPersona.persona_nickname,
                  },
                  color: ColorCode.WARN,
                }),
              );
              return completePersonaWorkflow();
            }

            const updated = await personaRepository.setHumanizerOverride(personaId, humanizerValue);
            if (!updated) {
              const context: ErrorContext = {
                personaId,
                serverId: selectedPersona.server_id,
                userId: userData.user_id,
                errorType: "DatabaseUpdateError",
                metadata: {
                  command: "config humanizer",
                  guildId: serverDiscId,
                  scope: "persona",
                  humanizerValue,
                },
              };
              await log.error(
                "Failed to update humanizer_degree config",
                new Error("Database update returned no rows"),
                context,
              );
              await work.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "general.errors.update_failed_title",
                  descriptionKey: "general.errors.update_failed_description",
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            selectedPersona.humanizer_degree_override = humanizerValue;
            invalidateTomoriStateCache(serverDiscId);
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.config.humanizer.persona_success_title",
                descriptionKey: "commands.config.humanizer.persona_success_description",
                descriptionVars: {
                  persona: selectedPersona.persona_nickname,
                  value: getHumanizerLabel(locale, humanizerValue),
                  previous_value: getHumanizerLabel(locale, currentOverride),
                },
                color: ColorCode.SUCCESS,
              }),
            );
            return completePersonaWorkflow();
          } catch (error) {
            await selection.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.unknown_error_title",
                descriptionKey: "general.errors.unknown_error_description",
                color: ColorCode.ERROR,
              }),
            );
            throw error;
          }
        },
      });
      return;
    }

    // Resolve the current value for pre-selection and "already set" comparison.
    // Global scope reads the raw server_chat_configs row instead of cached state:
    // the cached main persona's config.humanizer_degree may already carry a persona
    // overlay, which would mask the true server-wide value.
    let currentGlobal = HUMANIZER_DEFAULT;
    if (tomoriState.server_id) {
      const chatConfig = await configRepository.getChatConfig(tomoriState.server_id);
      currentGlobal = chatConfig?.humanizer_degree ?? tomoriState.config.humanizer_degree ?? HUMANIZER_DEFAULT;
    }
    const preselectedValue = String(currentGlobal);

    const modalResult = await promptWithRawModal(modalHost, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.config.humanizer.modal_title",
      components: [
        {
          kind: "radioGroup" as const,
          customId: HUMANIZER_SELECT_ID,
          labelKey: "commands.config.humanizer.select_label",
          descriptionKey: "commands.config.humanizer.select_description",
          required: true,
          options: createHumanizerOptions(locale, preselectedValue, false),
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Humanizer degree selection modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
    modalSubmitInteraction = modalResult.interaction!;

    // Defer the modal submit interaction because DB write below exceeds the 3-second window
    await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
    const selectedValue = modalResult.values![HUMANIZER_SELECT_ID];

    // Global scope always submits a numeric degree.
    const humanizerValue = Number.parseInt(selectedValue, 10);

    // Validate the parsed value (additional safety check)
    if (Number.isNaN(humanizerValue) || humanizerValue < HUMANIZER_MIN || humanizerValue > HUMANIZER_MAX) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "commands.config.humanizer.invalid_value_description",
        descriptionVars: {
          min: String(HUMANIZER_MIN),
          max: String(HUMANIZER_MAX),
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    if (humanizerValue === currentGlobal) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.config.humanizer.already_set_title",
        descriptionKey: "commands.config.humanizer.already_set_description",
        descriptionVars: {
          value: getHumanizerLabel(locale, humanizerValue),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      humanizer_degree: humanizerValue,
    });

    if (!updated) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "config humanizer",
          guildId: serverDiscId,
          scope: "global",
          humanizerValue,
        },
      };
      await log.error(
        "Failed to update humanizer_degree config",
        new Error("Database update returned no rows"),
        context,
      );

      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Invalidate cache so next message gets fresh config
    invalidateTomoriStateCache(serverDiscId);

    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.config.humanizer.success_title",
      descriptionKey: "commands.config.humanizer.success_description",
      descriptionVars: {
        value: getHumanizerLabel(locale, humanizerValue),
        previous_value: getHumanizerLabel(locale, currentGlobal),
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    let serverIdForError: number | null = null;
    let personaIdForError: number | null = null;
    if (interaction.guild?.id) {
      const state = await getCachedTomoriState(interaction.guild.id);
      serverIdForError = state?.server_id ?? null;
      personaIdForError = state?.persona_id ?? null;
    }

    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: serverIdForError,
      personaId: personaIdForError,
      errorType: "CommandExecutionError",
      metadata: {
        command: "config humanizer",
        guildId: interaction.guild?.id ?? interaction.user.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Error executing /config humanizer for user ${userData.user_disc_id}`, error as Error, context);

    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    // Inform user of unknown error on the most specific available interaction
    const replyTarget = modalSubmitInteraction ?? modalHost;
    if (!replyTarget.replied && !replyTarget.deferred) {
      await replyTarget.reply({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await replyTarget.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

/**
 * Helper function to get a user-friendly label for humanizer values
 * @param value - Humanizer degree value, or null for the persona-scope "Inherit" state
 */
function getHumanizerLabel(locale: string, value: number | null): string {
  switch (value) {
    case null:
      return localizer(locale, "commands.config.humanizer.choice_inherit");
    case 0:
      return localizer(locale, "commands.config.humanizer.choice_none");
    case 1:
      return localizer(locale, "commands.config.humanizer.choice_light");
    case 2:
      return localizer(locale, "commands.config.humanizer.choice_medium");
    case 3:
      return localizer(locale, "commands.config.humanizer.choice_heavy");
    default:
      // Default to light if value is somehow unexpected, though validation should prevent this
      log.warn(`Unexpected humanizer value encountered in getHumanizerLabel: ${value}`);
      return localizer(locale, "commands.config.humanizer.choice_light");
  }
}
