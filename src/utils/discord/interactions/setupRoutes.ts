import {
  MessageFlags,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  isSetupDraftComplete,
  type SetupDraftContext,
  type SetupDraftProviderAccess,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  claimSetupDraft,
  consumeSetupDraft,
  readSetupDraft,
  releaseSetupDraftClaim,
  storeSetupDraft,
  updateSetupDraft,
  type SetupDraftReadResult,
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
  SETUP_POLICY_CHOICE_VALUES,
  buildSetupByokModal,
  buildSetupByokModalFieldId,
  buildSetupCancelledPayload,
  buildSetupCatalogModal,
  buildSetupCatalogModalFieldId,
  buildSetupCommitFailedPayload,
  buildSetupEndpointConnectionModal,
  buildSetupEndpointConnectionModalFieldId,
  buildSetupEndpointModelModal,
  buildSetupEndpointModelModalFieldId,
  buildSetupExpiredPayload,
  buildSetupInFlightPayload,
  buildSetupPoliciesModal,
  buildSetupPoliciesModalFieldId,
  buildSetupSettingsModal,
  buildSetupSettingsModalFieldId,
  buildSetupSuccessPayload,
  buildSetupWizardPayload,
  getSetupCatalogProviderChoices,
  areSetupSettingsCatalogsRenderable,
  isSetupStartingSettingsResolvable,
  parseSetupHumanizerChoice,
  parseSetupSystemPromptChoice,
  parseSetupTimezoneOffset,
  setupNoticeReceipt,
  toSetupSettingsCatalogs,
  type SetupSettingsCatalogs,
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
  type SetupConfig,
  type SetupCustomEndpointCapability,
  type SetupProviderAccess,
  type TomoriPresetRow,
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
import { configRepository, llmModelRepo, personaRepository, serverRepository } from "@/utils/db/repositories";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { getCachedPresetAvatar, getPresetAvatarBuffer } from "@/utils/image/avatarHelper";
import { lazySyncGuildEmojis } from "@/utils/cache/emojiLazySync";
import { lazySyncGuildStickers } from "@/utils/cache/stickerLazySync";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { localizer, getDefaultBotName } from "@/utils/text/localizer";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed, replySummaryEmbed } from "@/utils/discord/interactionHelper";

function parseNumCtxField(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) || parsed < 512 ? null : parsed;
}

export const SETUP_ROUTE_NAMESPACE = "setup";
export const SETUP_ROUTE_VERSION = "v1";

/** What a workspace's current rows say about whether setup may start. */
type SetupHealthStatus = "ready" | "already-setup" | "broken";

export type SetupWizardAction =
  | "dashboard"
  | "cancel"
  | "policies"
  | "policies-submit"
  | "settings"
  | "settings-submit"
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
  "policies-submit",
  "settings",
  "settings-submit",
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

export function buildSetupPoliciesSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "policies-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupPoliciesSubmitRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "policies-submit" ? parsed : null;
}

export function buildSetupSettingsRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "settings", locale: input.locale, nonce: input.nonce });
}

export function parseSetupSettingsRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "settings" ? parsed : null;
}

export function buildSetupSettingsSubmitRouteId(input: { locale: string; nonce: string }): string {
  return buildSetupRouteId({ action: "settings-submit", locale: input.locale, nonce: input.nonce });
}

