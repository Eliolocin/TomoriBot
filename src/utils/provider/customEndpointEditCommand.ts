/**
 * Phase 4.5 edit flow: endpoint-select modal → summary + Edit button → capability detail modal.
 *
 * Discord's interaction rules:
 *   - Slash command    → showModal (endpoint select) ✓
 *   - ModalSubmit      → reply/defer (NOT showModal) ✓ so we reply with a button
 *   - ButtonInteraction → showModal (capability fields, pre-filled) ✓
 *   - ModalSubmit      → deferUpdate → register → editReply ✓
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from "discord.js";
import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import type { CustomEndpointCapability, CustomEndpointRow, AssembledServerConfig } from "@/types/db/schema";
import type { ModalComponent } from "@/types/discord/modal";
import type { SelectOption } from "@/types/discord/modal";
import { promptWithPaginatedModal, promptWithRawModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { validateRemoteUrl } from "@/utils/security/remoteUrlSecurity";
import {
  buildCapabilityEditModalComponents,
  parseCapabilityModalFields,
  WORKFLOW_UPLOAD_ID,
} from "@/utils/provider/customEndpointCapabilityModal";
import { registerCustomEndpoint, validateCustomEndpointReachability } from "@/utils/provider/customEndpointService";
import {
  buildImageEndpointSupportsComponent,
  IMAGE_ENDPOINT_SUPPORTS_ID,
  imageEndpointSupportsFromSubmittedValues,
  readImageEndpointSupports,
} from "@/utils/provider/customImageEndpointSupport";
import { IMPORT_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { localizer } from "@/utils/text/localizer";

const SELECT_MODAL_CUSTOM_ID = "custom_endpoint_edit_select_modal";
const ENDPOINT_SELECT_ID = "endpoint_select";
const EDIT_BUTTON_ID = "edit_fields";
const CANCEL_BUTTON_ID = "cancel_edit";

type RegistrationScope =
  | { kind: "server"; ownerId: number; baseConfig: AssembledServerConfig }
  | { kind: "personal"; ownerId: number; baseConfig: AssembledServerConfig };

export interface ExecuteCustomEndpointEditOptions {
  interaction: ChatInputCommandInteraction;
  locale: string;
  scope: RegistrationScope;
  keys: {
    noneTitle: string;
    noneDescription: string;
    selectModalTitle: string;
    selectLabel: string;
    selectDescription: string;
    selectPlaceholder: string;
    successTitle: string;
    successDescription: string;
    validationUnreachable: string;
    capabilityText: string;
    capabilityEmbedding: string;
    capabilityImage: string;
    capabilityVideo: string;
    capabilitySpeech: string;
    capabilityTranscription: string;
  };
  strictRemoteValidation: boolean;
  loadEndpoints: (ownerId: number) => Promise<CustomEndpointRow[]>;
  onSuccess?: () => void | Promise<void>;
}

function getCapabilityLabel(
  locale: string,
  keys: ExecuteCustomEndpointEditOptions["keys"],
  capability: CustomEndpointCapability,
): string {
  switch (capability) {
    case "text":
      return localizer(locale, keys.capabilityText);
    case "embedding":
      return localizer(locale, keys.capabilityEmbedding);
    case "image":
      return localizer(locale, keys.capabilityImage);
    case "video":
      return localizer(locale, keys.capabilityVideo);
    case "speech":
    case "transcription":
      return capability;
  }
}

function getEndpointSelectionValue(endpoint: CustomEndpointRow): string {
  return endpoint.custom_endpoint_id?.toString() ?? `${endpoint.capability}:${endpoint.label}`;
}

function buildEndpointSelectOptions(
  endpoints: CustomEndpointRow[],
  locale: string,
  keys: ExecuteCustomEndpointEditOptions["keys"],
): SelectOption[] {
  // First pass: count how many times each base label appears.
  //    Two workflows under the same label with identical names would otherwise
  //    produce duplicate option labels, so Discord silently drops the second one.
  const labelCounts = new Map<string, number>();
  for (const endpoint of endpoints) {
    const primaryName = endpoint.model_name?.trim() || endpoint.label;
    const base = endpoint.model_name?.trim() ? `${primaryName} (${endpoint.label})` : endpoint.label;
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }

  const labelIndex = new Map<string, number>();
  return endpoints.map((endpoint) => {
    const primaryName = endpoint.model_name?.trim() || endpoint.label;
    const capability = getCapabilityLabel(locale, keys, endpoint.capability);
    const base = endpoint.model_name?.trim() ? `${primaryName} (${endpoint.label})` : endpoint.label;
    const description = `${primaryName} (${capability})`;

    let label = base;
    if ((labelCounts.get(base) ?? 0) > 1) {
      const idx = (labelIndex.get(base) ?? 0) + 1;
      labelIndex.set(base, idx);
      label = `${base} #${idx}`;
    }

    return {
      label: safeSelectOptionText(label),
      value: getEndpointSelectionValue(endpoint),
      description: safeSelectOptionText(description),
    };
  });
}

async function loadWorkflowJson(url: string | null): Promise<Record<string, unknown> | null> {
  if (!url) {
    return null;
  }

  const downloadResult = await safeDownload(url, {
    maxSizeMB: IMPORT_LIMITS.MAX_DATA_IMPORT_SIZE_MB,
    timeoutMs: 10_000,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    throw new Error(`Workflow download failed: ${downloadResult.details ?? downloadResult.error ?? "unknown error"}`);
  }

  return JSON.parse(downloadResult.buffer.toString("utf8")) as Record<string, unknown>;
}

function isComfyUiMediaEndpoint(endpoint: CustomEndpointRow): boolean {
  return (endpoint.capability === "image" || endpoint.capability === "video") && endpoint.api_style === "comfyui";
}

/** Build a concise embed summarising the selected endpoint's current configuration. */
function buildEndpointSummaryEmbed(locale: string, endpoint: CustomEndpointRow): EmbedBuilder {
  const extra = endpoint.extra_config as Record<string, unknown>;
  const lines: string[] = [
    `**${localizer(locale, "commands.config.custom_models.capability_modal.endpoint_url_label")}:** \`${endpoint.endpoint_url}\``,
    `**${localizer(locale, "commands.config.custom_models.edit.summary_capability")}:** ${endpoint.capability}`,
    `**${localizer(locale, "commands.config.custom_models.edit.summary_api_style")}:** ${endpoint.api_style}`,
  ];

  if (endpoint.model_name) {
    lines.push(
      `**${localizer(locale, "commands.config.custom_models.capability_modal.model_name_label")}:** \`${endpoint.model_name}\``,
    );
  }

  if (endpoint.capability === "text" || endpoint.capability === "embedding") {
    const caps: string[] = [];
    if (endpoint.has_tools) caps.push("tools");
    if (endpoint.sees_images) caps.push("vision");
    if (endpoint.supports_structoutput) caps.push("structoutput");
    if (endpoint.strict_role_alternation) caps.push("rolealt");
    if (endpoint.supports_prefix_completion) caps.push("prefixcompletion");
    if (caps.length > 0) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.text_capabilities_label")}:** ${caps.join(", ")}`,
      );
    }
    if (endpoint.num_ctx) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.num_ctx_label")}:** ${endpoint.num_ctx}`,
      );
    }
  }

  if (endpoint.capability === "speech") {
    const scriptMarkup = extra.script_markup as string | undefined;
    const voiceMode = extra.voice_mode as string | undefined;
    const supportsInstruct = extra.supports_instruct as boolean | undefined;
    if (voiceMode) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_label")}:** ${voiceMode}`,
      );
    }
    if (scriptMarkup) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.script_markup_label")}:** ${scriptMarkup}`,
      );
    }
    if (supportsInstruct != null) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.supports_instruct_label")}:** ${supportsInstruct ? "yes" : "no"}`,
      );
    }
  }

  if (endpoint.capability === "transcription") {
    const model = extra.model as string | undefined;
    const language = extra.language as string | null | undefined;
    if (model) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.transcription_model_label")}:** \`${model}\``,
      );
    }
    if (language) {
      lines.push(
        `**${localizer(locale, "commands.config.custom_models.capability_modal.transcription_language_label")}:** ${language}`,
      );
    }
  }

  if (endpoint.capability === "image") {
    const supports = readImageEndpointSupports(endpoint);
    const enabled = [
      supports.txt2img
        ? localizer(locale, "commands.config.custom_models.capability_modal.workflow_support_txt2img")
        : null,
      supports.img2img
        ? localizer(locale, "commands.config.custom_models.capability_modal.workflow_support_img2img")
        : null,
      supports.inpaint
        ? localizer(locale, "commands.config.custom_models.capability_modal.workflow_support_inpaint")
        : null,
      supports.negative_prompt
        ? localizer(locale, "commands.config.custom_models.capability_modal.workflow_support_negative_prompt")
        : null,
    ].filter((item): item is string => !!item);
    lines.push(
      `**${localizer(locale, "commands.config.custom_models.capability_modal.workflow_supports_label")}:** ${enabled.join(", ")}`,
    );
  }

  return new EmbedBuilder()
    .setColor(ColorCode.INFO)
    .setTitle(localizer(locale, "commands.config.custom_models.edit.summary_title").replace("{label}", endpoint.label))
    .setDescription(lines.join("\n"));
}

