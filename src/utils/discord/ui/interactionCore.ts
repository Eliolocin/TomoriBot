import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionResponseType,
} from "discord.js";
import type {
  ActionRowData,
  ButtonInteraction,
  ButtonComponentData,
  ChannelSelectMenuInteraction,
  ChatInputCommandInteraction,
  ComponentInContainerData,
  ContainerComponentData,
  Message,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  InteractionUpdateOptions,
  MessagePayload,
  MentionableSelectMenuInteraction,
  RoleSelectMenuInteraction,
  APIAttachment,
  StringSelectMenuInteraction,
  TopLevelComponentData,
  UserSelectMenuInteraction,
} from "discord.js";
import { localizer } from "../../text/localizer";
import { log, ColorCode } from "../../misc/logger";
import type {
  RawDiscordComponent,
  RawDiscordWebSocketPacket,
  RawDiscordShard,
  GlobalDiscordState,
} from "@/types/discord/rawApiTypes";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import { resolveAlterPersonaAvatarAsset, type PersonaAvatarAsset } from "@/utils/discord/personaPanelAvatar";
import { getLastDbError } from "@/utils/cache/tomoriStateCache";
import {
  ComponentsV2LimitError,
  truncateDiscordText,
  validateComponentsV2MessageLimits,
  type ComponentsV2MessagePayload,
} from "./componentsV2Limits";
export { ComponentsV2LimitError, validateComponentsV2MessageLimits, type ComponentsV2MessagePayload };
import { buildPanelContainer } from "./panel";

// Clean storage for select values (Discord.js will strip them, so we preserve them)
const modalSelectValues = new Map<string, Record<string, string>>();

// Storage for file upload attachment IDs keyed by modal component custom ID
const modalFileUploadValues = new Map<string, Record<string, string[]>>();

// Storage for checkbox group selected values keyed by modal component custom ID
const modalCheckboxGroupValues = new Map<string, Record<string, string[]>>();

// Storage for resolved attachments from modal file uploads (Discord.js doesn't expose these)
const modalResolvedAttachments = new Map<string, Record<string, APIAttachment>>();

/**
 * Tracks interactions that were acknowledged via raw Discord REST API
 * Used to prevent "already acknowledged" errors when Discord.js state is out of sync
 */
const rawModalAcknowledged = new WeakMap<
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | UserSelectMenuInteraction
  | RoleSelectMenuInteraction
  | MentionableSelectMenuInteraction,
  boolean
>();

/**
 * Reports whether a command, button, or select menu interaction was acknowledged through the
 * raw REST modal path. Discord.js does not update `replied`/`deferred` for that
 * response, so workflow code must consult this state explicitly.
 */
export function hasRawModalAcknowledgement(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | UserSelectMenuInteraction
    | RoleSelectMenuInteraction
    | MentionableSelectMenuInteraction,
): boolean {
  return rawModalAcknowledged.get(interaction) === true;
}

/**
 * Tracks interactions whose reply message has been rendered as a Components V2
 * payload. Discord permanently stamps `IsComponentsV2` on such a message, and that
 * flag can never be removed by a later edit, so nor can a V2 message carry legacy
 * `embeds`/`content`. So once a selector (or any V2 writer) renders onto an
 * interaction's reply, a subsequent legacy `editReply({ embeds })` on the SAME
 * interaction would be rejected by Discord.
 *
 * The shared legacy sinks below ({@link replyInfoEmbed}, {@link replySummaryEmbed},
 * {@link replyPaginatedStatusPages}) consult this set and emit a V2-safe notice
 * instead. Mirrors the {@link rawModalAcknowledged} `WeakMap` pattern in this file:
 * interaction-keyed state that avoids an extra Discord fetch to read live flags.
 */
const componentsV2Reply = new WeakSet<ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction>();

/**
 * Marks an interaction's reply message as carrying `IsComponentsV2`. Callers that
 * write a Components V2 payload onto an interaction's own reply must call this so the
 * legacy sinks stay V2-safe if they later target the same interaction.
 *
 */
export function markComponentsV2Reply(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
): void {
  componentsV2Reply.add(interaction);
}

/**
 * Reports whether {@link markComponentsV2Reply} previously flagged this interaction's
 * reply as a Components V2 message.
 *
 */
export function hasComponentsV2Reply(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
): boolean {
  return componentsV2Reply.has(interaction);
}

/**
 * Transform Component Type 18 modal submission to standard ActionRow format
 * This makes Discord.js process the submission as if it were a normal modal from the start
 */
function transformModalSubmissionPacket(packet: RawDiscordWebSocketPacket): void {
  if (!packet.d?.data?.components) return;

  // Transform each Component Type 18 to standard ActionRow format with all data preserved
  packet.d.data.components = packet.d.data.components.map((comp) => {
    if (comp.type === 18 && comp.component) {
      const nestedComponent = comp.component;

      return {
        type: 1, // ActionRow
        components: [
          {
            type: nestedComponent.type,
            custom_id: nestedComponent.custom_id,
            ...(nestedComponent.type === 3 && {
              // STRING_SELECT
              values: nestedComponent.values,
            }),
            ...(nestedComponent.type === 4 && {
              value: nestedComponent.value,
            }),
            ...(nestedComponent.type === 5 && {
              values: nestedComponent.values,
            }),
            ...(nestedComponent.type === 6 && {
              values: nestedComponent.values,
            }),
            ...(nestedComponent.type === 8 && {
              // CHANNEL_SELECT
              channel_types: nestedComponent.channel_types,
              values: nestedComponent.values,
            }),
            ...(nestedComponent.type === 19 && {
              values: nestedComponent.values, // Array of attachment IDs
            }),
            ...(nestedComponent.type === 21 && {
              // RADIO_GROUP: value is the selected option string (or null)
              value: nestedComponent.value,
            }),
            ...(nestedComponent.type === 22 && {
              // CHECKBOX_GROUP: values is an array of selected option strings
              values: nestedComponent.values,
            }),
            ...(nestedComponent.type === 23 && {
              value: nestedComponent.value,
            }),
            ...Object.fromEntries(
              Object.entries(nestedComponent).filter(
                ([key]) => !["type", "custom_id", "values", "value"].includes(key),
              ),
            ),
          },
        ],
      };
    }
    return comp;
  });
}

/**
 * Intercept and transform WebSocket messages for Component Type 18 support
 * This patches the actual WebSocket message handler at a lower level
 */

type InterceptableDiscordClient = {
  ws?: {
    handlePacket?: (packet: RawDiscordWebSocketPacket, shard: RawDiscordShard) => unknown;
  };
};

function setupWebSocketInterception(client: unknown) {
  if ((globalThis as GlobalDiscordState).__webSocketPatched) return;

  try {
    // Patch the WebSocket manager's handlePacket method
    const wsManager = (client as InterceptableDiscordClient).ws;
    if (wsManager?.handlePacket) {
      const originalHandlePacket = wsManager.handlePacket.bind(wsManager);

      wsManager.handlePacket = (packet: RawDiscordWebSocketPacket, shard: RawDiscordShard) => {
        // Intercept INTERACTION_CREATE packets for modal submissions
        if (packet.t === "INTERACTION_CREATE" && packet.d?.type === 5 && packet.d?.data?.components) {
          const hasComponentType18 = packet.d.data.components.some((comp: RawDiscordComponent) => comp.type === 18);

          if (hasComponentType18) {
            log.info("Transforming Component Type 18 modal submission for Discord.js compatibility");

            const interactionId = packet.d.id;
            if (interactionId) {
              const selectValues: Record<string, string> = {};
              const fileUploadValues: Record<string, string[]> = {};
              const checkboxGroupValues: Record<string, string[]> = {};

              for (const comp of packet.d.data.components) {
                if (comp.type !== 18 || !comp.component?.custom_id) continue;
                const inner = comp.component;
                // Narrowed above: custom_id is guaranteed to be a non-empty string
                const customId = inner.custom_id as string;

                // Native select fields share one store because these routed fields accept one value each.
                if (
                  (inner.type === 3 || inner.type === 5 || inner.type === 6 || inner.type === 8) &&
                  inner.values?.[0]
                ) {
                  selectValues[customId] = inner.values[0];
                }

                // File Upload (type 19): store all attachment IDs
                if (inner.type === 19 && Array.isArray(inner.values)) {
                  fileUploadValues[customId] = inner.values;
                }

                // Radio Group (type 21): store selected value string (null → empty string)
                if (inner.type === 21) {
                  selectValues[customId] = typeof inner.value === "string" ? inner.value : "";
                }

                // Checkbox Group (type 22): store array of selected values
                if (inner.type === 22 && Array.isArray(inner.values)) {
                  checkboxGroupValues[customId] = inner.values;
                }

                if (inner.type === 23) {
                  selectValues[customId] = inner.value === true ? "true" : "false";
                }
              }

              if (Object.keys(selectValues).length > 0) {
                modalSelectValues.set(interactionId, selectValues);
                log.info(`Stored ${Object.keys(selectValues).length} select/radio/checkbox values for interaction`);
              }

              if (Object.keys(fileUploadValues).length > 0) {
                modalFileUploadValues.set(interactionId, fileUploadValues);
                log.info(`Stored ${Object.keys(fileUploadValues).length} file upload value set(s) for interaction`);
              }

              if (Object.keys(checkboxGroupValues).length > 0) {
                modalCheckboxGroupValues.set(interactionId, checkboxGroupValues);
                log.info(
                  `Stored ${Object.keys(checkboxGroupValues).length} checkbox group value set(s) for interaction`,
                );
              }

              // Store resolved attachments before Discord.js processes them
              if (packet.d.data.resolved?.attachments) {
                const resolvedAttachments = packet.d.data.resolved.attachments as Record<string, APIAttachment>;
                modalResolvedAttachments.set(interactionId, resolvedAttachments);
                log.info(
                  `Stored ${Object.keys(resolvedAttachments).length} resolved attachments for interaction ${interactionId}`,
                );
              }
            }

            transformModalSubmissionPacket(packet);
          }
        }

        return originalHandlePacket(packet, shard);
      };

      (globalThis as GlobalDiscordState).__webSocketPatched = true;
      log.info("Component Type 18 WebSocket transformation enabled");
    } else {
      log.warn("Could not find WebSocket handlePacket method for Component Type 18 support");
    }
  } catch (error) {
    log.warn("Failed to set up Component Type 18 WebSocket interception:", error);
  }
}

export function initializeRawModalInterception(client: unknown): void {
  setupWebSocketInterception(client);
}

import type {
  ConfirmationOptions,
  ConfirmationResult,
  PaginatedChoiceOptions,
  PaginatedChoiceResult,
  StandardEmbedOptions,
  SummaryEmbedOptions,
} from "../../../types/discord/embed";
import type {
  ModalComponent,
  ModalOptions,
  ModalResult,
  ModalRadioGroupField,
  ModalCheckboxGroupField,
  ModalCheckboxField,
  ModalUserSelectField,
  ModalRoleSelectField,
  ModalChannelSelectField,
} from "../../../types/discord/modal";
import {
  isModalInputField,
  isModalSelectField,
  isModalFileUploadField,
  isModalRadioGroupField,
  isModalCheckboxGroupField,
  isModalCheckboxField,
  isModalUserSelectField,
  isModalRoleSelectField,
  isModalChannelSelectField,
} from "../../../types/discord/modal";
import {
  createStandardEmbed,
  createSummaryEmbed,
  createTipText,
  TIP_BUTTON_TIMEOUT_MS,
  TIP_DETAILS_BUTTON_ID,
} from "../embedHelper";
import { buildDocsLinkRow } from "@/utils/discord/docsLinks";
import { attachTextDisplayModalCollector, buildTextDisplayModalButton } from "@/utils/discord/textDisplayModal";

const PROMPT_TIMEOUT = 60000; // 60 seconds
const MODAL_DESCRIPTION_MAX_LENGTH = 99; // Discord modal description limit
const MODAL_TITLE_MAX_LENGTH = 45;
const MODAL_LABEL_MAX_LENGTH = 45;
const TEXT_INPUT_PLACEHOLDER_MAX_LENGTH = 100;
const SELECT_PLACEHOLDER_MAX_LENGTH = 150;
const SELECT_OPTION_TEXT_MAX_LENGTH = 100;
const CONFIRMATION_DESCRIPTION_LIMIT = 3800; // Budget for description, leaving room for title/buttons in the 4000-char total component limit

/**
 * @description Detects a discord.js collector expiry across every awaiting surface
 * (`awaitMessageComponent`, `awaitModalSubmit`, and raw component collectors).
 * discord.js is inconsistent about the rejection shape, so both are handled:
 *   - Raw collectors reject with the bare end-reason string (`"time"` / `"idle"`).
 *   - `Message#awaitMessageComponent` and `awaitModalSubmit` reject with an
 *      `InteractionCollectorError` whose message embeds the end reason, e.g.
 *      "Collector received no interactions before ending with reason: time".
 * Only `time`/`idle` count as expiry: `limit`, `messageDelete`, and channel/guild
 * deletions are genuine failures the caller must surface as errors.
 */
export function isCollectorTimeoutError(error: unknown): boolean {
  if (error === "time" || error === "idle") return true;
  if (!error || typeof error !== "object") return false;

  // InteractionCollectorError form: identify by code/name, then read the reason.
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  const isInteractionCollectorError =
    code === "interactioncollectorerror" ||
    name === "interactioncollectorerror" ||
    message.includes("collector received");

  return isInteractionCollectorError && (message.includes("reason: time") || message.includes("reason: idle"));
}

function createRawModalRestError(response: Response, responseBody: string): Error {
  let rawError: unknown;
  try {
    rawError = JSON.parse(responseBody);
  } catch {
    rawError = responseBody;
  }

  const rawErrorRecord = rawError && typeof rawError === "object" ? (rawError as Record<string, unknown>) : undefined;
  const discordMessage = typeof rawErrorRecord?.message === "string" ? rawErrorRecord.message : response.statusText;
  const error = new Error(`Discord API error: ${response.status} ${discordMessage}`) as Error & {
    code?: unknown;
    rawError: unknown;
    status: number;
  };
  error.code = rawErrorRecord?.code;
  error.rawError = rawError;
  error.status = response.status;
  return error;
}

export async function showRoutedRawModal(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | UserSelectMenuInteraction
    | RoleSelectMenuInteraction
    | MentionableSelectMenuInteraction,
  data: { custom_id: string; title: string; components: RawDiscordComponent[] },
): Promise<void> {
  setupWebSocketInterception(interaction.client);
  const restEndpoint = `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`;
  const response = await fetch(restEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: InteractionResponseType.Modal, data }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    log.error(`Failed to send raw modal via REST API: ${response.status} ${response.statusText} - ${errorText}`);
    throw createRawModalRestError(response, errorText);
  }
  rawModalAcknowledged.set(interaction, true);
  log.info(`Marked interaction ${interaction.id} as raw-modal-acknowledged`);
}

export function takeRawModalSelectValue(interactionId: string, customId: string): string | undefined {
  const storedValues = modalSelectValues.get(interactionId);
  if (!storedValues) return undefined;
  const val = storedValues[customId];
  delete storedValues[customId];
  if (Object.keys(storedValues).length === 0) {
    modalSelectValues.delete(interactionId);
  }
  return val;
}

export function takeRawModalUserSelectValue(interactionId: string, customId: string): string | undefined {
  return takeRawModalSelectValue(interactionId, customId);
}

export function takeRawModalRoleSelectValue(interactionId: string, customId: string): string | undefined {
  return takeRawModalSelectValue(interactionId, customId);
}

export function takeRawModalChannelSelectValue(interactionId: string, customId: string): string | undefined {
  return takeRawModalSelectValue(interactionId, customId);
}

export function takeRawModalCheckboxGroupValues(interactionId: string, customId: string): string[] | undefined {
  const storedValues = modalCheckboxGroupValues.get(interactionId);
  if (!storedValues) return undefined;
  const val = storedValues[customId];
  delete storedValues[customId];
  if (Object.keys(storedValues).length === 0) {
    modalCheckboxGroupValues.delete(interactionId);
  }
  return val;
}

