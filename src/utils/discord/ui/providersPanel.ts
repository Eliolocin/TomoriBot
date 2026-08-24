import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import type {
  ProviderPanelCapabilitySection,
  ProviderPanelEntry,
  ProviderPanelModel,
} from "@/types/discord/providerPanel";
import type { CustomEndpointApiStyle, CustomEndpointCapability } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { escapeDiscordMarkdown, resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import {
  buildProvidersCustomIdForNamespace,
  PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_VERSION,
  type ProvidersRouteNamespace,
} from "@/utils/discord/providersPanelCatalog";
import { buildPanelContainer, buildPanelReceiptContainer, buildRangeChooserComponents } from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getAllProviderChoices, getProviderAddChoiceDescriptionKey } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";

export const PROVIDERS_ENTRIES_PER_SELECTOR_PAGE = 23;
const MAX_MODELS_PER_SELECTOR_PAGE = 19;
export const PROVIDERS_ADD_PROVIDER_VALUE = "action:add-provider";
export const PROVIDERS_ADD_ENDPOINT_VALUE = "action:add-endpoint";

export type AddProviderModalField = "provider" | "api-key";

export function buildAddProviderModalFieldId(field: AddProviderModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildAddProviderModal(
  locale: string,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
  includeBrave = true,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const curatedOptions = getAllProviderChoices()
    .filter((provider) => provider.value !== "custom")
    .map((provider) => {
      const descriptionKey = getProviderAddChoiceDescriptionKey(provider.value);
      return {
        label: safeSelectOptionText(provider.name, 100),
        value: provider.value,
        description: descriptionKey ? safeSelectOptionText(localizer(locale, descriptionKey), 100) : undefined,
      };
    });
  return {
    custom_id: buildProvidersCustomIdForNamespace(routeNamespace, "add-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.providers.add_provider_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.provider_label"), 45),
        description: safeSelectOptionText(
          localizer(
            locale,
            includeBrave
              ? "commands.providers.provider_description"
              : "commands.providers.provider_description_personal",
          ),
          100,
        ),
        component: {
          type: 3,
          custom_id: buildAddProviderModalFieldId("provider", nonce),
          required: true,
          options: [
            ...curatedOptions,
            {
              label: localizer(locale, "commands.providers.provider_elevenlabs"),
              value: "elevenlabs",
              description: localizer(locale, "commands.providers.provider_elevenlabs_description"),
            },
            ...(includeBrave
              ? [
                  {
                    label: localizer(locale, "commands.providers.provider_brave"),
                    value: "brave",
                    description: localizer(locale, "commands.providers.provider_brave_description"),
                  },
                ]
              : []),
          ],
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.api_key_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.api_key_description"), 100),
        component: {
          type: 4,
          custom_id: buildAddProviderModalFieldId("api-key", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(localizer(locale, "commands.providers.api_key_placeholder"), 100),
          min_length: 10,
          max_length: 500,
          required: true,
        },
      },
    ],
  };
}

const ENDPOINT_API_STYLES: Readonly<Record<CustomEndpointCapability, readonly CustomEndpointApiStyle[]>> = {
  text: ["openai-compatible", "ollama-native"],
  embedding: ["openai-compatible", "ollama-native"],
  image: ["openai-compatible", "comfyui"],
  video: ["openai-compatible", "comfyui"],
  speech: ["tts-clone"],
  transcription: ["openai-compatible-transcription"],
};

export type AddEndpointModalField = "label" | "url" | "api-style" | "auth-token";