export async function executeCustomEndpointEditCommand(options: ExecuteCustomEndpointEditOptions): Promise<void> {
  const { interaction, locale, scope, keys, strictRemoteValidation, loadEndpoints, onSuccess } = options;
  const registeredEndpoints = await loadEndpoints(scope.ownerId);

  if (registeredEndpoints.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: keys.noneTitle,
      descriptionKey: keys.noneDescription,
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Step 1: show endpoint selection modal (slash command → showModal is Discord-allowed).
  const selectModalResult = await promptWithPaginatedModal(interaction, locale, {
    modalCustomId: `${SELECT_MODAL_CUSTOM_ID}_${scope.kind}_${interaction.id}`,
    modalTitleKey: keys.selectModalTitle,
    components: [
      {
        customId: ENDPOINT_SELECT_ID,
        labelKey: keys.selectLabel,
        descriptionKey: keys.selectDescription,
        placeholder: keys.selectPlaceholder,
        required: true,
        options: buildEndpointSelectOptions(registeredEndpoints, locale, keys),
      },
    ],
  });

  if (selectModalResult.outcome !== "submit" || !selectModalResult.interaction) {
    return;
  }

  const selectInteraction = selectModalResult.interaction as ModalSubmitInteraction;
  const selectedValue = selectModalResult.values?.[ENDPOINT_SELECT_ID];
  const existingEndpoint = registeredEndpoints.find((e) => getEndpointSelectionValue(e) === selectedValue);

  if (!selectedValue || !existingEndpoint) {
    await replyInfoEmbed(selectInteraction, locale, {
      titleKey: "general.errors.invalid_option_title",
      descriptionKey: "general.errors.invalid_option_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  // Step 2: reply with an endpoint summary embed + "Edit Fields" button.
  // (Modal submit → showModal is forbidden; we must use reply → button → showModal.)
  const summaryEmbed = buildEndpointSummaryEmbed(locale, existingEndpoint);
  const editButton = new ButtonBuilder()
    .setCustomId(EDIT_BUTTON_ID)
    .setLabel(localizer(locale, "commands.config.custom_models.edit.edit_fields_button"))
    .setStyle(ButtonStyle.Primary);
  const cancelButton = new ButtonBuilder()
    .setCustomId(CANCEL_BUTTON_ID)
    .setLabel(localizer(locale, "general.pagination.cancel"))
    .setStyle(ButtonStyle.Secondary);

  await selectInteraction.reply({
    embeds: [summaryEmbed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(editButton, cancelButton)],
    flags: MessageFlags.Ephemeral,
  });

  const summaryMessage = await selectInteraction.fetchReply();

  // Step 3: wait for the Edit Fields button click.
  let buttonInteraction: ButtonInteraction;
  try {
    buttonInteraction = await summaryMessage.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => i.user.id === interaction.user.id,
      time: 300_000,
    });
  } catch {
    await selectInteraction.editReply({ components: [] });
    return;
  }

  if (buttonInteraction.customId === CANCEL_BUTTON_ID) {
    await buttonInteraction.update({ components: [] });
    return;
  }

  // Step 4: from the button click, show the capability-specific edit modal (pre-filled).
  const extra = existingEndpoint.extra_config as Record<string, unknown>;
  const editModalCustomId = `custom_endpoint_edit_fields_${interaction.id}`;
  const editModalComponents: ModalComponent[] = buildCapabilityEditModalComponents(
    existingEndpoint.capability,
    locale,
    {
      modelName: existingEndpoint.model_name,
      endpointUrl: existingEndpoint.endpoint_url,
      numCtx: existingEndpoint.num_ctx,
      hasTools: existingEndpoint.has_tools,
      seesImages: existingEndpoint.sees_images,
      supportsStructOutput: existingEndpoint.supports_structoutput,
      strictRoleAlternation: existingEndpoint.strict_role_alternation,
      supportsPrefixCompletion: existingEndpoint.supports_prefix_completion,
      voiceMode: extra.voice_mode as string | null,
      scriptMarkup: extra.script_markup as string | null,
      supportsInstruct: extra.supports_instruct as boolean | undefined,
      transcriptionModel: extra.model as string | null,
      transcriptionLanguage: extra.language as string | null,
    },
    isComfyUiMediaEndpoint(existingEndpoint),
  );
  if (existingEndpoint.capability === "image") {
    editModalComponents.push(
      buildImageEndpointSupportsComponent(
        locale,
        existingEndpoint.api_style,
        readImageEndpointSupports(existingEndpoint),
      ),
    );
  }

  // Collapse-at-open: replace the summary's now-dead controls before the modal goes up.
  // Discord emits no modal-dismiss event, so without this the Edit Fields/Cancel buttons stay
  // clickable (and fail) for the modal's full 10-minute lifetime, because the single-shot
  // collector above has already resolved. The summary message belongs to `selectInteraction`
  // while the modal opens from `buttonInteraction`, so editing here does not acknowledge the
  // button and the modal still opens normally. Doing it *before* the modal leaves no window
  // in which the stale buttons are clickable.
  await selectInteraction
    .editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "general.interaction.selector_opened_title"))
          .setDescription(localizer(locale, "general.interaction.selector_opened_description"))
          .setColor(ColorCode.INFO),
      ],
      components: [],
    })
    .catch(() => undefined);

  const editModalResult = await promptWithRawModal(buttonInteraction, locale, {
    modalCustomId: editModalCustomId,
    modalTitleKey: `commands.config.custom_models.capability_modal.${existingEndpoint.capability}_edit_title`,
    components: editModalComponents,
  });

  if (editModalResult.outcome !== "submit") {
    await selectInteraction.editReply({ components: [] });
    return;
  }

  // Step 5: defer the modal submit before async work.
  // biome-ignore lint/style/noNonNullAssertion: submit outcome guarantees interaction exists
  await editModalResult.interaction!.deferUpdate();

  try {
    const parsed = parseCapabilityModalFields(
      editModalResult.values ?? {},
      editModalResult.multiValues ?? {},
      existingEndpoint.capability,
    );

    const endpointUrl = parsed.endpointUrl || existingEndpoint.endpoint_url;
    const modelName =
      parsed.modelName !== null
        ? parsed.modelName || existingEndpoint.model_name || null
        : (existingEndpoint.model_name ?? null);
    const displayName = modelName || existingEndpoint.label;
    const numCtx = parsed.numCtx ?? existingEndpoint.num_ctx ?? null;
    // Checkbox group always returns definitive state (pre-filled with existing); use directly.
    const hasTools = parsed.hasTools;
    const seesImages = parsed.seesImages;
    const supportsStructOutput = parsed.supportsStructOutput;
    const strictRoleAlternation = parsed.strictRoleAlternation;
    const supportsPrefixCompletion = parsed.supportsPrefixCompletion;
    const authTokenProvided = Boolean(parsed.authToken);
    const authToken = authTokenProvided ? parsed.authToken : undefined;

    let extraConfig = { ...(existingEndpoint.extra_config as Record<string, unknown>) };
    if (existingEndpoint.capability === "speech") {
      extraConfig = {
        ...extraConfig,
        voice_mode: parsed.voiceMode,
        script_markup: parsed.scriptMarkup,
        supports_instruct: parsed.supportsInstruct,
      };
    } else if (existingEndpoint.capability === "transcription") {
      extraConfig = {
        ...extraConfig,
        model: parsed.transcriptionModel || (extra.model as string | null) || "whisper-1",
        language: parsed.transcriptionLanguage ?? (extra.language as string | null) ?? null,
      };
    } else if (existingEndpoint.capability === "image") {
      extraConfig = {
        ...extraConfig,
        workflow_supports: imageEndpointSupportsFromSubmittedValues(
          editModalResult.multiValues?.[IMAGE_ENDPOINT_SUPPORTS_ID],
          existingEndpoint.api_style,
        ),
      };
    }

    if (endpointUrl !== existingEndpoint.endpoint_url) {
      const urlValidation = strictRemoteValidation
        ? await validateRemoteUrl(endpointUrl, { strict: true })
        : await validateRemoteUrl(endpointUrl);
      if (!urlValidation.valid) {
        await selectInteraction.editReply({
          embeds: [],
          components: [],
          content: localizer(locale, "commands.config.custom_models.validation.unreachable").replace(
            "{reason}",
            urlValidation.failureCode ?? "invalid_url",
          ),
        });
        return;
      }

      const reachability = await validateCustomEndpointReachability({
        apiStyle: existingEndpoint.api_style,
        endpointUrl,
        apiKey: authToken ?? null,
        strict: strictRemoteValidation,
      });
      if (!reachability.ok) {
        await selectInteraction.editReply({
          embeds: [],
          components: [],
          content: localizer(locale, "commands.config.custom_models.validation.unreachable").replace(
            "{reason}",
            reachability.reason,
          ),
        });
        return;
      }
    }

    if (isComfyUiMediaEndpoint(existingEndpoint)) {
      const workflowAttachment = editModalResult.attachments?.[WORKFLOW_UPLOAD_ID];
      if (workflowAttachment) {
        const workflow = await loadWorkflowJson(workflowAttachment.url);
        extraConfig = { ...extraConfig, workflow };
      } else if (!extraConfig.workflow) {
        await selectInteraction.editReply({
          embeds: [],
          components: [],
          content: localizer(locale, "commands.config.custom_models.validation.workflow_required"),
        });
        return;
      }
    }

    const registered = await registerCustomEndpoint({
      scope,
      label: existingEndpoint.label,
      capability: existingEndpoint.capability,
      apiStyle: existingEndpoint.api_style,
      endpointUrl,
      modelName,
      authToken,
      numCtx,
      hasTools,
      seesImages,
      seesVideos: existingEndpoint.sees_videos,
      supportsStructOutput,
      strictRoleAlternation,
      supportsPrefixCompletion,
      extraConfig,
      // Edit the exact selected row in place (update its model + row by id) so a renamed model_name
      // does not collide with (or orphan) sibling models under the same label+capability.
      editingEndpointId: existingEndpoint.custom_endpoint_id,
    });

    if (!registered) {
      await selectInteraction.editReply({
        embeds: [],
        components: [],
        content: localizer(locale, "general.errors.update_failed_description"),
      });
      return;
    }

    await onSuccess?.();

    await selectInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(ColorCode.SUCCESS)
          .setTitle(localizer(locale, keys.successTitle))
          .setDescription(
            localizer(locale, keys.successDescription)
              .replace("{display_name}", displayName)
              .replace("{label}", existingEndpoint.label)
              .replace("{capability}", existingEndpoint.capability),
          ),
      ],
      components: [],
    });
  } catch (error) {
    log.error("Error in executeCustomEndpointEditCommand (fields modal)", error);
    await selectInteraction.editReply({
      embeds: [],
      components: [],
      content: localizer(locale, "general.errors.unknown_error_description"),
    });
  }
}