export function takeRawModalFileUpload(interactionId: string, customId: string): APIAttachment | undefined {
  const storedAttachments = modalResolvedAttachments.get(interactionId);
  const storedFileUploadValues = modalFileUploadValues.get(interactionId);
  if (!storedAttachments) return undefined;

  let attachment: APIAttachment | undefined;
  const attachmentIds = storedFileUploadValues?.[customId];
  if (attachmentIds && attachmentIds.length > 0) {
    const attachmentId = attachmentIds[0];
    attachment = storedAttachments[attachmentId];
    if (attachment) {
      delete storedAttachments[attachmentId];
    }
  } else if (!storedFileUploadValues || Object.keys(storedFileUploadValues).length <= 1) {
    const [firstId, firstAttachment] = Object.entries(storedAttachments)[0] ?? [];
    if (firstAttachment) {
      attachment = firstAttachment;
      delete storedAttachments[firstId];
    }
  }

  if (storedFileUploadValues) {
    delete storedFileUploadValues[customId];
    if (Object.keys(storedFileUploadValues).length === 0) {
      modalFileUploadValues.delete(interactionId);
    }
  }

  if (Object.keys(storedAttachments).length === 0) {
    modalResolvedAttachments.delete(interactionId);
  }

  return attachment;
}

/**
 * Safely localizes a string for modal usage, truncating if necessary to prevent Discord API errors
 * @param vars Variables for localization (optional)
 * @param maxLength Maximum allowed length (defaults to modal description limit)
 */
export function safeModalLocalizer(
  locale: string,
  key: string,
  vars?: Record<string, string | number>,
  maxLength: number = MODAL_DESCRIPTION_MAX_LENGTH,
): string {
  const localizedText = localizer(locale, key, vars);

  if (localizedText.length > maxLength) {
    log.warn(
      `Modal locale string truncated - Key: '${key}', Original: ${localizedText.length} chars, Truncated to: ${maxLength} chars`,
      {
        originalText: localizedText,
        truncatedText: `${localizedText.substring(0, maxLength - 3)}...`,
      },
    );
    return `${localizedText.substring(0, maxLength - 3)}...`;
  }

  return localizedText;
}

function truncateForDiscordDescription(text: string): string {
  if (text.length <= CONFIRMATION_DESCRIPTION_LIMIT) {
    return text;
  }

  return `${text.substring(0, CONFIRMATION_DESCRIPTION_LIMIT - 3)}...`;
}

function localizeConfirmationDescription(
  locale: string,
  key: string,
  vars?: Record<string, string | number | boolean>,
): string {
  const localizedText = localizer(locale, key, vars);

  if (localizedText.length > CONFIRMATION_DESCRIPTION_LIMIT) {
    log.warn(
      `Confirmation description truncated - Key: '${key}', Original: ${localizedText.length} chars, Truncated to: ${CONFIRMATION_DESCRIPTION_LIMIT} chars`,
    );
  }

  return truncateForDiscordDescription(localizedText);
}

/**
 * Safely truncates text for select option labels and values with "..." suffix,
 * delegating to the Unicode-safe truncation primitive.
 * @param maxLength Maximum allowed length (100 for select options)
 */
export function safeSelectOptionText(text: string, maxLength = 100): string {
  return truncateDiscordText(text, maxLength, "...");
}

/**
 * @description Prompts the user with an embed and Continue/Cancel buttons, awaiting their response.
 * Handles interaction replies, button filtering, and timeouts.
 */
export async function promptWithConfirmation(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const {
    embedTitleKey,
    embedDescriptionKey,
    embedDescriptionVars = {},
    embedColor = ColorCode.WARN, // Default Warning/Question color
    continueLabelKey,
    cancelLabelKey,
    continueCustomId,
    cancelCustomId,
    timeout = PROMPT_TIMEOUT, // Default 15 seconds
    continueStyle = ButtonStyle.Secondary,
    cancelStyle = ButtonStyle.Secondary,
  } = options;
  const localizedDescription = localizeConfirmationDescription(locale, embedDescriptionKey, embedDescriptionVars);

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(localizer(locale, embedTitleKey))
    .setDescription(localizedDescription);

  const continueButton = new ButtonBuilder()
    .setCustomId(continueCustomId)
    .setLabel(localizer(locale, continueLabelKey))
    .setStyle(continueStyle);

  const cancelButton = new ButtonBuilder()
    .setCustomId(cancelCustomId)
    .setLabel(localizer(locale, cancelLabelKey))
    .setStyle(cancelStyle);

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(continueButton, cancelButton);

  let message: Message;
  try {
    // First, check if this interaction has already been responded to
    if (interaction.deferred || interaction.replied) {
      message = await interaction.editReply({
        embeds: [embed],
        components: [buttonRow],
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: [buttonRow],
        flags: MessageFlags.Ephemeral,
      });
      message = (await interaction.fetchReply()) as Message;
    }
  } catch (error) {
    log.error("Failed to edit reply in promptWithConfirmation:", error);
    try {
      // Try followUp as a fallback
      message = (await interaction.followUp({
        embeds: [embed],
        components: [buttonRow],
        flags: MessageFlags.Ephemeral,
      })) as Message;
    } catch (followUpError) {
      log.error("Failed to follow up in promptWithConfirmation:", followUpError);
      return { outcome: "timeout" };
    }
  }

  const buttonCollectorFilter = (i: ButtonInteraction) => {
    i.deferUpdate().catch((e) => log.warn("Failed to defer update on button filter:", e));
    return i.user.id === interaction.user.id;
  };

  // Await Component Interaction
  try {
    const buttonInteraction = await message.awaitMessageComponent({
      filter: buttonCollectorFilter,
      componentType: ComponentType.Button,
      time: timeout,
    });

    if (buttonInteraction.customId === continueCustomId) {
      return { outcome: "continue", interaction: buttonInteraction };
    }

    const cancelEmbed = new EmbedBuilder()
      .setColor(ColorCode.ERROR)
      .setTitle(localizer(locale, "general.interaction.cancel_title"))
      .setDescription(localizer(locale, "general.interaction.cancel_description"));

    await interaction.editReply({ embeds: [cancelEmbed], components: [] });
    return { outcome: "cancel" };
  } catch (_timeoutError) {
    log.warn(`Confirmation prompt timed out for user ${interaction.user.id}`);
    const timeoutEmbed = new EmbedBuilder()
      .setColor(ColorCode.ERROR)
      .setTitle(localizer(locale, "general.interaction.timeout_title"))
      .setDescription(localizer(locale, "general.interaction.timeout_description"));
    await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
    return { outcome: "timeout" };
  }
}

/**
 * @description Prompts the user with a confirmation embed and buttons without
 * pre-acknowledging the selected button interaction, so the caller can still
 * open a modal from the returned ButtonInteraction.
 */
export async function promptWithUnacknowledgedConfirmation(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  options: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const {
    embedTitleKey,
    embedDescriptionKey,
    embedDescriptionVars = {},
    embedColor = ColorCode.WARN,
    useComponentsV2 = false,
    continueLabelKey,
    cancelLabelKey,
    continueCustomId,
    cancelCustomId,
    timeout = PROMPT_TIMEOUT,
    continueStyle = ButtonStyle.Secondary,
    cancelStyle = ButtonStyle.Secondary,
  } = options;
  const localizedDescription = localizeConfirmationDescription(locale, embedDescriptionKey, embedDescriptionVars);

  const embed = createStandardEmbed(locale, {
    titleKey: embedTitleKey,
    description: localizedDescription,
    color: embedColor,
  });

  const continueButton = new ButtonBuilder()
    .setCustomId(continueCustomId)
    .setLabel(localizer(locale, continueLabelKey))
    .setStyle(continueStyle);

  const cancelButton = new ButtonBuilder()
    .setCustomId(cancelCustomId)
    .setLabel(localizer(locale, cancelLabelKey))
    .setStyle(cancelStyle);

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(continueButton, cancelButton);
  const v2Components = useComponentsV2
    ? buildV2ConfirmationComponents(
        locale,
        localizer(locale, embedTitleKey),
        localizedDescription,
        embedColor,
        continueLabelKey,
        cancelLabelKey,
        continueCustomId,
        cancelCustomId,
        continueStyle,
        cancelStyle,
      )
    : null;

  let message: Message;
  try {
    const wasRawModalAcked =
      rawModalAcknowledged.get(interaction as ChatInputCommandInteraction | ButtonInteraction) ?? false;
    if (interaction.deferred || interaction.replied) {
      message = await interaction.editReply(
        useComponentsV2
          ? {
              components: v2Components ?? [],
              flags: MessageFlags.IsComponentsV2,
            }
          : {
              embeds: [embed],
              components: [buttonRow],
            },
      );
    } else if (wasRawModalAcked) {
      // Raw REST modal consumed the initial response without creating a reply message.
      // editReply() has nothing to target; Discord.js followUp() guard also blocks
      // (requires replied||deferred). Use webhook.send() to bypass both.
      message = (await interaction.webhook.send(
        useComponentsV2
          ? {
              components: v2Components ?? [],
              flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            }
          : {
              embeds: [embed],
              components: [buttonRow],
              flags: MessageFlags.Ephemeral,
            },
      )) as Message;
    } else {
      await interaction.reply(
        useComponentsV2
          ? {
              components: v2Components ?? [],
              flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            }
          : {
              embeds: [embed],
              components: [buttonRow],
              flags: MessageFlags.Ephemeral,
            },
      );
      message = await interaction.fetchReply();
    }
  } catch (error) {
    log.error("Failed to send modal confirmation prompt:", error);
    return { outcome: "timeout" };
  }

  try {
    const buttonInteraction = await message.awaitMessageComponent({
      filter: (i) =>
        i.user.id === interaction.user.id && (i.customId === continueCustomId || i.customId === cancelCustomId),
      componentType: ComponentType.Button,
      time: timeout,
    });

    if (buttonInteraction.customId === continueCustomId) {
      return { outcome: "continue", interaction: buttonInteraction };
    }

    await buttonInteraction.update(
      useComponentsV2
        ? {
            components: buildV2StatusComponents(
              locale,
              "general.interaction.cancel_title",
              "general.interaction.cancel_description",
              ColorCode.ERROR,
            ),
            flags: MessageFlags.IsComponentsV2,
          }
        : {
            embeds: [
              createStandardEmbed(locale, {
                titleKey: "general.interaction.cancel_title",
                descriptionKey: "general.interaction.cancel_description",
                color: ColorCode.ERROR,
              }),
            ],
            components: [],
          },
    );
    return { outcome: "cancel" };
  } catch (_timeoutError) {
    log.warn(`Unacknowledged confirmation prompt timed out for user ${interaction.user.id}`);
    await interaction.editReply(
      useComponentsV2
        ? {
            components: buildV2StatusComponents(
              locale,
              "general.interaction.timeout_title",
              "general.interaction.timeout_description",
              ColorCode.ERROR,
            ),
            flags: MessageFlags.IsComponentsV2,
          }
        : {
            embeds: [
              createStandardEmbed(locale, {
                titleKey: "general.interaction.timeout_title",
                descriptionKey: "general.interaction.timeout_description",
                color: ColorCode.ERROR,
              }),
            ],
            components: [],
          },
    );
    return { outcome: "timeout" };
  }
}

/**
 * @description Prompts the user with a modal form and awaits their response.
 * Discord handles modal timeouts naturally (~15 minutes), so no artificial timeout is applied.
 */
export async function promptWithModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: ModalOptions,
): Promise<ModalResult> {
  const { modalTitleKey, modalCustomId, components } = options;

  const modal = new ModalBuilder().setCustomId(modalCustomId).setTitle(localizer(locale, modalTitleKey));

  // Create Modal Components (Text Inputs Only - String Selects Not Yet Supported)
  const rows = components.map((component) => {
    if (isModalInputField(component)) {
      const textInput = new TextInputBuilder()
        .setCustomId(component.customId)
        .setLabel(localizer(locale, component.labelKey))
        .setStyle(component.style || TextInputStyle.Short)
        .setRequired(component.required !== false)
        .setMaxLength(component.maxLength || 256); // Discord API limit

      if (component.descriptionKey) {
        // Note: Discord.js does not support descriptions on TextInputs yet
        // For now, we can add the description to the placeholder or label
        const description = localizer(locale, component.descriptionKey);
        if (!component.placeholder) {
          textInput.setPlaceholder(description.substring(0, 100)); // Discord limit
        }
      }

      if (component.placeholder) {
        const placeholder =
          typeof component.placeholder === "string" && component.placeholder.startsWith("commands.")
            ? localizer(locale, component.placeholder)
            : component.placeholder;
        textInput.setPlaceholder(placeholder);
      }
      if (component.minLength) textInput.setMinLength(component.minLength);
      if (component.value) textInput.setValue(component.value);

      return new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
    } else if (isModalSelectField(component)) {
      // String selects in modals are not yet supported by Discord.js
      const fallbackInput = new TextInputBuilder()
        .setCustomId(component.customId)
        .setLabel(localizer(locale, component.labelKey))
        .setStyle(TextInputStyle.Short)
        .setRequired(component.required !== false)
        .setMaxLength(256); // Discord API limit

      if (component.placeholder) {
        const placeholder =
          typeof component.placeholder === "string" && component.placeholder.startsWith("commands.")
            ? localizer(locale, component.placeholder)
            : component.placeholder;
        fallbackInput.setPlaceholder(placeholder);
      } else {
        const optionsText = component.options.map((opt) => opt.label).join(", ");
        fallbackInput.setPlaceholder(`Options: ${optionsText.substring(0, 95)}...`);
      }

      return new ActionRowBuilder<TextInputBuilder>().addComponents(fallbackInput);
    }

    throw new Error(`Unsupported modal component type: ${component}`);
  });

  modal.addComponents(...rows);

  // Show Modal
  try {
    await interaction.showModal(modal);
  } catch (error) {
    log.error("Failed to show modal:", error);
    return { outcome: "timeout" };
  }

  // Wait for submission (use Discord's natural timeout duration ~15 minutes)
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: 600000, // 10 minutes - matches Discord's natural modal timeout
      filter: (i) => i.customId === modalCustomId && i.user.id === interaction.user.id,
    });

    const values: Record<string, string> = {};
    for (const component of components) {
      if (isModalInputField(component)) {
        values[component.customId] = submitted.fields.getTextInputValue(component.customId);
      } else if (isModalSelectField(component)) {
        const field = submitted.fields.getField(component.customId);
        if (field && "value" in field) {
          values[component.customId] = field.value;
        }
      }
    }

    return { outcome: "submit", values, interaction: submitted };
  } catch (error) {
    // This will only catch actual errors, not artificial timeouts
    // Discord's natural timeout or user cancellation will be handled by command timeout
    log.warn(`Modal submission failed for user ${interaction.user.id}:`, error);
    return { outcome: "timeout" };
  }
}

/**
 * Maps the title/description/footer of a legacy embed-style options object onto the
 * {@link NoticeContainerOptions} shape used by {@link buildNoticeContainer}. Used by
 * the V2-collision fallback in the legacy sinks so a marked interaction still receives
 * the same copy, rendered as a Components V2 notice rather than an embed.
 *
 * @param descriptionOverride - Optional pre-composed body (e.g. summary fields flattened).
 */
function standardOptionsToNotice(
  locale: string,
  options: StandardEmbedOptions,
  descriptionOverride?: string,
): NoticeContainerOptions {
  return {
    locale,
    // ColorResolvable is a superset of AccentColorInput; resolveAccentColor tolerates
    // any string/number and falls back to INFO, so the cast is safe at runtime.
    color: options.color as AccentColorInput | undefined,
    titleKey: options.titleKey,
    titleVars: options.titleVars,
    descriptionKey: descriptionOverride ? undefined : options.descriptionKey,
    description: descriptionOverride ?? options.description,
    descriptionVars: descriptionOverride ? undefined : options.descriptionVars,
    footerKey: options.footerKey,
    footerVars: options.footerVars,
  };
}

/**
 * Delivers a {@link buildNoticeContainer} payload to an interaction whose reply message
 * already carries `IsComponentsV2`. Mirrors the three delivery situations of the legacy
 * embed sinks: `editReply` when acknowledged, `webhook.send` after a raw modal, `reply`
 * otherwise, so but never emits legacy `embeds`, which Discord rejects on a V2 message.
 *
 * A marked interaction is, by construction, an ephemeral private workflow message, so
 * the fresh-response paths stay ephemeral.
 *
 */
