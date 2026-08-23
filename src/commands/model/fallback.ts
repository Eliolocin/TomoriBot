import type { ChatInputCommandInteraction, ButtonInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmModelRepo, llmOverrideRepo, llmProviderRepo } from "@/utils/db/repositories";

import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import type {
  LlmRow,
  UserRow,
  FallbackModelRef,
  FallbackEntry,
  CustomEndpointRow,
  ErrorContext,
} from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { loadSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import { getFallbackModelRefKey, getPrimaryFallbackRefKeys } from "@/utils/provider/fallbackModelIdentity";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import {
  beginAnchorPrivateWorkflow,
  buildPersonaWorkflowNotice,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/anchorWorkflow";
import {
  acquireModalOptionRange,
  acquireModelModalOpener,
  buildOpenRouterMovedNotice,
  buildOpenSelectorPayload,
  buildProviderPickerPayload,
  openAnchorModal,
} from "@/utils/discord/ui/anchorModelFlow";

// Modal field identifiers
// Note: MODAL_CUSTOM_ID is generated per-invocation (see execute()) to prevent stale
// awaitModalSubmit listeners from a previous run resolving on the same submission.
const SLOT_IDS = [
  "fallback_slot_1",
  "fallback_slot_2",
  "fallback_slot_3",
  "fallback_slot_4",
  "fallback_slot_5",
] as const;

const SLOT_LABEL_KEYS = [
  "commands.model.fallback.slot_1_label",
  "commands.model.fallback.slot_2_label",
  "commands.model.fallback.slot_3_label",
  "commands.model.fallback.slot_4_label",
  "commands.model.fallback.slot_5_label",
] as const;
const CLEAR_SLOT_VALUE = "__none__";
// Prefix used to distinguish custom endpoint values from LLM codenames in modal select values
const CUSTOM_ENDPOINT_VALUE_PREFIX = "ce:";

/** Custom-id root for this command's anchor provider picker / opener buttons. */
const ID_ROOT = "model_fallback";
// One of Discord's 25 select options is reserved for the explicit "None" / clear choice,
// which is re-prepended to every page, so only 24 models fit per range.
const ITEMS_PER_PAGE = 24;
const FALLBACK_DEBUG_ENABLED = new Set(["1", "true", "yes", "on"]).has(
  (process.env.FALLBACK_DEBUG_ENABLED ?? "").trim().toLowerCase(),
);

/**
 * Returns a localized description string for a given LLM model, with capability flags prepended.
 *
 * @param model - The LLM model row from the database
 * @param locale - User's preferred locale (e.g., "ja", "en-US")
 * @returns Localized description string with flags prefix
 */
function getLocalizedDescription(model: LlmRow, locale: string): string {
  const normalizedLocale = locale.toLowerCase().split("-")[0];
  const description = normalizedLocale === "ja" ? model.ja_description : model.llm_description;
  const baseDescription = description || model.llm_description || `${model.llm_provider} model`;

  if (model.llm_codename === "other-model") return baseDescription;

  const flags: string[] = [];
  if (model.is_free && !isCustomProvider(model.llm_provider)) flags.push("FREE");
  if (model.has_tools) flags.push("TOOLS");
  if (model.sees_images) flags.push("IMG");
  if (model.sees_videos) flags.push("VID");
  if (model.supports_structoutput) flags.push("STRUCT");

  const flagPrefix = flags.length > 0 ? `(${flags.join("+")}) ` : "";
  return `${flagPrefix}${baseDescription}`;
}

/**
 * Returns a capability flags string for a custom endpoint (e.g. "(TOOLS+IMG)").
 *
 * @returns Flag prefix string or empty string if no flags
 */
function getEndpointFlagPrefix(ep: CustomEndpointRow): string {
  const flags: string[] = [];
  if (ep.has_tools) flags.push("TOOLS");
  if (ep.sees_images) flags.push("IMG");
  if (ep.sees_videos) flags.push("VID");
  if (ep.supports_structoutput) flags.push("STRUCT");
  return flags.length > 0 ? `(${flags.join("+")}) ` : "";
}

function truncatePlaceholderValue(value: string): string {
  return value.length > 90 ? `${value.slice(0, 87)}...` : value;
}

/**
 * Builds a human-readable label for one slot in the fallback chain.
 * Includes the provider name in parentheses when the entry is from a different provider than selected.
 *
 * @param entry - Resolved fallback entry for this slot, or null if empty
 * @param rawRef - Raw ref from config (for unknown/unresolved IDs)
 * @param selectedProvider - The provider currently being configured (to decide if provider suffix is needed)
 */
function buildSlotPlaceholder(
  locale: string,
  entry: FallbackEntry | null,
  rawRef: FallbackModelRef | null,
  selectedProvider: string,
): string {
  if (!entry) {
    if (rawRef !== null) {
      return localizer(locale, "commands.model.fallback.current_placeholder", {
        model: truncatePlaceholderValue(`${localizer(locale, "general.unknown")} (#${rawRef.id})`),
      });
    }
    return localizer(locale, "commands.model.fallback.current_placeholder", {
      model: localizer(locale, "general.none"),
    });
  }

  if (entry.kind === "llm") {
    const modelLabel =
      entry.model.llm_codename === "other-model"
        ? `other-model -> ${entry.model.llm_codename}`
        : entry.model.llm_codename;

    // Show provider in parentheses when different from the one currently being configured
    const entryProvider = entry.model.llm_provider.toLowerCase();
    if (!isCustomProvider(selectedProvider) && entryProvider !== selectedProvider.toLowerCase()) {
      return localizer(locale, "commands.model.fallback.current_placeholder_with_provider", {
        model: truncatePlaceholderValue(modelLabel),
        provider: getProviderDisplayName(entryProvider),
      });
    }
    return localizer(locale, "commands.model.fallback.current_placeholder", {
      model: truncatePlaceholderValue(modelLabel),
    });
  }

  // Custom endpoint
  const epLabel = `${entry.endpoint.label}:${entry.endpoint.model_name ?? entry.endpoint.label}`;
  const parsed = parseCustomProvider(selectedProvider);
  const selectedConnectionId = parsed?.connectionId ?? null;
  if (selectedConnectionId !== entry.endpoint.connection_id) {
    return localizer(locale, "commands.model.fallback.current_placeholder_with_provider", {
      model: truncatePlaceholderValue(epLabel),
      provider: localizer(locale, "commands.model.fallback.custom_provider_label"),
    });
  }
  return localizer(locale, "commands.model.fallback.current_placeholder", {
    model: truncatePlaceholderValue(epLabel),
  });
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("fallback").setDescription(localizer("en-US", "commands.model.fallback.description"));

/**
 * Handles the /model fallback command.
 * Allows server admins to configure up to 5 ordered fallback models for automatic failover.
 * Supports mixing models from different providers and custom endpoints.
 *
 * @param _client - Discord client instance (unused)
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  // Scope modal custom ID to this invocation so stale awaitModalSubmit listeners
  //     from earlier (un-submitted) runs don't also resolve on this submission.
  const MODAL_CUSTOM_ID = `config_model_fallback_modal_${interaction.id}`;

  // Ensure the command is run in a channel context
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
    });
    return;
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
  if (FALLBACK_DEBUG_ENABLED) {
    log.info(
      `[FallbackDebug][/model fallback] server_disc_id=${serverDiscId} server_id=${tomoriState.server_id} current_chain=${JSON.stringify(tomoriState.config.fallback_model_refs)}`,
    );
  }

  // Anchor one-message controller, tracked so the outer catch can render an
  // unexpected-error terminal on the same ephemeral message.
  let anchorMessage: PersonaWorkflowMessageController | null = null;

  try {
    const savedProviders = await loadSavedProvidersForCapability(tomoriState.server_id, "text");
    const initialPayload =
      savedProviders.length === 0
        ? buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.fallback.no_providers_title",
            descriptionKey: "commands.model.fallback.no_providers_description",
            color: ColorCode.ERROR,
          })
        : savedProviders.length === 1
          ? buildOpenSelectorPayload(locale, `${ID_ROOT}_open`)
          : buildProviderPickerPayload(
              locale,
              ID_ROOT,
              savedProviders.map((row) => row.provider),
              [{ model: tomoriState.llm.llm_codename, provider: tomoriState.llm.llm_provider }],
            );

    const phase = await beginAnchorPrivateWorkflow(interaction, locale, initialPayload);
    anchorMessage = phase.message;
    if (savedProviders.length === 0) return;

    const opener = await acquireModelModalOpener(phase, interaction.user.id, locale, savedProviders, ID_ROOT);
    if (!opener) return;
    const selectedProvider = opener.provider;
    // The button the modal will finally open from. The range step (if any) consumes this
    // one and hands back the range button in its place.
    let modalButton: ButtonInteraction = opener.button;

    let availableModels: LlmRow[] = [];
    let availableEndpoints: CustomEndpointRow[] = [];
    let allModelOptions: SelectOption[];

    if (isCustomProvider(selectedProvider)) {
      // Custom providers resolve through connection-scoped rows so each fallback retains its exact model.
      const parsed = parseCustomProvider(selectedProvider);
      const connectionId = parsed?.connectionId ?? null;
      const allEndpoints = await llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id);
      availableEndpoints = connectionId
        ? allEndpoints.filter((ep) => ep.connection_id === connectionId && ep.capability === "text")
        : [];

      if (availableEndpoints.length === 0) {
        await phase.useButton(modalButton).replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.fallback.no_models_title",
            descriptionKey: "commands.model.fallback.no_models_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      allModelOptions = availableEndpoints.map((ep) => ({
        label: safeSelectOptionText(`${ep.label}:${ep.model_name ?? ep.label}`),
        value: `${CUSTOM_ENDPOINT_VALUE_PREFIX}${ep.custom_endpoint_id}`,
        description: safeSelectOptionText(`${getEndpointFlagPrefix(ep)}${ep.model_name ?? ep.label}`),
      }));
    } else {
      // Standard provider path
      availableModels =
        (await llmModelRepo.loadAvailableModelsForProvider(selectedProvider, false, {
          kind: "server",
          ownerId: tomoriState.server_id,
        })) ?? [];

      if (availableModels.length === 0) {
        await phase.useButton(modalButton).replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.fallback.no_models_title",
            descriptionKey: "commands.model.fallback.no_models_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      const selectableModels =
        selectedProvider === "openrouter"
          ? availableModels.filter((model) => model.llm_codename !== "other-model")
          : availableModels;

      allModelOptions = selectableModels.map((m) => ({
        label: safeSelectOptionText(m.llm_codename),
        value: safeSelectOptionText(m.llm_codename),
        description: safeSelectOptionText(getLocalizedDescription(m, userData.language_pref)),
      }));
    }

    // Build per-slot placeholders from the existing fallback_chain (cross-provider aware)
    const existingRefs = tomoriState.config.fallback_model_refs ?? [];
    const existingChain = tomoriState.fallback_chain ?? [];
    const currentFallbackPlaceholders = SLOT_IDS.map((_, index) =>
      buildSlotPlaceholder(locale, existingChain[index] ?? null, existingRefs[index] ?? null, selectedProvider),
    );

    const clearOption: SelectOption = {
      label: safeSelectOptionText(localizer(locale, "commands.model.fallback.clear_option_label")),
      value: CLEAR_SLOT_VALUE,
      description: safeSelectOptionText(localizer(locale, "commands.model.fallback.clear_option_description")),
    };

    // Past 24 models the user picks a range on the anchor message first. This modal
    //    can't use the engine's own >25 bridge: it has five selects over one shared list
    //    (the bridge slices only the first) and reserves a slot for the clear option.
    let optionsForModal: SelectOption[];
    if (allModelOptions.length > ITEMS_PER_PAGE) {
      const range = await acquireModalOptionRange(
        phase,
        modalButton,
        interaction.user.id,
        locale,
        allModelOptions.length,
        ITEMS_PER_PAGE,
      );
      if (!range) return;
      modalButton = range.button;
      optionsForModal = [clearOption, ...allModelOptions.slice(range.start, range.end)];
    } else {
      optionsForModal = [clearOption, ...allModelOptions];
    }

    // Show modal with 5 select fields (one per fallback slot)
    const modalPhase = await openAnchorModal(phase, modalButton, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.model.fallback.modal_title",
      components: SLOT_IDS.map((customId, index) => ({
        customId,
        labelKey: SLOT_LABEL_KEYS[index],
        placeholder: currentFallbackPlaceholders[index],
        required: false,
        options: optionsForModal,
      })),
    });
    if (!modalPhase) return;

    // Acknowledge the modal submit within 3s; every terminal below edits in place.
    const work = await modalPhase.beginInPlaceWork();
    const values = modalPhase.values;

    const resolvedModelMap = new Map<number, LlmRow>();
    for (const m of availableModels) {
      if (m.llm_id !== undefined) resolvedModelMap.set(m.llm_id, m);
    }
    for (const entry of existingChain) {
      if (entry.kind === "llm" && entry.model.llm_id !== undefined) {
        resolvedModelMap.set(entry.model.llm_id, entry.model);
      }
    }
    const resolvedEndpointMap = new Map<number, CustomEndpointRow>();
    for (const ep of availableEndpoints) {
      if (ep.custom_endpoint_id !== undefined) resolvedEndpointMap.set(ep.custom_endpoint_id, ep);
    }
    for (const entry of existingChain) {
      if (entry.kind === "custom_endpoint" && entry.endpoint.custom_endpoint_id !== undefined) {
        resolvedEndpointMap.set(entry.endpoint.custom_endpoint_id, entry.endpoint);
      }
    }

    // Per-slot merge: blank = keep existing, __none__ = clear, value = update
    const mergedRefs: FallbackModelRef[] = [];
    // Refs the user picked in this submission, as opposed to inherited from untouched slots.
    const submittedKeys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const raw = (values[SLOT_IDS[i]] ?? "").trim();

      if (raw === "") {
        // User didn't touch this slot, so preserve existing ref
        if (existingRefs[i]) mergedRefs.push(existingRefs[i]);
      } else if (raw === CLEAR_SLOT_VALUE) {
        // Explicit clear, so skip (no push)
      } else if (raw.startsWith(CUSTOM_ENDPOINT_VALUE_PREFIX)) {
        // Custom endpoint selection
        const epId = Number.parseInt(raw.slice(CUSTOM_ENDPOINT_VALUE_PREFIX.length), 10);
        if (!Number.isNaN(epId)) {
          mergedRefs.push({ type: "custom_endpoint", id: epId });
          submittedKeys.add(`custom_endpoint:${epId}`);
        }
      } else {
        if (selectedProvider === "openrouter" && raw === "other-model") {
          await work.message.replace(buildOpenRouterMovedNotice(locale, "server"));
          return;
        }
        const match = availableModels.find((m) => m.llm_codename === raw);
        if (match?.llm_id !== undefined) {
          mergedRefs.push({ type: "llm", id: match.llm_id });
          submittedKeys.add(`llm:${match.llm_id}`);
        }
      }
    }

    const seen = new Set<string>();
    const dedupedRefs: FallbackModelRef[] = [];
    for (const ref of mergedRefs) {
      const key = getFallbackModelRefKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        dedupedRefs.push(ref);
      }
    }

    // A fallback equal to the primary is meaningless, so it never survives the write. Only a
    // pick made in this submission is worth an error; an inherited duplicate (the primary was
    // promoted after this chain was saved) is dropped silently, since erroring on it would
    // reject every submission until the user found and cleared that untouched slot.
    const primaryLlmId = tomoriState.config.llm_id;
    const primaryKeys = getPrimaryFallbackRefKeys(primaryLlmId, resolvedEndpointMap.values());
    if ([...submittedKeys].some((key) => primaryKeys.has(key))) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.fallback.primary_conflict_title",
          descriptionKey: "commands.model.fallback.primary_conflict_description",
          descriptionVars: { model: tomoriState.llm.llm_codename },
          color: ColorCode.ERROR,
        }),
      );
      return;
    }
    const finalRefs = dedupedRefs.filter((ref) => !primaryKeys.has(getFallbackModelRefKey(ref)));

    if (FALLBACK_DEBUG_ENABLED) {
      log.info(
        `[FallbackDebug][/model fallback] server_disc_id=${serverDiscId} final_refs=${JSON.stringify(finalRefs)}`,
      );
    }

    const writeOk = await llmOverrideRepo.setFallbackModelRefs(tomoriState.server_id, finalRefs, { serverDiscId });
    if (!writeOk) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    // Render the terminal on the anchor message
    if (finalRefs.length === 0) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.fallback.cleared_title",
          descriptionKey: "commands.model.fallback.cleared_description",
          color: ColorCode.SUCCESS,
        }),
      );
      return;
    }

    const modelList = finalRefs
      .map((ref, i) => {
        if (ref.type === "llm") {
          const m = resolvedModelMap.get(ref.id);
          const codename = m?.llm_codename ?? `#${ref.id}`;
          const provider = m?.llm_provider ? ` (${getProviderDisplayName(m.llm_provider)})` : "";
          return `${i + 1}. \`${codename}\`${provider}`;
        }
        const ep = resolvedEndpointMap.get(ref.id);
        const label = ep ? `${ep.label}:${ep.model_name ?? ep.label}` : `#${ref.id}`;
        return `${i + 1}. \`${label}\` (Custom)`;
      })
      .join("\n");

    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "commands.model.fallback.success_title",
        descriptionKey: "commands.model.fallback.success_description",
        descriptionVars: { model_list: modelList },
        color: ColorCode.SUCCESS,
      }),
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "model fallback",
        guildId: serverDiscId,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Error executing /model fallback for user ${userData.user_disc_id}`, error as Error, context);

    // Render the unexpected-error terminal on the anchor message; fall back to a fresh
    // reply only if the message is already gone (fatal) or was never created.
    if (anchorMessage) {
      try {
        await anchorMessage.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      } catch {}
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
