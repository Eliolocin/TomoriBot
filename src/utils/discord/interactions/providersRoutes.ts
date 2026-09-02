import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { CustomEndpointCapability } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import type { ProviderPanelCapabilitySection, ProviderPanelModel } from "@/types/discord/providerPanel";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import {
  PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_VERSION,
  parseProvidersPanelRoute,
  type ProvidersRouteNamespace,
} from "@/utils/discord/providersPanelCatalog";
import {
  PROVIDERS_ADD_ENDPOINT_VALUE,
  PROVIDERS_ADD_PROVIDER_VALUE,
  buildAddProviderModal,
  buildAddProviderModalFieldId,
  buildAddEndpointModal,
  buildAddEndpointModalFieldId,
  buildProvidersPanelPayload,
  buildProviderModelModal,
  parseEndpointActivationValue,
  buildProviderModelModalFieldId,
  buildEditProviderModal,
  buildEditProviderModalFieldId,
  buildEditEndpointModal,
  buildEditEndpointModalFieldId,
  offeredChatCompatFlags,
  parseModelSelectionValue,
  PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
  type EditEndpointModalContext,
  type ProviderModelModalDefaults,
  type ProvidersPanelPage,
} from "@/utils/discord/ui/providersPanel";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { getDefaultImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";
import { getDefaultSpeechEndpointSettings } from "@/utils/provider/customSpeechEndpointSettings";
import { resolveCuratedImageSupports } from "@/utils/provider/providerImageCapabilities";
import {
  showRoutedRawModal,
  takeRawModalCheckboxGroupValues,
  takeRawModalFileUpload,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";
import {
  providerPanelOperations,
  type AddServerProviderResult,
  type AddCustomEndpointConnectionResult,
  type LoadedProviderPanelScope,
  type SaveProviderModelResult,
  type ActivateWorkspaceEndpointResult,
  type EditProviderResult,
  type EditEndpointResult,
  type RemoveProviderEntryResult,
} from "@/utils/provider/providerPanelOperations";
import { resolveProviderPanelAction } from "@/constants/panelActions";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { IMPORT_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { localizer } from "@/utils/text/localizer";

export interface ProvidersRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<LoadedProviderPanelScope | null>;
  operations: Pick<
    typeof providerPanelOperations,
    | "addServerProvider"
    | "addCustomEndpointConnection"
    | "saveProviderModel"
    | "editServerProvider"
    | "editServerEndpoint"
    | "activateWorkspaceEndpoint"
    | "removeServerProviderEntry"
  >;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showAddProviderModal(interaction: StringSelectMenuInteraction, locale: string, nonce: string): Promise<void>;
  takeProvider(interactionId: string, nonce: string): string | undefined;
  showAddEndpointModal(interaction: StringSelectMenuInteraction, locale: string, nonce: string): Promise<void>;
  takeApiStyle(interactionId: string, nonce: string): string | undefined;
  showModelModal(
    interaction: StringSelectMenuInteraction,
    locale: string,
    entryKind: "provider" | "endpoint",
    entryKey: string,
    capability: Parameters<typeof buildProviderModelModal>[3],
    editingModelId: number | null,
    nonce: string,
    defaults?: ProviderModelModalDefaults,
  ): Promise<void>;
  takeModelFlags(interactionId: string, nonce: string): string[] | undefined;
  takeImageSupports(interactionId: string, nonce: string): string[] | undefined;
  takeCompatFlags(interactionId: string, nonce: string): string[] | undefined;
  takeVoiceMode(interactionId: string, nonce: string): string | undefined;
  takeScriptMarkup(interactionId: string, nonce: string): string | undefined;
  takeSupportsInstruct(interactionId: string, nonce: string): string[] | undefined;
  takeWorkflow(interactionId: string, nonce: string): ReturnType<typeof takeRawModalFileUpload>;
  loadWorkflow(url: string): Promise<Record<string, unknown> | null>;
  showProviderEditModal(
    interaction: ButtonInteraction,
    locale: string,
    provider: string,
    rotationKeyCount: number,
    nonce: string,
  ): Promise<void>;
  showEndpointEditModal(
    interaction: ButtonInteraction,
    locale: string,
    context: EditEndpointModalContext,
    nonce: string,
  ): Promise<void>;
  takeDeleteRotation(interactionId: string, nonce: string): string | undefined;
}

export interface ProvidersRouteConfiguration {
  namespace: ProvidersRouteNamespace;
  authorize(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): boolean;
  includeBrave: boolean;
  allowRotation: boolean;
  allowEndpointActivation: boolean;
}

const enabledProviderActions = new Set<"model" | "edit" | "activate" | "remove">([
  "model",
  "edit",
  "activate",
  "remove",
]);
const enabledPersonalProviderActions = new Set<"model" | "edit" | "activate" | "remove">(["model", "edit", "remove"]);

function actionsForNamespace(namespace: ProvidersRouteNamespace | undefined) {
  return namespace === PERSONAL_PROVIDERS_ROUTE_NAMESPACE ? enabledPersonalProviderActions : enabledProviderActions;
}

function isAuthorized(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): boolean {
  return !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [buildPanelContainer([{ type: ComponentType.TextDisplay, content: localizer(locale, key) }])],
    flags: MessageFlags.IsComponentsV2,
  };
}

async function defaultResolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  forceRefresh = false,
): Promise<LoadedProviderPanelScope | null> {
  return providerPanelOperations.loadServerProviderPanelScope(interaction.guildId ?? interaction.user.id, forceRefresh);
}