async function replyNoticeContainerV2(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  notice: NoticeContainerOptions,
): Promise<void> {
  const components = buildNoticeContainer(notice);
  const wasRawModalSent = rawModalAcknowledged.get(interaction as ChatInputCommandInteraction | ButtonInteraction);

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
    } else if (wasRawModalSent) {
      await interaction.webhook.send({ components, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    } else {
      await interaction.reply({ components, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    }
  } catch (error) {
    // Last-resort: try webhook.send so a state-desync still surfaces the notice.
    log.warn("Failed to deliver V2 notice fallback via primary method:", error);
    try {
      await interaction.webhook.send({ components, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    } catch (fallbackError) {
      log.error("All methods failed for V2 notice fallback:", fallbackError);
    }
  }
}

/**
 * @description Shows a simple info/status embed without any interactive components.
 * Handles interaction state management defensively to prevent acknowledgment conflicts.
 */
export async function replyInfoEmbed(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  options: StandardEmbedOptions,
  flags:
    | MessageFlags.SuppressEmbeds
    | MessageFlags.Ephemeral
    | MessageFlags.SuppressNotifications
    | undefined = MessageFlags.Ephemeral,
): Promise<void> {
  // Check if "not setup" is actually a transient DB error (e.g. during deployment).
  //    If the DB was recently unreachable, show a yellow "Currently Updating..." embed
  //    instead of the misleading red "Initial Setup Required" error.
  const isDMContext = !interaction.guild;
  const finalOptions = { ...options };
  const serverDiscId = interaction.guild?.id ?? interaction.user?.id;

  if (options.titleKey === "general.errors.tomori_not_setup_title" && serverDiscId && getLastDbError(serverDiscId)) {
    finalOptions.titleKey = "general.errors.tomori_updating_title";
    finalOptions.descriptionKey = "general.errors.tomori_updating_description";
    finalOptions.color = ColorCode.WARN;
  }

  if (
    isDMContext &&
    (finalOptions.titleKey === "general.errors.tomori_not_setup_title" ||
      finalOptions.titleKey === "general.errors.api_key_missing_title")
  ) {
    finalOptions.footerKey = "general.errors.tomori_not_setup_dm_footer";
  }

  // Components V2 collision guard. If this interaction's reply already carries
  //      IsComponentsV2 (e.g. a range selector rendered onto it), a legacy
  //      `editReply({ embeds })` would be rejected by Discord. Render the same
  //      title/description/footer as a V2 notice container instead. Tip buttons are
  //      dropped here, so they are rare on the error/info paths that hit this guard.
  if (hasComponentsV2Reply(interaction)) {
    await replyNoticeContainerV2(interaction, standardOptionsToNotice(locale, finalOptions));
    return;
  }

  const embed = createStandardEmbed(locale, finalOptions);
  const tipText = finalOptions.tipKeys?.length
    ? createTipText(locale, finalOptions.tipKeys, finalOptions.tipVars)
    : null;
  const activeTipRow = tipText
    ? buildTextDisplayModalButton(TIP_DETAILS_BUTTON_ID, localizer(locale, "genai.tips.button"))
    : undefined;
  const disabledTipRow = tipText
    ? buildTextDisplayModalButton(TIP_DETAILS_BUTTON_ID, localizer(locale, "genai.tips.button"), true)
    : undefined;
  const components = activeTipRow ? [activeTipRow] : [];
  const embeds = [embed];

  const attachTipCollector = (message: Message): void => {
    if (!tipText || !disabledTipRow) return;
    attachTextDisplayModalCollector({
      message,
      customId: TIP_DETAILS_BUTTON_ID,
      title: localizer(locale, "genai.tips.title"),
      content: tipText,
      timeoutMs: TIP_BUTTON_TIMEOUT_MS,
      logLabel: "Interaction error tips",
      onExpire: async () => {
        await interaction.webhook.editMessage(message.id, { embeds, components: [disabledTipRow] });
      },
    });
  };

  const interactionState = {
    deferred: interaction.deferred,
    replied: interaction.replied,
    id: interaction.id,
  };

  log.info(`replyInfoEmbed interaction state: ${JSON.stringify(interactionState)}`);

  // Check if interaction was acknowledged via raw REST API (e.g., modal shown)
  // Discord.js state may be out of sync in this case
  const wasRawModalSent = rawModalAcknowledged.get(interaction as ChatInputCommandInteraction | ButtonInteraction);

  if (wasRawModalSent && !interaction.deferred && !interaction.replied) {
    // State desync detected: raw REST modal acknowledged the interaction on Discord's
    // side, but Discord.js still thinks replied=false / deferred=false.
    // interaction.followUp() would throw INTERACTION_NOT_REPLIED because of a
    // Discord.js internal guard, so bypass it by calling webhook.send() directly.
    log.info(`Raw modal state desync detected for interaction ${interaction.id}, using webhook.send directly`);
    try {
      const message = await interaction.webhook.send({
        embeds,
        components,
        flags: flags || MessageFlags.Ephemeral,
      });
      attachTipCollector(message);
      return;
    } catch (webhookError) {
      log.error("webhook.send failed for raw-modal-acknowledged interaction:", webhookError);
    }
  }

  try {
    if (interaction.deferred || interaction.replied) {
      const message = await interaction.editReply({ embeds, components });
      attachTipCollector(message);
    } else {
      await interaction.reply({ embeds, components, flags });
      attachTipCollector(await interaction.fetchReply());
    }
  } catch (error) {
    log.warn("Failed to show info embed via primary method:", error);

    try {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("has already been acknowledged")) {
        // Interaction was acknowledged via raw REST (e.g. modal shown) but
        // Discord.js state is out of sync. followUp() would hit the same
        // INTERACTION_NOT_REPLIED guard, so use webhook.send() instead.
        log.info("Attempting webhook.send due to acknowledgment conflict (raw REST desync)");
        const message = await interaction.webhook.send({
          embeds,
          components,
          flags: flags || MessageFlags.Ephemeral,
        });
        attachTipCollector(message);
      } else if (errorMessage.includes("not been sent or deferred")) {
        // Interaction wasn't properly acknowledged - try reply without flags first
        log.info("Attempting basic reply due to no prior acknowledgment");
        await interaction.reply({
          embeds,
          components,
          flags: MessageFlags.Ephemeral,
        });
        attachTipCollector(await interaction.fetchReply());
      } else {
        // Other error - try webhook.send as last resort (avoids followUp guard)
        log.info("Attempting webhook.send as last resort fallback");
        const message = await interaction.webhook.send({
          embeds,
          components,
          flags: flags || MessageFlags.Ephemeral,
        });
        attachTipCollector(message);
      }
    } catch (fallbackError) {
      await log.error("All interaction methods failed for replyInfoEmbed:", error, {
        errorType: "InteractionReplyFailure",
        metadata: {
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          interactionState: {
            id: interaction.id,
            type: interaction.type,
            deferred: interaction.deferred,
            replied: interaction.replied,
          },
          embedTitle: options.titleKey,
        },
      });
    }
  }
}

/**
 * @description Shows a summary embed with multiple fields, organized and localized.
 * Useful for displaying configuration summaries, help information, etc.
 * Handles interaction state management defensively to prevent acknowledgment conflicts.
 */
export async function replySummaryEmbed(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  options: SummaryEmbedOptions,
  flags:
    | MessageFlags.SuppressEmbeds
    | MessageFlags.Ephemeral
    | MessageFlags.SuppressNotifications
    | undefined = MessageFlags.Ephemeral,
): Promise<void> {
  // Components V2 collision guard (see replyInfoEmbed step 2.5). A summary embed cannot
  // be edited onto a V2 message, so flatten the title/description plus each field into a
  // single notice container. Docs link and appended embeds are dropped, so this path is a
  // rare defensive fallback for a marked interaction.
  if (hasComponentsV2Reply(interaction)) {
    const fieldLines = options.fields.map((field) => {
      const name = field.nameKey ? localizer(locale, field.nameKey, field.nameVars) : (field.name ?? "");
      const value = field.valueKey ? localizer(locale, field.valueKey, field.valueVars) : (field.value ?? "");
      return name ? `**${name}**\n${value}` : value;
    });
    const baseDescription =
      options.description ??
      (options.descriptionKey ? localizer(locale, options.descriptionKey, options.descriptionVars) : "");
    const composedDescription = [baseDescription, ...fieldLines].filter((line) => line.length > 0).join("\n\n");
    await replyNoticeContainerV2(interaction, standardOptionsToNotice(locale, options, composedDescription));
    return;
  }

  const embed = createSummaryEmbed(locale, options);
  const embeds = options.appendEmbeds?.length ? [embed, ...options.appendEmbeds] : [embed];
  const components = options.docsPath ? [buildDocsLinkRow(locale, options.docsPath, options.docsLabelKey)] : [];

  const interactionState = {
    deferred: interaction.deferred,
    replied: interaction.replied,
    id: interaction.id,
  };

  log.info(`replySummaryEmbed interaction state: ${JSON.stringify(interactionState)}`);

  const wasRawModalSent = rawModalAcknowledged.get(interaction as ChatInputCommandInteraction | ButtonInteraction);

  if (wasRawModalSent && !interaction.deferred && !interaction.replied) {
    // State desync: raw REST modal acknowledged the interaction but Discord.js
    // still thinks replied=false / deferred=false. Use webhook.send() to bypass
    // the followUp() INTERACTION_NOT_REPLIED guard.
    log.info(`Raw modal state desync detected for interaction ${interaction.id}, using webhook.send directly`);
    try {
      await interaction.webhook.send({
        embeds,
        components,
        flags: flags || MessageFlags.Ephemeral,
      });
      return;
    } catch (webhookError) {
      log.error("webhook.send failed for raw-modal-acknowledged interaction:", webhookError);
    }
  }

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds, components });
    } else {
      await interaction.reply({ embeds, components, flags });
    }
  } catch (error) {
    log.warn("Failed to show summary embed via primary method:", error);

    try {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("has already been acknowledged")) {
        log.info("Attempting webhook.send due to acknowledgment conflict (raw REST desync)");
        await interaction.webhook.send({
          embeds,
          components,
          flags: flags || MessageFlags.Ephemeral,
        });
      } else if (errorMessage.includes("not been sent or deferred")) {
        log.info("Attempting basic reply due to no prior acknowledgment");
        await interaction.reply({
          embeds,
          components,
          flags: flags || MessageFlags.Ephemeral,
        });
      } else {
        log.info("Attempting webhook.send as last resort fallback");
        await interaction.webhook.send({
          embeds,
          components,
          flags: flags || MessageFlags.Ephemeral,
        });
      }
    } catch (fallbackError) {
      await log.error("All interaction methods failed for replySummaryEmbed:", error, {
        errorType: "InteractionReplyFailure",
        metadata: {
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          interactionState: {
            id: interaction.id,
            type: interaction.type,
            deferred: interaction.deferred,
            replied: interaction.replied,
          },
          embedTitle: options.titleKey,
        },
      });
    }
  }
}

const PAGINATION_TIMEOUT_MS = 120000; // 2 minute timeout for pagination interactions
// Discord interaction tokens expire after 15 minutes. We cap the total session at
// 14 minutes so there's always a 1-minute buffer to deliver the final reply.
const PAGINATION_SESSION_MAX_MS = 14 * 60 * 1000;
const PAGINATION_ITEMS_PER_PAGE = 9; // Number of items to show per page
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"]; // Emojis for numbered selection
const PERSONA_PAGINATION_ITEMS_PER_PAGE = 4;
const PERSONA_SNIPPET_MAX_LENGTH = 200;
const PERSONA_SELECT_CUSTOM_ID_PREFIX = "persona_select_";
const PERSONA_PREV_PAGE_CUSTOM_ID = "persona_prev_page";
const PERSONA_NEXT_PAGE_CUSTOM_ID = "persona_next_page";
const PERSONA_CANCEL_CUSTOM_ID = "persona_cancel";

interface PersonaPaginatedChoiceOptions {
  personas: TomoriState[];
  titleKey?: string;
  descriptionKey?: string;
  color?: string | number;
  onSelect?: (index: number) => Promise<void>;
  onCancel?: () => Promise<void>;
  preserveSelectedInteraction?: boolean;
  /** Workflow-owned avatar cache shared across internal picker retries. */
  avatarSessionCache?: AvatarSessionCache;
  /**
   * Pre-localized notice appended under the picker description when the list has
   * been narrowed by an eligibility filter. Rendered only when at least one
   * persona was excluded so an unfiltered picker stays visually unchanged.
   */
  filteredNotice?: string;
}

type AccentColorInput = string | number | readonly [red: number, green: number, blue: number];

function resolveAccentColor(color?: AccentColorInput): number {
  if (typeof color === "number") {
    return color;
  }

  if (typeof color === "string") {
    const normalized = color.trim().replace("#", "");
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return Number.parseInt(normalized, 16);
    }
  }

  if (Array.isArray(color) && color.length === 3) {
    const [red, green, blue] = color;
    return (red << 16) + (green << 8) + blue;
  }

  return Number.parseInt(ColorCode.INFO.replace("#", ""), 16);
}

/**
 * Formats the leading "title" line of a Components V2 container. All CV2
 * containers render their title as an H3 heading for consistent prominence
 * (status, confirmation, persona picker, persona results all share this).
 *
 * @param text - The already-localized title text.
 */
function formatContainerTitle(text: string): string {
  return `### ${text}`;
}

function buildV2StatusComponents(
  locale: string,
  titleKey: string,
  descriptionKey: string,
  color: string | number,
  descriptionVars?: Record<string, string | number | boolean>,
  secondaryDescriptionKey?: string,
  secondaryDescriptionVars?: Record<string, string | number | boolean>,
): TopLevelComponentData[] {
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveAccentColor(color),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: formatContainerTitle(localizer(locale, titleKey)),
      },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, descriptionKey, descriptionVars),
      },
      ...(secondaryDescriptionKey
        ? [
            {
              type: ComponentType.TextDisplay,
              content: `**${localizer(locale, secondaryDescriptionKey, secondaryDescriptionVars)}**`,
            } satisfies ComponentInContainerData,
          ]
        : []),
    ],
  };

  return [container];
}

function buildV2ConfirmationComponents(
  locale: string,
  title: string,
  description: string,
  color: AccentColorInput,
  continueLabelKey: string,
  cancelLabelKey: string,
  continueCustomId: string,
  cancelCustomId: string,
  continueStyle: ButtonStyle.Secondary | ButtonStyle.Danger = ButtonStyle.Secondary,
  cancelStyle: ButtonStyle.Secondary | ButtonStyle.Danger = ButtonStyle.Secondary,
): TopLevelComponentData[] {
  const actionRow: ActionRowData<ButtonComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: continueStyle,
        customId: continueCustomId,
        label: localizer(locale, continueLabelKey),
      },
      {
        type: ComponentType.Button,
        style: cancelStyle,
        customId: cancelCustomId,
        label: localizer(locale, cancelLabelKey),
      },
    ],
  };

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveAccentColor(color),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: formatContainerTitle(title),
      },
      {
        type: ComponentType.TextDisplay,
        content: description,
      },
      actionRow,
    ],
  };

  return [container];
}

/**
 * Optional in-container notice action button. Rendered as a left-aligned
 * ActionRow inside the notice card so utility actions stay visually attached
 * to the notice content.
 */
export interface NoticeContainerButtonOptions {
  /** Discord component custom ID for the button. */
  customId: string;
  /** Locale key for the button label. */
  labelKey: string;
  /** Button style (defaults to {@link ButtonStyle.Secondary}); Success, Link, and Premium are excluded. */
  style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger;
  /** Whether the button is disabled after its collector expires. */
  disabled?: boolean;
}

/**
 * Configuration for {@link buildNoticeContainer}.
 */
export interface NoticeContainerOptions {
  /** Locale used for every localized string in the container. */
  locale: string;
  /** Accent color of the container's left bar (maps to the old embed color). */
  color?: AccentColorInput;
  /** Locale key for the H3 title line. */
  titleKey: string;
  /** Variables for the title. */
  titleVars?: Record<string, string | number | boolean>;
  /** Locale key for the body description. */
  descriptionKey?: string;
  /** Raw description text, used when the caller has already composed the body. */
  description?: string;
  /** Variables for the localized description. */
  descriptionVars?: Record<string, string | number | boolean>;
  /** Optional muted footer line. */
  footerKey?: string;
  /** Variables for the footer. */
  footerVars?: Record<string, string | number | boolean>;
  /** Optional action button placed inside the container. */
  button?: NoticeContainerButtonOptions;
}

/**
 * Builds a compact Components V2 notice container that mirrors the simple
 * title/description/footer shape of a standard embed while allowing an action
 * button to live inside the same card.
 *
 */