export function buildAddEndpointModalFieldId(field: AddEndpointModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

function endpointTextInput(
  locale: string,
  nonce: string,
  field: Exclude<AddEndpointModalField, "api-style">,
  required: boolean,
): RawDiscordComponent {
  return {
    type: 18,
    label: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_label`), 45),
    description: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_description`), 100),
    component: {
      type: 4,
      custom_id: buildAddEndpointModalFieldId(field, nonce),
      style: field === "auth-token" ? TextInputStyle.Paragraph : TextInputStyle.Short,
      placeholder: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_placeholder`), 100),
      max_length: field === "label" ? 40 : 500,
      required,
    },
  };
}

export function buildAddEndpointModal(
  locale: string,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildProvidersCustomIdForNamespace(routeNamespace, "endpoint-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.providers.add_endpoint_modal_title"), 45),
    components: [
      endpointTextInput(locale, nonce, "label", true),
      endpointTextInput(locale, nonce, "url", true),
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_api_style_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_api_style_description"), 100),
        component: {
          type: 21,
          custom_id: buildAddEndpointModalFieldId("api-style", nonce),
          required: true,
          options: [...new Set(Object.values(ENDPOINT_API_STYLES).flat())].map((style, index) => ({
            value: style,
            label: localizer(locale, `commands.providers.api_styles.${style}`),
            description: localizer(locale, `commands.providers.api_style_descriptions.${style}`),
            default: index === 0,
          })),
        },
      },
      endpointTextInput(locale, nonce, "auth-token", false),
    ],
  };
}

export type EditProviderModalField = "api-key" | "rotation-key" | "delete-rotation";

export function buildEditProviderModalFieldId(field: EditProviderModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildEditProviderModal(
  locale: string,
  provider: string,
  rotationKeyCount: number,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
  allowRotation = true,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const credentialField = (field: "api-key" | "rotation-key"): RawDiscordComponent => ({
    type: 18,
    label: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_label`), 45),
    description: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_description`), 100),
    component: {
      type: 4,
      custom_id: buildEditProviderModalFieldId(field, nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_placeholder`), 100),
      min_length: 10,
      max_length: 500,
      required: false,
    },
  });
  return {
    custom_id: buildProvidersCustomIdForNamespace(routeNamespace, "edit-provider-submit", locale, provider, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.providers.edit_provider_modal_title"), 45),
    components:
      provider === "brave" || !allowRotation
        ? [credentialField("api-key")]
        : [
            credentialField("api-key"),
            credentialField("rotation-key"),
            {
              type: 18,
              label: safeSelectOptionText(localizer(locale, "commands.providers.delete_rotation_label"), 45),
              description: safeSelectOptionText(
                localizer(locale, "commands.providers.delete_rotation_description", { count: rotationKeyCount }),
                100,
              ),
              component: {
                type: 21,
                custom_id: buildEditProviderModalFieldId("delete-rotation", nonce),
                required: true,
                options: [
                  { value: "keep", label: localizer(locale, "commands.providers.delete_rotation_keep"), default: true },
                  { value: "delete", label: localizer(locale, "commands.providers.delete_rotation_confirm") },
                ],
              },
            },
          ],
  };
}

export interface EditEndpointModalContext {
  connectionId: number;
  label: string;
  endpointUrl: string;
  apiStyles: string[];
  isPreset: boolean;
}

export type EditEndpointModalField = "label" | "url" | "auth-token";

export function buildEditEndpointModalFieldId(field: EditEndpointModalField, nonce: string): string {
  return `edit-${field}_${nonce}`;
}

