import { MessageFlags, PermissionsBitField, type ChatInputCommandInteraction, type Client } from "discord.js";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  isSetupDraftComplete,
  type SetupDraftContext,
  type SetupDraftProviderMode,
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
  buildSetupCancelledPayload,
  buildSetupExpiredPayload,
  buildSetupWizardPayload,
} from "@/utils/discord/ui/setupPanel";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { parseNonce } from "@/utils/discord/panelRouteCodec";
import { createNonce, parseLocale } from "@/utils/discord/panelRouteTokens";
import { isHostedPolicyEnvironment } from "@/utils/misc/hostedPolicy";
import { serverRepository } from "@/utils/db/repositories";
import { getCachedMainPersona } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";

export const SETUP_ROUTE_NAMESPACE = "setup";
export const SETUP_ROUTE_VERSION = "v1";

export type SetupWizardAction =
  | "dashboard"
  | "cancel"
  | "policies"
  | "provider"
  | "settings"
  | "provider-mode"
  | "finish";

const SETUP_WIZARD_ACTIONS = new Set<SetupWizardAction>([
  "dashboard",
  "cancel",
  "policies",
  "provider",
  "settings",
  "provider-mode",
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
        const selectedMode = interaction.values[0] as SetupDraftProviderMode;
        if (selectedMode === "user-byok") {
          if (context === "dm") {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({
                content: localizer(locale, "commands.setup.wizard.step_unavailable"),
                flags: MessageFlags.Ephemeral,
              });
            }
            return;
          }
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
            await deliverGuardedPanel(interaction, payload, { locale, method: "update" });
          }
        } else {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: localizer(locale, "commands.setup.wizard.step_unavailable"),
              flags: MessageFlags.Ephemeral,
            });
          }
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