export function buildNoticeContainer(options: NoticeContainerOptions): TopLevelComponentData[] {
  const { locale } = options;
  const components: ComponentInContainerData[] = [];
  const descriptionText =
    options.description ??
    (options.descriptionKey ? localizer(locale, options.descriptionKey, options.descriptionVars) : "");

  components.push({
    type: ComponentType.TextDisplay,
    content: formatContainerTitle(localizer(locale, options.titleKey, options.titleVars)),
  });

  if (descriptionText) {
    components.push({
      type: ComponentType.TextDisplay,
      content: descriptionText,
    });
  }

  if (options.footerKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, options.footerKey, options.footerVars)}`,
    });
  }

  if (options.button) {
    const button: ButtonComponentData = {
      type: ComponentType.Button,
      style: options.button.style ?? ButtonStyle.Secondary,
      customId: options.button.customId,
      label: localizer(locale, options.button.labelKey),
      disabled: options.button.disabled ?? false,
    };

    components.push({
      type: ComponentType.ActionRow,
      components: [button],
    } satisfies ActionRowData<ButtonComponentData>);
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveAccentColor(options.color),
    components,
  };

  return [container];
}

/** A Components V2 edit/send payload: a component tree flagged `IsComponentsV2`. */
export interface ComponentsV2Payload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

/**
 * How many option ranges (`1-25`, `26-50`, …) a single selector page shows before
 * paginating with Previous/Next. Shared with `personaWorkflow.ts` so both consumers
 * of {@link buildRangeSelectorPayload} agree on the page depth.
 */
export const RANGES_PER_SELECTOR_PAGE = 20;

/** How many range buttons fit per Discord action row (max 5 components per row). */
const RANGE_BUTTONS_PER_ROW = 5;

/**
 * Builds the Components V2 range-selector container shown when a modal's select has
 * more than {@link MODAL_OPTIONS_PER_PAGE} options. Each range button opens a modal
 * scoped to its 25-option slice; a Previous/Cancel/Next nav row paginates the ranges.
 *
 * This is the single source of the `>25` selector shell. Both the persona anchor
 * workflow (`personaWorkflow.ts`) and the legacy `promptWithPaginatedModal`
 * `componentsV2` branch render it, replacing the two divergent renderers that used to
 * read the same two `general.pagination.*` locale keys.
 *
 * @param locale - Locale for the selector's localized strings.
 * @param customIdPrefix - Per-session prefix scoping every button custom id
 *   (`${prefix}_range_${index}`, `${prefix}_previous`, `${prefix}_cancel`, `${prefix}_next`).
 * @param optionCount - Total number of options across all ranges.
 * @param rangePage - Zero-based selector page currently shown.
 * @param pageSize - How many options each range covers. Defaults to
 *   {@link MODAL_OPTIONS_PER_PAGE}. Callers that reserve select entries for their own
 *   fixed choices (e.g. `/model fallback` prepends a "None" option to every page, so only
 *   24 models fit) pass the smaller number here, keeping the button labels honest about
 *   what the modal will actually show.
 */
export function buildRangeSelectorPayload(
  locale: string,
  customIdPrefix: string,
  optionCount: number,
  rangePage: number,
  pageSize: number = MODAL_OPTIONS_PER_PAGE,
): ComponentsV2Payload {
  const totalRanges = Math.ceil(optionCount / pageSize);
  const totalRangePages = Math.ceil(totalRanges / RANGES_PER_SELECTOR_PAGE);
  const firstRange = rangePage * RANGES_PER_SELECTOR_PAGE;
  const lastRange = Math.min(firstRange + RANGES_PER_SELECTOR_PAGE, totalRanges);
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "general.pagination.select_page_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "general.pagination.select_page_description", {
        totalItems: optionCount,
        totalPages: totalRanges,
      }),
    },
  ];

  const rangeButtons: ButtonComponentData[] = [];
  for (let rangeIndex = firstRange; rangeIndex < lastRange; rangeIndex += 1) {
    const start = rangeIndex * pageSize + 1;
    const end = Math.min(start + pageSize - 1, optionCount);
    rangeButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: `${customIdPrefix}_range_${rangeIndex}`,
      label: `${start}-${end}`,
    });
  }
  for (let offset = 0; offset < rangeButtons.length; offset += RANGE_BUTTONS_PER_ROW) {
    components.push({
      type: ComponentType.ActionRow,
      components: rangeButtons.slice(offset, offset + RANGE_BUTTONS_PER_ROW),
    } satisfies ActionRowData<ButtonComponentData>);
  }

  const navigation: ButtonComponentData[] = [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: `${customIdPrefix}_previous`,
      label: localizer(locale, "general.pagination.previous"),
      disabled: rangePage === 0,
    },
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: `${customIdPrefix}_cancel`,
      label: localizer(locale, "general.pagination.cancel"),
    },
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: `${customIdPrefix}_next`,
      label: localizer(locale, "general.pagination.next"),
      disabled: rangePage >= totalRangePages - 1,
    },
  ];
  components.push({
    type: ComponentType.ActionRow,
    components: navigation,
  } satisfies ActionRowData<ButtonComponentData>);

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Optional in-container action button (e.g. the "Import Now" button on persona
 * generate/create results). Rendered as an ActionRow inside the container so it
 * reads as part of the result card rather than a detached button row.
 */
export interface PersonaResultButtonOptions {
  /** Discord component custom ID for the button. */
  customId: string;
  /** Locale key for the button label. */
  labelKey: string;
  /** Button style (defaults to {@link ButtonStyle.Secondary}); Success, Link, and Premium are excluded. */
  style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger;
  /** Whether the button is disabled (e.g. after a successful import). */
  disabled?: boolean;
  /** Optional unicode emoji shown on the button. */
  emoji?: string;
}

/**
 * A content block rendered (after a divider) inside a persona-result container.
 * Supports a localized heading plus either a localized or raw body.
 */
export interface PersonaResultSection {
  /** Optional locale key for the bold section heading. */
  titleKey?: string;
  /** Variables for the section heading. */
  titleVars?: Record<string, string | number | boolean>;
  /** Locale key for the section body (takes precedence over {@link PersonaResultSection.body}). */
  bodyKey?: string;
  /** Variables for the localized section body. */
  bodyVars?: Record<string, string | number | boolean>;
  /** Raw (already-composed) section body, used when {@link PersonaResultSection.bodyKey} is absent. */
  body?: string;
}

/**
 * Configuration for {@link buildPersonaResultContainer}.
 */
export interface PersonaResultContainerOptions {
  /** Locale used for every localized string in the container. */
  locale: string;
  /** Accent color of the container's left bar (maps to the old embed color). */
  color: AccentColorInput;
  /** Locale key for the bold title line. */
  titleKey: string;
  /** Variables for the title. */
  titleVars?: Record<string, string | number | boolean>;
  /** Locale key for the body description. */
  descriptionKey: string;
  /** Variables for the description. */
  descriptionVars?: Record<string, string | number | boolean>;
  /** Optional hero image attachment name, rendered as a MediaGallery item under the title. */
  imageAttachmentName?: string;
  /**
   * Image arrangement. "image-top" (default) shows the attachment as a full-width
   * MediaGallery under the title. "thumbnail-section" instead pins it as a
   * right-aligned Thumbnail accessory on the final section, with the button
   * directly beneath it, so mirroring the persona picker's avatar-above-button look.
   */
  layout?: "image-top" | "thumbnail-section";
  /** Optional content blocks (e.g. sample dialogue, next steps), each after a divider. */
  sections?: PersonaResultSection[];
  /** Optional footer note (e.g. DM warning), rendered after a divider in a muted style. */
  footerKey?: string;
  /** Variables for the footer. */
  footerVars?: Record<string, string | number | boolean>;
  /** Optional action button placed inside the container. */
  button?: PersonaResultButtonOptions;
  /**
   * Horizontal alignment of {@link PersonaResultContainerOptions.button}.
   * "left" renders it in an ActionRow; "right" renders it as a Section accessory
   * (the only way to right-align a button in Components V2). Defaults to "left".
   */
  buttonAlignment?: "left" | "right";
  /**
   * Optional closing note rendered as a final row *after* the button (e.g. a
   * "you can edit this later" tip), so the button stays tight under the avatar
   * while the note lives on its own row below.
   */
  trailingNoteKey?: string;
  /** Variables for the trailing note. */
  trailingNoteVars?: Record<string, string | number | boolean>;
}

/**
 * Builds a Components V2 container that mirrors a classic "result" embed: title,
 * hero image, description, optional next-steps block, optional footer; but can
 * also host an action button inside the same card. Used by `/persona generate`
 * and `/persona create` success messages so the "Import Now" button sits within
 * the result rather than dangling beneath a separate embed.
 *
 */
export function buildPersonaResultContainer(options: PersonaResultContainerOptions): TopLevelComponentData[] {
  const { locale } = options;
  const components: ComponentInContainerData[] = [];
  const sections = options.sections ?? [];

  // The thumbnail layout needs a section to host the avatar accessory, so it
  // falls back to the default hero-image layout when no sections are supplied.
  const useThumbnailLayout =
    options.layout === "thumbnail-section" && Boolean(options.imageAttachmentName) && sections.length > 0;

  components.push({
    type: ComponentType.TextDisplay,
    content: formatContainerTitle(localizer(locale, options.titleKey, options.titleVars)),
  });

  // Hero image directly under the title (CV2 has no embed image slot, so the
  //    attachment is surfaced through a single-item MediaGallery). Skipped in the
  //    thumbnail layout, which shows the avatar beside the final section instead.
  if (options.imageAttachmentName && !useThumbnailLayout) {
    components.push({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: `attachment://${options.imageAttachmentName}` } }],
    });
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: localizer(locale, options.descriptionKey, options.descriptionVars),
  });

  sections.forEach((section, index) => {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    const heading = section.titleKey ? `**${localizer(locale, section.titleKey, section.titleVars)}**\n` : "";
    const sectionBody = section.bodyKey ? localizer(locale, section.bodyKey, section.bodyVars) : (section.body ?? "");
    const textDisplay = {
      type: ComponentType.TextDisplay,
      content: `${heading}${sectionBody}`,
    } satisfies ComponentInContainerData;

    if (useThumbnailLayout && index === sections.length - 1 && options.imageAttachmentName) {
      components.push({
        type: ComponentType.Section,
        components: [textDisplay],
        accessory: {
          type: ComponentType.Thumbnail,
          media: { url: `attachment://${options.imageAttachmentName}` },
        },
      });
    } else {
      components.push(textDisplay);
    }
  });

  if (options.footerKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, options.footerKey, options.footerVars)}`,
    });
  }

  // Optional action button. Left alignment uses a standard ActionRow; right
  //    alignment uses a Section with the button as an accessory (CV2's only way
  //    to right-align a button), mirroring the persona picker's "select" button.
  if (options.button) {
    const button: ButtonComponentData = {
      type: ComponentType.Button,
      style: options.button.style ?? ButtonStyle.Secondary,
      customId: options.button.customId,
      label: localizer(locale, options.button.labelKey),
      disabled: options.button.disabled ?? false,
      ...(options.button.emoji ? { emoji: { name: options.button.emoji } } : {}),
    };

    // The thumbnail layout always right-aligns so the button sits beneath the avatar.
    if (useThumbnailLayout || options.buttonAlignment === "right") {
      components.push({
        type: ComponentType.Section,
        // A blank spacer line keeps the button on its own right-aligned row.
        components: [{ type: ComponentType.TextDisplay, content: "** **" }],
        accessory: button,
      });
    } else {
      components.push({
        type: ComponentType.ActionRow,
        components: [button],
      } satisfies ActionRowData<ButtonComponentData>);
    }
  }

  // Optional closing note after the button, on its own divided row. Keeps the
  //    button tight under the avatar while the note sits below it.
  if (options.trailingNoteKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, options.trailingNoteKey, options.trailingNoteVars),
    });
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveAccentColor(options.color),
    components,
  };

  return [container];
}

export async function replyComponentsV2Status(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  locale: string,
  titleKey: string,
  descriptionKey: string,
  color: string | number,
  descriptionVars?: Record<string, string | number | boolean>,
  secondaryDescriptionKey?: string,
  secondaryDescriptionVars?: Record<string, string | number | boolean>,
): Promise<void> {
  const components = buildV2StatusComponents(
    locale,
    titleKey,
    descriptionKey,
    color,
    descriptionVars,
    secondaryDescriptionKey,
    secondaryDescriptionVars,
  );

  const wasRawModalSent = rawModalAcknowledged.get(interaction as ChatInputCommandInteraction | ButtonInteraction);
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        components,
        flags: MessageFlags.IsComponentsV2,
      });
    } else if (wasRawModalSent) {
      await interaction.webhook.send({
        components,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
    } else {
      await interaction.reply({
        components,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
    }
    // The interaction's reply message now carries IsComponentsV2. Flag it so a later
    // legacy embed sink on the same interaction renders a V2 notice instead of throwing.
    markComponentsV2Reply(interaction);
  } catch (error) {
    log.warn("Failed to update Components V2 status reply:", error);
  }
}

export async function updateButtonComponentsV2Status(
  interaction: ButtonInteraction,
  locale: string,
  titleKey: string,
  descriptionKey: string,
  color: string | number,
  descriptionVars?: Record<string, string | number | boolean>,
  secondaryDescriptionKey?: string,
  secondaryDescriptionVars?: Record<string, string | number | boolean>,
): Promise<void> {
  const components = buildV2StatusComponents(
    locale,
    titleKey,
    descriptionKey,
    color,
    descriptionVars,
    secondaryDescriptionKey,
    secondaryDescriptionVars,
  );

  try {
    await interaction.update({
      components,
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    log.warn("Failed to update button interaction with Components V2 status:", error);
  }
}

export async function acknowledgeModalSubmitForRefresh(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (error) {
    log.warn("Failed to silently acknowledge modal submit for picker refresh:", error);
  }
}

export interface GuardedPanelWorkflowController {
  replace(payload: unknown): Promise<unknown>;
  replaceFrom?(source: unknown, payload: unknown): Promise<unknown>;
}

export type GuardedPanelDeliveryTarget =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | RoleSelectMenuInteraction
  | UserSelectMenuInteraction
  | MentionableSelectMenuInteraction
  | ModalSubmitInteraction
  | GuardedPanelWorkflowController
  | {
      editReply?: (payload: InteractionEditReplyOptions | MessagePayload | string) => Promise<unknown>;
      update?: (payload: InteractionUpdateOptions | MessagePayload | string) => Promise<unknown>;
      reply?: (payload: InteractionReplyOptions | MessagePayload | string) => Promise<unknown>;
      replace?: (payload: unknown) => Promise<unknown>;
      replaceFrom?: (source: unknown, payload: unknown) => Promise<unknown>;
      deferred?: boolean;
      replied?: boolean;
    };

export type GuardedPanelDeliveryMethod = "editReply" | "update" | "reply" | "replace" | "replaceFrom";

export interface GuardedPanelDeliveryOptions {
  /** Delivery transport to invoke on the target. Defaults to editReply, falling back to available methods. */
  method?: GuardedPanelDeliveryMethod;
  /** Locale used to localize the minimal fallback payload if the provided payload is invalid. */
  locale?: string;
  /** Source interaction when method is "replace" and target provides replaceFrom. */
  sourceInteraction?: unknown;
  /** Flags override, e.g. Ephemeral | IsComponentsV2 for initial reply. */
  flags?: MessageFlags | number;
  /**
   * The receipt this payload repaints with, when it carries one.
   *
   * Threaded through delivery rather than read back off the payload so the failure signal cannot
   * cost the payload any of its Discord text budget, and cannot widen a rendered receipt past the
   * panel prose line limit.
   */
  receipt?: PanelReceipt;
}

/**
 * Resolves whether the current environment should enforce production behavior for panel delivery.
 * Reads dynamically from environment variables with fallback so runtime mode switches are detected immediately.
 */
export function isProductionEnvironment(): boolean {
  const env = process.env.RUN_ENV || process.env.NODE_ENV || "development";
  return env.toLowerCase() === "production";
}

/**
 * Builds the minimal fallback Components V2 container payload for panel delivery.
 * Contains only a localized error title and description in a single container.
 * Guaranteed to satisfy validateComponentsV2MessageLimits.
 */
export function buildPanelFallbackPayload(locale = "en-US"): ComponentsV2MessagePayload {
  const container = buildPanelContainer([
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "general.errors.unknown_error_description"),
    },
  ]);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

/**
 * Validates a Components V2 payload before it reaches a delivery transport.
 *
 * Invalid payloads throw outside production so tests and development expose the exact violation.
 * Production logs only structured limit metadata and returns the minimal fallback while retaining
 * attachment fields as empty arrays when the original payload included them.
 */
export function validateAndFallbackPanelPayload<T>(payload: T, locale = "en-US"): T {
  const validation = validateComponentsV2MessageLimits(payload as ComponentsV2MessagePayload);
  if (validation.valid) return payload;

  if (!isProductionEnvironment()) {
    const summary = validation.violations
      .map((v) => `${v.path}: [${v.code}] observed ${v.observed} (limit ${v.limit})`)
      .join("; ");
    throw new ComponentsV2LimitError(
      `Components V2 panel payload exceeded Discord limits: ${summary}`,
      validation.violations,
    );
  }

  const sanitizedViolations = validation.violations.map((v) => ({
    path: v.path,
    componentType: v.componentType,
    observed: v.observed,
    limit: v.limit,
    code: v.code,
  }));

  void log.error("Components V2 panel payload exceeded Discord limits", undefined, {
    metadata: {
      violations: sanitizedViolations,
    },
  });

  const fallback = buildPanelFallbackPayload(locale);
  const original = payload as Record<string, unknown>;
  return {
    ...fallback,
    ...(payload && typeof payload === "object" && "attachments" in original ? { attachments: [] } : {}),
    ...(payload && typeof payload === "object" && "files" in original ? { files: [] } : {}),
  } as T;
}

/**
 * Single reporting point for every panel that repaints itself as a failed or warning receipt.
 *
 * Route code reports an expected refusal by returning a status object rather than throwing, so the
 * router's exception handler never sees it and the user's red receipt leaves no trace anywhere.
 * Every panel transport already funnels through {@link deliverGuardedPanel}, which makes it the one
 * place a receipt can be observed without an opt-in line in each of the roughly sixteen `repaint`
 * helpers.
 *
 * Emitted as a metric rather than an error record: the metric level is never filtered out of the
 * production stream, while `error_logs` is reserved for incidents. Most of these receipts are
 * expected outcomes the actor can correct (bad input, stale panel, unavailable read), and writing
 * every one of them at error level is the storm the repository's circuit breaker exists to absorb.
 * The genuinely broken paths log at error level where their cause is still in scope.
 */
function reportPanelFailure(
  target: GuardedPanelDeliveryTarget | ((payload: unknown) => Promise<unknown>),
  options?: GuardedPanelDeliveryOptions,
): void {
  const receipt = options?.receipt;
  if (!receipt || (receipt.tone !== "error" && receipt.tone !== "warning")) return;

  try {
    const customId =
      typeof target === "object" && target !== null && "customId" in target ? target.customId : undefined;
    log.metric("panel_failure", {
      locale: options?.locale ?? "en-US",
      tone: receipt.tone,
      heading: receipt.heading,
      // The namespace is the route prefix before the version segment, so a metric query can group
      // failures by panel without a second lookup.
      namespace: typeof customId === "string" ? (customId.split(":")[0] ?? "unknown") : "unknown",
    });
  } catch {
    // Diagnostics must never be able to break the delivery they describe.
  }
}

/**
 * Universal guarded delivery helper used across all panel transports (initial reply,
 * editReply, component update, anchor replacement, and avatar-bearing paths).
 *
 * In tests and development, surfaces exact limit violations loudly.
 * In production, logs a redacted structured diagnostic and delivers the minimal fallback
 * payload so committed operations always leave an acknowledged interaction repainted.
 */
export async function deliverGuardedPanel<T = unknown>(
  target: GuardedPanelDeliveryTarget | ((payload: unknown) => Promise<T>),
  payload: unknown,
  options?: GuardedPanelDeliveryOptions,
): Promise<T> {
  const locale = options?.locale ?? "en-US";
  let deliveryPayload = validateAndFallbackPanelPayload(payload, locale) as Record<string, unknown>;

  reportPanelFailure(target, options);

  if (options?.method === "reply" && options?.flags !== undefined) {
    deliveryPayload = {
      ...deliveryPayload,
      flags: options.flags,
    };
  }

  let result: T;
  if (typeof target === "function") {
    result = (await target(deliveryPayload)) as T;
  } else {
    const candidate = target as Record<string, unknown>;
    if (options?.method === "update") {
      if (typeof candidate.update !== "function") {
        throw new TypeError("Target does not support update delivery");
      }
      result = (await (candidate.update as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
    } else if (options?.method === "reply") {
      if (typeof candidate.reply !== "function") {
        throw new TypeError("Target does not support reply delivery");
      }
      result = (await (candidate.reply as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
    } else if (options?.method === "replace" || options?.method === "replaceFrom") {
      if (options?.sourceInteraction && typeof candidate.replaceFrom === "function") {
        result = (await (candidate.replaceFrom as (source: unknown, payload: unknown) => Promise<unknown>)(
          options.sourceInteraction,
          deliveryPayload,
        )) as T;
      } else if (typeof candidate.replace === "function") {
        result = (await (candidate.replace as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
      } else {
        throw new TypeError("Target does not support replace delivery");
      }
    } else {
      if (typeof candidate.editReply === "function") {
        result = (await (candidate.editReply as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
      } else if (typeof candidate.update === "function") {
        result = (await (candidate.update as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
      } else if (typeof candidate.replace === "function") {
        result = (await (candidate.replace as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
      } else if (typeof candidate.reply === "function") {
        result = (await (candidate.reply as (payload: unknown) => Promise<unknown>)(deliveryPayload)) as T;
      } else {
        throw new TypeError("Target does not provide a known delivery method");
      }
    }
  }

  if (typeof target === "object" && target !== null) {
    try {
      markComponentsV2Reply(target as unknown as ChatInputCommandInteraction);
    } catch {
      // Best-effort tracking
    }
  }

  return result;
}

/**
 * Resolved avatar data for a single persona, cached across page renders within a picker session.
 * - `url`: a public HTTP(S) URL or the bot fallback, so no file attachment needed.
 * - `buffer`: raw image bytes for a local-disk avatar that must be attached to the Discord message.
 */
export type AvatarCacheEntry = PersonaAvatarAsset;

/**
 * Session-scoped avatar cache keyed by absolute persona index (not page-local).
 * Populated lazily on first page visit; reused on re-navigation to the same page.
 * The persona workflow owns this map and passes it through internal picker retries.
 */
export type AvatarSessionCache = Map<number, AvatarCacheEntry>;

/**
 * Resolves avatar images for a single page of personas, using a session cache to
 * avoid re-fetching the same avatar on repeated page visits.
 *
 * Resolution order per alter persona (only runs on first visit per persona):
 * 1. Public HTTP(S) URL (always works in production, and in dev when
 *    AVATAR_PUBLIC_BASE_URL is configured)
 * 2. Discord file attachment: used in non-production when the avatar is stored
 *    as a local path and AVATAR_PUBLIC_BASE_URL is not set. The buffer is loaded
 *    from disk and returned as an AttachmentBuilder so the caller can include it
 *    in the reply. The media URL is set to `attachment://avatar_{idx}.png` which
 *    Discord resolves against the message's attachments.
 * 3. Fallback URL (bot server avatar) when no avatar is available.
 *
 * @param sessionCache - Mutable cache shared across all page renders in one picker session
 */