export function buildEditEndpointModal(
  locale: string,
  context: EditEndpointModalContext,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = context.isPreset
    ? [
        {
          type: 10,
          content: localizer(locale, "commands.providers.preset_endpoint_read_only", {
            label: context.label,
            url: context.endpointUrl,
            formats: context.apiStyles.join(", "),
          }),
        },
      ]
    : [
        {
          type: 18,
          label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_label_label"), 45),
          description: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_label_description"), 100),
          component: {
            type: 4,
            custom_id: buildEditEndpointModalFieldId("label", nonce),
            style: TextInputStyle.Short,
            value: context.label,
            min_length: 1,
            max_length: 40,
            required: true,
          },
        },
        {
          type: 18,
          label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_url_label"), 45),
          description: safeSelectOptionText(localizer(locale, "commands.providers.edit_endpoint_url_description"), 100),
          component: {
            type: 4,
            custom_id: buildEditEndpointModalFieldId("url", nonce),
            style: TextInputStyle.Short,
            value: context.endpointUrl,
            placeholder: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_url_placeholder"), 100),
            max_length: 500,
            required: true,
          },
        },
      ];
  components.push({
    type: 18,
    label: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_label"), 45),
    description: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_description"), 100),
    component: {
      type: 4,
      custom_id: buildEditEndpointModalFieldId("auth-token", nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_placeholder"), 100),
      max_length: 500,
      required: false,
    },
  });
  return {
    custom_id: buildProvidersCustomIdForNamespace(
      routeNamespace,
      "edit-endpoint-submit",
      locale,
      context.connectionId,
      nonce,
    ),
    title: safeSelectOptionText(localizer(locale, "commands.providers.edit_endpoint_modal_title"), 45),
    components,
  };
}

export type ProvidersPanelPage =
  | { kind: "entry"; entryId?: string }
  | { kind: "entry-chooser"; chooserPage?: number }
  | { kind: "add-provider" }
  | { kind: "models"; entryId: string; rangeIndex?: number }
  | { kind: "remove"; entryId: string };

export type ProviderModelModalField = "code-name" | "num-ctx" | "flags" | "workflow";

export function buildProviderModelModalFieldId(field: ProviderModelModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

function entryRouteSegments(entry: ProviderPanelEntry): ["provider" | "endpoint", string] | null {
  if (entry.kind === "provider") return ["provider", entry.provider];
  if (entry.kind === "endpoint") return ["endpoint", String(entry.connectionIds[0])];
  return null;
}

function removalRouteSegments(entry: ProviderPanelEntry): ["provider" | "endpoint" | "brave", string] {
  if (entry.kind === "provider") return ["provider", entry.provider];
  if (entry.kind === "endpoint") return ["endpoint", String(entry.connectionIds[0] ?? 0)];
  return ["brave", "brave"];
}

export function buildProviderModelModal(
  locale: string,
  entryKind: "provider" | "endpoint",
  entryKey: string,
  capability: ProviderPanelCapabilitySection["capability"],
  editingModelId: number | null,
  nonce: string,
  textDefaults?: ProviderPanelModel["textSettings"],
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = [
    {
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_code_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_code_description"), 100),
      component: {
        type: 4,
        custom_id: buildProviderModelModalFieldId("code-name", nonce),
        style: TextInputStyle.Short,
        placeholder: safeSelectOptionText(
          localizer(locale, `commands.providers.model_code_placeholders.${capability}`),
          100,
        ),
        min_length: 1,
        max_length: 200,
        required: true,
      },
    },
  ];
  if (capability === "text" && entryKind === "endpoint") {
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_num_ctx_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_num_ctx_description"), 100),
      component: {
        type: 4,
        custom_id: buildProviderModelModalFieldId("num-ctx", nonce),
        style: TextInputStyle.Short,
        placeholder: "8192",
        value: textDefaults?.numCtx ? String(textDefaults.numCtx) : undefined,
        max_length: 8,
        required: false,
      },
    });
  }
  if (capability === "text") {
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_flags_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_flags_description"), 100),
      component: {
        type: 22,
        custom_id: buildProviderModelModalFieldId("flags", nonce),
        min_values: 0,
        max_values: 5,
        required: false,
        options: [
          ["tools", textDefaults?.hasTools],
          ["images", textDefaults?.seesImages],
          ["structured", textDefaults?.supportsStructOutput],
          ["strict-roles", textDefaults?.strictRoleAlternation],
          ["prefix", textDefaults?.supportsPrefixCompletion],
        ].map(([value, selected]) => ({
          value: String(value),
          label: localizer(locale, `commands.providers.model_flags.${String(value)}`),
          default: Boolean(selected),
        })),
      },
    });
  }
  if (capability === "image" || capability === "video") {
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_workflow_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_workflow_description"), 100),
      component: {
        type: 19,
        custom_id: buildProviderModelModalFieldId("workflow", nonce),
        min_values: 0,
        max_values: 1,
        required: false,
      },
    });
  }
  return {
    custom_id: buildProvidersCustomIdForNamespace(
      routeNamespace,
      "model-submit",
      locale,
      entryKind,
      entryKey,
      capability,
      editingModelId ?? 0,
      nonce,
    ),
    title: safeSelectOptionText(
      localizer(
        locale,
        editingModelId ? "commands.providers.edit_model_modal_title" : "commands.providers.add_model_modal_title",
      ),
      45,
    ),
    components,
  };
}

export interface ProvidersPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface ProvidersPanelRenderInput {
  locale: string;
  entries: ProviderPanelEntry[];
  initialEntryId: string | null;
  readStatus: PanelReadStatus;
  page: ProvidersPanelPage;
  rangeIndex?: number;
  receipt?: PanelReceipt;
  enabledActions?: ReadonlySet<"add-provider" | "add-endpoint" | "model" | "edit" | "remove">;
  routeNamespace?: ProvidersRouteNamespace;
  footerCommand?: { root: string; subcommandGroup?: string; subcommand?: string };
}