async function defaultResolvePersonalScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<LoadedProviderPanelScope | null> {
  return providerPanelOperations.loadPersonalProviderPanelScope(
    interaction.user.id,
    interaction.guildId ?? interaction.user.id,
  );
}

function changedReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.providers.changed_receipt"),
    detail: localizer(locale, "commands.providers.changed_receipt_detail"),
  };
}

function removeReceipt(locale: string, result: RemoveProviderEntryResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.removed_receipt"),
      detail: localizer(locale, "commands.providers.removed_receipt_detail", { name: result.displayName }),
    };
  }
  const detail =
    result.status === "active"
      ? "commands.providers.remove_active"
      : result.status === "not-found"
        ? "commands.providers.changed_receipt_detail"
        : "commands.providers.write_failed";
  return {
    tone: result.status === "not-found" ? "info" : "error",
    heading: localizer(locale, "commands.providers.remove_failed"),
    detail: localizer(locale, detail),
  };
}

function removalEntryId(route: { entryKind: "provider" | "endpoint" | "brave"; entryKey: string }): string {
  return route.entryKind === "brave" ? "brave" : `${route.entryKind}:${route.entryKey}`;
}

function addReceipt(locale: string, result: AddServerProviderResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(
        locale,
        result.updated ? "commands.providers.provider_updated" : "commands.providers.provider_added",
      ),
      detail: localizer(locale, "commands.providers.provider_added_detail", {
        provider: result.displayName,
        model: result.modelName ?? localizer(locale, "commands.providers.not_applicable"),
      }),
    };
  }
  const detailKey: Record<Exclude<AddServerProviderResult["status"], "success">, string> = {
    "invalid-key": "commands.providers.invalid_key",
    "unsupported-provider": "commands.providers.unsupported_provider",
    "validation-failed": "commands.providers.validation_failed",
    "missing-model": "commands.providers.missing_default_model",
    "write-failed": "commands.providers.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.add_provider_failed"),
    detail: localizer(locale, detailKey[result.status]),
  };
}

function addEndpointReceipt(locale: string, result: AddCustomEndpointConnectionResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.endpoint_added"),
      detail: localizer(locale, "commands.providers.endpoint_added_detail", { label: result.label }),
    };
  }
  if (result.status === "unreachable") {
    return {
      tone: "error",
      heading: localizer(locale, "commands.providers.add_endpoint_failed"),
      detail: localizer(locale, "commands.providers.endpoint_unreachable", {
        reason: escapeDiscordMarkdown(result.reason.replace(/\s+/g, " ").trim().slice(0, 300)),
      }),
    };
  }
  const keys: Record<Exclude<AddCustomEndpointConnectionResult["status"], "success" | "unreachable">, string> = {
    "invalid-label": "commands.providers.endpoint_invalid_label",
    "invalid-style": "commands.providers.endpoint_invalid_style",
    "already-exists": "commands.providers.endpoint_already_exists",
    "label-url-conflict": "commands.providers.endpoint_label_url_conflict",
    "write-failed": "commands.providers.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.add_endpoint_failed"),
    detail: localizer(locale, keys[result.status]),
  };
}

function modelReceipt(locale: string, result: SaveProviderModelResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.model_added"),
      detail: localizer(locale, "commands.providers.model_added_detail", {
        model: result.codeName,
      }),
    };
  }
  const keys: Record<Exclude<SaveProviderModelResult["status"], "success">, string> = {
    "invalid-model": "commands.providers.model_invalid",
    "unsupported-capability": "commands.providers.model_unsupported",
    "not-found": "commands.providers.model_not_found",
    "already-available": "commands.providers.model_already_available",
    "write-failed": "commands.providers.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.model_save_failed"),
    detail: localizer(locale, keys[result.status]),
  };
}

function providerEditReceipt(locale: string, result: EditProviderResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.provider_edit_saved"),
      detail: localizer(locale, "commands.providers.provider_edit_saved_detail", {
        changes: result.changed.join(", "),
      }),
    };
  }
  if (result.status === "unchanged") {
    return {
      tone: "info",
      heading: localizer(locale, "commands.providers.provider_edit_unchanged"),
      detail: localizer(locale, "commands.providers.provider_edit_unchanged_detail"),
    };
  }
  const keys: Record<Exclude<EditProviderResult["status"], "success" | "unchanged">, string> = {
    "invalid-key": "commands.providers.invalid_key",
    "invalid-combination": "commands.providers.provider_edit_invalid_combination",
    "not-found": "commands.providers.model_not_found",
    "validation-failed": "commands.providers.validation_failed",
    "write-failed": "commands.providers.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.change_failed"),
    detail: localizer(locale, keys[result.status]),
  };
}