async function resolvePersonaPageAvatarData(
  pagePersonas: TomoriState[],
  pageStartIdx: number,
  fallbackAvatarUrl: string,
  sessionCache: AvatarSessionCache,
): Promise<{ avatarUrls: Map<number, string>; files: AttachmentBuilder[] }> {
  const avatarUrls = new Map<number, string>();
  const files: AttachmentBuilder[] = [];

  await Promise.all(
    pagePersonas.map(async (persona, idx) => {
      const absoluteIdx = pageStartIdx + idx;

      // Return cached result immediately, so skip all I/O on repeated page visits.
      const cached = sessionCache.get(absoluteIdx);
      if (cached) {
        if (cached.type === "url") {
          avatarUrls.set(idx, cached.url);
        } else {
          const attachmentName = `avatar_${idx}.png`;
          files.push(new AttachmentBuilder(cached.buffer, { name: attachmentName }));
          avatarUrls.set(idx, `attachment://${attachmentName}`);
        }
        return;
      }

      if (!persona.is_alter) {
        sessionCache.set(absoluteIdx, { type: "url", url: fallbackAvatarUrl });
        avatarUrls.set(idx, fallbackAvatarUrl);
        return;
      }

      const asset = await resolveAlterPersonaAvatarAsset(persona);
      if (asset?.type === "url") {
        sessionCache.set(absoluteIdx, asset);
        avatarUrls.set(idx, asset.url);
        return;
      }
      if (asset?.type === "buffer") {
        sessionCache.set(absoluteIdx, asset);
        const attachmentName = `avatar_${idx}.png`;
        files.push(new AttachmentBuilder(asset.buffer, { name: attachmentName }));
        avatarUrls.set(idx, `attachment://${attachmentName}`);
        return;
      }

      // Nothing resolved, so use fallback
      sessionCache.set(absoluteIdx, { type: "url", url: fallbackAvatarUrl });
      avatarUrls.set(idx, fallbackAvatarUrl);
    }),
  );

  return { avatarUrls, files };
}

function buildPersonaPageComponents(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: PersonaPaginatedChoiceOptions,
  currentPage: number,
  totalPages: number,
  avatarUrlMap: Map<number, string>,
): TopLevelComponentData[] {
  const startIdx = (currentPage - 1) * PERSONA_PAGINATION_ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx + PERSONA_PAGINATION_ITEMS_PER_PAGE, options.personas.length);
  const pagePersonas = options.personas.slice(startIdx, endIdx);
  const serverAvatarUrl = interaction.guild?.members.me?.displayAvatarURL({
    extension: "png",
    size: 128,
    forceStatic: true,
  });
  const fallbackAvatarUrl =
    serverAvatarUrl ??
    interaction.client.user?.displayAvatarURL({
      extension: "png",
      size: 128,
      forceStatic: true,
    }) ??
    "https://cdn.discordapp.com/embed/avatars/0.png";
  const containerComponents: ComponentInContainerData[] = [
    {
      type: ComponentType.Section,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: formatContainerTitle(
            localizer(locale, options.titleKey ?? "general.pagination.select_persona_title"),
          ),
        },
      ],
      accessory: {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: PERSONA_CANCEL_CUSTOM_ID,
        emoji: { name: "✖️" },
      },
    },
  ];

  if (options.descriptionKey) {
    containerComponents.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, options.descriptionKey),
    });
  }

  // Filtered-notice line. The workflow pre-localizes this and only supplies it
  // when the eligibility filter actually excluded a persona, so an unfiltered
  // picker never shows it. Rendered as muted subtext beneath the description.
  if (options.filteredNotice) {
    containerComponents.push({
      type: ComponentType.TextDisplay,
      content: `-# ${options.filteredNotice}`,
    });
  }

  pagePersonas.forEach((persona, idx) => {
    const personaPrompt = persona.persona_prompt?.trim();
    const firstAttribute = persona.attribute_list?.[0]?.trim();
    const snippet = safeSelectOptionText(
      personaPrompt || firstAttribute || localizer(locale, "general.pagination.persona_no_attributes"),
      PERSONA_SNIPPET_MAX_LENGTH,
    );

    if (idx === 0) {
      containerComponents.push({
        type: ComponentType.Separator,
        divider: true,
        spacing: 1,
      });
    }

    containerComponents.push({
      type: ComponentType.Section,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `### ${safeSelectOptionText(persona.persona_nickname, 80)}\n${snippet}`,
        },
      ],
      accessory: {
        type: ComponentType.Thumbnail,
        media: {
          // avatarUrlMap is pre-resolved by resolvePersonaPageAvatarData, which
          // handles public URLs, attachment:// refs for local files, and fallbacks
          url: avatarUrlMap.get(idx) ?? fallbackAvatarUrl,
        },
      },
    });

    containerComponents.push({
      type: ComponentType.Section,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "** **",
        },
      ],
      accessory: {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: `${PERSONA_SELECT_CUSTOM_ID_PREFIX}${idx}`,
        label: localizer(locale, "general.pagination.persona_select_button"),
      },
    });

    containerComponents.push({
      type: ComponentType.Separator,
      divider: true,
      spacing: 1,
    });
  });

  const navRow: ActionRowData<ButtonComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: PERSONA_PREV_PAGE_CUSTOM_ID,
        emoji: { name: "⬅️" },
        disabled: currentPage <= 1,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: `persona_page_${currentPage}`,
        label: `${currentPage}/${totalPages}`,
        disabled: true,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: PERSONA_NEXT_PAGE_CUSTOM_ID,
        emoji: { name: "➡️" },
        disabled: currentPage >= totalPages,
      },
    ],
  };
  containerComponents.push(navRow);

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: resolveAccentColor(options.color),
    components: containerComponents,
  };

  return [container];
}

/**
 * Displays a paginated list of choices with emoji reactions for selection
 * @returns A promise that resolves with the selected item or null if cancelled/timeout
 */
