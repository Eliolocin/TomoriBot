import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import type { ThinkingLevelValue } from "@/constants/thinkingLevels";
import type { PanelReceipt, PanelReceiptTone } from "@/types/discord/panel";
import type { TomoriState } from "@/types/db/schema";
import {
  CONFIG_LOGIT_BIAS_PAGE_SIZE,
  CONFIG_MODEL_CLEAR_VALUE,
  CONFIG_STOP_STRING_CAPACITY,
  CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE,
  CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE,
  CONFIG_FALLBACK_SLOT_COUNT,
  computeLogitBiasFingerprint,
  computeStopStringFingerprint,
  CONFIG_MODEL_PAGE_SIZE,
  type ConfigModelCapability,
  type ConfigPage,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import {
  decodeConfigProviderPageValue,
  decodeConfigProviderRangeValue,
} from "@/utils/discord/interactions/configModelLoaders";
import {
  currentModelIdForCapability,
  type ConfigParameterPatch,
} from "@/utils/discord/interactions/configModelOperations";
import {
  isConfigRouteAuthorized,
  MODELS_PAGE_BY_ROUTE,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import {
  repaint,
  staleReceipt,
  type ConfigRepaintOptions,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { performPanelAction } from "@/utils/discord/interactions/panelController";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import {
  buildConfigFallbackModal,
  buildConfigFallbackSlotId,
  buildConfigGenerationModal,
  buildConfigImageTagsModal,
  buildConfigLogitBiasAddModal,
  buildConfigLogitBiasGroupId,
  buildConfigLogitBiasManageModal,
  buildConfigLogitBiasUploadModal,
  buildConfigNaiParametersModal,
  buildConfigSamplingModal,
  buildConfigStopStringAddModal,
  buildConfigStopStringGroupId,
  buildConfigStopStringManageModal,
  CONFIG_IMAGE_TAGS_FIELD,
  CONFIG_LOGIT_FILE_FIELD,
  CONFIG_LOGIT_TERMS_FIELD,
  CONFIG_LOGIT_VALUE_FIELD,
  CONFIG_NAI_NOISE_FIELD,
  CONFIG_NAI_RESCALE_FIELD,
  CONFIG_NAI_SAMPLER_FIELD,
  CONFIG_NAI_SCALE_FIELD,
  CONFIG_NAI_STEPS_FIELD,
  CONFIG_MODEL_SELECT_FIELD,
  CONFIG_STOP_SPEAKER_PATTERN_FIELD,
  buildConfigModelSelectModal,
} from "@/utils/discord/ui/configModelModals";
import { NAI_IMAGE_NOISE_SCHEDULES, NAI_IMAGE_SAMPLERS } from "@/utils/image/naiImageParams";
import { safeDownload } from "@/utils/security/safeDownload";
import { log } from "@/utils/misc/logger";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";

/** Routes that answer with a modal, which is its own acknowledgement and must not be deferred. */
export const CONFIG_MODEL_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "sampling-open",
  "generation-open",
  "stop-add-open",
  "stop-manage-open",
  "logit-add-open",
  "logit-upload-open",
  "logit-manage-open",
  "logit-manage-select",
  "fallback-provider-select",
  "model-provider-select",
  "image-tags-default-open",
  "nai-parameters-open",
]);

export const CONFIG_MODEL_SELECT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "model-provider-select",
  "parameters-provider-select",
  "fallback-provider-select",
  "logit-manage-select",
]);

export const CONFIG_MODEL_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "sampling-submit",
  "generation-submit",
  "stop-add-submit",
  "stop-manage-submit",
  "logit-add-submit",
  "logit-upload-submit",
  "logit-manage-submit",
  "fallback-submit",
  "model-modal-submit",
  "image-tags-default-submit",
  "nai-parameters-submit",
]);

const MAX_LOGIT_BIAS_UPLOAD_MB = 2;
const LOGIT_BIAS_DOWNLOAD_TIMEOUT_MS = 15000;

function receipt(
  locale: string,
  tone: PanelReceiptTone,
  headingKey: string,
  detailKey: string,
  vars: Record<string, string | number> = {},
): PanelReceipt {
  return { tone, heading: localizer(locale, headingKey), detail: localizer(locale, detailKey, vars) };
}

function writeFailedReceipt(locale: string): PanelReceipt {
  return receipt(
    locale,
    "error",
    "commands.config.panel.write_failed_heading",
    "commands.config.panel.write_failed_detail",
  );
}

function noChangesReceipt(locale: string, detailKey: string): PanelReceipt {
  return receipt(locale, "info", "commands.config.panel.no_changes_heading", detailKey);
}