export function parseSetupSettingsSubmitRoute(route: ParsedInteractionRoute | string): SetupWizardRoute | null {
  const parsed = parseSetupRoute(route);
  return parsed?.action === "settings-submit" ? parsed : null;
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

/**
 * Names the rejection a settings submission earned, so an out-of-range hour count is told the bound
 * rather than being described as a non-number.
 */
function describeSetupSettingsRejection(rawTimezone: string | undefined, timezoneOffset: number | null): string {
  const prefix = "commands.setup.wizard.";
  if (timezoneOffset === null) {
    const typed = rawTimezone?.trim() ?? "";
    // Blank is UTC rather than an error, so a rejection here is either unparseable or out of range.
    const isOutOfRange = typed !== "" && !Number.isNaN(Number.parseFloat(typed));
    return `${prefix}${isOutOfRange ? "settings_timezone_out_of_range" : "settings_timezone_invalid"}`;
  }
  return `${prefix}settings_persona_stale`;
}

/**
 * Reads a workspace's setup health from its persona and config rows.
 *
 * The three states are not a boolean because a missing main persona is recoverable in place while a
 * missing config row is not: a workspace whose main persona row exists but whose state does not load
 * has to be told to repair that model reference rather than being walked into a second setup.
 *
 * The persona test is the cheap row check rather than a cached-persona read, because that reader
 * answers a database failure with whatever it last held: a fresh workspace whose persona query failed
 * would come back as an empty list and read here as "ready to set up", which is the one answer this
 * guard exists to prevent.
 */
export async function readSetupHealth(workspaceKey: string): Promise<SetupHealthStatus> {
  const serverId = await serverRepository.loadServerIdByDiscId(workspaceKey);
  if (!serverId) return "ready";
  if (!(await personaRepository.hasMainPersona(serverId))) return "ready";
  return (await personaRepository.loadState(workspaceKey)) ? "already-setup" : "broken";
}

/**
 * The long-form refusal a healthy workspace's owner sees, preserved from the pre-wizard command.
 *
 * It is a summary embed rather than the wizard's one-line notice because the command exists to get a
 * workspace set up, and an already-configured one is better served by its current state and the
 * commands that change it than by a sentence saying no.
 */
async function replyWorkspaceAlreadySetup(
  interaction: ChatInputCommandInteraction,
  locale: string,
  workspaceKey: string,
): Promise<void> {
  const existingTomoriState = await personaRepository.loadState(workspaceKey);
  const providerAddMention = commandRegistry.getCommandMention("providers");
  const modelTextMention = commandRegistry.getCommandMention("config");
  const userByokToggleMention = commandRegistry.getCommandMention("moderation");
  const helpPersonalProviderMention = commandRegistry.getCommandMention("help");
  const currentModelValue =
    existingTomoriState?.config.llm_id && existingTomoriState.llm
      ? formatLlmDisplayLabel(
          existingTomoriState.llm,
          existingTomoriState.config.custom_model_name,
          existingTomoriState.config.other_model_codename,
        )
      : existingTomoriState?.config.user_byok_mode
        ? localizer(locale, "commands.choices.none_user_byok")
        : localizer(locale, "commands.choices.none");

  await replySummaryEmbed(interaction, locale, {
    titleKey: "commands.setup.already_setup_title",
    descriptionKey: "commands.setup.already_setup_summary_description",
    color: ColorCode.WARN,
    fields: [
      {
        nameKey: "commands.setup.current_provider_field",
        value: currentModelValue,
      },
      {
        nameKey: "commands.setup.current_byok_field",
        value: localizer(
          locale,
          existingTomoriState?.config.user_byok_mode
            ? "commands.setup.current_byok_enabled_value"
            : "commands.setup.current_byok_disabled_value",
          { toggle_command: userByokToggleMention },
        ),
      },
      {
        nameKey: "commands.setup.already_setup_next_steps_field",
        value: localizer(locale, "commands.setup.already_setup_next_steps_value", {
          provider_add_command: providerAddMention,
          model_text_command: modelTextMention,
          byok_toggle_command: userByokToggleMention,
          help_personal_provider: helpPersonalProviderMention,
        }),
      },
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The repair guidance for a workspace that has a main persona but no loadable state.
 *
 * Setup deliberately does not clear this state, because the alters on the workspace may be healthy
 * and only the config row or the model it points at is gone.
 */
async function replyWorkspaceBroken(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  log.warn("[Setup] Workspace has a main persona row but state validation failed, surfacing repair guidance");
  await replyInfoEmbed(interaction, locale, {
    titleKey: "commands.setup.broken_state_title",
    descriptionKey: "commands.setup.broken_state_description",
    descriptionVars: {
      model_text_command: commandRegistry.getCommandMention("config"),
      provider_add_command: commandRegistry.getCommandMention("providers"),
    },
    color: ColorCode.ERROR,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The live rows the Starting Settings summary resolves its stored identities against.
 *
 * `undefined` is "there is nothing stored to resolve" and skips both reads, which is the whole of the
 * first pass through the wizard. `null` is a read that failed, which the panel deliberately treats
 * differently from a catalog that resolved and does not contain the stored row.
 */
async function readSetupSettingsCatalogs(
  draft: SetupDraftRecord,
  locale: string,
): Promise<SetupSettingsCatalogs | null | undefined> {
  if (!draft.startingSettings) return undefined;
  return loadSetupSettingsCatalogs(locale);
}

/** The same read for a path that needs the catalogs themselves rather than a drift verdict. */
async function loadSetupSettingsCatalogs(locale: string): Promise<SetupSettingsCatalogs | null> {
  const [personaPresets, promptPresets] = await Promise.all([
    configRepository.loadPresetRowsByLocale(locale),
    configRepository.loadSystemPromptPresets(),
  ]);
  return toSetupSettingsCatalogs(personaPresets, promptPresets, locale);
}

/**
 * Repaints the wizard from catalogs the caller already holds.
 *
 * It exists so that a save path which just resolved those catalogs does not read them a second time,
 * while still keeping the payload builder out of the individual action arms.
 */
async function deliverSetupWizard(
  interaction: ChatInputCommandInteraction | GlobalRoutableInteraction,
  draft: SetupDraftRecord,
  locale: string,
  nonce: string,
  options: {
    method: "update" | "editReply";
    notice?: string;
    receipt?: PanelReceipt;
    settingsCatalogs: SetupSettingsCatalogs | null | undefined;
  },
): Promise<void> {
  const payload = buildSetupWizardPayload({
    draft,
    locale,
    isHosted: draft.requiresPolicies,
    nonce,
    notice: options.notice,
    receipt: options.receipt,
    settingsCatalogs: options.settingsCatalogs,
  });
  await deliverGuardedPanel(interaction, payload, { locale, method: options.method, receipt: options.receipt });
}

/**
 * Repaints the wizard, resolving the stored starting settings against the live catalogs first.
 *
 * Every repaint goes through here or through {@link deliverSetupWizard} rather than calling the
 * payload builder directly, because a repaint that skipped the catalog read would show a completed
 * step for a persona or prompt row that no longer exists.
 */
async function repaintSetupWizard(
  interaction: ChatInputCommandInteraction | GlobalRoutableInteraction,
  draft: SetupDraftRecord,
  locale: string,
  nonce: string,
  options: { method: "update" | "editReply"; notice?: string; receipt?: PanelReceipt },
): Promise<void> {
  await deliverSetupWizard(interaction, draft, locale, nonce, {
    ...options,
    settingsCatalogs: await readSetupSettingsCatalogs(draft, locale),
  });
}

function providerValidationFailureReceipt(locale: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.setup.wizard.provider_validation_failed_title"),
    detail: localizer(locale, "commands.setup.wizard.provider_validation_failed"),
    reason: "setup_provider_validation_failed",
  };
}

function setupFailureReceipt(locale: string, detail: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.setup.wizard.change_failed_title"),
    detail,
    reason: "setup_step_failed",
  };
}

function setupInFlightReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.setup.wizard.commit_in_progress_title"),
    detail: localizer(locale, "commands.setup.wizard.commit_in_progress"),
  };
}

function customEndpointFailureReceipt(locale: string, detail: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.setup.wizard.custom_endpoint_failed_title"),
    detail,
  };
}

function safeCustomEndpointProbeReason(
  reason: string,
  endpointUrl: string,
  authToken: string | undefined,
): string | null {
  const normalized = reason.replace(/\s+/g, " ").trim();
  if (!normalized || /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b|\blocalhost\b)/i.test(normalized)) return null;

  let sanitized = normalized;
  if (authToken) sanitized = sanitized.split(authToken).join("[redacted]");
  try {
    const endpoint = new URL(endpointUrl);
    sanitized = sanitized.split(endpointUrl).join("[redacted endpoint]");
    sanitized = sanitized.split(endpoint.host).join("[redacted endpoint]");
    sanitized = sanitized.split(endpoint.hostname).join("[redacted endpoint]");
  } catch {
    return null;
  }

  return escapeDiscordMarkdown(sanitized.slice(0, 300));
}

function customEndpointProbeFailureReceipt(
  locale: string,
  reason: string,
  endpointUrl: string,
  authToken: string | undefined,
): PanelReceipt {
  const safeReason = safeCustomEndpointProbeReason(reason, endpointUrl, authToken);
  return customEndpointFailureReceipt(
    locale,
    safeReason
      ? localizer(locale, "commands.setup.wizard.custom_endpoint_unreachable_detail", { reason: safeReason })
      : localizer(locale, "commands.setup.wizard.custom_endpoint_unreachable"),
  );
}

/**
 * Repaints after a save, answering whatever the write returned.
 *
 * Every arm that saves a draft step used to discard what the store returned and re-read the record
 * immediately afterwards. A read succeeds whatever the write did, so an arm that wrote nothing still
 * repainted a panel, and a save refused because the draft was mid-commit looked like a save that
 * landed. Reading the write's result is also what makes the in-flight and expired refusals reachable
 * here, and every one of them has to answer: these arms run behind an already-acknowledged modal, so
 * returning without a response leaves the actor with a spinner and no explanation.
 */
async function applySetupDraftWrite(
  interaction: ChatInputCommandInteraction | GlobalRoutableInteraction,
  write: SetupDraftReadResult,
  locale: string,
  nonce: string,
  method: "update" | "editReply",
): Promise<void> {
  if (write.status === "in-flight") {
    await deliverGuardedPanel(interaction, buildSetupInFlightPayload(locale), {
      locale,
      method,
      receipt: setupNoticeReceipt(locale, "in-flight"),
    });
    return;
  }
  if (write.status === "missing") {
    await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
      locale,
      method,
      receipt: setupNoticeReceipt(locale, "expired"),
    });
    return;
  }
  if (write.status === "ok") {
    await repaintSetupWizard(interaction, write.draft, locale, nonce, { method });
  }
}