function buildRetryRow(locale: string, routeNamespace: ProvidersRouteNamespace): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildProvidersCustomIdForNamespace(routeNamespace, "retry", locale),
        label: localizer(locale, "commands.providers.retry"),
      },
    ],
  };
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): ProvidersPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildModelLine(locale: string, model: ProviderPanelModel, routeNamespace: ProvidersRouteNamespace): string {
  const markers: string[] = [];
  const personal = routeNamespace !== PROVIDERS_ROUTE_NAMESPACE;
  if (model.isWorkspaceActive) {
    markers.push(
      localizer(
        locale,
        personal ? "commands.providers.marker_personal_active" : "commands.providers.marker_workspace_active",
      ),
    );
  }
  if (model.isWorkspaceFallback) {
    markers.push(
      localizer(
        locale,
        personal ? "commands.providers.marker_personal_fallback" : "commands.providers.marker_workspace_fallback",
      ),
    );
  }
  if (model.isProviderFallback) markers.push(localizer(locale, "commands.providers.marker_provider_fallback"));
  if (model.isCustomRegistration) {
    markers.push(localizer(locale, "commands.providers.marker_custom_registration"));
  }
  const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
  const codeName = model.codeName.replaceAll("`", "ˋ").replaceAll(/\s+/g, " ").trim();
  return `> \`${codeName}\`${suffix}`;
}

function buildCapabilitySection(
  locale: string,
  section: ProviderPanelCapabilitySection,
  routeNamespace: ProvidersRouteNamespace,
): string {
  const label = localizer(locale, `commands.providers.capabilities.${section.capability}`);
  if (section.availability === "unavailable") {
    return `**${label}**\n${localizer(locale, "commands.providers.capability_unavailable")}`;
  }
  if (section.models.length === 0) {
    return `**${label}**\n${localizer(locale, "commands.providers.capability_empty")}`;
  }
  return [
    `**${label}**`,
    localizer(locale, "commands.providers.capability_models_explanation"),
    ...section.models.map((model) => buildModelLine(locale, model, routeNamespace)),
  ].join("\n");
}

function buildEntryBody(locale: string, entry: ProviderPanelEntry, routeNamespace: ProvidersRouteNamespace): string {
  if (entry.kind === "brave") {
    return [
      localizer(locale, "commands.providers.brave_description"),
      `> ${localizer(locale, "commands.providers.brave_configured")}`,
    ].join("\n");
  }

  return entry.capabilities.map((section) => buildCapabilitySection(locale, section, routeNamespace)).join("\n\n");
}

function buildEntryActions(
  locale: string,
  entry: ProviderPanelEntry,
  readStatus: PanelReadStatus,
  enabledActions: ProvidersPanelRenderInput["enabledActions"],
  routeNamespace: ProvidersRouteNamespace,
): ActionRowData<ButtonComponentData> {
  const unavailable = readStatus !== "fresh";
  const buttons: ButtonComponentData[] = [];
  if (entry.kind !== "brave") {
    const routeSegments = entryRouteSegments(entry);
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: routeSegments
        ? buildProvidersCustomIdForNamespace(routeNamespace, "model-open", locale, ...routeSegments)
        : buildProvidersCustomIdForNamespace(routeNamespace, "retry", locale),
      label: localizer(locale, "commands.providers.add_or_edit_model"),
      disabled: unavailable || !enabledActions?.has("model"),
    });
  }
  buttons.push(
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId:
        entry.kind === "endpoint"
          ? buildProvidersCustomIdForNamespace(
              routeNamespace,
              "edit-endpoint-open",
              locale,
              entry.connectionIds[0] ?? 0,
            )
          : entry.kind === "provider"
            ? buildProvidersCustomIdForNamespace(
                routeNamespace,
                "edit-provider-open",
                locale,
                entry.provider,
                entry.rotationKeyCount,
              )
            : buildProvidersCustomIdForNamespace(routeNamespace, "edit-provider-open", locale, "brave", 0),
      label:
        entry.kind === "endpoint"
          ? localizer(locale, "commands.providers.edit_endpoint")
          : localizer(locale, "commands.providers.edit_provider"),
      disabled: unavailable || !enabledActions?.has("edit"),
    },
    {
      type: ComponentType.Button,
      style: ButtonStyle.Danger,
      customId: buildProvidersCustomIdForNamespace(
        routeNamespace,
        "remove-prompt",
        locale,
        ...removalRouteSegments(entry),
      ),
      label: localizer(locale, "commands.providers.remove"),
      disabled: unavailable || !enabledActions?.has("remove"),
    },
  );
  return { type: ComponentType.ActionRow, components: buttons };
}