/**
 * Server model state lives on the assembled workspace config that every persona row carries, so any
 * persona is an equally authoritative source for it.
 */
function serverStateFromScope(scope: ConfigScope): TomoriState | null {
  return scope.personas[0] ?? null;
}

function readSelectValue(context: ConfigModelRouteContext, fieldId: string): string | undefined {
  const modal = context.interaction as ModalSubmitInteraction;
  return context.dependencies.takeSelectValue(modal.id, fieldId);
}

function readOptionalNumber(modal: ModalSubmitInteraction, fieldId: string): number | null | undefined {
  if (!modal.fields.fields.has(fieldId)) return undefined;
  const raw = modal.fields.getTextInputValue(fieldId).trim();
  return raw ? Number(raw) : null;
}

export interface ConfigModelRouteContext {
  interaction: GlobalRoutableInteraction;
  route: ConfigPanelRoute;
  scope: ConfigScope;
  dependencies: ConfigRouteDependencies;
  selectedValue: string | null;
}

function baseRepaint(
  context: ConfigModelRouteContext,
  page: ConfigPage,
  extra: Partial<ConfigRepaintOptions> = {},
): Promise<void> {
  return repaint(context.interaction, {
    locale: context.route.locale,
    scope: context.scope,
    category: "models",
    page,
    selectedPersonaId: null,
    dependencies: context.dependencies,
    ...extra,
  });
}

/**
 * Modal-open half of the Models surface.
 *
 * Runs before the panel controller defers, because a modal is its own acknowledgement: deferring
 * first would consume the interaction and Discord would reject the modal.
 */