/**
 * Which draft field a failed revalidation invalidates, or `none` when the workspace itself moved.
 *
 * `provider` and `settings` clear one step each and keep the other's stored values, because a
 * provider whose catalog row was removed says nothing about the persona the actor chose. `none`
 * consumes the draft, either because a configured workspace must not be walked into a second setup
 * or because the environment no longer matches the step set this draft was built for.
 */
type SetupDriftScope = "provider" | "settings" | "none";

interface SetupRevalidation {
  notice: string;
  scope: SetupDriftScope;
}

/** The provider catalog row a catalog-mode draft was built from, re-read at the moment of commit. */
function isCatalogProviderCurrent(access: SetupDraftProviderAccess): boolean {
  if (access.mode !== "catalog") return false;
  return getSetupCatalogProviderChoices().some((choice) => choice.value === access.provider);
}

/**
 * Rechecks every guard and every catalog-backed identity before the commit transaction runs.
 *
 * `null` is "still valid". The wizard's own gates were read when the draft was created or last
 * saved, and each of them can have moved since: a stored persona row can be deleted while the panel
 * sits open, and the panel's catalog-aware ready state protects the button but not this path.
 */
async function revalidateSetupCommit(draft: SetupDraftRecord, locale: string): Promise<SetupRevalidation | null> {
  if (isHostedPolicyEnvironment() !== draft.requiresPolicies) {
    return { notice: localizer(locale, "commands.setup.wizard.env_mismatch"), scope: "none" };
  }

  if ((await readSetupHealth(draft.workspaceKey)) !== "ready") {
    return { notice: localizer(locale, "commands.setup.already_setup_description"), scope: "none" };
  }

  const access = draft.providerAccess;
  if (!access) {
    return { notice: localizer(locale, "commands.setup.wizard.provider_invalid"), scope: "provider" };
  }
  if (access.mode === "user-byok" && draft.context === "dm") {
    return { notice: localizer(locale, "commands.setup.wizard.provider_byok_guild_only"), scope: "provider" };
  }
  if (access.mode === "catalog") {
    if (!isCatalogProviderCurrent(access)) {
      return { notice: localizer(locale, "commands.setup.wizard.provider_invalid"), scope: "provider" };
    }
    if (!(await llmModelRepo.loadDefaultModel(access.provider))) {
      // The transaction falls back to the provider's first non-deprecated model, so a workspace with
      // no text model at all is the only unresolvable case, and it leaves nothing to reply with.
      return { notice: localizer(locale, "commands.setup.wizard.provider_invalid"), scope: "provider" };
    }
  }

  const settings = draft.startingSettings;
  if (!settings) {
    return { notice: localizer(locale, "commands.setup.wizard.settings_persona_stale"), scope: "settings" };
  }
  const catalogs = await loadSetupSettingsCatalogs(locale);
  if (!areSetupSettingsCatalogsRenderable(catalogs)) {
    return { notice: localizer(locale, "commands.setup.wizard.settings_unavailable"), scope: "settings" };
  }
  if (!isSetupStartingSettingsResolvable(settings, catalogs)) {
    return { notice: localizer(locale, "commands.setup.wizard.settings_persona_stale"), scope: "settings" };
  }

  return null;
}

/** The draft's provider access as the repository write input, which owns its own discriminated union. */
function toSetupProviderAccess(access: SetupDraftProviderAccess): SetupProviderAccess {
  if (access.mode === "catalog") {
    return {
      mode: "catalog",
      provider: access.provider,
      encryptedApiKey: access.encryptedApiKey,
      keyVersion: access.keyVersion,
    };
  }
  if (access.mode === "user-byok") {
    return { mode: "user-byok" };
  }
  // A complete custom-endpoint draft always carries both halves: a connection-only draft never
  // passes the completeness gate that guards this path.
  return {
    mode: "custom-endpoint",
    connection: {
      label: access.connection?.label ?? "",
      apiStyle: access.connection?.apiStyle ?? "openai-compatible",
      endpointUrl: access.connection?.endpointUrl ?? "",
      encryptedAuthToken: access.connection?.encryptedAuthToken ?? null,
      keyVersion: access.connection?.keyVersion ?? 1,
    },
    textModel: {
      modelCode: access.textModel?.modelCode ?? "",
      numCtx: access.textModel?.numCtx ?? null,
      capabilities: access.textModel?.capabilities ?? [],
    },
  };
}

