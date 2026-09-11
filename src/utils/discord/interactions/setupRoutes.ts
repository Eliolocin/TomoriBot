import { MessageFlags, PermissionsBitField, type ChatInputCommandInteraction, type Client } from "discord.js";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  isSetupDraftComplete,
  type SetupDraftContext,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import {
  consumeSetupDraft,
  readSetupDraft,
  storeSetupDraft,
  updateSetupDraft,
} from "@/utils/discord/interactions/setupDraftStore";
import {
  buildInteractionRouteId,
  parseInteractionRoute,
  type GlobalInteractionRoute,
  type GlobalRoutableInteraction,
  type ParsedInteractionRoute,
} from "@/utils/discord/interactions/routeRegistry";
import {
  SETUP_ENDPOINT_API_STYLES,
  buildSetupByokModal,
  buildSetupByokModalFieldId,
  buildSetupCancelledPayload,
  buildSetupCatalogModal,
  buildSetupCatalogModalFieldId,
  buildSetupEndpointConnectionModal,
  buildSetupEndpointConnectionModalFieldId,
  buildSetupEndpointModelModal,
  buildSetupEndpointModelModalFieldId,
  buildSetupExpiredPayload,
  buildSetupWizardPayload,
  getSetupCatalogProviderChoices,
} from "@/utils/discord/ui/setupPanel";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import {
  acknowledgeModalSubmitForRefresh,
  showRoutedRawModal,
  takeRawModalCheckboxGroupValues,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";
import {
  setupCustomEndpointCapabilitySchema,
  type CustomEndpointApiStyle,
  type SetupCustomEndpointCapability,
} from "@/types/db/schema";
import {
  normalizeCustomEndpointUrlForStorage,
  validateCustomEndpointReachability,
} from "@/utils/provider/customEndpointService";
import { ProviderFactory } from "@/utils/provider/providerFactory";
import { encryptApiKey } from "@/utils/security/crypto";
import { parseNonce } from "@/utils/discord/panelRouteCodec";
import { createNonce, parseLocale } from "@/utils/discord/panelRouteTokens";
import { isHostedPolicyEnvironment } from "@/utils/misc/hostedPolicy";
import { serverRepository } from "@/utils/db/repositories";
import { getCachedMainPersona } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";

function parseNumCtxField(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) || parsed < 512 ? null : parsed;
}

export const SETUP_ROUTE_NAMESPACE = "setup";
export const SETUP_ROUTE_VERSION = "v1";

export type SetupWizardAction =
  | "dashboard"
  | "cancel"
  | "policies"
  | "provider"
  | "settings"
  | "provider-mode"
  | "provider-catalog-submit"
  | "provider-byok-submit"
  | "endpoint-connection"
  | "endpoint-connection-submit"
  | "endpoint-model"
  | "endpoint-model-submit"
  | "finish";

const SETUP_WIZARD_ACTIONS = new Set<SetupWizardAction>([
  "dashboard",
  "cancel",
  "policies",
  "provider",
  "settings",
  "provider-mode",
  "provider-catalog-submit",
  "provider-byok-submit",
  "endpoint-connection",
  "endpoint-connection-submit",
  "endpoint-model",
  "endpoint-model-submit",
  "finish",
]);

export interface SetupWizardRoute {
  action: SetupWizardAction;
  locale: string;
  nonce: string;
}

export function buildSetupRouteId(route: SetupWizardRoute): string {
  return buildInteractionRouteId(SETUP_ROUTE_NAMESPACE, SETUP_ROUTE_VERSION, route.action, route.locale, route.nonce);
}

export function parseSetupRoute(input: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = typeof input === "string" ? parseInteractionRoute(input) : input;
  if (!parsed || parsed.namespace !== SETUP_ROUTE_NAMESPACE || parsed.version !== SETUP_ROUTE_VERSION) {
    return null;
  }
  const [action, rawLocale, rawNonce] = parsed.segments;
  if (!action || !rawLocale || !rawNonce) return null;
  if (!SETUP_WIZARD_ACTIONS.has(action as SetupWizardAction)) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const nonce = parseNonce(rawNonce);
  if (!nonce) return null;

  return { action: action as SetupWizardAction, locale, nonce };
}