function buildModelsPage(
  locale: string,
  entry: ProviderPanelEntry,
  readStatus: PanelReadStatus,
  rangeIndex = 0,
  routeNamespace: ProvidersRouteNamespace,
): ComponentInContainerData[] {
  const routeSegments = entryRouteSegments(entry);
  if (!routeSegments || entry.kind === "brave") return [];
  const customModels = entry.capabilities.flatMap((section) =>
    section.models
      .filter((model) => model.isCustomRegistration)
      .map((model) => ({ capability: section.capability, model })),
  );
  const selection = resolveRangeSelection(customModels, rangeIndex, MAX_MODELS_PER_SELECTOR_PAGE);
  const addOptions: SelectMenuComponentOptionData[] = (
    ["text", "image", "embedding", "video", "speech", "transcription"] as const
  ).map((capability) => ({
    label: safeSelectOptionText(
      localizer(locale, "commands.providers.add_capability_model", {
        capability: localizer(locale, `commands.providers.capabilities.${capability}`),
      }),
      100,
    ),
    value: `add:${capability}`,
  }));
  const options: SelectMenuComponentOptionData[] = [
    ...addOptions,
    ...selection.visibleItems.map(({ capability, model }) => ({
      label: safeSelectOptionText(model.codeName, 100),
      value: `edit:${capability}:${model.id}`,
      description: safeSelectOptionText(
        `${localizer(locale, `commands.providers.capabilities.${capability}`)} · ${localizer(
          locale,
          "commands.providers.marker_custom_registration",
        )}`,
        100,
      ),
    })),
  ];
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.providers.manage_models_title", { provider: entry.displayName })}\n${localizer(
        locale,
        "commands.providers.manage_models_description",
      )}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildProvidersCustomIdForNamespace(routeNamespace, "model-select", locale, ...routeSegments),
          placeholder: localizer(locale, "commands.providers.manage_models_placeholder"),
          options,
          disabled: readStatus !== "fresh",
        },
      ],
    },
  ];
  if (selection.rangeCount > 1) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildProvidersCustomIdForNamespace(
            routeNamespace,
            "model-range",
            locale,
            ...routeSegments,
            Math.max(0, selection.rangeIndex - 1),
          ),
          label: localizer(locale, "general.pagination.previous"),
          disabled: selection.rangeIndex === 0,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildProvidersCustomIdForNamespace(
            routeNamespace,
            "model-range",
            locale,
            ...routeSegments,
            selection.rangeIndex + 1,
          ),
          label: localizer(locale, "general.pagination.next"),
          disabled: selection.rangeIndex >= selection.rangeCount - 1,
        },
      ],
    });
  }
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildProvidersCustomIdForNamespace(routeNamespace, "model-close", locale, ...routeSegments),
        label: localizer(locale, "commands.providers.back_to_provider"),
      },
    ],
  });
  return components;
}

function selectedEntryId(input: ProvidersPanelRenderInput): string | null {
  if (input.page.kind === "entry") return input.page.entryId ?? input.initialEntryId;
  if (input.page.kind === "remove") return input.page.entryId;
  if (input.page.kind === "models") return input.page.entryId;
  return null;
}