/**
 * The resolved catalog text of a stored preset selection, or null for the built-in default.
 *
 * The prompt is read again here rather than stored in the draft: a preset edited between the save
 * and the commit must be written in its current form, and the built-in default deliberately writes
 * NULL so `DEFAULT_SYSTEM_PROMPT` keeps evolving at read time.
 */
function resolveSystemPromptText(draft: SetupDraftRecord, catalogs: SetupSettingsCatalogs): string | null {
  const prompt = draft.startingSettings?.systemPrompt;
  if (!prompt || prompt.kind === "built-in") return null;
  return catalogs.promptTexts.get(prompt.presetName) ?? null;
}

/** The `A Few Things to Note` entries that apply to a committed provider mode. */
function buildSetupReceiptNotes(locale: string, access: SetupDraftProviderAccess, context: SetupDraftContext) {
  const notes: Array<{ label: string; detail: string }> = [];

  if (access.mode === "catalog" && access.provider === "novelai") {
    notes.push({
      label: localizer(locale, "commands.setup.novelai_expressions_warning_field"),
      detail: localizer(locale, "commands.setup.novelai_expressions_warning_value"),
    });
  }

  if (access.mode === "catalog" && (access.provider === "zai" || access.provider === "zaicoding")) {
    notes.push({
      label: localizer(locale, "commands.setup.zai_tos_warning_field"),
      detail: localizer(locale, "commands.setup.zai_tos_warning_value"),
    });
  }

  if (access.mode === "user-byok") {
    notes.push({
      label: localizer(locale, "commands.setup.byok_bootstrap_field"),
      detail: localizer(locale, "commands.setup.byok_bootstrap_value", {
        toggle_command: commandRegistry.getCommandMention("moderation"),
        help_personal_provider: commandRegistry.getCommandMention("help"),
      }),
    });
  }

  if (context !== "dm") return notes;

  // A DM has no guild member record to update, and the receipt says so rather than showing a
  // success that quietly skipped the avatar.
  return notes;
}

async function syncGuildExpressionsAfterSetup(guild: Guild | null, workspaceKey: string): Promise<void> {
  if (!guild) return;
  try {
    const tomoriState = await personaRepository.loadState(workspaceKey);
    if (!tomoriState) {
      log.warn(`[Setup] Failed to load TomoriState after setup for guild ${workspaceKey}`);
      return;
    }
    log.info(`[Setup] Force syncing emojis/stickers for guild ${guild.name}`);
    await Promise.all([
      lazySyncGuildEmojis(guild, tomoriState.server_id, true),
      lazySyncGuildStickers(guild, tomoriState.server_id, true),
    ]);
    log.success(`[Setup] Successfully synced expressions for guild ${guild.name}`);
  } catch (syncError) {
    // Non-critical: expressions sync on the first message anyway.
    log.warn(`[Setup] Failed to sync expressions during setup (will sync on first message): ${syncError}`);
  }
}

/** Applies the starting persona's avatar to the bot's guild member record. */
async function applySetupPresetAvatar(
  guild: Guild | null,
  presetRow: TomoriPresetRow | null,
  presetId: number,
  presetName: string,
): Promise<"applied" | "failed" | "skipped"> {
  if (!guild) return "skipped";
  // The catalog read that produced this draft also produced its row, so a null here is a preset that
  // vanished between the revalidation and this call. Leaving the avatar alone is the safe answer: the
  // preset id no longer names anything to draw.
  if (!presetRow) return "skipped";
  try {
    const cachedAvatar = getCachedPresetAvatar(presetId);
    const presetAvatarBuffer = cachedAvatar ? null : await getPresetAvatarBuffer(presetRow);
    const avatarValue =
      cachedAvatar ?? (presetAvatarBuffer ? `data:image/png;base64,${presetAvatarBuffer.toString("base64")}` : null);

    const response = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/members/@me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar: avatarValue }),
    });

    if (!response.ok) {
      log.warn(`Failed to update guild avatar during setup: ${response.status} ${response.statusText}`);
      return "failed";
    }

    log.info(
      `${avatarValue ? `Set preset avatar for "${presetName}"` : "Reset guild avatar to bot default"} for guild ${guild.id} during setup`,
    );
    // Stamp the applied avatar hash so the background fan-out reconciler skips this freshly-set-up
    // server until the catalog art changes again.
    await personaRepository.markServerMainAvatarSynced(guild.id);
    return "applied";
  } catch (avatarError) {
    log.warn(`Failed to update avatar during setup: ${avatarError}`);
    return "failed";
  }
}

/**
 * Everything that runs after the setup transaction has committed.
 *
 * The non-critical steps are not allowed to fail the setup: each reports into the receipt instead,
 * which is why the avatar result drives a footer rather than throwing and the expression sync
 * swallows its own errors. The receipt delivery is the exception and it is returned rather than
 * caught, because a caller that treated a failed delivery as a non-critical adjustment would leave
 * the actor looking at a wizard for a workspace that is already configured.
 *
 * @returns whether the receipt reached the actor.
 */