export function buildSetupDashboardRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "dashboard", locale: input.locale, nonce: input.nonce });
}

export function parseSetupDashboardRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "dashboard" ? parsed : null;
}

export function buildSetupCancelRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "cancel", locale: input.locale, nonce: input.nonce });
}

export function parseSetupCancelRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "cancel" ? parsed : null;
}

export function buildSetupPoliciesRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "policies", locale: input.locale, nonce: input.nonce });
}

export function parseSetupPoliciesRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "policies" ? parsed : null;
}

export function buildSetupProviderRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "provider", locale: input.locale, nonce: input.nonce });
}

export function parseSetupProviderRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "provider" ? parsed : null;
}

export function buildSetupSettingsRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "settings", locale: input.locale, nonce: input.nonce });
}

export function parseSetupSettingsRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "settings" ? parsed : null;
}

export function buildSetupProviderModeRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "provider-mode", locale: input.locale, nonce: input.nonce });
}

export function parseSetupProviderModeRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "provider-mode" ? parsed : null;
}

export function buildSetupProviderCatalogSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "provider-catalog-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupProviderCatalogSubmitRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "provider-catalog-submit" ? parsed : null;
}

export function buildSetupProviderByokSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "provider-byok-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupProviderByokSubmitRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "provider-byok-submit" ? parsed : null;
}

export function buildSetupEndpointConnectionRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "endpoint-connection", locale: input.locale, nonce: input.nonce });
}

export function parseSetupEndpointConnectionRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "endpoint-connection" ? parsed : null;
}

export function buildSetupEndpointConnectionSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "endpoint-connection-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupEndpointConnectionSubmitRoute(
  route: ParsedInteractionRoute | string,
): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "endpoint-connection-submit" ? parsed : null;
}

export function buildSetupEndpointModelRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "endpoint-model", locale: input.locale, nonce: input.nonce });
}

export function parseSetupEndpointModelRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "endpoint-model" ? parsed : null;
}

export function buildSetupEndpointModelSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "endpoint-model-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupEndpointModelSubmitRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "endpoint-model-submit" ? parsed : null;
}

export function buildSetupFinishRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "finish", locale: input.locale, nonce: input.nonce });
}

export function parseSetupFinishRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "finish" ? parsed : null;
}

export async function isWorkspaceAlreadySetup(workspaceKey: string): Promise<boolean> {
  const serverId = await serverRepository.loadServerIdByDiscId(workspaceKey);
  if (!serverId) return false;
  const mainPersona = await getCachedMainPersona(workspaceKey);
  return mainPersona !== null;
}

export interface SetupWizardDependencies {
  isSetupAuthorized: (interaction: ChatInputCommandInteraction) => boolean;
  checkExistingSetup: (workspaceKey: string) => Promise<boolean>;
  createNonce: () => string;
  isHostedPolicyEnvironment: () => boolean;
  storeSetupDraft: typeof storeSetupDraft;
}