export function buildProvidersPanelPayload(input: ProvidersPanelRenderInput): ProvidersPanelPayload {
  const { locale, entries, readStatus } = input;
  const routeNamespace = input.routeNamespace ?? PROVIDERS_ROUTE_NAMESPACE;
  const titleKey =
    routeNamespace === PROVIDERS_ROUTE_NAMESPACE ? "commands.providers.title" : "commands.providers.personal_title";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, titleKey)}\n${localizer(locale, "commands.providers.selector_guidance")}`,
    },
  ];

  if (readStatus === "unavailable") {
    components.push(
      { type: ComponentType.TextDisplay, content: localizer(locale, "commands.providers.unavailable") },
      buildRetryRow(locale, routeNamespace),
    );
    return buildPayload(components, input.receipt);
  }

  const selectedId = selectedEntryId(input);
  const selectedIndex = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1;
  const implicitRangeIndex = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / PROVIDERS_ENTRIES_PER_SELECTOR_PAGE);
  const selection = resolveRangeSelection(
    entries,
    input.rangeIndex ?? implicitRangeIndex,
    PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
  );
  const options: SelectMenuComponentOptionData[] = [
    {
      label: localizer(locale, "commands.providers.select_add_provider"),
      value: PROVIDERS_ADD_PROVIDER_VALUE,
      description: localizer(locale, "commands.providers.select_add_provider_description"),
      default: input.page.kind === "add-provider",
    },
    {
      label: localizer(locale, "commands.providers.select_add_endpoint"),
      value: PROVIDERS_ADD_ENDPOINT_VALUE,
      description: localizer(locale, "commands.providers.select_add_endpoint_description"),
    },
    ...selection.visibleItems.map((entry) => ({
      label: safeSelectOptionText(entry.displayName, 100),
      value: entry.id,
      description: localizer(locale, `commands.providers.entry_kind_${entry.kind}`),
      default: entry.id === selectedId,
    })),
  ];
  const selectRow: ActionRowData<StringSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildProvidersCustomIdForNamespace(routeNamespace, "select", locale),
        placeholder: localizer(locale, "commands.providers.select_placeholder"),
        options,
        disabled: readStatus !== "fresh",
      },
    ],
  };
  components.push(selectRow);

  if (selection.rangeCount > 1) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildProvidersCustomIdForNamespace(routeNamespace, "range-open", locale),
          label: localizer(locale, "general.pagination.select_page_title"),
        },
      ],
    });
  }

  components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
  if (input.page.kind === "entry-chooser") {
    components.push(
      ...buildRangeChooserComponents({
        locale,
        totalCount: entries.length,
        pageSize: PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
        chooserPage: input.page.chooserPage,
        namespace: routeNamespace,
        version: PROVIDERS_ROUTE_VERSION,
        buildSegments: {
          range: (rangeIndex) => ["range", locale, String(rangeIndex)],
          previous: (targetPage) => ["range-page", locale, String(targetPage)],
          next: (targetPage) => ["range-page", locale, String(targetPage)],
          cancel: () => ["range-cancel", locale],
        },
      }),
    );
  } else if (input.page.kind === "remove") {
    const removalPage = input.page;
    const entry = entries.find((candidate) => candidate.id === removalPage.entryId);
    if (entry) {
      const routeSegments = removalRouteSegments(entry);
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.providers.remove_title")}
${localizer(locale, `commands.providers.remove_impact_${entry.kind}`, {
  name: escapeDiscordMarkdown(entry.displayName),
})}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildProvidersCustomIdForNamespace(routeNamespace, "remove-confirm", locale, ...routeSegments),
              label: localizer(locale, "commands.providers.remove_confirm"),
              disabled: readStatus !== "fresh",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildProvidersCustomIdForNamespace(routeNamespace, "remove-cancel", locale, ...routeSegments),
              label: localizer(locale, "commands.providers.cancel"),
            },
          ],
        },
      );
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.providers.changed_receipt_detail"),
      });
    }
  } else if (input.page.kind === "models") {
    const modelPage = input.page;
    const entry = entries.find((candidate) => candidate.id === modelPage.entryId);
    if (entry) components.push(...buildModelsPage(locale, entry, readStatus, modelPage.rangeIndex, routeNamespace));
    else
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.providers.changed_receipt_detail"),
      });
  } else if (input.page.kind === "add-provider") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.providers.select_add_provider")}\n${localizer(
        locale,
        "commands.providers.read_only_action_pending",
      )}`,
    });
  } else {
    const entry = entries.find((candidate) => candidate.id === selectedId) ?? entries[0];
    if (entry) {
      components.push(
        { type: ComponentType.TextDisplay, content: buildEntryBody(locale, entry, routeNamespace) },
        buildEntryActions(locale, entry, readStatus, input.enabledActions, routeNamespace),
      );
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.providers.empty_heading")}\n${localizer(
          locale,
          "commands.providers.empty_description",
        )}`,
      });
    }
  }

  components.push(
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, "commands.providers.routing_hint", {
        command: commandRegistry.getCommandMention(
          input.footerCommand?.root ?? "model",
          input.footerCommand?.subcommandGroup ?? input.footerCommand?.subcommand ?? "text",
          input.footerCommand?.subcommandGroup ? input.footerCommand.subcommand : undefined,
        ),
      })}`,
    },
  );

  if (readStatus === "stale") {
    components.push(buildRetryRow(locale, routeNamespace), {
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, "commands.providers.stale_warning")}`,
    });
  }
  return buildPayload(components, input.receipt);
}