async function runSetupPostCommitEffects(input: {
  interaction: ChatInputCommandInteraction | GlobalRoutableInteraction;
  draft: SetupDraftRecord;
  locale: string;
  access: SetupDraftProviderAccess;
  presetId: number;
  presetName: string;
  presetRow: TomoriPresetRow | null;
  serverInternalId: number | null;
  modelName: string | null;
  providerLabel: string;
}): Promise<boolean> {
  const { draft, locale, access } = input;
  const guild = "guild" in input.interaction ? (input.interaction.guild ?? null) : null;

  if (access.mode === "catalog" && access.provider === "novelai") {
    const tomoriState = await personaRepository.loadState(draft.workspaceKey);
    if (tomoriState) {
      try {
        // NovelAI's token budget makes emoji and sticker injection counterproductive: they consume
        // context without the model being able to use them. The receipt tells the actor they can
        // re-enable both.
        await configRepository.updateCapabilitiesConfig(tomoriState.server_id, {
          emoji_usage_enabled: false,
          sticker_usage_enabled: false,
        });
        log.info(`[Setup] Auto-disabled emoji/sticker usage for NovelAI server ${draft.workspaceKey}`);
      } catch (disableError) {
        log.warn(`[Setup] Failed to auto-disable emoji/sticker for NovelAI: ${disableError}`);
      }
    }
  }

  if (draft.context === "guild") {
    await syncGuildExpressionsAfterSetup(guild, draft.workspaceKey);
  }

  const status = await applySetupPresetAvatar(guild, input.presetRow, input.presetId, input.presetName);
  const avatarUpdateFailed = status === "failed";

  const footerKey =
    draft.context === "dm"
      ? "commands.setup.wizard.receipt_footer_avatar_skipped_dm"
      : avatarUpdateFailed
        ? "commands.setup.wizard.receipt_footer_avatar_failed"
        : undefined;

  const payload = buildSetupSuccessPayload({
    locale,
    context: draft.context,
    providerAccess: access,
    modelName: input.modelName,
    providerLabel: input.providerLabel,
    personaName: input.presetName,
    notes: buildSetupReceiptNotes(locale, access, draft.context),
    learnMore: localizer(locale, "commands.setup.wizard.receipt_learn_more", {
      help: commandRegistry.getCommandMention("help"),
    }),
    footerKey,
  });

  try {
    await deliverGuardedPanel(input.interaction, payload, { locale, method: "editReply" });
  } catch (deliveryError) {
    // Not swallowed like the adjustments above: the workspace is committed, so an actor shown the
    // still-open wizard would be looking at a setup that already exists, and every later press would
    // read the consumed draft as expired. Returning false is what turns that into a truthful answer.
    log.error("[Setup] Failed to deliver the success receipt for a committed setup:", deliveryError);
    return false;
  }

  if (input.serverInternalId) {
    // One low-cardinality action per completed setup. Opening the wizard, saving a draft, failing a
    // validation, cancelling, and expiring all record nothing, so the counter reads as completed
    // setups rather than as interest in the surface. Recording is detached and swallows its own
    // failure because telemetry must never turn an already-committed setup into a failure notice.
    void recordPanelActionStat({
      action: "setup.workspace.setup.complete",
      serverId: input.serverInternalId,
      userDiscId: input.interaction.user.id,
    }).catch((error) => log.warn("[Setup] Failed to record the setup completion action", error));
  }

  return true;
}

/** What the finish action did, which its caller and tests both read. */
type SetupCommitOutcome =
  | { status: "committed" }
  | { status: "in-flight" }
  | { status: "drift"; notice: string; scope: SetupDriftScope }
  | { status: "failed" };

/**
 * Commits a complete draft through the setup transaction exactly once.
 *
 * The order is the contract. The interaction is acknowledged before the claim, because everything
 * after it is a database round trip, a set of catalog reads, and a Discord REST call, and an
 * unacknowledged component interaction is dropped at three seconds. The claim then runs before the
 * first awaited revalidation so two confirmations cannot both reach the transaction. Tomori state is
 * invalidated only after the transaction returns. The `finally` owns the draft, so no exception on
 * any path can leave a claimed draft holding an encrypted credential.
 */