export async function startSetupWizard(
  interaction: ChatInputCommandInteraction,
  dependencies: Partial<SetupWizardDependencies> = {},
): Promise<void> {
  const locale = interaction.locale ?? interaction.guildLocale ?? "en-US";
  const workspaceKey = interaction.guildId ?? interaction.user.id;
  const context: SetupDraftContext = interaction.guildId ? "guild" : "dm";

  // Acknowledged before the existing-setup lookup, not after it: Discord drops an interaction that is not
  // acknowledged within three seconds, and that lookup can miss its cache and reach the database.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAuthorized = dependencies.isSetupAuthorized
    ? dependencies.isSetupAuthorized(interaction)
    : !interaction.guildId || (interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false);

  if (!isAuthorized) {
    await interaction.editReply({
      content: localizer(locale, "commands.setup.wizard.permission_denied"),
    });
    return;
  }

  const alreadySetup = dependencies.checkExistingSetup
    ? await dependencies.checkExistingSetup(workspaceKey)
    : await isWorkspaceAlreadySetup(workspaceKey);

  if (alreadySetup) {
    await interaction.editReply({
      content: localizer(locale, "commands.setup.already_setup_description"),
    });
    return;
  }

  const nonce = (dependencies.createNonce ?? createNonce)();
  const requiresPolicies = (dependencies.isHostedPolicyEnvironment ?? isHostedPolicyEnvironment)();
  const record: SetupDraftRecord = {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: interaction.user.id,
    workspaceKey,
    context,
    providerAccess: null,
    startingSettings: null,
    policiesAccepted: false,
    requiresPolicies,
  };
  (dependencies.storeSetupDraft ?? storeSetupDraft)(nonce, record);

  const payload = buildSetupWizardPayload({
    draft: record,
    locale,
    isHosted: requiresPolicies,
    nonce,
  });
  await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
}