export async function replyPaginatedChoices(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: PaginatedChoiceOptions,
): Promise<PaginatedChoiceResult> {
  const totalItems = options.items.length;
  const totalPages = Math.ceil(totalItems / PAGINATION_ITEMS_PER_PAGE);
  let currentPage = 1;
  const preserveSelectedInteraction = options.preserveSelectedInteraction === true;

  if (totalItems === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: options.titleKey,
      titleVars: options.titleVars,
      descriptionKey: "general.pagination.no_items", // Ensure this key exists
      color: ColorCode.INFO,
      flags: MessageFlags.Ephemeral,
    });

    return {
      success: false,
      reason: "error", // Indicate error because there were no items to choose from
    };
  }

  try {
    while (true) {
      const startIdx = (currentPage - 1) * PAGINATION_ITEMS_PER_PAGE;
      const endIdx = Math.min(startIdx + PAGINATION_ITEMS_PER_PAGE, totalItems);
      const currentPageItems = options.items.slice(startIdx, endIdx);

      let itemsDisplay = "";
      if (options.itemLabelKey) {
        itemsDisplay += `**${localizer(locale, options.itemLabelKey)}**\n\n`;
      }

      currentPageItems.forEach((item, idx) => {
        const displayItem = typeof item === "string" ? item : String(item);
        itemsDisplay += `${NUMBER_EMOJIS[idx]} ${displayItem}\n`;
      });

      if (totalPages > 1) {
        itemsDisplay += `\n${localizer(locale, "general.pagination.page_info", {
          current: currentPage,
          total: totalPages,
        })}`;
      }

      const buttons: ButtonBuilder[] = [];

      if (currentPage > 1) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId("prev_page")
            .setLabel(localizer(locale, "general.pagination.previous"))
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("⬅️"),
        );
      }

      buttons.push(
        new ButtonBuilder()
          .setCustomId("cancel")
          .setLabel(localizer(locale, "general.pagination.cancel"))
          .setStyle(ButtonStyle.Secondary),
      );

      if (currentPage < totalPages) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId("next_page")
            .setLabel(localizer(locale, "general.pagination.next"))
            .setStyle(ButtonStyle.Secondary)
            .setEmoji("➡️"),
        );
      }

      const selectionButtons: ButtonBuilder[] = [];
      currentPageItems.forEach((_, idx) => {
        selectionButtons.push(
          new ButtonBuilder().setCustomId(`select_${idx}`).setStyle(ButtonStyle.Secondary).setEmoji(NUMBER_EMOJIS[idx]), // Use the number emoji
        );
      });

      const paginationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

      const selectionRows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let i = 0; i < selectionButtons.length; i += 5) {
        const rowButtons = selectionButtons.slice(i, i + 5);
        if (rowButtons.length > 0) {
          selectionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
        }
      }

      const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
        paginationRow as ActionRowBuilder<MessageActionRowComponentBuilder>,
        ...selectionRows.map((row) => row as ActionRowBuilder<MessageActionRowComponentBuilder>),
      ];

      const embed = createStandardEmbed(locale, {
        titleKey: options.titleKey,
        titleVars: options.titleVars,
        descriptionKey: options.descriptionKey,
        descriptionVars: {
          ...options.descriptionVars,
          items: itemsDisplay, // Pass the generated list here
        },
        color: options.color ?? ColorCode.INFO, // Use provided color or default INFO
      });

      const baseReplyOptions: Omit<InteractionReplyOptions, "flags"> = {
        embeds: [embed],
        components: rows,
      };

      let message: Message;
      if (interaction.replied || interaction.deferred) {
        message = await interaction.editReply(baseReplyOptions);
      } else {
        await interaction.reply({
          ...baseReplyOptions,
          flags: MessageFlags.Ephemeral,
        });
        message = await interaction.fetchReply();
      }

      try {
        const buttonInteraction = await message.awaitMessageComponent({
          filter: (i) => i.user.id === interaction.user.id,
          componentType: ComponentType.Button,
          time: PAGINATION_TIMEOUT_MS,
        });

        const customId = buttonInteraction.customId;

        if (customId === "prev_page") {
          currentPage--;
          await buttonInteraction.deferUpdate();
          continue; // Continue the while loop to show the previous page
        }
        if (customId === "next_page") {
          currentPage++;
          await buttonInteraction.deferUpdate();
          continue; // Continue the while loop to show the next page
        }
        if (customId === "cancel") {
          await buttonInteraction.update({
            embeds: [
              createStandardEmbed(locale, {
                titleKey: options.titleKey, // Keep original title context
                titleVars: options.titleVars,
                descriptionKey: "general.pagination.cancelled", // Use specific cancelled key
                color: ColorCode.WARN, // Use WARN for cancellation feedback
              }),
            ],
            components: [], // Remove buttons
          });

          if (options.onCancel) {
            try {
              await options.onCancel();
            } catch (cancelCallbackError) {
              log.error("Error executing onCancel callback in replyPaginatedChoices", cancelCallbackError);
            }
          }

          return {
            success: false,
            reason: "cancelled",
          };
        }
        if (customId.startsWith("select_")) {
          const selectionIdx = Number.parseInt(customId.split("_")[1], 10);
          const absoluteIndex = startIdx + selectionIdx;
          const selectedItem = options.items[absoluteIndex];

          // Preserve button interaction for callers that need to open a modal from the selection.
          if (preserveSelectedInteraction) {
            try {
              await options.onSelect(absoluteIndex);
              return {
                success: true,
                selectedIndex: absoluteIndex,
                selectedItem,
                interaction: buttonInteraction,
              };
            } catch (selectCallbackError) {
              // The callback failed after the actor chose an item, so the user is about to be told
              // the operation failed while nothing durable records why. Escalated from warn, which
              // the production level filter drops.
              await log.error("onSelect callback failed in replyPaginatedChoices", selectCallbackError, {
                errorType: "PaginationSelectCallbackError",
                metadata: { userDiscordId: interaction.user.id, absoluteIndex },
              });
              await buttonInteraction.reply({
                embeds: [
                  createStandardEmbed(locale, {
                    titleKey: "general.errors.operation_failed_title",
                    descriptionKey: "general.errors.operation_failed_description",
                    descriptionVars: { item: selectedItem },
                    color: ColorCode.ERROR,
                  }),
                ],
                flags: MessageFlags.Ephemeral,
              });
              return {
                success: false,
                reason: "error",
              };
            }
          }

          // Defer update before potentially long-running callback
          await buttonInteraction.deferUpdate();

          try {
            await options.onSelect(absoluteIndex);

            await interaction.editReply({
              embeds: [
                createStandardEmbed(locale, {
                  titleKey: options.titleKey, // Keep original title context
                  titleVars: options.titleVars,
                  descriptionKey: "general.pagination.item_selected", // Use specific selected key
                  descriptionVars: { item: selectedItem }, // Pass selected item
                  color: ColorCode.SUCCESS, // Use SUCCESS color
                }),
              ],
              components: [], // Remove buttons
            });

            return {
              success: true,
              selectedIndex: absoluteIndex,
              selectedItem,
            };
          } catch (selectCallbackError) {
            // The callback failed after the actor chose an item, so the user is about to be told the
            // operation failed while nothing durable records why. Escalated from warn, which the
            // production level filter drops, and paired with the ambient interaction context.
            await log.error("onSelect callback failed in replyPaginatedChoices", selectCallbackError, {
              errorType: "PaginationSelectCallbackError",
              metadata: { userDiscordId: interaction.user.id, absoluteIndex },
            });
            await interaction.editReply({
              embeds: [
                createStandardEmbed(locale, {
                  titleKey: "general.errors.operation_failed_title", // Specific error title
                  descriptionKey: "general.errors.operation_failed_description", // Specific error description
                  descriptionVars: { item: selectedItem }, // Mention the item
                  color: ColorCode.ERROR, // Use ERROR color
                }),
              ],
              components: [], // Remove buttons
            });

            return {
              success: false,
              reason: "error", // Indicate an error occurred during processing
            };
          }
        }
      } catch (error) {
        // Only expiry is routine. An onSelect callback that threw, a deleted panel message, or a
        // removed channel all land here too, and `log.warn` is filtered out of the production
        // stream, so those would otherwise reach the user as a bare timeout with no record.
        if (isCollectorTimeoutError(error)) {
          log.warn(`Pagination interaction timed out for user ${interaction.user.id}`); // Log timeout specifically
        } else {
          await log.error("Pagination interaction ended abnormally in replyPaginatedChoices", error, {
            errorType: "PaginationCollectorEnded",
            metadata: { userDiscordId: interaction.user.id, currentPage },
          });
        }
        await interaction.editReply({
          embeds: [
            createStandardEmbed(locale, {
              titleKey: options.titleKey, // Keep original title context
              titleVars: options.titleVars,
              descriptionKey: "general.pagination.timeout", // Use specific timeout key
              color: ColorCode.WARN, // Use WARN for timeout user feedback
            }),
          ],
          components: [], // Remove buttons
        });

        return {
          success: false,
          reason: "timeout",
        };
      }
    } // End while loop
  } catch (error) {
    // Handle unexpected errors during setup (e.g., initial reply/edit failed)
    // Errors from onSelect are now caught inside the loop's try-catch
    log.error("Unexpected error during replyPaginatedChoices setup:", error); // Log the setup error

    try {
      // Use replyInfoEmbed for consistency, ensuring it handles deferred/replied state
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.Ephemeral, // Ensure it's ephemeral if possible
      );
    } catch (finalErrorReplyError) {
      log.error("Failed even to send final error message in replyPaginatedChoices:", finalErrorReplyError);
    }

    return {
      success: false,
      reason: "error", // Indicate a general setup error
    };
  }
}

/**
 * Low-level Components V2 persona renderer used by `runPersonaPickerWorkflow`.
 * Command and feature callers must use the workflow API so acknowledgment,
 * retry, cache, and anchor-message invariants remain enforced.
 */
export async function replyPaginatedPersonaChoicesV2(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: PersonaPaginatedChoiceOptions,
): Promise<PaginatedChoiceResult> {
  const totalItems = options.personas.length;
  const totalPages = Math.ceil(totalItems / PERSONA_PAGINATION_ITEMS_PER_PAGE);
  let currentPage = 1;
  const preserveSelectedInteraction = options.preserveSelectedInteraction === true;
  const onSelect = options.onSelect ?? (async () => {});

  if (totalItems === 0) {
    const components = buildV2StatusComponents(
      locale,
      options.titleKey ?? "general.pagination.select_persona_title",
      "general.pagination.no_items",
      ColorCode.INFO,
    );
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ components, attachments: [], flags: MessageFlags.IsComponentsV2 });
    } else {
      await interaction.reply({
        components,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        withResponse: true,
      });
    }

    return {
      success: false,
      reason: "error",
    };
  }

  // Compute fallback avatar URL once; used when no persona avatar can be resolved.
  // Mirrors the same logic inside buildPersonaPageComponents so both agree on the fallback.
  const serverAvatarUrl = interaction.guild?.members.me?.displayAvatarURL({
    extension: "png",
    size: 128,
    forceStatic: true,
  });
  const fallbackAvatarUrl =
    serverAvatarUrl ??
    interaction.client.user?.displayAvatarURL({
      extension: "png",
      size: 128,
      forceStatic: true,
    }) ??
    "https://cdn.discordapp.com/embed/avatars/0.png";

  // Outer try catches only programming errors (e.g. bad options). It must NOT make
  // Discord API calls because by the time an error escapes the inner try, the interaction
  // token may already be dead and any recovery attempt just wastes rate-limit quota.
  const sessionStart = Date.now();
  // Reuse the workflow-owned cache across retries, or create one for direct internal use.
  const avatarSessionCache: AvatarSessionCache = options.avatarSessionCache ?? new Map();
  try {
    while (true) {
      // Inner try wraps the ENTIRE loop body: setup, render, and button wait.
      //    This ensures every Discord API error is caught here and returned cleanly
      //    without propagating to the outer catch and triggering a second API call.
      try {
        // Slash-command entry points may spend most of their 3-second ACK window
        //     loading personas before they reach the picker. Acknowledge here before
        //     avatar/file resolution so the initial render uses editReply() instead of
        //     racing the first interaction.reply().
        if (interaction.isChatInputCommand() && !interaction.replied && !interaction.deferred) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }

        // Guard against the Discord 15-minute interaction token expiry.
        //     awaitMessageComponent resets its per-iteration timeout on each loop
        //     pass, so an active user clicking buttons can hold the session open
        //     indefinitely; past the point where the token becomes invalid and all
        //     editReply calls start throwing "Invalid Webhook Token".
        if (Date.now() - sessionStart >= PAGINATION_SESSION_MAX_MS) {
          try {
            await interaction.editReply({
              components: buildV2StatusComponents(
                locale,
                options.titleKey ?? "general.pagination.select_persona_title",
                "general.pagination.timeout",
                ColorCode.WARN,
              ),
              attachments: [],
              flags: MessageFlags.IsComponentsV2,
            });
          } catch (error) {
            log.warn("Failed to mark persona pagination session as timed out", {
              errorType: "InteractionEditFailed",
              metadata: { userId: interaction.user.id, error },
            });
          }
          return { success: false, reason: "timeout" };
        }

        const startIdx = (currentPage - 1) * PERSONA_PAGINATION_ITEMS_PER_PAGE;
        const endIdx = Math.min(startIdx + PERSONA_PAGINATION_ITEMS_PER_PAGE, options.personas.length);
        const pagePersonas = options.personas.slice(startIdx, endIdx);

        // Pre-resolve avatar URLs (and collect local file attachments when needed).
        //     In non-production without AVATAR_PUBLIC_BASE_URL, alter avatars stored as
        //     local paths are loaded from disk and attached directly to the message.
        //     avatarSessionCache ensures each persona's avatar is only fetched once per session.
        const { avatarUrls, files } = await resolvePersonaPageAvatarData(
          pagePersonas,
          startIdx,
          fallbackAvatarUrl,
          avatarSessionCache,
        );

        const components = buildPersonaPageComponents(
          interaction,
          locale,
          options,
          currentPage,
          totalPages,
          avatarUrls,
        );
        const baseReplyOptions: Omit<InteractionReplyOptions, "flags"> = {
          components,
          files,
        };

        let message: Message;
        if (interaction.replied || interaction.deferred) {
          message = await interaction.editReply({
            ...baseReplyOptions,
            attachments: [],
            flags: MessageFlags.IsComponentsV2,
          });
        } else {
          const response = await interaction.reply({
            ...baseReplyOptions,
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            withResponse: true,
          });
          message = response.resource?.message ?? (await interaction.fetchReply());
        }

        const buttonInteraction = await message.awaitMessageComponent({
          filter: (i) => i.user.id === interaction.user.id,
          componentType: ComponentType.Button,
          time: PAGINATION_TIMEOUT_MS,
        });

        const customId = buttonInteraction.customId;
        if (customId === PERSONA_PREV_PAGE_CUSTOM_ID) {
          currentPage = Math.max(1, currentPage - 1);
          await buttonInteraction.deferUpdate();
          continue;
        }

        if (customId === PERSONA_NEXT_PAGE_CUSTOM_ID) {
          currentPage = Math.min(totalPages, currentPage + 1);
          await buttonInteraction.deferUpdate();
          continue;
        }

        if (customId === PERSONA_CANCEL_CUSTOM_ID) {
          await buttonInteraction.deferUpdate();
          await interaction.editReply({
            components: buildV2StatusComponents(
              locale,
              options.titleKey ?? "general.pagination.select_persona_title",
              "general.pagination.cancelled",
              ColorCode.WARN,
            ),
            attachments: [],
            flags: MessageFlags.IsComponentsV2,
          });

          if (options.onCancel) {
            try {
              await options.onCancel();
            } catch (cancelCallbackError) {
              log.error("Error executing onCancel callback in replyPaginatedPersonaChoicesV2", cancelCallbackError);
            }
          }

          return {
            success: false,
            reason: "cancelled",
          };
        }

        if (customId.startsWith(PERSONA_SELECT_CUSTOM_ID_PREFIX)) {
          const selectionIdx = Number.parseInt(customId.slice(PERSONA_SELECT_CUSTOM_ID_PREFIX.length), 10);
          if (Number.isNaN(selectionIdx)) {
            await buttonInteraction.deferUpdate();
            continue;
          }

          const startIdx = (currentPage - 1) * PERSONA_PAGINATION_ITEMS_PER_PAGE;
          const absoluteIndex = startIdx + selectionIdx;
          const selectedPersona = options.personas[absoluteIndex];
          const selectedItem = selectedPersona?.persona_nickname ?? localizer(locale, "general.unknown");

          if (!selectedPersona) {
            await buttonInteraction.deferUpdate();
            await interaction.editReply({
              components: buildV2StatusComponents(
                locale,
                "general.errors.invalid_option_title",
                "general.errors.invalid_option_description",
                ColorCode.ERROR,
              ),
              attachments: [],
              flags: MessageFlags.IsComponentsV2,
            });
            return {
              success: false,
              reason: "error",
            };
          }

          if (preserveSelectedInteraction) {
            try {
              await onSelect(absoluteIndex);
              return {
                success: true,
                selectedIndex: absoluteIndex,
                selectedItem,
                interaction: buttonInteraction,
              };
            } catch (selectCallbackError) {
              // Same blind spot as the sibling paginator: the caller's callback decides whether the
              // write landed, and warn does not survive the production level filter.
              await log.error("onSelect callback failed in replyPaginatedPersonaChoicesV2", selectCallbackError, {
                errorType: "PaginationSelectCallbackError",
                metadata: { userDiscordId: interaction.user.id, absoluteIndex },
              });
              await buttonInteraction.reply({
                embeds: [
                  createStandardEmbed(locale, {
                    titleKey: "general.errors.operation_failed_title",
                    descriptionKey: "general.errors.operation_failed_description",
                    descriptionVars: { item: selectedItem },
                    color: ColorCode.ERROR,
                  }),
                ],
                flags: MessageFlags.Ephemeral,
              });
              return {
                success: false,
                reason: "error",
              };
            }
          }

          await buttonInteraction.deferUpdate();

          try {
            await onSelect(absoluteIndex);
            await interaction.editReply({
              components: buildV2StatusComponents(
                locale,
                options.titleKey ?? "general.pagination.select_persona_title",
                "general.pagination.item_selected",
                ColorCode.SUCCESS,
                { item: selectedItem },
              ),
              attachments: [],
              flags: MessageFlags.IsComponentsV2,
            });

            return {
              success: true,
              selectedIndex: absoluteIndex,
              selectedItem,
            };
          } catch (selectCallbackError) {
            await log.error("onSelect callback failed in replyPaginatedPersonaChoicesV2", selectCallbackError, {
              errorType: "PaginationSelectCallbackError",
              metadata: { userDiscordId: interaction.user.id, absoluteIndex },
            });
            await interaction.editReply({
              components: buildV2StatusComponents(
                locale,
                "general.errors.operation_failed_title",
                "general.errors.operation_failed_description",
                ColorCode.ERROR,
                { item: selectedItem },
              ),
              attachments: [],
              flags: MessageFlags.IsComponentsV2,
            });
            return {
              success: false,
              reason: "error",
            };
          }
        }
      } catch (innerError) {
        // Discord.js signals an awaitMessageComponent expiry either with the bare
        // string "time" or with an InteractionCollectorError carrying the end
        // reason, depending on the surface: isCollectorTimeoutError covers both.
        // Any other value is a real Discord API error (rate limit, expired token,
        // lost permission, etc.) and must stay classified as fatal.
        const isTimeout = isCollectorTimeoutError(innerError);

        if (isTimeout) {
          log.warn(`Pagination interaction timed out for user ${interaction.user.id}`);
        } else {
          log.warn(`Pagination interaction failed for user ${interaction.user.id}`, innerError);
        }

        // Best-effort: show a status message. We swallow any editReply failure
        // here so it never escapes to the outer catch and triggers a second
        // API call (which would worsen an ongoing rate-limit spiral).
        try {
          await interaction.editReply({
            components: buildV2StatusComponents(
              locale,
              options.titleKey ?? "general.pagination.select_persona_title",
              isTimeout ? "general.pagination.timeout" : "general.errors.unknown_error_description",
              isTimeout ? ColorCode.WARN : ColorCode.ERROR,
            ),
            attachments: [],
            flags: MessageFlags.IsComponentsV2,
          });
        } catch (error) {
          log.warn("Failed to update persona pagination terminal status", {
            errorType: "InteractionEditFailed",
            metadata: { userId: interaction.user.id, isTimeout, error },
          });
        }

        // "fatal" signals callers that the interaction token is dead and they must
        // NOT continue their own while(true) loop, because doing so would call this
        // function again on a dead interaction, creating an infinite API spam loop.
        return {
          success: false,
          reason: isTimeout ? "timeout" : "fatal",
        };
      }
    }
  } catch (error) {
    // Only genuine programming errors reach here (e.g. bad options, sync throws).
    // Do NOT make Discord API calls in this handler because the interaction state is
    // unknown at this point and any attempt would just waste rate-limit quota.
    log.error("Unexpected error during replyPaginatedPersonaChoicesV2 setup:", error);

    return {
      success: false,
      reason: "error",
    };
  }
}