export async function finishSetupWizardDraft(
  interaction: ChatInputCommandInteraction | GlobalRoutableInteraction,
  draft: SetupDraftRecord,
  locale: string,
  nonce: string,
): Promise<SetupCommitOutcome> {
  const { actorDiscId, workspaceKey, context } = draft;
  const acknowledged = "deferUpdate" in interaction && !interaction.replied && !interaction.deferred;
  if (acknowledged) {
    await interaction.deferUpdate();
  }

  const claim = claimSetupDraft(nonce, actorDiscId, workspaceKey, context);

  if (claim.status === "in-flight") {
    // A second press while the first is still committing. Repainting is safe here, unlike on the
    // success path: the wizard is still the live surface and the first press will replace it.
    await repaintSetupWizard(interaction, draft, locale, nonce, {
      method: "editReply",
      receipt: setupInFlightReceipt(locale),
    });
    return { status: "in-flight" };
  }

  if (claim.status !== "claimed") {
    // Missing means the draft expired or a racing confirmation already consumed it. Neither may
    // start a second transaction, and both have to answer because a silent return reads as a failed
    // interaction in the client.
    await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
      locale,
      method: "editReply",
      receipt: setupNoticeReceipt(locale, "expired"),
    });
    return { status: "failed" };
  }

  const claimedDraft = claim.draft;
  // Whether the transaction landed. It survives the try so the unexpected-error handler can tell an
  // actor whose setup may already exist from one whose attempt never reached the database.
  let committed = false;
  // Whether a refusal left the actor something to correct. A drift re-pends one step and the panel
  // keeps serving it, so that draft outlives the attempt; every other outcome ends the attempt.
  let preserved = false;

  try {
    const drift = await revalidateSetupCommit(claimedDraft, locale);

    if (drift) {
      if (drift.scope === "none") {
        await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
          locale,
          method: "editReply",
          receipt: setupNoticeReceipt(locale, "expired"),
        });
        return { status: "failed" };
      }

      releaseSetupDraftClaim(nonce, actorDiscId, workspaceKey, context);
      const cleared =
        drift.scope === "provider"
          ? updateSetupDraft(nonce, actorDiscId, workspaceKey, context, { providerAccess: null })
          : updateSetupDraft(nonce, actorDiscId, workspaceKey, context, { startingSettings: null });

      if (cleared.status === "ok") {
        await deliverSetupWizard(interaction, cleared.draft, locale, nonce, {
          method: "editReply",
          receipt: setupFailureReceipt(locale, drift.notice),
          settingsCatalogs: await readSetupSettingsCatalogs(cleared.draft, locale),
        });
        preserved = true;
        return { status: "drift", notice: drift.notice, scope: drift.scope };
      }

      await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
        locale,
        method: "editReply",
        receipt: setupNoticeReceipt(locale, "expired"),
      });
      return { status: "failed" };
    }

    const access = claimedDraft.providerAccess;
    if (!access) {
      // Unreachable behind the completeness gate, and refusing here keeps the write path total rather
      // than asserting a shape the gate is the only thing that guarantees.
      releaseSetupDraftClaim(nonce, actorDiscId, workspaceKey, context);
      await repaintSetupWizard(interaction, claimedDraft, locale, nonce, {
        method: "editReply",
        receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.provider_invalid")),
      });
      preserved = true;
      return {
        status: "drift",
        notice: localizer(locale, "commands.setup.wizard.provider_invalid"),
        scope: "provider",
      };
    }

    const catalogs = await loadSetupSettingsCatalogs(locale);
    if (!areSetupSettingsCatalogsRenderable(catalogs)) {
      releaseSetupDraftClaim(nonce, actorDiscId, workspaceKey, context);
      await repaintSetupWizard(interaction, claimedDraft, locale, nonce, {
        method: "editReply",
        receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.settings_unavailable")),
      });
      preserved = true;
      return {
        status: "drift",
        notice: localizer(locale, "commands.setup.wizard.settings_unavailable"),
        scope: "settings",
      };
    }

    const presetId = claimedDraft.startingSettings?.presetId;
    const presetRow =
      typeof presetId === "number"
        ? await configRepository
            .loadPresetRowsByLocale(locale)
            .then((rows) => rows?.find((row) => row.persona_preset_id === presetId) ?? null)
        : null;

    if (!presetRow) {
      releaseSetupDraftClaim(nonce, actorDiscId, workspaceKey, context);
      const cleared = updateSetupDraft(nonce, actorDiscId, workspaceKey, context, { startingSettings: null });
      if (cleared.status === "ok") {
        await deliverSetupWizard(interaction, cleared.draft, locale, nonce, {
          method: "editReply",
          receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.settings_persona_stale")),
          settingsCatalogs: catalogs,
        });
      } else {
        await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
          locale,
          method: "editReply",
          receipt: setupNoticeReceipt(locale, "expired"),
        });
      }
      preserved = true;
      return {
        status: "drift",
        notice: localizer(locale, "commands.setup.wizard.settings_persona_stale"),
        scope: "settings",
      };
    }

    const modelName =
      access.mode === "catalog"
        ? ((await llmModelRepo.loadDefaultModel(access.provider))?.llm_codename ?? null)
        : access.mode === "custom-endpoint"
          ? (access.textModel?.modelCode ?? null)
          : null;
    const providerLabel =
      access.mode === "catalog"
        ? getProviderDisplayName(access.provider)
        : access.mode === "custom-endpoint"
          ? (access.connection?.label ?? "")
          : "";

    const setupConfig: SetupConfig = {
      serverId: workspaceKey,
      presetId: presetRow.persona_preset_id,
      humanizer: claimedDraft.startingSettings?.humanizer ?? 1,
      tomoriName: getDefaultBotName(locale),
      timezoneOffset: claimedDraft.startingSettings?.timezoneOffset ?? 0,
      locale,
      registrationLocale: locale,
      providerAccess: toSetupProviderAccess(access),
      systemPrompt: resolveSystemPromptText(claimedDraft, catalogs),
    };

    let setupResult: Awaited<ReturnType<typeof serverRepository.setup>>;
    try {
      setupResult = await serverRepository.setup(context === "guild" ? (interaction.guild ?? null) : null, setupConfig);
    } catch (error) {
      log.error("[Setup] Setup transaction failed:", error);
      await deliverGuardedPanel(interaction, buildSetupCommitFailedPayload(locale), {
        locale,
        method: "editReply",
        receipt: setupNoticeReceipt(locale, "commit-failed"),
      });
      return { status: "failed" };
    }

    committed = true;
    // Only now, with the rows committed: every reader below this line must see the new workspace.
    invalidateTomoriStateCache(workspaceKey);

    let receiptDelivered: boolean;
    try {
      receiptDelivered = await runSetupPostCommitEffects({
        interaction,
        draft: claimedDraft,
        locale,
        access,
        presetId: presetRow.persona_preset_id,
        presetName: presetRow.persona_preset_name,
        presetRow,
        serverInternalId: setupResult.server.server_id ?? null,
        modelName,
        providerLabel,
      });
    } catch (effectsError) {
      // An unexpected throw inside the tail. The receipt may or may not have landed, and the one
      // thing that cannot be reported is "nothing was saved", because the transaction did commit.
      log.error("[Setup] Post-commit effects failed after a committed setup:", effectsError);
      receiptDelivered = false;
    }

    if (!receiptDelivered) {
      // The draft is still consumed by the exit path, so a retry starts over rather than resuming
      // anything. What the actor gets here is the one honest answer left: the setup could not be
      // confirmed, not that it did not happen.
      try {
        await deliverGuardedPanel(interaction, buildSetupCommitFailedPayload(locale), {
          locale,
          method: "editReply",
          receipt: setupNoticeReceipt(locale, "commit-failed"),
        });
      } catch (noticeError) {
        log.error("[Setup] Failed to deliver the receipt-failure notice:", noticeError);
      }
      return { status: "failed" };
    }

    return { status: "committed" };
  } catch (error) {
    // Anything past the claim that is not one of the handled outcomes above. An uncommitted attempt
    // saved nothing; a committed one may have, so the two are logged apart even though the actor is
    // told the same thing either way, because only one of them needs a human to look at the rows.
    log.error(
      committed
        ? "[Setup] Commit path failed after the transaction committed; the workspace may already be configured:"
        : "[Setup] Setup commit path failed before any write landed:",
      error,
    );
    try {
      await deliverGuardedPanel(interaction, buildSetupCommitFailedPayload(locale), {
        locale,
        method: "editReply",
        receipt: setupNoticeReceipt(locale, "commit-failed"),
      });
    } catch (replyError) {
      log.error("[Setup] Failed to deliver the commit-failure notice:", replyError);
    }
    return { status: "failed" };
  } finally {
    // The claim is always drained here, so no exception can leave a frozen draft holding an encrypted
    // credential. Releasing first is also what lets the consume below get past the store's own freeze:
    // a committed setup consumes its draft, a drift keeps the corrected draft for the next press, and
    // every other outcome consumes it so the actor starts over rather than resuming an attempt whose
    // state is unknown.
    releaseSetupDraftClaim(nonce, actorDiscId, workspaceKey, context);
    if (!preserved) {
      consumeSetupDraft(nonce, actorDiscId, workspaceKey, context);
    }
  }
}