export const setupInteractionRoute: GlobalInteractionRoute = {
  namespace: SETUP_ROUTE_NAMESPACE,
  version: SETUP_ROUTE_VERSION,
  async execute(_client: Client, interaction: GlobalRoutableInteraction, route: ParsedInteractionRoute): Promise<void> {
    const parsed = parseSetupRoute(route);
    if (!parsed) return;

    const { action, locale, nonce } = parsed;
    const actorDiscId = interaction.user.id;
    const workspaceKey = interaction.guildId ?? interaction.user.id;
    const context: SetupDraftContext = interaction.guildId ? "guild" : "dm";

    const readResult = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
    if (readResult.status === "missing") {
      const expiredPayload = buildSetupExpiredPayload(locale);
      await deliverGuardedPanel(interaction, expiredPayload, { locale, method: "update" });
      return;
    }

    if (readResult.status === "forbidden") {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: localizer(locale, "commands.setup.wizard.forbidden"),
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    const draft = readResult.draft;

    if (context === "guild") {
      const isAuthorized = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false;
      if (!isAuthorized) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: localizer(locale, "commands.setup.wizard.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }
    }

    if (isHostedPolicyEnvironment() !== draft.requiresPolicies) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: localizer(locale, "commands.setup.wizard.env_mismatch"),
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    switch (action) {
      case "cancel": {
        consumeSetupDraft(nonce, actorDiscId, workspaceKey, context);
        const cancelledPayload = buildSetupCancelledPayload(locale);
        await deliverGuardedPanel(interaction, cancelledPayload, { locale, method: "update" });
        break;
      }

      case "dashboard": {
        const payload = buildSetupWizardPayload({
          draft,
          locale,
          isHosted: draft.requiresPolicies,
          nonce,
        });
        await deliverGuardedPanel(interaction, payload, { locale, method: "update" });
        break;
      }

      case "policies":
      case "provider":
      case "settings": {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: localizer(locale, "commands.setup.wizard.step_unavailable"),
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case "provider-mode": {
        if (!interaction.isStringSelectMenu()) {
          return;
        }
        const selectedMode = interaction.values[0];
        if (selectedMode === "catalog") {
          const modalPayload = buildSetupCatalogModal(locale, nonce);
          await showRoutedRawModal(interaction, modalPayload);
          return;
        }
        if (selectedMode === "custom-endpoint") {
          updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
            providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
          });
          const updated = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
          if (updated.status === "ok") {
            const payload = buildSetupWizardPayload({
              draft: updated.draft,
              locale,
              isHosted: draft.requiresPolicies,
              nonce,
            });
            await deliverGuardedPanel(interaction, payload, { locale, method: "update" });
          }
          return;
        }
        if (selectedMode === "user-byok") {
          if (context === "dm") {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({
                content: localizer(locale, "commands.setup.wizard.provider_byok_guild_only"),
                flags: MessageFlags.Ephemeral,
              });
            }
            return;
          }
          const modalPayload = buildSetupByokModal(locale, nonce);
          await showRoutedRawModal(interaction, modalPayload);
          return;
        }
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: localizer(locale, "commands.setup.wizard.provider_invalid"),
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case "provider-catalog-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        const providerFieldId = buildSetupCatalogModalFieldId("provider", nonce);
        const apiKeyFieldId = buildSetupCatalogModalFieldId("api-key", nonce);

        const selectedProvider = takeRawModalSelectValue(interaction.id, providerFieldId);
        const apiKey = interaction.fields.getTextInputValue(apiKeyFieldId);

        const curatedProviders = new Set(getSetupCatalogProviderChoices().map((choice) => choice.value));

        if (!selectedProvider || !curatedProviders.has(selectedProvider)) {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.provider_invalid"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        let providerInstance: Awaited<ReturnType<typeof ProviderFactory.getProviderByName>>;
        try {
          providerInstance = await ProviderFactory.getProviderByName(selectedProvider);
        } catch {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.provider_validation_failed"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        const validation = await providerInstance.validateApiKey(apiKey);
        if (!validation.valid) {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.provider_validation_failed"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        const encryption = await encryptApiKey(apiKey);
        updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
          providerAccess: {
            mode: "catalog",
            provider: selectedProvider,
            encryptedApiKey: encryption.encrypted,
            keyVersion: encryption.version,
          },
        });

        const updated = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
        if (updated.status === "ok") {
          const payload = buildSetupWizardPayload({
            draft: updated.draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
        }
        break;
      }

      case "provider-byok-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        if (context === "dm") {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.provider_byok_guild_only"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        const confirmFieldId = buildSetupByokModalFieldId("confirm", nonce);
        const selectedConfirm = takeRawModalSelectValue(interaction.id, confirmFieldId);

        if (selectedConfirm !== "yes" && selectedConfirm !== "no") {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.byok_choice_invalid"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        if (selectedConfirm === "yes") {
          updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
            providerAccess: { mode: "user-byok" },
          });
          const updated = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
          if (updated.status === "ok") {
            const payload = buildSetupWizardPayload({
              draft: updated.draft,
              locale,
              isHosted: draft.requiresPolicies,
              nonce,
            });
            await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          }
          return;
        }

        // On no, repaint without updating the draft so any prior access stays intact.
        const payload = buildSetupWizardPayload({
          draft,
          locale,
          isHosted: draft.requiresPolicies,
          nonce,
        });
        await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
        return;
      }

      case "endpoint-connection": {
        if (interaction.isModalSubmit()) {
          return;
        }
        if (draft.providerAccess?.mode !== "custom-endpoint") {
          return;
        }
        const modalPayload = buildSetupEndpointConnectionModal(locale, nonce, draft.providerAccess.connection);
        await showRoutedRawModal(interaction, modalPayload);
        return;
      }

      case "endpoint-connection-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        if (draft.providerAccess?.mode !== "custom-endpoint") {
          return;
        }

        const apiStyleFieldId = buildSetupEndpointConnectionModalFieldId("api-style", nonce);
        const selectedApiStyle = takeRawModalSelectValue(interaction.id, apiStyleFieldId);
        const validStyles = new Set<string>(SETUP_ENDPOINT_API_STYLES);

        if (!selectedApiStyle || !validStyles.has(selectedApiStyle)) {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.custom_endpoint_api_style_invalid"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        const labelFieldId = buildSetupEndpointConnectionModalFieldId("label", nonce);
        const urlFieldId = buildSetupEndpointConnectionModalFieldId("url", nonce);
        const authTokenFieldId = buildSetupEndpointConnectionModalFieldId("auth-token", nonce);

        const label = interaction.fields.getTextInputValue(labelFieldId)?.trim() ?? "";
        const rawUrl = interaction.fields.getTextInputValue(urlFieldId)?.trim() ?? "";
        let rawToken: string | undefined;
        try {
          rawToken = interaction.fields.getTextInputValue(authTokenFieldId)?.trim();
        } catch {
          rawToken = undefined;
        }

        const normalizedUrl = normalizeCustomEndpointUrlForStorage(selectedApiStyle as CustomEndpointApiStyle, rawUrl);

        const probe = await validateCustomEndpointReachability({
          apiStyle: selectedApiStyle as CustomEndpointApiStyle,
          endpointUrl: normalizedUrl,
          apiKey: rawToken || null,
        });

        if (!probe.ok) {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.custom_endpoint_unreachable"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        let encryptedAuthToken: Buffer | null = null;
        let keyVersion = 1;
        if (rawToken) {
          const encryption = await encryptApiKey(rawToken);
          encryptedAuthToken = encryption.encrypted;
          keyVersion = encryption.version;
        }

        // Saving a connection voids any prior text model because compatibility declarations depend on the API style.
        updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
          providerAccess: {
            mode: "custom-endpoint",
            connection: {
              label,
              apiStyle: selectedApiStyle as CustomEndpointApiStyle,
              endpointUrl: normalizedUrl,
              encryptedAuthToken,
              keyVersion,
            },
            textModel: null,
          },
        });

        const updated = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
        if (updated.status === "ok") {
          const payload = buildSetupWizardPayload({
            draft: updated.draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
        }
        break;
      }

      case "endpoint-model": {
        if (interaction.isModalSubmit()) {
          return;
        }
        if (draft.providerAccess?.mode !== "custom-endpoint" || !draft.providerAccess.connection) {
          return;
        }
        const modalPayload = buildSetupEndpointModelModal(locale, nonce, draft.providerAccess.textModel);
        await showRoutedRawModal(interaction, modalPayload);
        return;
      }

      case "endpoint-model-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        if (draft.providerAccess?.mode !== "custom-endpoint" || !draft.providerAccess.connection) {
          return;
        }

        const modelCodeFieldId = buildSetupEndpointModelModalFieldId("model-code", nonce);
        const numCtxFieldId = buildSetupEndpointModelModalFieldId("num-ctx", nonce);
        const capabilitiesFieldId = buildSetupEndpointModelModalFieldId("capabilities", nonce);

        const modelCode = interaction.fields.getTextInputValue(modelCodeFieldId)?.trim();
        if (!modelCode) {
          const payload = buildSetupWizardPayload({
            draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
            notice: localizer(locale, "commands.setup.wizard.custom_endpoint_model_invalid"),
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
          return;
        }

        let rawNumCtx: string | undefined;
        try {
          rawNumCtx = interaction.fields.getTextInputValue(numCtxFieldId);
        } catch {
          rawNumCtx = undefined;
        }
        const numCtx = parseNumCtxField(rawNumCtx);

        const rawCapabilities = takeRawModalCheckboxGroupValues(interaction.id, capabilitiesFieldId) ?? [];
        for (const cap of rawCapabilities) {
          if (!setupCustomEndpointCapabilitySchema.safeParse(cap).success) {
            const payload = buildSetupWizardPayload({
              draft,
              locale,
              isHosted: draft.requiresPolicies,
              nonce,
              notice: localizer(locale, "commands.setup.wizard.custom_endpoint_model_invalid"),
            });
            await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
            return;
          }
        }

        updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
          providerAccess: {
            mode: "custom-endpoint",
            connection: draft.providerAccess.connection,
            textModel: {
              modelCode,
              numCtx,
              capabilities: rawCapabilities as SetupCustomEndpointCapability[],
            },
          },
        });

        const updated = readSetupDraft(nonce, actorDiscId, workspaceKey, context);
        if (updated.status === "ok") {
          const payload = buildSetupWizardPayload({
            draft: updated.draft,
            locale,
            isHosted: draft.requiresPolicies,
            nonce,
          });
          await deliverGuardedPanel(interaction, payload, { locale, method: "editReply" });
        }
        break;
      }

      case "finish": {
        if (!isSetupDraftComplete(draft)) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: localizer(locale, "commands.setup.wizard.finish_incomplete"),
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }

        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: localizer(locale, "commands.setup.wizard.step_unavailable"),
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }
    }
  },
};