/**
 * @description Creates a modal using raw Discord API with Component Type 18 (Label) support for descriptions and string selects
 * @param autoDeferReply Optional. If provided, automatically defers the modal submission reply to prevent 3-second timeout. Pass `true` for public reply, or `MessageFlags.Ephemeral` for ephemeral reply.
 */
export async function promptWithRawModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: ModalOptions,
  autoDeferReply?: boolean | MessageFlags.Ephemeral,
): Promise<ModalResult> {
  setupWebSocketInterception(interaction.client);

  const { modalTitleKey, modalCustomId, components } = options;

  // Generate a unique nonce for this modal instance. Discord's client caches
  // checked state by custom_id because without a nonce, re-opening a modal (or
  // opening a different page that reuses the same component custom_ids)
  // causes the client to restore stale selections instead of honoring defaults.
  const modalNonce = Date.now().toString(36);
  const noncedModalCustomId = `${modalCustomId}_${modalNonce}`;

  /** Append the nonce to a component custom_id for cache-busting */
  const nonceCustomId = (id: string) => `${id}_${modalNonce}`;

  try {
    const rawModalPayload = {
      type: InteractionResponseType.Modal, // Type 9
      data: {
        custom_id: noncedModalCustomId,
        title: safeSelectOptionText(localizer(locale, modalTitleKey), MODAL_TITLE_MAX_LENGTH),
        components: components.map((component) => {
          // Check kind-discriminated types first: before any structural guards.
          // isModalSelectField checks "options" in component, which would also match
          // RadioGroupField and CheckboxGroupField. isModalInputField's fallback
          // (no options/minValues/style) would match CheckboxField. Checking `kind`
          // first avoids both false-positive matches.
          if (isModalRadioGroupField(component)) {
            const c = component as ModalRadioGroupField;
            const rawComponent: RawDiscordComponent = {
              type: 21, // ComponentType.RadioGroup
              custom_id: nonceCustomId(c.customId),
              options: c.options.map((opt) => ({
                value: safeSelectOptionText(opt.value, SELECT_OPTION_TEXT_MAX_LENGTH),
                label: safeSelectOptionText(opt.label, SELECT_OPTION_TEXT_MAX_LENGTH),
                description: opt.description
                  ? safeSelectOptionText(opt.description, SELECT_OPTION_TEXT_MAX_LENGTH)
                  : undefined,
                default: opt.default,
              })),
              required: c.required !== false,
            };

            const radioLabelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, c.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (c.descriptionKey) {
              radioLabelComponent.description = safeModalLocalizer(locale, c.descriptionKey);
            }

            return radioLabelComponent;
          } else if (isModalCheckboxGroupField(component)) {
            const cg = component as ModalCheckboxGroupField;
            const rawComponent: RawDiscordComponent = {
              type: 22, // ComponentType.CheckboxGroup
              custom_id: nonceCustomId(cg.customId),
              options: cg.options.map((opt) => ({
                value: safeSelectOptionText(opt.value, SELECT_OPTION_TEXT_MAX_LENGTH),
                label: safeSelectOptionText(opt.label, SELECT_OPTION_TEXT_MAX_LENGTH),
                description: opt.description
                  ? safeSelectOptionText(opt.description, SELECT_OPTION_TEXT_MAX_LENGTH)
                  : undefined,
                default: opt.default,
              })),
            };

            if (cg.minValues !== undefined) rawComponent.min_values = cg.minValues;
            if (cg.maxValues !== undefined) rawComponent.max_values = cg.maxValues;
            if (cg.required !== undefined) rawComponent.required = cg.required;

            const checkboxGroupLabelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, cg.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (cg.descriptionKey) {
              checkboxGroupLabelComponent.description = safeModalLocalizer(locale, cg.descriptionKey);
            }

            return checkboxGroupLabelComponent;
          } else if (isModalCheckboxField(component)) {
            const cb = component as ModalCheckboxField;
            const rawComponent: RawDiscordComponent = {
              type: 23, // ComponentType.Checkbox
              custom_id: nonceCustomId(cb.customId),
            };

            if (cb.default !== undefined) rawComponent.default = cb.default;

            const checkboxLabelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, cb.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (cb.descriptionKey) {
              checkboxLabelComponent.description = safeModalLocalizer(locale, cb.descriptionKey);
            }

            return checkboxLabelComponent;
          } else if (isModalUserSelectField(component)) {
            const us = component as ModalUserSelectField;
            const rawComponent: RawDiscordComponent = {
              type: 5,
              custom_id: nonceCustomId(us.customId),
              min_values: us.minValues ?? 1,
              max_values: us.maxValues ?? 1,
              required: us.required !== false,
            };

            if (us.placeholder) {
              const placeholder =
                typeof us.placeholder === "string" && us.placeholder.startsWith("commands.")
                  ? localizer(locale, us.placeholder)
                  : us.placeholder;
              rawComponent.placeholder = safeSelectOptionText(placeholder, SELECT_PLACEHOLDER_MAX_LENGTH);
            }

            const userSelectLabelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, us.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (us.descriptionKey) {
              userSelectLabelComponent.description = safeModalLocalizer(locale, us.descriptionKey);
            }

            return userSelectLabelComponent;
          } else if (isModalRoleSelectField(component)) {
            const rs = component as ModalRoleSelectField;
            const rawComponent: RawDiscordComponent = {
              type: 6,
              custom_id: nonceCustomId(rs.customId),
              min_values: rs.minValues ?? 1,
              max_values: rs.maxValues ?? 1,
              required: rs.required !== false,
            };

            if (rs.placeholder) {
              const placeholder = rs.placeholder.startsWith("commands.")
                ? localizer(locale, rs.placeholder)
                : rs.placeholder;
              rawComponent.placeholder = safeSelectOptionText(placeholder, SELECT_PLACEHOLDER_MAX_LENGTH);
            }

            const roleSelectLabelComponent: RawDiscordComponent = {
              type: 18,
              label: safeSelectOptionText(localizer(locale, rs.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (rs.descriptionKey) {
              roleSelectLabelComponent.description = safeModalLocalizer(locale, rs.descriptionKey);
            }

            return roleSelectLabelComponent;
          } else if (isModalChannelSelectField(component)) {
            const cs = component as ModalChannelSelectField;
            const rawComponent: RawDiscordComponent = {
              type: 8,
              custom_id: nonceCustomId(cs.customId),
              min_values: cs.minValues ?? 1,
              max_values: cs.maxValues ?? 1,
              required: cs.required !== false,
            };

            if (cs.channelTypes) {
              rawComponent.channel_types = cs.channelTypes;
            }

            if (cs.placeholder) {
              const placeholder =
                typeof cs.placeholder === "string" && cs.placeholder.startsWith("commands.")
                  ? localizer(locale, cs.placeholder)
                  : cs.placeholder;
              rawComponent.placeholder = safeSelectOptionText(placeholder, SELECT_PLACEHOLDER_MAX_LENGTH);
            }

            const channelSelectLabelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, cs.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (cs.descriptionKey) {
              channelSelectLabelComponent.description = safeModalLocalizer(locale, cs.descriptionKey);
            }

            return channelSelectLabelComponent;
          } else if (isModalInputField(component)) {
            const rawComponent: RawDiscordComponent = {
              type: 4, // ComponentType.TextInput
              custom_id: component.customId,
              style: component.style || TextInputStyle.Short,
              required: component.required !== false,
            };

            if (component.placeholder) {
              const placeholder =
                typeof component.placeholder === "string" && component.placeholder.startsWith("commands.")
                  ? localizer(locale, component.placeholder)
                  : component.placeholder;
              rawComponent.placeholder = safeSelectOptionText(placeholder, TEXT_INPUT_PLACEHOLDER_MAX_LENGTH);
            }
            if (component.minLength) rawComponent.min_length = component.minLength;
            if (component.maxLength) rawComponent.max_length = component.maxLength;
            if (component.value) rawComponent.value = component.value;

            const labelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, component.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (component.descriptionKey) {
              labelComponent.description = safeModalLocalizer(locale, component.descriptionKey);
            }

            return labelComponent;
          } else if (isModalSelectField(component)) {
            // String Select wrapped in Label component (type 18)
            const rawComponent: RawDiscordComponent = {
              type: 3, // ComponentType.StringSelect
              custom_id: component.customId,
              options: component.options.map((option) => ({
                label: safeSelectOptionText(option.label, SELECT_OPTION_TEXT_MAX_LENGTH),
                value: safeSelectOptionText(option.value, SELECT_OPTION_TEXT_MAX_LENGTH),
                description: option.description
                  ? safeSelectOptionText(option.description, SELECT_OPTION_TEXT_MAX_LENGTH)
                  : undefined,
                emoji: option.emoji,
              })),
              required: component.required !== false,
            };

            if (component.placeholder) {
              const placeholder =
                typeof component.placeholder === "string" && component.placeholder.startsWith("commands.")
                  ? localizer(locale, component.placeholder)
                  : component.placeholder;
              rawComponent.placeholder = safeSelectOptionText(placeholder, SELECT_PLACEHOLDER_MAX_LENGTH);
            }

            const labelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, component.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (component.descriptionKey) {
              labelComponent.description = safeModalLocalizer(locale, component.descriptionKey);
            }

            return labelComponent;
          } else if (isModalFileUploadField(component)) {
            const rawComponent: RawDiscordComponent = {
              type: 19, // ComponentType.FileUpload
              custom_id: component.customId,
              min_values: component.minValues ?? 0,
              max_values: component.maxValues ?? 1,
              required: component.required ?? false,
            };

            const labelComponent: RawDiscordComponent = {
              type: 18, // ComponentType.Label
              label: safeSelectOptionText(localizer(locale, component.labelKey), MODAL_LABEL_MAX_LENGTH),
              component: rawComponent,
            };

            if (component.descriptionKey) {
              labelComponent.description = safeModalLocalizer(locale, component.descriptionKey);
            }

            return labelComponent;
          }

          throw new Error(`Unsupported modal component type: ${JSON.stringify(component)}`);
        }),
      },
    };

    await showRoutedRawModal(interaction, rawModalPayload.data);

    // Now we can use the standard awaitModalSubmit with the transformed data
    // Use Discord's natural timeout duration (~15 minutes)
    try {
      const submitted = await interaction.awaitModalSubmit({
        time: 600000, // 10 minutes - matches Discord's natural modal timeout
        filter: (i) => i.customId === noncedModalCustomId && i.user.id === interaction.user.id,
      });

      // Extract values using Discord.js methods and stored select values
      // Keys are stored under the ORIGINAL (non-nonce'd) custom_id so callers
      // don't need to know about the nonce.
      const values: Record<string, string> = {};
      const multiValues: Record<string, string[]> = {};
      const attachments: Record<string, APIAttachment> = {};
      const fileUploadComponentCount = components.filter((component) => isModalFileUploadField(component)).length;

      // Check kind-based guards (radio, checkbox group, checkbox) BEFORE the
      // catch-all isModalInputField: it matches anything without select-like
      // properties and would swallow checkbox/radio components otherwise.
      for (const component of components) {
        if (isModalRadioGroupField(component)) {
          try {
            const c = component as ModalRadioGroupField;
            // Radio Group value is stored in modalSelectValues under the nonce'd custom_id
            const storedValues = modalSelectValues.get(submitted.id);
            const radioValue = storedValues?.[nonceCustomId(c.customId)];
            if (radioValue !== undefined) {
              values[c.customId] = radioValue;
            } else {
              log.warn(`Could not extract radio group value for ${c.customId}`);
            }
          } catch (error) {
            log.warn(`Failed to get radio group value for component: ${error}`);
          }
        } else if (isModalCheckboxGroupField(component)) {
          try {
            const cg = component as ModalCheckboxGroupField;
            const storedValues = modalCheckboxGroupValues.get(submitted.id);
            const checkboxValues = storedValues?.[nonceCustomId(cg.customId)];
            if (checkboxValues !== undefined) {
              multiValues[cg.customId] = checkboxValues;
            } else {
              // If no values stored, treat as empty selection (user checked nothing)
              multiValues[cg.customId] = [];
              log.warn(`No checkbox group values found for ${cg.customId}, defaulting to []`);
            }
          } catch (error) {
            log.warn(`Failed to get checkbox group values for component: ${error}`);
          }
        } else if (isModalCheckboxField(component)) {
          try {
            const cb = component as ModalCheckboxField;
            const storedValues = modalSelectValues.get(submitted.id);
            const checkboxValue = storedValues?.[nonceCustomId(cb.customId)];
            if (checkboxValue !== undefined) {
              values[cb.customId] = checkboxValue;
            } else {
              values[cb.customId] = cb.default ? "true" : "false";
              log.warn(`No checkbox value found for ${cb.customId}, using default: ${values[cb.customId]}`);
            }
          } catch (error) {
            log.warn(`Failed to get checkbox value for component: ${error}`);
          }
        } else if (isModalUserSelectField(component)) {
          try {
            const us = component as ModalUserSelectField;
            const storedValues = modalSelectValues.get(submitted.id);
            const userValue = storedValues?.[nonceCustomId(us.customId)];
            if (userValue !== undefined) {
              values[us.customId] = userValue;
            } else {
              log.warn(`Could not extract user select value for ${us.customId}`);
            }
          } catch (error) {
            log.warn(`Failed to get user select value for component: ${error}`);
          }
        } else if (isModalRoleSelectField(component)) {
          try {
            const rs = component as ModalRoleSelectField;
            const storedValues = modalSelectValues.get(submitted.id);
            const roleValue = storedValues?.[nonceCustomId(rs.customId)];
            if (roleValue !== undefined) {
              values[rs.customId] = roleValue;
            } else {
              log.warn(`Could not extract role select value for ${rs.customId}`);
            }
          } catch (error) {
            log.warn(`Failed to get role select value for component: ${error}`);
          }
        } else if (isModalChannelSelectField(component)) {
          try {
            const cs = component as ModalChannelSelectField;
            const storedValues = modalSelectValues.get(submitted.id);
            const channelValue = storedValues?.[nonceCustomId(cs.customId)];
            if (channelValue !== undefined) {
              values[cs.customId] = channelValue;
            } else {
              log.warn(`Could not extract channel select value for ${cs.customId}`);
            }
          } catch (error) {
            log.warn(`Failed to get channel select value for component: ${error}`);
          }
        } else if (isModalInputField(component)) {
          try {
            values[component.customId] = submitted.fields.getTextInputValue(component.customId);
          } catch (error) {
            log.warn(`Failed to get text input value for ${component.customId}:`, error);
          }
        } else if (isModalSelectField(component)) {
          try {
            // Get select value from storage (since Discord.js strips them)
            const storedValues = modalSelectValues.get(submitted.id);
            const selectValue = storedValues?.[component.customId];

            if (selectValue) {
              values[component.customId] = selectValue;
            } else {
              log.warn(`Could not extract select value for ${component.customId}`);
            }
          } catch (error) {
            log.warn(`Failed to get select value for ${component.customId}: ${error}`);
          }
        } else if (isModalFileUploadField(component)) {
          try {
            const storedAttachments = modalResolvedAttachments.get(submitted.id);
            const storedFileUploadValues = modalFileUploadValues.get(submitted.id);

            if (storedAttachments) {
              const attachmentIds = storedFileUploadValues?.[component.customId] ?? [];

              if (attachmentIds.length > 0) {
                for (const attachmentId of attachmentIds) {
                  const attachment = storedAttachments[attachmentId];
                  if (!attachment) {
                    continue;
                  }
                  attachments[component.customId] = attachment;
                  log.info(`Extracted file upload for ${component.customId}: ${attachmentId} (${attachment.filename})`);
                  break; // ModalResult currently stores a single attachment per custom ID
                }
              } else if (fileUploadComponentCount === 1) {
                // Backward-compatible fallback for older single-upload modals
                const [firstAttachmentEntry] = Object.entries(storedAttachments);
                if (firstAttachmentEntry) {
                  const [attachmentId, attachment] = firstAttachmentEntry;
                  attachments[component.customId] = attachment;
                  log.info(
                    `Extracted fallback file upload for ${component.customId}: ${attachmentId} (${attachment.filename})`,
                  );
                }
              }
            } else {
              log.info(`No stored attachments found for interaction ${submitted.id}`);
            }
          } catch (error) {
            log.warn(`Failed to extract file upload for ${component.customId}: ${error}`);
          }
        }
      }

      modalSelectValues.delete(submitted.id);
      modalFileUploadValues.delete(submitted.id);
      modalCheckboxGroupValues.delete(submitted.id);
      modalResolvedAttachments.delete(submitted.id);

      // Auto-defer reply if requested to prevent 3-second interaction timeout
      if (autoDeferReply) {
        const flags = typeof autoDeferReply === "boolean" ? undefined : autoDeferReply;
        await submitted.deferReply({ flags });
        log.info(`Auto-deferred modal submission reply (flags: ${flags ? MessageFlags[flags] : "none"})`);
      }

      return {
        outcome: "submit",
        values,
        multiValues: Object.keys(multiValues).length > 0 ? multiValues : undefined,
        attachments,
        interaction: submitted,
      };
    } catch (error) {
      log.warn(`Modal submission failed for user ${interaction.user.id}:`, error);
      return isCollectorTimeoutError(error) ? { outcome: "timeout" } : { outcome: "error", error };
    }
  } catch (error) {
    log.error("Failed to show raw modal:", error);
    return { outcome: "error", error };
  }
}

/**
 * Shared page size for the `>25`-option paginated modal selector. Both the legacy
 * page-button path in {@link promptWithPaginatedModal} and the Components V2 range
 * selector in `personaWorkflow.ts` slice option lists into chunks of this size, so a
 * single exported value keeps them in lockstep (previously `ITEMS_PER_PAGE` and
 * `OPTIONS_PER_MODAL` duplicated the same `25`).
 */
export const MODAL_OPTIONS_PER_PAGE = 25;

/**
 * Finds the single option-bearing select component in a modal's component list.
 * Radio/checkbox groups also carry `options`, but they are capped well under the
 * page size so pagination never triggers for them: matching prior behavior in
 * both the legacy and persona paths.
 *
 * @returns The paginatable select component, or `undefined` when none exists.
 */
export function getPaginatedModalComponent(options: ModalOptions): ModalComponent | undefined {
  return options.components.find((component) => "options" in component && Array.isArray(component.options));
}

/**
 * Returns a shallow copy of `options` whose `target` select component has its
 * option list narrowed to the half-open range `[start, end)`. Every other
 * component is passed through by reference. Shared by both selector paths so the
 * index math that maps a chosen page/range back to a modal is defined once.
 *
 * @param start - Inclusive start index into the target's option list.
 * @param end - Exclusive end index into the target's option list.
 */
export function sliceModalOptions(
  options: ModalOptions,
  target: ModalComponent,
  start: number,
  end: number,
): ModalOptions {
  return {
    ...options,
    components: options.components.map((component) => {
      if (component !== target || !("options" in component)) return component;
      return { ...component, options: component.options.slice(start, end) } as ModalComponent;
    }),
  };
}

/**
 * Parses a `${prefix}_range_${index}` custom id emitted by the shared range
 * selector, returning the 0-based range index or `null` when the id is not a
 * valid range button. Centralizing the parse keeps the selector's custom-id
 * scheme in one place for every consumer of the range payload.
 *
 * @param prefix - The selector's per-session custom-id prefix.
 * @returns The parsed 0-based range index, or `null` on a mismatch.
 */
export function parseModalRangeIndex(customId: string, prefix: string): number | null {
  const marker = `${prefix}_range_`;
  if (!customId.startsWith(marker)) return null;
  const parsed = Number.parseInt(customId.slice(marker.length), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Enhanced modal function that automatically handles pagination when select options exceed 25 items
 */
export async function promptWithPaginatedModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: ModalOptions,
): Promise<ModalResult> {
  // Find the select component (should only be one per modal in current usage)
  const selectComponent = getPaginatedModalComponent(options);
  const optionCount = selectComponent && "options" in selectComponent ? selectComponent.options.length : 0;

  // If no select component or (≤25 options and interaction not yet acknowledged), use direct modal.
  // On loop re-entry the original slash interaction is already acknowledged: either via Discord.js
  // (interaction.replied) or via raw REST modal (rawModalAcknowledged) which bypasses Discord.js
  // state tracking. In that case fall through to the paginated path, which uses editReply + a
  // fresh button interaction to open the modal.
  const wasRawModalAcked = rawModalAcknowledged.get(interaction) ?? false;
  if (
    !selectComponent ||
    (optionCount <= MODAL_OPTIONS_PER_PAGE && !interaction.deferred && !interaction.replied && !wasRawModalAcked)
  ) {
    return promptWithRawModal(interaction, locale, options);
  }

  // Opt-in Components V2 range selector (see ModalOptions.selectorStyle). Shares the
  // payload + index math with the persona workflow via buildRangeSelectorPayload, but
  // keeps its own transport + await loop: the global path's three delivery situations
  // (reply / editReply / webhook.send) differ from the persona anchor message.
  if (options.selectorStyle === "componentsV2") {
    return runComponentsV2RangeSelectorModal(
      interaction,
      locale,
      options,
      selectComponent,
      optionCount,
      wasRawModalAcked,
    );
  }

  // Paginated modal system for >25 options
  const ITEMS_PER_PAGE = MODAL_OPTIONS_PER_PAGE;
  const totalPages = Math.ceil(optionCount / ITEMS_PER_PAGE);

  const pageSelectEmbed = createStandardEmbed(locale, {
    titleKey: "general.pagination.select_page_title",
    descriptionKey: "general.pagination.select_page_description",
    descriptionVars: { totalItems: optionCount, totalPages },
    color: ColorCode.INFO,
  });

  // Create numbered page buttons (1-9, limited by total pages)
  const maxButtons = Math.min(totalPages, 9);
  const pageButtons: ButtonBuilder[] = [];

  for (let i = 1; i <= maxButtons; i++) {
    pageButtons.push(
      new ButtonBuilder().setCustomId(`page_${i}`).setLabel(i.toString()).setStyle(ButtonStyle.Secondary),
    );
  }

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...pageButtons);

  // Always resolve to a Message (not InteractionResponse) so that
  // awaitMessageComponent works reliably on ephemeral messages.
  let pageSelectMessage: Message;
  if (interaction.deferred || interaction.replied) {
    pageSelectMessage = await interaction.editReply({
      embeds: [pageSelectEmbed],
      components: [actionRow],
    });
  } else if (wasRawModalAcked) {
    // Raw REST modal consumed the initial response, so no reply to edit, followUp()
    // guard blocks. Use webhook.send() directly to send the page picker.
    pageSelectMessage = (await interaction.webhook.send({
      embeds: [pageSelectEmbed],
      components: [actionRow],
      flags: MessageFlags.Ephemeral,
    })) as Message;
  } else {
    await interaction.reply({
      embeds: [pageSelectEmbed],
      components: [actionRow],
      flags: MessageFlags.Ephemeral,
    });
    pageSelectMessage = await interaction.fetchReply();
  }

  try {
    // Wait for page button interaction
    const pageButtonInteraction = await pageSelectMessage.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("page_"),
      time: 300_000, // 5 minutes timeout
    });

    const selectedPage = Number.parseInt(pageButtonInteraction.customId.replace("page_", ""), 10);

    const startIndex = (selectedPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, optionCount);

    const paginatedModalOptions = sliceModalOptions(options, selectComponent, startIndex, endIndex);

    // Show modal with selected page items
    return promptWithRawModal(pageButtonInteraction as ButtonInteraction, locale, paginatedModalOptions);
  } catch (error) {
    log.warn(`Page selection timed out or failed for user ${interaction.user.id}:`, error);
    return { outcome: "timeout" };
  }
}

/**
 * Components V2 range-selector implementation of the `>25`-option paginated modal.
 * Renders the shared {@link buildRangeSelectorPayload} shell (identical to the persona
 * workflow's `>25` selector) and drives its own await loop.
 *
 * Delivery is path-specific by design (see the plan's "Delivery must stay path-specific"):
 * this branch preserves the global path's three situations: `reply` when unacknowledged,
 * `editReply` when deferred/replied, and `webhook.send` after a raw modal; rather than
 * routing through the persona anchor-message controller.
 *
 * @param selectComponent - The paginatable select (already guaranteed non-null by the caller).
 * @param optionCount - Total option count across all ranges.
 * @param wasRawModalAcked - Whether a raw REST modal already consumed the initial response.
 *   `cancelled` when the user clicks the selector's Cancel button.
 */
async function runComponentsV2RangeSelectorModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  options: ModalOptions,
  selectComponent: ModalComponent,
  optionCount: number,
  wasRawModalAcked: boolean,
): Promise<ModalResult> {
  // Per-session prefix so concurrent selectors never collide on custom ids.
  const prefix = `paginated_modal_${interaction.id}_${Date.now().toString(36)}`;
  const totalRangePages = Math.ceil(Math.ceil(optionCount / MODAL_OPTIONS_PER_PAGE) / RANGES_PER_SELECTOR_PAGE);
  let rangePage = 0;

  // Render the initial selector via the path-specific transport, always resolving
  //    to a Message so awaitMessageComponent works on ephemeral replies. The reply now
  //    carries IsComponentsV2, so mark the interaction so a later legacy embed sink renders
  //    a V2 notice instead of throwing (Phase 1 collision guard).
  const payload = buildRangeSelectorPayload(locale, prefix, optionCount, rangePage);
  let selectorMessage: Message;
  try {
    if (interaction.deferred || interaction.replied) {
      selectorMessage = await interaction.editReply({
        components: payload.components,
        flags: MessageFlags.IsComponentsV2,
      });
    } else if (wasRawModalAcked) {
      selectorMessage = (await interaction.webhook.send({
        components: payload.components,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      })) as Message;
    } else {
      await interaction.reply({
        components: payload.components,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      selectorMessage = await interaction.fetchReply();
    }
    markComponentsV2Reply(interaction);
  } catch (error) {
    log.error("Failed to render Components V2 range selector:", error);
    return { outcome: "error", error };
  }

  // Await loop: paginate ranges (Previous/Next), cancel, or pick a range → open modal.
  while (true) {
    let button: ButtonInteraction;
    try {
      button = (await selectorMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (candidate) => candidate.user.id === interaction.user.id && candidate.customId.startsWith(prefix),
        time: 300_000, // 5 minutes, matching the legacy page selector
      })) as ButtonInteraction;
    } catch (error) {
      log.warn(`Range selection timed out or failed for user ${interaction.user.id}:`, error);
      return { outcome: "timeout" };
    }

    // Cancel: acknowledge with a cancelled notice and report the cancellation.
    if (button.customId === `${prefix}_cancel`) {
      try {
        await button.update({
          components: buildNoticeContainer({
            locale,
            color: ColorCode.WARN,
            titleKey: "general.interaction.cancel_title",
            descriptionKey: "general.pagination.cancelled",
          }),
          flags: MessageFlags.IsComponentsV2,
        });
      } catch (error) {
        log.warn("Failed to render range-selector cancellation notice:", error);
      }
      return { outcome: "cancelled" };
    }

    // Previous / Next: re-render the selector page in place via the button update.
    if (button.customId === `${prefix}_previous` || button.customId === `${prefix}_next`) {
      rangePage =
        button.customId === `${prefix}_previous`
          ? Math.max(0, rangePage - 1)
          : Math.min(totalRangePages - 1, rangePage + 1);
      try {
        await button.update(buildRangeSelectorPayload(locale, prefix, optionCount, rangePage));
      } catch (error) {
        log.warn("Failed to paginate the range selector:", error);
        return { outcome: "error", error };
      }
      continue;
    }

    // Range button: slice options to the chosen 25 and open the modal on this button.
    const rangeIndex = parseModalRangeIndex(button.customId, prefix);
    if (rangeIndex === null) {
      log.warn(`Unrecognized range-selector custom id: ${button.customId}`);
      return { outcome: "error", error: new Error("Invalid range selector custom id") };
    }
    const startIndex = rangeIndex * MODAL_OPTIONS_PER_PAGE;
    const endIndex = Math.min(startIndex + MODAL_OPTIONS_PER_PAGE, optionCount);
    const rangedOptions = sliceModalOptions(options, selectComponent, startIndex, endIndex);
    return promptWithRawModal(button, locale, rangedOptions);
  }
}

