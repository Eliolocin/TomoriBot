import type { ChatInputCommandInteraction, ButtonInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags } from "discord.js";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { log, ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import type {
  ErrorContext,
  LlmRow,
  UserRow,
  FallbackModelRef,
  FallbackEntry,
  CustomEndpointRow,
} from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";

import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { loadUserSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { isCustomProvider, parseCustomProvider } from "@/utils/provider/customProviderUtils";
import { getFallbackModelRefKey, getPrimaryFallbackRefKeys } from "@/utils/provider/fallbackModelIdentity";
import { resolveActivePersonalProviderModelSelections } from "@/utils/provider/personalProviderHelpers";
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
const CUSTOM_ENDPOINT_VALUE_PREFIX = "ce:";
/** Custom-id root for this command's anchor provider picker / opener buttons. */
const ID_ROOT = "personal_model_fallback";
// One of Discord's 25 select options is reserved for the explicit "None" / clear choice,
// which is re-prepended to every page so only 24 models fit per range.
const ITEMS_PER_PAGE = 24;

function getLocalizedDescription(model: LlmRow, locale: string): string {
  const normalizedLocale = locale.toLowerCase().split("-")[0];
  const description = normalizedLocale === "ja" ? model.ja_description : model.llm_description;
  const baseDescription = description || model.llm_description || `${model.llm_provider} model`;
  const flags: string[] = [];
  if (model.is_free) flags.push("FREE");
  if (model.has_tools) flags.push("TOOLS");
  if (model.sees_images) flags.push("IMG");
  if (model.sees_videos) flags.push("VID");
  if (model.supports_structoutput) flags.push("STRUCT");
  return flags.length > 0 ? `(${flags.join("+")}) ${baseDescription}` : baseDescription;
}

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
    const modelLabel = entry.model.llm_codename;
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
  subcommand.setName("fallback").setDescription(localizer("en-US", "commands.personal.model.fallback.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!userData.user_id) {
    return;
  }

  // Anchor one-message controller, tracked so the outer catch can render an
  // unexpected-error terminal on the same ephemeral message.
  let anchorMessage: PersonaWorkflowMessageController | null = null;

  try {
    const savedProviders = await loadUserSavedProvidersForCapability(userData.user_id, "text");
    const currentSelections =
      savedProviders.length > 1 ? await resolveActivePersonalProviderModelSelections(savedProviders, "text") : [];
    const initialPayload =
      savedProviders.length === 0
        ? buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.personal.model.fallback.no_provider_title",
            descriptionKey: "commands.personal.model.fallback.no_provider_description",
            color: ColorCode.WARN,
          })
        : savedProviders.length === 1
          ? buildOpenSelectorPayload(locale, `${ID_ROOT}_open`)
          : buildProviderPickerPayload(
              locale,
              ID_ROOT,
              savedProviders.map((row) => row.provider),
              currentSelections,
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

    const selectedConfig = savedProviders.find((p) => p.provider.toLowerCase() === selectedProvider) ?? null;
    const existingRefs = selectedConfig?.fallback_model_refs ?? [];

    const llmRefIds = existingRefs.filter((r) => r.type === "llm").map((r) => r.id);
    const epRefIds = existingRefs.filter((r) => r.type === "custom_endpoint").map((r) => r.id);
    const [refLlms, refEndpoints] = await Promise.all([
      llmRefIds.length > 0 ? llmModelRepo.getLlmsByIds(llmRefIds) : Promise.resolve([]),
      epRefIds.length > 0 ? llmProviderRepo.loadCustomEndpointsByIds(epRefIds) : Promise.resolve([]),
    ]);
    const llmMap = new Map(refLlms.map((m) => [m.llm_id as number, m]));
    const epMap = new Map(refEndpoints.map((e) => [e.custom_endpoint_id as number, e]));
    const existingChain: FallbackEntry[] = existingRefs
      .map((ref) => {
        if (ref.type === "llm") {
          const model = llmMap.get(ref.id);
          return model ? ({ kind: "llm", model } as FallbackEntry) : null;
        }
        const endpoint = epMap.get(ref.id);
        return endpoint ? ({ kind: "custom_endpoint", endpoint } as FallbackEntry) : null;
      })
      .filter((e): e is FallbackEntry => e !== null);

    let availableModels: LlmRow[] = [];
    let availableEndpoints: CustomEndpointRow[] = [];
    let allModelOptions: SelectOption[];

    if (isCustomProvider(selectedProvider)) {
      const parsed = parseCustomProvider(selectedProvider);
      const connectionId = parsed?.connectionId ?? null;
      const allEndpoints = await llmProviderRepo.loadCustomEndpointsForUser(userData.user_id);
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
      availableModels =
        (await llmModelRepo.loadAvailableModelsForProvider(selectedProvider, false, {
          kind: "personal",
          ownerId: userData.user_id,
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

      allModelOptions = selectableModels.map((model) => ({
        label: safeSelectOptionText(model.llm_codename),
        value: safeSelectOptionText(model.llm_codename),
        description: safeSelectOptionText(getLocalizedDescription(model, userData.language_pref)),
      }));
    }

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

    const modalPhase = await openAnchorModal(phase, modalButton, locale, {
      modalCustomId: `personal_model_fallback_modal_${interaction.id}`,
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
        if (existingRefs[i]) mergedRefs.push(existingRefs[i]);
      } else if (raw === CLEAR_SLOT_VALUE) {
      } else if (raw.startsWith(CUSTOM_ENDPOINT_VALUE_PREFIX)) {
        const epId = Number.parseInt(raw.slice(CUSTOM_ENDPOINT_VALUE_PREFIX.length), 10);
        if (!Number.isNaN(epId)) {
          mergedRefs.push({ type: "custom_endpoint", id: epId });
          submittedKeys.add(`custom_endpoint:${epId}`);
        }
      } else {
        if (selectedProvider === "openrouter" && raw === "other-model") {
          await work.message.replace(buildOpenRouterMovedNotice(locale, "personal"));
          return;
        }
        const match = availableModels.find((model) => model.llm_codename === raw);
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
    const primaryLlmId = selectedConfig?.llm_id ?? null;
    const primaryKeys = getPrimaryFallbackRefKeys(primaryLlmId, resolvedEndpointMap.values());
    if ([...submittedKeys].some((key) => primaryKeys.has(key))) {
      const primaryModel = primaryLlmId ? resolvedModelMap.get(primaryLlmId) : undefined;
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.personal.model.fallback.primary_conflict_title",
          descriptionKey: "commands.personal.model.fallback.primary_conflict_description",
          descriptionVars: { model: primaryModel?.llm_codename ?? `#${primaryLlmId}` },
          color: ColorCode.ERROR,
        }),
      );
      return;
    }
    const finalRefs = dedupedRefs.filter((ref) => !primaryKeys.has(getFallbackModelRefKey(ref)));

    if (!selectedConfig) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    const writeOk = await llmProviderRepo.upsertUserSavedProviderConfig(userData.user_id, {
      ...selectedConfig,
      fallback_model_refs: finalRefs,
    });
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

    if (finalRefs.length === 0) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.personal.model.fallback.cleared_title",
          descriptionKey: "commands.personal.model.fallback.cleared_description",
          descriptionVars: { provider: getProviderDisplayName(selectedProvider) },
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
        titleKey: "commands.personal.model.fallback.success_title",
        descriptionKey: "commands.personal.model.fallback.success_description",
        descriptionVars: {
          model_list: modelList,
          provider: getProviderDisplayName(selectedProvider),
        },
        color: ColorCode.SUCCESS,
      }),
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "personal model fallback",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /personal model fallback", error as Error, context);

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