function endpointEditReceipt(locale: string, result: EditEndpointResult): PanelReceipt {
  if (result.status === "success") {
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.endpoint_edit_saved"),
      detail: localizer(locale, "commands.providers.endpoint_edit_saved_detail", { label: result.label }),
    };
  }
  if (result.status === "unchanged") {
    return {
      tone: "info",
      heading: localizer(locale, "commands.providers.endpoint_edit_unchanged"),
      detail: localizer(locale, "commands.providers.endpoint_edit_unchanged_detail"),
    };
  }
  if (result.status === "unreachable") {
    return {
      tone: "error",
      heading: localizer(locale, "commands.providers.change_failed"),
      detail: localizer(locale, "commands.providers.endpoint_unreachable", {
        reason: escapeDiscordMarkdown(result.reason.replace(/\s+/g, " ").trim().slice(0, 300)),
      }),
    };
  }
  const keys: Record<Exclude<EditEndpointResult["status"], "success" | "unchanged" | "unreachable">, string> = {
    "invalid-label": "commands.providers.endpoint_invalid_label",
    "not-found": "commands.providers.model_not_found",
    "write-failed": "commands.providers.write_failed",
  };
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.change_failed"),
    detail: localizer(locale, keys[result.status]),
  };
}

function activateReceipt(
  locale: string,
  capability: "speech" | "transcription",
  result: ActivateWorkspaceEndpointResult,
): PanelReceipt {
  if (result.status === "success") {
    // Only speech binds a stored voice to its source, so only speech has anything to re-assign when
    // the api style changes. `/model transcription` has never carried this variant.
    const sourceChanged = result.sourceChanged && capability === "speech";
    return {
      tone: "success",
      heading: localizer(locale, "commands.providers.endpoint_activated"),
      detail: sourceChanged
        ? localizer(locale, "commands.providers.endpoint_activated_source_changed_detail", {
            endpoint: result.identity,
            voice_assign_command: commandRegistry.getCommandMention("speech", "voice-assign"),
          })
        : localizer(locale, "commands.providers.endpoint_activated_detail", { endpoint: result.identity }),
    };
  }
  if (result.status === "already-active") {
    return {
      tone: "info",
      heading: localizer(locale, "commands.providers.endpoint_already_active"),
      detail: localizer(locale, "commands.providers.endpoint_already_active_detail", { endpoint: result.identity }),
    };
  }
  return {
    tone: result.status === "not-found" ? "info" : "error",
    heading: localizer(locale, "commands.providers.activate_failed"),
    detail: localizer(
      locale,
      result.status === "not-found" ? "commands.providers.changed_receipt_detail" : "commands.providers.write_failed",
    ),
  };
}

/**
 * Chooses the image capability defaults a model modal opens with, or omits them entirely.
 *
 * A custom endpoint stores its declaration on the endpoint row and can only inpaint through ComfyUI. A
 * curated model stores its own columns and inherits its provider's defaults until it declares otherwise;
 * a provider whose image path ignores these flags yields no section at all.
 */
function imageModalDefaults(
  capability: CustomEndpointCapability,
  entryKind: "provider" | "endpoint",
  entryKey: string,
  section: ProviderPanelCapabilitySection,
  editing: ProviderPanelModel | undefined,
): Pick<ProviderModelModalDefaults, "image"> {
  if (capability !== "image") return {};

  if (entryKind === "endpoint") {
    return {
      image: {
        supports: editing?.imageSettings ?? getDefaultImageEndpointSupports(section.apiStyle ?? "openai-compatible"),
        allowInpaint: section.apiStyle === "comfyui",
      },
    };
  }

  const supports = editing?.imageSettings ?? resolveCuratedImageSupports(entryKey);
  return supports ? { image: { supports, allowInpaint: true } } : {};
}

function speechModalDefaults(
  capability: CustomEndpointCapability,
  section: ProviderPanelCapabilitySection,
  editing: ProviderPanelModel | undefined,
): Pick<ProviderModelModalDefaults, "speech"> {
  if (capability !== "speech") return {};

  // Only a `tts-clone` server implements the clone/VoiceDesign/Auto split; `isVoiceDesignEndpoint`
  // requires that api style, so offering it for the ElevenLabs preset would store a dead value.
  const apiStyle = section.apiStyle ?? "tts-clone";
  return {
    speech: {
      settings: editing?.speechSettings ?? getDefaultSpeechEndpointSettings(apiStyle),
      allowVoiceMode: apiStyle === "tts-clone",
    },
  };
}

function endpointEditContext(scope: LoadedProviderPanelScope, connectionId: number): EditEndpointModalContext | null {
  const entry = scope.data.entries.find(
    (candidate) => candidate.kind === "endpoint" && candidate.connectionIds.includes(connectionId),
  );
  if (!entry || entry.kind !== "endpoint") return null;
  return {
    connectionId: entry.connectionIds[0] ?? connectionId,
    label: entry.displayName,
    endpointUrl: entry.connectionDetails[0]?.endpointUrl ?? "",
    apiStyles: [...new Set(entry.connectionDetails.map((detail) => detail.apiStyle))],
    isPreset: entry.isPreset,
  };
}