// Custom ID suffixes for status pagination buttons (scoped per interaction ID)
const STATUS_PREV_SUFFIX = "_status_prev";
const STATUS_NEXT_SUFFIX = "_status_next";
const STATUS_LABEL_SUFFIX = "_status_label";

/**
 * Displays an array of summary embed pages with previous/next navigation buttons.
 * Used by the `/status` command to show paginated scoped status data.
 * If only one page is provided, shows it directly with no buttons.
 * On pagination timeout, removes buttons but preserves the last viewed embed.
 * @param pages - Ordered array of SummaryEmbedOptions pages to display
 * @param flags - Message flags (defaults to Ephemeral)
 */
export async function replyPaginatedStatusPages(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  locale: string,
  pages: SummaryEmbedOptions[],
  flags:
    | MessageFlags.SuppressEmbeds
    | MessageFlags.Ephemeral
    | MessageFlags.SuppressNotifications
    | undefined = MessageFlags.Ephemeral,
): Promise<void> {
  if (pages.length === 0) return;

  // Single page: skip navigation buttons entirely
  if (pages.length === 1) {
    await replySummaryEmbed(interaction, locale, pages[0], flags);
    return;
  }

  // Components V2 collision guard. Legacy nav buttons + embeds cannot render onto a
  //      V2 message. This co-occurrence (multi-page status after a V2 selector) is not
  //      expected in practice, so degrade to the first page rendered as a V2 notice via
  //      the guarded replySummaryEmbed rather than throw.
  if (hasComponentsV2Reply(interaction)) {
    log.warn("Paginated status pages targeting a Components V2 reply; degrading to first page only.");
    await replySummaryEmbed(interaction, locale, pages[0], flags);
    return;
  }

  let currentPage = 0;
  const totalPages = pages.length;

  // Scope button IDs to this interaction to avoid cross-user conflicts
  const prevId = `${interaction.id}${STATUS_PREV_SUFFIX}`;
  const nextId = `${interaction.id}${STATUS_NEXT_SUFFIX}`;
  const labelId = `${interaction.id}${STATUS_LABEL_SUFFIX}`;

  /** Builds the navigation button row for the given page index */
  function buildNavRow(page: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel(`◀ ${localizer(locale, "general.pagination.previous")}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(labelId)
        .setLabel(
          localizer(locale, "general.pagination.page_info", {
            current: page + 1,
            total: totalPages,
          }),
        )
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel(`${localizer(locale, "general.pagination.next")} ▶`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages - 1),
    );
  }

  const embed = createSummaryEmbed(locale, pages[currentPage]);
  const navRow = buildNavRow(currentPage);

  let message: Message;
  if (interaction.deferred || interaction.replied) {
    message = await interaction.editReply({
      embeds: [embed],
      components: [navRow],
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [navRow],
      flags,
    });
    message = await interaction.fetchReply();
  }

  // Pagination loop: keep collecting button presses until timeout
  try {
    while (true) {
      const buttonInteraction = await message.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id && (i.customId === prevId || i.customId === nextId),
        componentType: ComponentType.Button,
        time: PAGINATION_TIMEOUT_MS,
      });

      // Advance or retreat page index based on which button was pressed
      if (buttonInteraction.customId === prevId) {
        currentPage = Math.max(0, currentPage - 1);
      } else {
        currentPage = Math.min(totalPages - 1, currentPage + 1);
      }

      const newEmbed = createSummaryEmbed(locale, pages[currentPage]);
      const newNavRow = buildNavRow(currentPage);
      await buttonInteraction.update({
        embeds: [newEmbed],
        components: [newNavRow],
      });
    }
  } catch (error) {
    log.warn("Status pagination collector ended", {
      errorType: "PaginationCollectorEnded",
      metadata: { userId: interaction.user.id, error },
    });
    // Timeout: strip buttons from the last viewed page to keep it clean
    try {
      const timeoutEmbed = createSummaryEmbed(locale, pages[currentPage]);
      await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
    } catch (editError) {
      log.warn("Failed to clear status pagination buttons after collector ended", {
        errorType: "InteractionEditFailed",
        metadata: { userId: interaction.user.id, error: editError },
      });
    }
  }
}