export async function handleConfigModelModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_MODEL_MODAL_OPEN_ACTIONS.has(route.action)) return false;

  // Clearing is a write rather than a modal, and it rides the provider select alongside the entries
  // that do open one. Declining before the gate below routes it through the deferred path, which
  // owns both the acknowledgement a write needs and the denial repaint an unauthorized replay gets.
  if (
    route.action === "model-provider-select" &&
    interaction.isStringSelectMenu() &&
    interaction.values[0] === CONFIG_MODEL_CLEAR_VALUE
  ) {
    return false;
  }

  const locale = route.locale;
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  const state = scope ? serverStateFromScope(scope) : null;
  if (!scope || !state) {
    await interaction.reply({
      content: localizer(locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const nonce = dependencies.createNonce();

  if (route.action === "sampling-open" || route.action === "generation-open") {
    const view = await dependencies.loadParametersView(state, route.provider, 0);
    // The view falls back to the active provider when the requested one is gone, so an exact match
    // is what stops the modal prefilling from a provider the submit would then refuse to write.
    if (view.selectedProvider?.toLowerCase() !== route.provider.toLowerCase()) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(
      interaction,
      route.action === "sampling-open"
        ? buildConfigSamplingModal(locale, route.provider, nonce, view.selectedConfig)
        : buildConfigGenerationModal(locale, route.provider, nonce, view.selectedConfig),
    );
    return true;
  }

  if (route.action === "stop-add-open") {
    await dependencies.showModal(interaction, buildConfigStopStringAddModal(locale, nonce));
    return true;
  }

  if (route.action === "stop-manage-open") {
    const stopStrings = state.config.llm_stop_strings ?? [];
    // Beyond the modal's checkbox capacity a submission could only ever describe a prefix of the
    // list, and unchecked-means-remove would read the remainder as deselected.
    if (stopStrings.length > CONFIG_STOP_STRING_CAPACITY) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.stop_too_many_detail", {
          count: stopStrings.length,
          max_entries: CONFIG_STOP_STRING_CAPACITY,
        }),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await dependencies.showModal(
      interaction,
      buildConfigStopStringManageModal(
        locale,
        nonce,
        computeStopStringFingerprint(state.server_id, stopStrings),
        stopStrings,
        state.config.llm_stop_speaker_pattern_enabled ?? false,
      ),
    );
    return true;
  }

  if (route.action === "image-tags-default-open") {
    await dependencies.showModal(
      interaction,
      buildConfigImageTagsModal(
        locale,
        route.negative,
        nonce,
        route.negative ? state.config.image_default_negative_tags : state.config.image_default_positive_tags,
      ),
    );
    return true;
  }

  if (route.action === "nai-parameters-open") {
    await dependencies.showModal(
      interaction,
      buildConfigNaiParametersModal(locale, nonce, NAI_IMAGE_SAMPLERS, NAI_IMAGE_NOISE_SCHEDULES, {
        sampler: state.config.nai_sampler,
        steps: state.config.nai_steps,
        scale: state.config.nai_scale,
        noiseSchedule: state.config.nai_noise_schedule,
        cfgRescale: state.config.nai_cfg_rescale,
      }),
    );
    return true;
  }

  if (route.action === "logit-add-open") {
    await dependencies.showModal(interaction, buildConfigLogitBiasAddModal(locale, nonce));
    return true;
  }

  if (route.action === "logit-upload-open") {
    await dependencies.showModal(interaction, buildConfigLogitBiasUploadModal(locale, nonce));
    return true;
  }

  if (route.action === "logit-manage-open" || route.action === "logit-manage-select") {
    const requestedStart =
      route.action === "logit-manage-open"
        ? route.start
        : Number.parseInt(interaction.isStringSelectMenu() ? (interaction.values[0] ?? "") : "", 10);
    const entries = state.config.llm_logit_biases ?? [];
    if (entries.length === 0) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.logit_none_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (!Number.isInteger(requestedStart) || requestedStart < 0) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const start = Math.min(requestedStart, Math.max(0, entries.length - 1));
    const pageStart = Math.floor(start / CONFIG_LOGIT_BIAS_PAGE_SIZE) * CONFIG_LOGIT_BIAS_PAGE_SIZE;
    const presented = entries.slice(pageStart, pageStart + CONFIG_LOGIT_BIAS_PAGE_SIZE);
    await dependencies.showModal(
      interaction,
      buildConfigLogitBiasManageModal(
        locale,
        nonce,
        pageStart,
        computeLogitBiasFingerprint(
          state.server_id,
          presented.map((entry) => entry.id),
        ),
        presented,
      ),
    );
    return true;
  }

  if (route.action === "model-provider-select") {
    const selected = interaction.isStringSelectMenu() ? (interaction.values[0] ?? null) : null;

    // The advance entry rides the select too, because six selectors cannot each afford a
    // prev/next row under the forty-component budget.
    const range = selected ? decodeConfigProviderRangeValue(selected) : null;
    if (range) {
      await interaction.deferUpdate();
      await repaint(interaction, {
        locale,
        scope,
        category: "models",
        page: "switch",
        selectedPersonaId: null,
        modelProviderPage: {
          capability: route.capability,
          provider: range.expandedProvider ?? undefined,
          start: range.start,
        },
        dependencies,
      });
      return true;
    }

    const chosenSlice = selected ? decodeConfigProviderPageValue(selected) : null;
    const chosenProvider = chosenSlice?.provider ?? selected;
    const providers = await dependencies.loadModelProviders(state, route.capability);
    const provider = providers.find((candidate) => candidate.toLowerCase() === chosenProvider?.toLowerCase());
    if (!provider) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const models = await dependencies.loadModelChoices(state, route.capability, provider);
    if (models.length === 0) {
      await interaction.reply({
        content: localizer(locale, "commands.model.text.no_models_description", {
          provider: getProviderDisplayName(provider),
        }),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // A slice value is the reader picking part of an already expanded provider, so it opens the
    // modal directly instead of expanding again.
    if (!chosenSlice && models.length > CONFIG_MODEL_PAGE_SIZE) {
      await interaction.deferUpdate();
      await repaint(interaction, {
        locale,
        scope,
        category: "models",
        page: "switch",
        selectedPersonaId: null,
        modelProviderPage: { capability: route.capability, provider, start: 0 },
        // Expanding rewrites options inside a selector the reader has already closed, so without a
        // receipt the selection reads as a no-op and gets repeated.
        receipt: receipt(
          locale,
          "info",
          "commands.config.panel.model_provider_paged_heading",
          "commands.config.panel.model_provider_paged_detail",
          { provider: getProviderDisplayName(provider), count: models.length },
        ),
        dependencies,
      });
      return true;
    }

    const sliceStart = chosenSlice?.start ?? 0;
    if (sliceStart % CONFIG_MODEL_PAGE_SIZE !== 0 || sliceStart >= models.length) {
      await interaction.reply({
        content: localizer(locale, "commands.config.panel.stale_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await dependencies.showModal(
      interaction,
      buildConfigModelSelectModal(
        locale,
        route.capability,
        provider,
        nonce,
        models.slice(sliceStart, sliceStart + CONFIG_MODEL_PAGE_SIZE),
        currentModelIdForCapability(state, route.capability),
      ),
    );
    return true;
  }

  // The fallback provider select opens its modal directly: one option per option-page, so the
  // range is already chosen by the time the five slot selects are built.
  const chosen = interaction.isStringSelectMenu() ? (interaction.values[0] ?? null) : null;
  const decoded = chosen ? decodeConfigProviderPageValue(chosen) : null;
  if (!decoded) {
    await interaction.reply({
      content: localizer(locale, "commands.config.panel.stale_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const options = await dependencies.loadFallbackOptions(state, decoded.provider);
  if (options.length === 0) {
    await interaction.reply({
      content: localizer(locale, "commands.model.fallback.no_models_description"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const refs = state.config.fallback_model_refs ?? [];
  const chain = state.fallback_chain ?? [];
  const noneLabel = localizer(locale, "general.none");
  const slotPlaceholders = Array.from({ length: CONFIG_FALLBACK_SLOT_COUNT }, (_slot, index) => {
    const entry = chain[index];
    if (entry) {
      return entry.kind === "llm"
        ? `${entry.model.llm_codename} (${getProviderDisplayName(entry.model.llm_provider)})`
        : `${entry.endpoint.label}:${entry.endpoint.model_name ?? entry.endpoint.label}`;
    }
    return refs[index] ? `${localizer(locale, "general.unknown")} (#${refs[index].id})` : noneLabel;
  });

  await dependencies.showModal(
    interaction,
    buildConfigFallbackModal(
      locale,
      decoded.provider,
      decoded.start,
      nonce,
      options.slice(decoded.start, decoded.start + 24),
      slotPlaceholders,
    ),
  );
  return true;
}

function recordModelAction(context: ConfigModelRouteContext, action: PanelAction): void {
  if (!context.scope.internalServerId) return;
  context.dependencies.recordAction({
    action,
    serverId: context.scope.internalServerId,
    userDiscId: context.interaction.user.id,
  });
}

async function clearSwitchModel(context: ConfigModelRouteContext, capability: ConfigModelCapability): Promise<boolean> {
  const { dependencies, route } = context;
  const locale = route.locale;
  const state = serverStateFromScope(context.scope);
  if (!state) return false;

  const action = await performPanelAction(
    () =>
      dependencies.modelOperations.clearCapabilityModel({
        tomoriState: state,
        serverDiscId: context.scope.serverDiscId,
        capability,
      }),
    () => dependencies.resolveScope(context.interaction, true),
  );
  context.scope = action.state ?? context.scope;
  const result = action.result;
  if (result.status === "success") recordModelAction(context, "server-config.workspace.model.clear");
  await baseRepaint(context, "switch", {
    receipt:
      result.status === "success"
        ? receipt(
            locale,
            "success",
            "commands.config.panel.model_cleared_heading",
            "commands.config.panel.model_cleared_detail",
          )
        : result.status === "already-clear"
          ? noChangesReceipt(locale, "commands.config.panel.model_already_clear_detail")
          : writeFailedReceipt(locale),
  });
  return true;
}

async function handleSwitchModels(context: ConfigModelRouteContext): Promise<boolean> {
  const { route, dependencies } = context;
  const locale = route.locale;
  const state = serverStateFromScope(context.scope);
  if (!state) return false;

  // The clearable slots fold their clear into the provider select, which the modal-open handler
  // declines so the write lands here with the interaction already deferred.
  if (route.action === "model-provider-select") {
    if (context.selectedValue !== CONFIG_MODEL_CLEAR_VALUE) {
      await baseRepaint(context, "switch", { receipt: staleReceipt(locale) });
      return true;
    }
    return await clearSwitchModel(context, route.capability);
  }

  if (route.action !== "model-modal-submit") return false;

  const capability: ConfigModelCapability = route.capability;
  const modelId = Number(
    dependencies.takeSelectValue(
      context.interaction.id,
      buildConfigModalFieldId(CONFIG_MODEL_SELECT_FIELD, route.nonce),
    ),
  );
  if (!Number.isSafeInteger(modelId)) {
    await baseRepaint(context, "switch", { receipt: staleReceipt(locale) });
    return true;
  }

  const action = await performPanelAction(
    () =>
      dependencies.modelOperations.setCapabilityModel({
        tomoriState: state,
        serverDiscId: context.scope.serverDiscId,
        capability,
        provider: route.provider,
        modelId,
      }),
    () => dependencies.resolveScope(context.interaction, true),
  );
  context.scope = action.state ?? context.scope;
  const result = action.result;

  if (result.status === "success") {
    recordModelAction(context, "server-config.workspace.model.set");
    await baseRepaint(context, "switch", {
      receipt: receipt(
        locale,
        "success",
        "commands.config.panel.model_updated_heading",
        result.reembedded
          ? "commands.config.panel.model_updated_reembedded_detail"
          : "commands.config.panel.model_updated_detail",
        { model: result.modelName, provider: getProviderDisplayName(route.provider) },
      ),
    });
    return true;
  }

  await baseRepaint(context, "switch", {
    receipt:
      result.status === "already-selected"
        ? noChangesReceipt(locale, "commands.config.panel.model_already_selected_detail")
        : result.status === "openrouter-moved"
          ? receipt(
              locale,
              "warning",
              "commands.config.panel.model_moved_heading",
              "commands.config.panel.model_moved_detail",
            )
          : result.status === "no-models"
            ? receipt(
                locale,
                "error",
                "commands.model.text.no_models_title",
                "commands.model.text.no_models_description",
              )
            : result.status === "not-found"
              ? staleReceipt(locale)
              : writeFailedReceipt(locale),
  });
  return true;
}

async function handleParameters(context: ConfigModelRouteContext): Promise<boolean> {
  const { route, dependencies } = context;
  const locale = route.locale;
  const state = serverStateFromScope(context.scope);
  if (!state) return false;

  if (route.action === "parameters-provider-select") {
    await baseRepaint(context, "parameters", { parametersProvider: context.selectedValue ?? undefined });
    return true;
  }

  if (route.action === "sampling-submit" || route.action === "generation-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const patch: ConfigParameterPatch =
      route.action === "sampling-submit"
        ? {
            temperature: readOptionalNumber(modal, buildConfigModalFieldId("temperature", route.nonce)),
            min_p: readOptionalNumber(modal, buildConfigModalFieldId("min_p", route.nonce)),
            top_p: readOptionalNumber(modal, buildConfigModalFieldId("top_p", route.nonce)),
            top_k: readOptionalNumber(modal, buildConfigModalFieldId("top_k", route.nonce)),
          }
        : {
            frequency_penalty: readOptionalNumber(modal, buildConfigModalFieldId("frequency_penalty", route.nonce)),
            presence_penalty: readOptionalNumber(modal, buildConfigModalFieldId("presence_penalty", route.nonce)),
            max_output_tokens: readOptionalNumber(modal, buildConfigModalFieldId("max_output_tokens", route.nonce)),
            thinking_level: (dependencies.takeSelectValue(
              modal.id,
              buildConfigModalFieldId("thinking_level", route.nonce),
            ) ?? null) as ThinkingLevelValue | null,
          };

    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.setProviderParameters({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          provider: route.provider,
          patch,
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.parameters.set");

    await baseRepaint(context, "parameters", {
      parametersProvider: route.provider,
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.parameters_updated_heading",
              "commands.config.panel.parameters_updated_detail",
              { provider: getProviderDisplayName(route.provider) },
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.parameters_no_changes_detail")
            : result.status === "invalid-value"
              ? receipt(
                  locale,
                  "error",
                  "commands.config.panel.invalid_input_heading",
                  "commands.config.panel.parameters_invalid_detail",
                )
              : result.status === "not-found"
                ? staleReceipt(locale)
                : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action === "stop-add-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const rawInput = modal.fields.getTextInputValue(buildConfigModalFieldId("stop_strings", route.nonce));
    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.addStopStrings({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          rawInput,
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.stop-strings.add");

    await baseRepaint(context, "parameters", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.stop_added_heading",
              "commands.config.panel.stop_added_detail",
              { count: result.addedCount, total: result.totalCount },
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.stop_no_changes_detail")
            : result.status === "invalid-input"
              ? receipt(
                  locale,
                  "error",
                  "commands.config.panel.invalid_input_heading",
                  "commands.config.panel.stop_invalid_detail",
                )
              : result.status === "too-long"
                ? receipt(
                    locale,
                    "error",
                    "commands.config.panel.invalid_input_heading",
                    "commands.config.panel.stop_too_long_detail",
                    { max_length: result.maxLength },
                  )
                : result.status === "too-many"
                  ? receipt(
                      locale,
                      "error",
                      "commands.config.panel.invalid_input_heading",
                      "commands.config.panel.stop_limit_detail",
                      { max_count: result.maxCount },
                    )
                  : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action === "stop-manage-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const presented = state.config.llm_stop_strings ?? [];
    if (computeStopStringFingerprint(state.server_id, presented) !== route.fp) {
      await baseRepaint(context, "parameters", { receipt: staleReceipt(locale) });
      return true;
    }

    const keptIndices: number[] = [];
    let sawAnyGroup = false;
    for (let offset = 0; offset < presented.length; offset += CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE) {
      const groupIndex = offset / CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE;
      const values = dependencies.takeCheckboxValues(modal.id, buildConfigStopStringGroupId(groupIndex, route.nonce));
      if (values === undefined) continue;
      sawAnyGroup = true;
      for (const value of values) {
        const index = Number.parseInt(value, 10);
        if (Number.isInteger(index) && index >= 0 && index < presented.length) keptIndices.push(index);
      }
    }
    const speakerValues = dependencies.takeCheckboxValues(
      modal.id,
      buildConfigModalFieldId(CONFIG_STOP_SPEAKER_PATTERN_FIELD, route.nonce),
    );
    // A modal that carried no checkbox payload at all is a stale continuation, not an instruction
    // to remove every presented string.
    if (presented.length > 0 && !sawAnyGroup && speakerValues === undefined) {
      await baseRepaint(context, "parameters", { receipt: staleReceipt(locale) });
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.manageStopStrings({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          presentedStopStrings: presented,
          keptIndices,
          speakerPatternEnabled: (speakerValues ?? []).includes("enabled"),
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.stop-strings.manage");

    await baseRepaint(context, "parameters", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.stop_updated_heading",
              "commands.config.panel.stop_updated_detail",
              { count: result.removedCount },
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.stop_no_changes_detail")
            : result.status === "stale"
              ? staleReceipt(locale)
              : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action === "logit-add-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.addLogitBias({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          rawTerms: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_LOGIT_TERMS_FIELD, route.nonce)),
          rawBias: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_LOGIT_VALUE_FIELD, route.nonce)),
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.logit-bias.add");

    await baseRepaint(context, "parameters", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.logit_added_heading",
              "commands.config.panel.logit_added_detail",
              { added: result.addedCount, updated: result.updatedCount, total: result.totalCount },
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.logit_no_changes_detail")
            : result.status === "empty-terms"
              ? receipt(
                  locale,
                  "error",
                  "commands.config.panel.invalid_input_heading",
                  "commands.config.panel.logit_empty_detail",
                )
              : result.status === "term-too-long"
                ? receipt(
                    locale,
                    "error",
                    "commands.config.panel.invalid_input_heading",
                    "commands.config.panel.logit_term_long_detail",
                  )
                : result.status === "invalid-bias"
                  ? receipt(
                      locale,
                      "error",
                      "commands.config.panel.invalid_input_heading",
                      "commands.config.panel.logit_invalid_bias_detail",
                    )
                  : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action === "logit-upload-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const attachment = dependencies.takeFileUpload(
      modal.id,
      buildConfigModalFieldId(CONFIG_LOGIT_FILE_FIELD, route.nonce),
    );
    if (!attachment) {
      await baseRepaint(context, "parameters", {
        receipt: receipt(
          locale,
          "error",
          "commands.config.panel.invalid_input_heading",
          "commands.config.panel.logit_upload_missing_detail",
        ),
      });
      return true;
    }

    let payload: unknown;
    try {
      const download = await safeDownload(attachment.url, {
        maxSizeMB: MAX_LOGIT_BIAS_UPLOAD_MB,
        timeoutMs: LOGIT_BIAS_DOWNLOAD_TIMEOUT_MS,
        knownSize: attachment.size,
      });
      if (!download.success || !download.buffer) {
        await baseRepaint(context, "parameters", {
          receipt: receipt(
            locale,
            "error",
            "commands.config.panel.invalid_input_heading",
            "commands.config.panel.logit_upload_failed_detail",
          ),
        });
        return true;
      }
      payload = JSON.parse(download.buffer.toString("utf8"));
    } catch (error) {
      await log.error("Failed to read a /config logit-bias upload", error, {
        errorType: "InteractionRouteError",
        metadata: { serverDiscId: context.scope.serverDiscId },
      });
      await baseRepaint(context, "parameters", {
        receipt: receipt(
          locale,
          "error",
          "commands.config.panel.invalid_input_heading",
          "commands.config.panel.logit_upload_invalid_detail",
        ),
      });
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.uploadLogitBias({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          payload,
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.logit-bias.upload");

    await baseRepaint(context, "parameters", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.logit_added_heading",
              "commands.config.panel.logit_added_detail",
              { added: result.addedCount, updated: result.updatedCount, total: result.totalCount },
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.logit_no_changes_detail")
            : result.status === "invalid-file"
              ? receipt(
                  locale,
                  "error",
                  "commands.config.panel.invalid_input_heading",
                  "commands.config.panel.logit_upload_invalid_detail",
                )
              : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action !== "logit-manage-submit") return false;

  const modal = context.interaction as ModalSubmitInteraction;
  const entries = state.config.llm_logit_biases ?? [];
  const presented = entries.slice(route.start, route.start + CONFIG_LOGIT_BIAS_PAGE_SIZE);
  if (
    computeLogitBiasFingerprint(
      state.server_id,
      presented.map((entry) => entry.id),
    ) !== route.fp
  ) {
    await baseRepaint(context, "parameters", { receipt: staleReceipt(locale) });
    return true;
  }

  const keptIds: string[] = [];
  let sawAnyGroup = false;
  for (let offset = 0; offset < presented.length; offset += CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE;
    const values = dependencies.takeCheckboxValues(modal.id, buildConfigLogitBiasGroupId(groupIndex, route.nonce));
    if (values === undefined) continue;
    sawAnyGroup = true;
    keptIds.push(...values);
  }
  // No checkbox payload at all is a stale continuation, not a request to remove the whole page.
  if (!sawAnyGroup) {
    await baseRepaint(context, "parameters", { receipt: staleReceipt(locale) });
    return true;
  }

  const action = await performPanelAction(
    () =>
      dependencies.modelOperations.removeLogitBias({
        tomoriState: state,
        serverDiscId: context.scope.serverDiscId,
        presentedIds: presented.map((entry) => entry.id),
        keptIds,
      }),
    () => dependencies.resolveScope(context.interaction, true),
  );
  context.scope = action.state ?? context.scope;
  const result = action.result;
  if (result.status === "success") recordModelAction(context, "server-config.workspace.logit-bias.remove");

  await baseRepaint(context, "parameters", {
    receipt:
      result.status === "success"
        ? receipt(
            locale,
            "success",
            "commands.config.panel.logit_removed_heading",
            "commands.config.panel.logit_removed_detail",
            { count: result.removedCount },
          )
        : result.status === "no-changes"
          ? noChangesReceipt(locale, "commands.config.panel.logit_no_changes_detail")
          : result.status === "stale"
            ? staleReceipt(locale)
            : writeFailedReceipt(locale),
  });
  return true;
}

async function handleFallbacks(context: ConfigModelRouteContext): Promise<boolean> {
  const { route, dependencies } = context;
  const locale = route.locale;
  const state = serverStateFromScope(context.scope);
  if (!state) return false;

  if (route.action === "fallback-provider-range" || route.action === "fallback-provider-page") {
    await baseRepaint(context, "fallbacks", {
      fallbackExpandedProvider: route.action === "fallback-provider-page" ? route.provider : null,
      fallbackEntryStart: route.start,
    });
    return true;
  }

  if (route.action === "randomizer-set") {
    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.setModelRandomizer({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          enabled: route.enabled,
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.randomizer.set");

    await baseRepaint(context, "fallbacks", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.randomizer_updated_heading",
              result.enabled
                ? "commands.config.panel.randomizer_enabled_detail"
                : "commands.config.panel.randomizer_disabled_detail",
            )
          : result.status === "no-changes"
            ? noChangesReceipt(locale, "commands.config.panel.randomizer_no_changes_detail")
            : result.status === "requires-fallbacks"
              ? receipt(
                  locale,
                  "warning",
                  "commands.config.panel.randomizer_blocked_heading",
                  "commands.config.panel.randomizer_blocked_detail",
                )
              : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action !== "fallback-submit") return false;

  const slotValues = Array.from(
    { length: CONFIG_FALLBACK_SLOT_COUNT },
    (_slot, index) => readSelectValue(context, buildConfigFallbackSlotId(index, route.nonce)) ?? "",
  );

  const action = await performPanelAction(
    () =>
      dependencies.modelOperations.setFallbackChain({
        tomoriState: state,
        serverDiscId: context.scope.serverDiscId,
        provider: route.provider,
        slotValues,
      }),
    () => dependencies.resolveScope(context.interaction, true),
  );
  context.scope = action.state ?? context.scope;
  const result = action.result;
  if (result.status === "success") recordModelAction(context, "server-config.workspace.fallbacks.set");

  await baseRepaint(context, "fallbacks", {
    fallbackExpandedProvider: route.provider,
    receipt:
      result.status === "success"
        ? receipt(
            locale,
            "success",
            "commands.config.panel.fallback_updated_heading",
            result.refs.length === 0
              ? "commands.config.panel.fallback_cleared_detail"
              : "commands.config.panel.fallback_updated_detail",
            { count: result.refs.length },
          )
        : result.status === "no-changes"
          ? noChangesReceipt(locale, "commands.config.panel.fallback_no_changes_detail")
          : result.status === "primary-conflict"
            ? receipt(
                locale,
                "error",
                "commands.config.panel.fallback_conflict_heading",
                "commands.config.panel.fallback_conflict_detail",
                { model: result.primaryModelName },
              )
            : result.status === "openrouter-moved"
              ? receipt(
                  locale,
                  "warning",
                  "commands.config.panel.model_moved_heading",
                  "commands.config.panel.model_moved_detail",
                )
              : result.status === "not-found"
                ? staleReceipt(locale)
                : writeFailedReceipt(locale),
  });
  return true;
}

async function handleImageGeneration(context: ConfigModelRouteContext): Promise<boolean> {
  const { route, dependencies } = context;
  const locale = route.locale;
  const state = serverStateFromScope(context.scope);
  if (!state) return false;

  if (route.action === "image-tags-default-submit") {
    const modal = context.interaction as ModalSubmitInteraction;
    const rawInput = modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_IMAGE_TAGS_FIELD, route.nonce));
    const action = await performPanelAction(
      () =>
        dependencies.modelOperations.setImageDefaultTags({
          tomoriState: state,
          serverDiscId: context.scope.serverDiscId,
          negative: route.negative,
          rawInput,
        }),
      () => dependencies.resolveScope(context.interaction, true),
    );
    context.scope = action.state ?? context.scope;
    const result = action.result;
    if (result.status === "success") recordModelAction(context, "server-config.workspace.image-tags.set");

    await baseRepaint(context, "image", {
      receipt:
        result.status === "success"
          ? receipt(
              locale,
              "success",
              "commands.config.panel.image_tags_updated_heading",
              result.reset
                ? "commands.config.panel.image_tags_reset_detail"
                : "commands.config.panel.image_tags_updated_detail",
              { tags: result.tags.join(", ") },
            )
          : result.status === "no-tags"
            ? receipt(
                locale,
                "error",
                "commands.config.panel.invalid_input_heading",
                "commands.config.panel.image_tags_empty_detail",
              )
            : result.status === "too-many"
              ? receipt(
                  locale,
                  "error",
                  "commands.config.panel.invalid_input_heading",
                  "commands.config.panel.image_tags_too_many_detail",
                )
              : result.status === "tag-too-long"
                ? receipt(
                    locale,
                    "error",
                    "commands.config.panel.invalid_input_heading",
                    "commands.config.panel.image_tags_too_long_detail",
                  )
                : result.status === "invalid"
                  ? receipt(
                      locale,
                      "error",
                      "commands.config.panel.invalid_input_heading",
                      "commands.config.panel.image_tags_invalid_detail",
                    )
                  : writeFailedReceipt(locale),
    });
    return true;
  }

  if (route.action !== "nai-parameters-submit") return false;

  const modal = context.interaction as ModalSubmitInteraction;
  const action = await performPanelAction(
    () =>
      dependencies.modelOperations.setNaiImageParameters({
        tomoriState: state,
        serverDiscId: context.scope.serverDiscId,
        values: {
          sampler: readSelectValue(context, buildConfigModalFieldId(CONFIG_NAI_SAMPLER_FIELD, route.nonce)) ?? null,
          steps: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_NAI_STEPS_FIELD, route.nonce)),
          scale: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_NAI_SCALE_FIELD, route.nonce)),
          noiseSchedule: readSelectValue(context, buildConfigModalFieldId(CONFIG_NAI_NOISE_FIELD, route.nonce)) ?? null,
          cfgRescale: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_NAI_RESCALE_FIELD, route.nonce)),
        },
      }),
    () => dependencies.resolveScope(context.interaction, true),
  );
  context.scope = action.state ?? context.scope;
  const result = action.result;
  if (result.status === "success") recordModelAction(context, "server-config.workspace.nai-parameters.set");

  await baseRepaint(context, "image", {
    receipt:
      result.status === "success"
        ? receipt(
            locale,
            "success",
            "commands.config.panel.nai_updated_heading",
            "commands.config.panel.nai_updated_detail",
          )
        : result.status === "write-failed"
          ? writeFailedReceipt(locale)
          : receipt(
              locale,
              "error",
              "commands.config.panel.invalid_input_heading",
              "commands.config.panel.nai_invalid_detail",
            ),
  });
  return true;
}

/**
 * Post-defer half of the Models surface. Returns false for a route this module does not own so the
 * caller falls through to its own navigation repaint.
 */
export async function handleConfigModelRoutes(context: ConfigModelRouteContext): Promise<boolean> {
  const page = MODELS_PAGE_BY_ROUTE[context.route.action];
  if (!page) return false;

  const state = serverStateFromScope(context.scope);
  if (!state) {
    await baseRepaint(context, page, { receipt: staleReceipt(context.route.locale) });
    return true;
  }

  switch (page) {
    case "switch":
      return handleSwitchModels(context);
    case "parameters":
      return handleParameters(context);
    case "fallbacks":
      return handleFallbacks(context);
    case "image":
      return handleImageGeneration(context);
    default:
      return false;
  }
}