async function loadWorkflowJson(url: string): Promise<Record<string, unknown> | null> {
  const result = await safeDownload(url, {
    maxSizeMB: IMPORT_LIMITS.MAX_DATA_IMPORT_SIZE_MB,
    timeoutMs: 10_000,
  });
  if (!result.success || !result.buffer) return null;
  try {
    const parsed: unknown = JSON.parse(result.buffer.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unavailableScope(scope: LoadedProviderPanelScope): LoadedProviderPanelScope {
  return { ...scope, data: { readStatus: "unavailable", entries: [], initialEntryId: null } };
}

function readUnavailableReceipt(locale: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.providers.change_failed"),
    detail: localizer(locale, "commands.providers.unavailable"),
  };
}

function rangeForEntry(scope: LoadedProviderPanelScope, entryId: string | undefined): number {
  const index = entryId ? scope.data.entries.findIndex((entry) => entry.id === entryId) : -1;
  return index < 0 ? 0 : Math.floor(index / 23);
}

function repaint(
  interaction: GlobalRoutableInteraction,
  locale: string,
  scope: LoadedProviderPanelScope,
  page: ProvidersPanelPage,
  rangeIndex?: number,
  receipt?: PanelReceipt,
): Promise<unknown> {
  return interaction.editReply(
    buildProvidersPanelPayload({
      locale,
      entries: scope.data.entries,
      initialEntryId: scope.data.initialEntryId,
      readStatus: scope.data.readStatus,
      page,
      rangeIndex,
      receipt,
      enabledActions: actionsForNamespace(scope.routeNamespace),
      routeNamespace: scope.routeNamespace,
      footerCommand: scope.footerCommand,
    }),
  );
}

export function createProvidersInteractionRoute(
  overrides: Partial<ProvidersRouteDependencies> = {},
  configuration: ProvidersRouteConfiguration = {
    namespace: PROVIDERS_ROUTE_NAMESPACE,
    authorize: isAuthorized,
    includeBrave: true,
    allowRotation: true,
    allowEndpointActivation: true,
  },
): GlobalInteractionRoute {
  const dependencies: ProvidersRouteDependencies = {
    resolveScope: defaultResolveScope,
    operations: providerPanelOperations,
    recordAction: (input) => {
      void recordPanelActionStat(input);
    },
    createNonce,
    showAddProviderModal: (interaction, locale, nonce) =>
      showRoutedRawModal(
        interaction,
        buildAddProviderModal(locale, nonce, configuration.namespace, configuration.includeBrave),
      ),
    takeProvider: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildAddProviderModalFieldId("provider", nonce)),
    showAddEndpointModal: (interaction, locale, nonce) =>
      showRoutedRawModal(interaction, buildAddEndpointModal(locale, nonce, configuration.namespace)),
    takeApiStyle: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildAddEndpointModalFieldId("api-style", nonce)),
    showModelModal: (interaction, locale, entryKind, entryKey, capability, editingModelId, nonce, defaults) =>
      showRoutedRawModal(
        interaction,
        buildProviderModelModal(
          locale,
          entryKind,
          entryKey,
          capability,
          editingModelId,
          nonce,
          defaults,
          configuration.namespace,
        ),
      ),
    takeModelFlags: (interactionId, nonce) =>
      takeRawModalCheckboxGroupValues(interactionId, buildProviderModelModalFieldId("flags", nonce)),
    takeImageSupports: (interactionId, nonce) =>
      takeRawModalCheckboxGroupValues(interactionId, buildProviderModelModalFieldId("image-supports", nonce)),
    takeCompatFlags: (interactionId, nonce) =>
      takeRawModalCheckboxGroupValues(interactionId, buildProviderModelModalFieldId("compat", nonce)),
    takeVoiceMode: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildProviderModelModalFieldId("voice-mode", nonce)),
    takeScriptMarkup: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildProviderModelModalFieldId("script-markup", nonce)),
    takeSupportsInstruct: (interactionId, nonce) =>
      takeRawModalCheckboxGroupValues(interactionId, buildProviderModelModalFieldId("supports-instruct", nonce)),
    takeWorkflow: (interactionId, nonce) =>
      takeRawModalFileUpload(interactionId, buildProviderModelModalFieldId("workflow", nonce)),
    loadWorkflow: loadWorkflowJson,
    showProviderEditModal: (interaction, locale, provider, rotationKeyCount, nonce) =>
      showRoutedRawModal(
        interaction,
        buildEditProviderModal(
          locale,
          provider,
          rotationKeyCount,
          nonce,
          configuration.namespace,
          configuration.allowRotation,
        ),
      ),
    showEndpointEditModal: (interaction, locale, context, nonce) =>
      showRoutedRawModal(interaction, buildEditEndpointModal(locale, context, nonce, configuration.namespace)),
    takeDeleteRotation: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildEditProviderModalFieldId("delete-rotation", nonce)),
    ...overrides,
  };

  return {
    namespace: configuration.namespace,
    version: PROVIDERS_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseProvidersPanelRoute(parsed, configuration.namespace);
      if (!route) throw new Error(`Malformed providers panel route: ${interaction.customId}`);

      if (
        (route.action === "select" || route.action === "model-select" || route.action === "endpoint-activate") &&
        !interaction.isStringSelectMenu()
      ) {
        throw new Error("Providers select route requires a String Select interaction");
      }
      if (
        (route.action === "add-submit" ||
          route.action === "endpoint-submit" ||
          route.action === "model-submit" ||
          route.action === "edit-provider-submit" ||
          route.action === "edit-endpoint-submit") &&
        !interaction.isModalSubmit()
      ) {
        throw new Error(`Providers ${route.action} route requires a modal submission`);
      }
      if (
        route.action !== "select" &&
        route.action !== "model-select" &&
        route.action !== "endpoint-activate" &&
        route.action !== "add-submit" &&
        route.action !== "endpoint-submit" &&
        route.action !== "model-submit" &&
        route.action !== "edit-provider-submit" &&
        route.action !== "edit-endpoint-submit" &&
        !interaction.isButton()
      ) {
        throw new Error(`Providers ${route.action} route requires a button interaction`);
      }

      if (route.action === "select") {
        const selectedValue = (interaction as StringSelectMenuInteraction).values[0];
        if (selectedValue === PROVIDERS_ADD_PROVIDER_VALUE) {
          if (!configuration.authorize(interaction)) {
            await interaction.reply({
              content: localizer(route.locale, "general.errors.permission_denied_description"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddProviderModal(interaction as StringSelectMenuInteraction, route.locale, nonce);
          return;
        }
        if (selectedValue === PROVIDERS_ADD_ENDPOINT_VALUE) {
          if (!configuration.authorize(interaction)) {
            await interaction.reply({
              content: localizer(route.locale, "general.errors.permission_denied_description"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddEndpointModal(interaction as StringSelectMenuInteraction, route.locale, nonce);
          return;
        }
      }

      if (route.action === "edit-provider-open") {
        if (!configuration.authorize(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showProviderEditModal(
          interaction as ButtonInteraction,
          route.locale,
          route.provider,
          route.rotationKeyCount,
          nonce,
        );
        return;
      }

      if (route.action === "edit-endpoint-open") {
        if (!configuration.authorize(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        const context = scope ? endpointEditContext(scope, route.connectionId) : null;
        if (!scope || scope.data.readStatus !== "fresh" || !context) {
          await interaction.reply({
            content: localizer(route.locale, "commands.providers.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showEndpointEditModal(interaction as ButtonInteraction, route.locale, context, nonce);
        return;
      }

      if (route.action === "model-select") {
        if (!configuration.authorize(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "general.errors.permission_denied_description"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const selection = parseModelSelectionValue((interaction as StringSelectMenuInteraction).values[0]);
        if (!selection) {
          throw new Error("Malformed provider model selection");
        }
        // The modal is this interaction's acknowledgement, so the scope read must be the cached one
        // Edit Endpoint already relies on. The selector is disabled unless the panel is fresh, so a
        // stale read here means the panel outlived its data.
        const modelScope = await dependencies.resolveScope(interaction, false);
        const entry = modelScope?.data.entries.find(
          (candidate) => candidate.id === `${route.entryKind}:${route.entryKey}`,
        );
        // A panel opened before a capability stopped being exposed can still carry its option, and
        // the write would fail with `unsupported-capability` or `not-found` after the modal closed.
        const section =
          entry && entry.kind !== "brave"
            ? entry.capabilities.find(
                (candidate) =>
                  candidate.capability === selection.capability && candidate.availability !== "unavailable",
              )
            : undefined;
        if (!modelScope || modelScope.data.readStatus !== "fresh" || !section) {
          await interaction.reply({
            content: localizer(route.locale, "commands.providers.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const editing = selection.editingModelId
          ? section.models.find(
              (candidate) => candidate.id === selection.editingModelId && candidate.isCustomRegistration,
            )
          : undefined;
        const nonce = dependencies.createNonce();
        await dependencies.showModelModal(
          interaction as StringSelectMenuInteraction,
          route.locale,
          route.entryKind,
          route.entryKey,
          selection.capability,
          selection.editingModelId,
          nonce,
          {
            codeName: editing?.codeName,
            text: editing?.textSettings,
            ...imageModalDefaults(selection.capability, route.entryKind, route.entryKey, section, editing),
            ...speechModalDefaults(selection.capability, section, editing),
          },
        );
        return;
      }

      const selectedProvider =
        route.action === "add-submit" ? dependencies.takeProvider(interaction.id, route.nonce) : undefined;
      const selectedApiStyle =
        route.action === "endpoint-submit" ? dependencies.takeApiStyle(interaction.id, route.nonce) : undefined;
      const selectedModelFlags =
        route.action === "model-submit" ? (dependencies.takeModelFlags(interaction.id, route.nonce) ?? []) : [];
      const selectedImageSupports =
        route.action === "model-submit" ? dependencies.takeImageSupports(interaction.id, route.nonce) : undefined;
      const selectedCompatFlags =
        route.action === "model-submit" ? dependencies.takeCompatFlags(interaction.id, route.nonce) : undefined;
      const selectedVoiceMode =
        route.action === "model-submit" ? dependencies.takeVoiceMode(interaction.id, route.nonce) : undefined;
      const selectedScriptMarkup =
        route.action === "model-submit" ? dependencies.takeScriptMarkup(interaction.id, route.nonce) : undefined;
      const selectedInstructValues =
        route.action === "model-submit" ? dependencies.takeSupportsInstruct(interaction.id, route.nonce) : undefined;
      const workflowAttachment =
        route.action === "model-submit" ? dependencies.takeWorkflow(interaction.id, route.nonce) : undefined;
      const deleteRotation =
        route.action === "edit-provider-submit"
          ? dependencies.takeDeleteRotation(interaction.id, route.nonce) === "delete"
          : false;

      const scope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => configuration.authorize(interaction),
        onDenied: () =>
          interaction.editReply(terminalPayload(route.locale, "general.errors.permission_denied_description")),
        load: () =>
          dependencies.resolveScope(
            interaction,
            route.action === "retry" ||
              route.action === "model-submit" ||
              route.action === "endpoint-activate" ||
              route.action === "edit-provider-submit" ||
              route.action === "edit-endpoint-submit" ||
              route.action === "remove-confirm",
          ),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.providers.not_setup")),
      });
      if (!scope) return;

      if (
        (route.action === "add-submit" ||
          route.action === "endpoint-submit" ||
          route.action === "model-submit" ||
          route.action === "edit-provider-submit" ||
          route.action === "edit-endpoint-submit" ||
          route.action === "endpoint-activate" ||
          route.action === "remove-confirm") &&
        scope.data.readStatus !== "fresh"
      ) {
        await repaint(
          interaction,
          route.locale,
          scope,
          route.action === "model-submit"
            ? { kind: "entry", entryId: `${route.entryKind}:${route.entryKey}` }
            : route.action === "endpoint-activate"
              ? { kind: "entry", entryId: `endpoint:${route.connectionId}` }
              : { kind: "entry" },
          0,
          readUnavailableReceipt(route.locale),
        );
        return;
      }

      if (route.action === "endpoint-activate") {
        const entryId = `endpoint:${route.connectionId}`;
        const selection = parseEndpointActivationValue((interaction as StringSelectMenuInteraction).values[0]);
        if (!selection) {
          throw new Error("Malformed provider endpoint activation selection");
        }
        const entry = scope.data.entries.find((candidate) => candidate.id === entryId);
        // The personal panel never renders this select, so reaching it there means a workspace custom
        // id was replayed against a personal panel; its scope owns no server-scoped endpoint rows.
        if (!configuration.allowEndpointActivation || !entry || entry.kind !== "endpoint") {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.activateWorkspaceEndpoint({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              capability: selection.capability,
              customEndpointId: selection.customEndpointId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action:
              selection.capability === "speech"
                ? "providers.workspace.speech-endpoint.activate"
                : "providers.workspace.transcription-endpoint.activate",
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          { kind: "entry", entryId },
          rangeForEntry(nextScope, entryId),
          activateReceipt(route.locale, selection.capability, action.result),
        );
        return;
      }

      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const action = await performPanelAction(
          () =>
            dependencies.operations.addServerProvider({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              provider: selectedProvider ?? "",
              apiKey: modal.fields.getTextInputValue(buildAddProviderModalFieldId("api-key", route.nonce)),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "provider.add"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          action.result.status === "success" ? { kind: "entry", entryId: action.result.entryId } : { kind: "entry" },
          action.result.status === "success" ? rangeForEntry(nextScope, action.result.entryId) : 0,
          addReceipt(route.locale, action.result),
        );
        return;
      }

      if (route.action === "remove-prompt" || route.action === "remove-cancel" || route.action === "remove-confirm") {
        const entryId = removalEntryId(route);
        const entry = scope.data.entries.find((candidate) => candidate.id === entryId);
        if (!entry) {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        if (route.action === "remove-prompt") {
          await repaint(interaction, route.locale, scope, { kind: "remove", entryId }, rangeForEntry(scope, entryId));
          return;
        }
        if (route.action === "remove-cancel") {
          await repaint(interaction, route.locale, scope, { kind: "entry", entryId }, rangeForEntry(scope, entryId));
          return;
        }
        if (scope.data.readStatus !== "fresh") {
          await repaint(
            interaction,
            route.locale,
            scope,
            { kind: "entry", entryId },
            rangeForEntry(scope, entryId),
            readUnavailableReceipt(route.locale),
          );
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.removeServerProviderEntry({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              entry,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "entry.remove"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const nextEntryId = nextScope.data.initialEntryId ?? nextScope.data.entries[0]?.id;
        await repaint(
          interaction,
          route.locale,
          nextScope,
          { kind: "entry", entryId: nextEntryId },
          nextEntryId ? rangeForEntry(nextScope, nextEntryId) : 0,
          removeReceipt(route.locale, action.result),
        );
        return;
      }
      if (route.action === "endpoint-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const field = (name: "label" | "url" | "auth-token") =>
          modal.fields.getTextInputValue(buildAddEndpointModalFieldId(name, route.nonce));
        const action = await performPanelAction(
          () =>
            dependencies.operations.addCustomEndpointConnection({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              label: field("label"),
              endpointUrl: field("url"),
              apiStyle: selectedApiStyle as never,
              authToken: field("auth-token"),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "endpoint.add"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          action.result.status === "success" ? { kind: "entry", entryId: action.result.entryId } : { kind: "entry" },
          action.result.status === "success" ? rangeForEntry(nextScope, action.result.entryId) : 0,
          addEndpointReceipt(route.locale, action.result),
        );
        return;
      }
      if (route.action === "edit-provider-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const entryId = route.provider === "brave" ? "brave" : `provider:${route.provider}`;
        if (!scope.data.entries.some((entry) => entry.id === entryId)) {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.editServerProvider({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              provider: route.provider,
              apiKey: modal.fields.getTextInputValue(buildEditProviderModalFieldId("api-key", route.nonce)),
              rotationKey:
                route.provider === "brave" || !configuration.allowRotation
                  ? ""
                  : modal.fields.getTextInputValue(buildEditProviderModalFieldId("rotation-key", route.nonce)),
              deleteRotationKeys: deleteRotation,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "provider.edit"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          { kind: "entry", entryId },
          rangeForEntry(nextScope, entryId),
          providerEditReceipt(route.locale, action.result),
        );
        return;
      }
      if (route.action === "edit-endpoint-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const entryId = `endpoint:${route.connectionId}`;
        const entry = scope.data.entries.find((candidate) => candidate.id === entryId);
        if (!entry || entry.kind !== "endpoint") {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        const action = await performPanelAction(
          () =>
            dependencies.operations.editServerEndpoint({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              entryId,
              label: entry.isPreset
                ? entry.displayName
                : modal.fields.getTextInputValue(buildEditEndpointModalFieldId("label", route.nonce)),
              endpointUrl: entry.isPreset
                ? ""
                : modal.fields.getTextInputValue(buildEditEndpointModalFieldId("url", route.nonce)),
              authToken: modal.fields.getTextInputValue(buildEditEndpointModalFieldId("auth-token", route.nonce)),
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "endpoint.edit"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          { kind: "entry", entryId },
          rangeForEntry(nextScope, entryId),
          endpointEditReceipt(route.locale, action.result),
        );
        return;
      }
      if (route.action === "model-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const entryId = `${route.entryKind}:${route.entryKey}`;
        const entry = scope.data.entries.find((candidate) => candidate.id === entryId);
        const target = route.editingModelId
          ? entry && entry.kind !== "brave"
            ? entry.capabilities
                .find((section) => section.capability === route.capability)
                ?.models.find((model) => model.id === route.editingModelId && model.isCustomRegistration)
            : undefined
          : undefined;
        if (!entry || (route.editingModelId && !target)) {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        // Re-derived rather than inferred from the submission: a panel can outlive the answer, and a
        // flag this provider never offered must keep its stored value instead of being written false.
        const offeredCompat = offeredChatCompatFlags(route.entryKind, route.entryKey);
        const resolveCompatFlag = (flag: string, stored: boolean | undefined): boolean =>
          offeredCompat.includes(flag as (typeof offeredCompat)[number])
            ? (selectedCompatFlags?.includes(flag) ?? false)
            : (stored ?? false);
        const workflow = workflowAttachment ? await dependencies.loadWorkflow(workflowAttachment.url) : undefined;
        if (workflowAttachment && !workflow) {
          await repaint(interaction, route.locale, scope, { kind: "entry", entryId }, rangeForEntry(scope, entryId), {
            tone: "error",
            heading: localizer(route.locale, "commands.providers.model_save_failed"),
            detail: localizer(route.locale, "commands.providers.model_workflow_invalid"),
          });
          return;
        }
        const rawNumCtx =
          route.entryKind === "endpoint" && route.capability === "text"
            ? modal.fields.getTextInputValue(buildProviderModelModalFieldId("num-ctx", route.nonce)).trim()
            : "";
        const numCtx = rawNumCtx ? Number(rawNumCtx) : null;
        const action = await performPanelAction(
          () =>
            dependencies.operations.saveProviderModel({
              serverDiscId: interaction.guildId ?? interaction.user.id,
              ownerId: scope.ownerId,
              scopeKind: scope.scopeKind,
              state: scope.state,
              entryId,
              capability: route.capability,
              codeName: modal.fields.getTextInputValue(buildProviderModelModalFieldId("code-name", route.nonce)).trim(),
              editingModelId: route.editingModelId ?? undefined,
              numCtx: rawNumCtx ? (Number.isSafeInteger(numCtx) ? numCtx : Number.NaN) : null,
              hasTools: selectedModelFlags.includes("tools"),
              seesImages: selectedModelFlags.includes("images"),
              supportsStructOutput: selectedModelFlags.includes("structured"),
              strictRoleAlternation: resolveCompatFlag("strict-roles", target?.textSettings?.strictRoleAlternation),
              supportsPrefixCompletion: resolveCompatFlag("prefix", target?.textSettings?.supportsPrefixCompletion),
              imageSupportValues: route.capability === "image" ? selectedImageSupports : undefined,
              speechVoiceMode: route.capability === "speech" ? selectedVoiceMode : undefined,
              speechScriptMarkup: route.capability === "speech" ? selectedScriptMarkup : undefined,
              speechInstructValues: route.capability === "speech" ? selectedInstructValues : undefined,
              workflow: workflow ?? undefined,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const nextScope = action.state ?? unavailableScope(scope);
        if (action.result.status === "success") {
          dependencies.recordAction({
            action: resolveProviderPanelAction(scope.scopeKind, "model.save"),
            serverId: scope.state.server_id,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        await repaint(
          interaction,
          route.locale,
          nextScope,
          { kind: "entry", entryId },
          rangeForEntry(nextScope, entryId),
          modelReceipt(route.locale, action.result),
        );
        return;
      }

      if (route.action === "retry") {
        await repaint(interaction, route.locale, scope, { kind: "entry" });
        return;
      }
      if (route.action === "range-open" || route.action === "range-page") {
        const rangeIndex = route.action === "range-page" ? route.rangeIndex : 0;
        const entry = scope.data.entries[rangeIndex * PROVIDERS_ENTRIES_PER_SELECTOR_PAGE];
        await repaint(
          interaction,
          route.locale,
          scope,
          {
            kind: "entry",
            entryId: entry?.id,
          },
          rangeIndex,
        );
        return;
      }
      if (route.action === "range-cancel") {
        await repaint(interaction, route.locale, scope, { kind: "entry" });
        return;
      }
      if (route.action === "range") {
        const entry = scope.data.entries[route.rangeIndex * PROVIDERS_ENTRIES_PER_SELECTOR_PAGE];
        await repaint(interaction, route.locale, scope, { kind: "entry", entryId: entry?.id }, route.rangeIndex);
        return;
      }
      if (route.action === "model-open" || route.action === "model-close" || route.action === "model-range") {
        const entryId = `${route.entryKind}:${route.entryKey}`;
        const entry = scope.data.entries.find((candidate) => candidate.id === entryId);
        if (!entry) {
          await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
          return;
        }
        await repaint(
          interaction,
          route.locale,
          scope,
          {
            kind: "entry",
            entryId,
            modelRangeIndex: route.action === "model-range" ? route.rangeIndex : 0,
          },
          rangeForEntry(scope, entryId),
        );
        return;
      }

      const selectedValue = (interaction as StringSelectMenuInteraction).values[0];
      const entry = scope.data.entries.find((candidate) => candidate.id === selectedValue);
      if (!entry) {
        await repaint(interaction, route.locale, scope, { kind: "entry" }, 0, changedReceipt(route.locale));
        return;
      }
      await repaint(
        interaction,
        route.locale,
        scope,
        { kind: "entry", entryId: entry.id },
        rangeForEntry(scope, entry.id),
      );
    },
  };
}

export const providersInteractionRoute = createProvidersInteractionRoute();
export const personalProvidersInteractionRoute = createProvidersInteractionRoute(
  { resolveScope: defaultResolvePersonalScope },
  {
    namespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
    authorize: () => true,
    includeBrave: false,
    allowRotation: false,
    allowEndpointActivation: false,
  },
);

export async function buildInitialProvidersPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  resolveScope: ProvidersRouteDependencies["resolveScope"] = defaultResolveScope,
): Promise<InteractionEditReplyOptions> {
  if (!isAuthorized(interaction)) {
    return terminalPayload(locale, "general.errors.permission_denied_description");
  }
  const scope = await resolveScope(interaction, false);
  if (!scope) return terminalPayload(locale, "commands.providers.not_setup");
  return buildProvidersPanelPayload({
    locale,
    entries: scope.data.entries,
    initialEntryId: scope.data.initialEntryId,
    readStatus: scope.data.readStatus,
    page: { kind: "entry" },
    enabledActions: actionsForNamespace(scope.routeNamespace),
    routeNamespace: scope.routeNamespace,
    footerCommand: scope.footerCommand,
  });
}

export async function buildInitialPersonalProvidersPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  resolveScope: ProvidersRouteDependencies["resolveScope"] = defaultResolvePersonalScope,
): Promise<InteractionEditReplyOptions> {
  const scope = await resolveScope(interaction, false);
  if (!scope) return terminalPayload(locale, "commands.providers.not_setup");
  return buildProvidersPanelPayload({
    locale,
    entries: scope.data.entries,
    initialEntryId: scope.data.initialEntryId,
    readStatus: scope.data.readStatus,
    page: { kind: "entry" },
    enabledActions: enabledPersonalProviderActions,
    routeNamespace: PERSONAL_PROVIDERS_ROUTE_NAMESPACE,
    footerCommand: scope.footerCommand,
  });
}