export interface SetupWizardDependencies {
  isSetupAuthorized: (interaction: ChatInputCommandInteraction) => boolean;
  checkExistingSetup: (workspaceKey: string) => Promise<SetupHealthStatus>;
  createNonce: () => string;
  isHostedPolicyEnvironment: () => boolean;
  storeSetupDraft: typeof storeSetupDraft;
  /**
   * Locale for the wizard's own surfaces. The command resolves it from the guild first, so the
   * stored locale, the persona's default name, and the copy the actor reads all agree.
   */
  locale?: string;
}

export async function startSetupWizard(
  interaction: ChatInputCommandInteraction,
  dependencies: Partial<SetupWizardDependencies> = {},
): Promise<void> {
  const locale = dependencies.locale ?? interaction.locale ?? interaction.guildLocale ?? "en-US";
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

  const health = dependencies.checkExistingSetup
    ? await dependencies.checkExistingSetup(workspaceKey)
    : await readSetupHealth(workspaceKey);

  if (health === "already-setup") {
    await replyWorkspaceAlreadySetup(interaction, locale, workspaceKey);
    return;
  }

  if (health === "broken") {
    await replyWorkspaceBroken(interaction, locale);
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

  await repaintSetupWizard(interaction, record, locale, nonce, { method: "editReply" });
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
      await deliverGuardedPanel(interaction, expiredPayload, {
        locale,
        method: "update",
        receipt: setupNoticeReceipt(locale, "expired"),
      });
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

    if (readResult.status === "in-flight") {
      // A commit is running on this draft, so every other action is refused rather than dispatched:
      // the draft is frozen until that commit finishes, and a repaint that read it would be showing
      // state the commit is about to replace.
      await deliverGuardedPanel(interaction, buildSetupInFlightPayload(locale), {
        locale,
        method: "update",
        receipt: setupNoticeReceipt(locale, "in-flight"),
      });
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
        await repaintSetupWizard(interaction, draft, locale, nonce, { method: "update" });
        break;
      }

      case "policies": {
        if (interaction.isModalSubmit()) {
          return;
        }
        // A policy control on a draft that renders no policy step is forged, so the modal opens
        // only for the draft's own captured requirement rather than a fresh environment read. The
        // refusal replies rather than returning silently, because an unanswered component
        // interaction surfaces as a failed interaction in the client.
        if (!draft.requiresPolicies) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: localizer(locale, "commands.setup.wizard.policies_denied"),
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
        const modalPayload = buildSetupPoliciesModal(locale, nonce);
        await showRoutedRawModal(interaction, modalPayload);
        return;
      }

      case "policies-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        if (!draft.requiresPolicies) {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.policies_denied")),
          });
          return;
        }

        const acceptanceFieldId = buildSetupPoliciesModalFieldId("acceptance", nonce);
        const acceptedChoices = takeRawModalCheckboxGroupValues(interaction.id, acceptanceFieldId) ?? [];

        // Both documents are required and nothing else is an acceptance, so the submitted set has
        // to match exactly rather than merely contain what the modal offered.
        const acceptedEveryDocument =
          acceptedChoices.length === SETUP_POLICY_CHOICE_VALUES.length &&
          SETUP_POLICY_CHOICE_VALUES.every((value) => acceptedChoices.includes(value));

        if (!acceptedEveryDocument) {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.policies_required")),
          });
          return;
        }

        const updated = updateSetupDraft(nonce, actorDiscId, workspaceKey, context, { policiesAccepted: true });
        // Repainting is conditional on the write landing: a draft that expired across the
        // acknowledgement round trip has recorded no acceptance, and showing a completed step for it
        // would claim a legal acceptance that does not exist. The refusal still answers, because the
        // modal has already closed and a silent return leaves the actor unable to tell whether their
        // acceptance registered.
        if (updated.status === "ok") {
          await repaintSetupWizard(interaction, updated.draft, locale, nonce, { method: "editReply" });
          return;
        }

        await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
          locale,
          method: "editReply",
          receipt: setupNoticeReceipt(locale, "expired"),
        });
        return;
      }

      case "settings": {
        if (interaction.isModalSubmit()) {
          return;
        }
        const catalogs = await loadSetupSettingsCatalogs(locale);
        if (!areSetupSettingsCatalogsRenderable(catalogs)) {
          // The catalogs just read are the ones whose unrenderability is being reported, so they are
          // passed straight through rather than read a second time on this path.
          await deliverSetupWizard(interaction, draft, locale, nonce, {
            method: "update",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.settings_unavailable")),
            settingsCatalogs: catalogs,
          });
          return;
        }
        const modalPayload = buildSetupSettingsModal(locale, nonce, catalogs, draft.startingSettings);
        await showRoutedRawModal(interaction, modalPayload);
        return;
      }

      case "settings-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        const catalogs = await loadSetupSettingsCatalogs(locale);
        if (!areSetupSettingsCatalogsRenderable(catalogs)) {
          await deliverSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.settings_unavailable")),
            settingsCatalogs: catalogs,
          });
          return;
        }

        const selectedPersonaId = takeRawModalSelectValue(
          interaction.id,
          buildSetupSettingsModalFieldId("persona", nonce),
        );
        const selectedHumanizer = takeRawModalSelectValue(
          interaction.id,
          buildSetupSettingsModalFieldId("humanizer", nonce),
        );
        // Optional, so it is read defensively like every other optional text input in this file:
        // Discord omits an empty one from the submission and the lookup then throws.
        let rawTimezone: string | undefined;
        try {
          rawTimezone = interaction.fields.getTextInputValue(buildSetupSettingsModalFieldId("timezone", nonce));
        } catch {
          rawTimezone = undefined;
        }
        const selectedSystemPrompt = takeRawModalSelectValue(
          interaction.id,
          buildSetupSettingsModalFieldId("system-prompt", nonce),
        );

        const presetId = Number.parseInt(selectedPersonaId ?? "", 10);
        const humanizer = parseSetupHumanizerChoice(selectedHumanizer);
        const timezoneOffset = parseSetupTimezoneOffset(rawTimezone);
        const systemPrompt = parseSetupSystemPromptChoice(selectedSystemPrompt);

        // A submission is rebuilt from the live catalogs rather than trusted: the row it names may
        // have been removed since the modal opened, and a blank timezone is enforced here too.
        const nextSettings =
          Number.isInteger(presetId) &&
          catalogs.personas.some((persona) => persona.id === presetId) &&
          humanizer !== null &&
          timezoneOffset !== null &&
          systemPrompt !== null
            ? { presetId, humanizer, timezoneOffset, systemPrompt }
            : null;

        if (!nextSettings || !isSetupStartingSettingsResolvable(nextSettings, catalogs)) {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(
              locale,
              localizer(locale, describeSetupSettingsRejection(rawTimezone, timezoneOffset)),
            ),
          });
          return;
        }

        const updated = updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
          startingSettings: nextSettings,
        });
        if (updated.status === "ok") {
          await deliverSetupWizard(interaction, updated.draft, locale, nonce, {
            method: "editReply",
            settingsCatalogs: catalogs,
          });
          return;
        }

        await deliverGuardedPanel(interaction, buildSetupExpiredPayload(locale), {
          locale,
          method: "editReply",
          receipt: setupNoticeReceipt(locale, "expired"),
        });
        return;
      }

      case "provider-mode": {
        if (!interaction.isStringSelectMenu()) {
          return;
        }
        const selectedMode = interaction.values[0];
        if (selectedMode === "catalog") {
          const cleared = updateSetupDraft(nonce, actorDiscId, workspaceKey, context, { providerAccess: null });
          if (cleared.status !== "ok") {
            await applySetupDraftWrite(interaction, cleared, locale, nonce, "update");
            return;
          }
          const modalPayload = buildSetupCatalogModal(locale, nonce);
          await showRoutedRawModal(interaction, modalPayload);
          return;
        }
        if (selectedMode === "custom-endpoint") {
          await applySetupDraftWrite(
            interaction,
            updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
              providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
            }),
            locale,
            nonce,
            "update",
          );
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
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.provider_invalid")),
          });
          return;
        }

        let providerInstance: Awaited<ReturnType<typeof ProviderFactory.getProviderByName>>;
        try {
          providerInstance = await ProviderFactory.getProviderByName(selectedProvider);
        } catch {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: providerValidationFailureReceipt(locale),
          });
          return;
        }

        const validation = await providerInstance.validateApiKey(apiKey);
        if (!validation.valid) {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: providerValidationFailureReceipt(locale),
          });
          return;
        }

        const encryption = await encryptApiKey(apiKey);
        await applySetupDraftWrite(
          interaction,
          updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
            providerAccess: {
              mode: "catalog",
              provider: selectedProvider,
              encryptedApiKey: encryption.encrypted,
              keyVersion: encryption.version,
            },
          }),
          locale,
          nonce,
          "editReply",
        );
        break;
      }

      case "provider-byok-submit": {
        if (!interaction.isModalSubmit()) {
          return;
        }
        await acknowledgeModalSubmitForRefresh(interaction);

        if (context === "dm") {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.provider_byok_guild_only")),
          });
          return;
        }

        const confirmFieldId = buildSetupByokModalFieldId("confirm", nonce);
        const selectedConfirm = takeRawModalSelectValue(interaction.id, confirmFieldId);

        if (selectedConfirm !== "yes" && selectedConfirm !== "no") {
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: setupFailureReceipt(locale, localizer(locale, "commands.setup.wizard.byok_choice_invalid")),
          });
          return;
        }

        if (selectedConfirm === "yes") {
          await applySetupDraftWrite(
            interaction,
            updateSetupDraft(nonce, actorDiscId, workspaceKey, context, {
              providerAccess: { mode: "user-byok" },
            }),
            locale,
            nonce,
            "editReply",
          );
          return;
        }

        // On no, repaint without updating the draft so any prior access stays intact.
        await repaintSetupWizard(interaction, draft, locale, nonce, {
          method: "editReply",
        });
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
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: customEndpointFailureReceipt(
              locale,
              localizer(locale, "commands.setup.wizard.custom_endpoint_api_style_invalid"),
            ),
          });
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
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: customEndpointProbeFailureReceipt(locale, probe.reason, normalizedUrl, rawToken),
          });
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
        await applySetupDraftWrite(
          interaction,
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
          }),
          locale,
          nonce,
          "editReply",
        );
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
          await repaintSetupWizard(interaction, draft, locale, nonce, {
            method: "editReply",
            receipt: customEndpointFailureReceipt(
              locale,
              localizer(locale, "commands.setup.wizard.custom_endpoint_model_invalid"),
            ),
          });
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
            await repaintSetupWizard(interaction, draft, locale, nonce, {
              method: "editReply",
              receipt: customEndpointFailureReceipt(
                locale,
                localizer(locale, "commands.setup.wizard.custom_endpoint_model_invalid"),
              ),
            });
            return;
          }
        }

        await applySetupDraftWrite(
          interaction,
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
          }),
          locale,
          nonce,
          "editReply",
        );
        break;
      }

      case "finish": {
        // The routed fan-out has already rechecked the draft's owner, workspace, context, guild
        // permission, and captured environment, so this arm owns only the final-action gates.
        if (!isSetupDraftComplete(draft)) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: localizer(locale, "commands.setup.wizard.finish_incomplete"),
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }

        await finishSetupWizardDraft(interaction, draft, locale, nonce);
        break;
      }
    }
  },
};
