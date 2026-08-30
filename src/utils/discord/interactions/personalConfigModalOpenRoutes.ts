import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import { PrivacyLevel } from "@/types/db/schema";
import { loadFallbackSelectionOptions } from "@/utils/discord/interactions/personalConfigLoaders";
import {
  PERSONAL_FALLBACK_PAGE_SIZE,
  PERSONAL_MODEL_PAGE_SIZE,
  PERSONAL_PROVIDER_DIRECT_LIMIT,
  PERSONAL_PROVIDER_RANGE_VALUE,
  SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  computeSpotlightRemoveFingerprint,
  computeSpotlightSetFingerprint,
  decodeProviderParam,
} from "@/utils/discord/personalConfigPanelCatalog";
import { localizer } from "@/utils/text/localizer";
import { log } from "@/utils/misc/logger";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { loadUserSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import {
  repaint,
  resolveSpotlightBlockSelection,
  type PersonalConfigPreDeferContext,
} from "@/utils/discord/interactions/personalConfigRouteContext";

export async function handlePersonalConfigModalOpen(
  context: PersonalConfigPreDeferContext,
): Promise<"handled" | "fall-through"> {
  const { interaction, route, dependencies } = context;

  // Modal openings handle their own interaction response (they must not defer beforehand)
  if (route.action === "language-open") {
    if (!interaction.isButton()) throw new Error("language-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showLanguageModal(interaction, route.locale, nonce, cachedScope.user.language_pref ?? "en-US");
    return "handled";
  }

  if (route.action === "timezone-open") {
    if (!interaction.isButton()) throw new Error("timezone-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showTimezoneModal(interaction, route.locale, nonce, cachedScope.user.timezone_offset ?? null);
    return "handled";
  }

  if (route.action === "naming-open") {
    if (!interaction.isButton()) throw new Error("naming-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showNamingModal(interaction, route.locale, nonce, {
      nickname: cachedScope.user.user_nickname ?? null,
      prefix: cachedScope.user.prefix_override ?? null,
      suffix: cachedScope.user.suffix_override ?? null,
    });
    return "handled";
  }

  if (route.action === "persona-naming-open") {
    if (!interaction.isButton()) throw new Error("persona-naming-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const pref = await dependencies.loadPersonaNamingPreference(cachedScope.userId, route.lineageId);
    const nonce = dependencies.createNonce();
    await dependencies.showPersonaNamingModal(interaction, route.locale, route.lineageId, nonce, {
      nickname: pref?.nickname_override ?? null,
      prefix: pref?.prefix_override ?? null,
      suffix: pref?.suffix_override ?? null,
    });
    return "handled";
  }

  if (route.action === "about-open") {
    if (!interaction.isButton()) throw new Error("about-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showAboutModal(interaction, route.locale, nonce, {
      genderIdentity: cachedScope.user.gender_identity ?? null,
      pronouns: cachedScope.user.pronouns ?? null,
      addressingStyle: cachedScope.user.addressing_style ?? null,
    });
    return "handled";
  }

  if (route.action === "appearance-open") {
    if (!interaction.isButton()) throw new Error("appearance-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showAppearanceModal(
      interaction,
      route.locale,
      nonce,
      cachedScope.user.physical_appearance_tags ?? [],
    );
    return "handled";
  }

  if (route.action === "privacy-level-open") {
    if (!interaction.isButton()) throw new Error("privacy-level-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showPrivacyLevelModal(
      interaction,
      route.locale,
      nonce,
      cachedScope.user.privacy_level ?? PrivacyLevel.MINIMAL,
    );
    return "handled";
  }

  if (route.action === "quick-toggle-open") {
    if (!interaction.isButton()) throw new Error("quick-toggle-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const nonce = dependencies.createNonce();
    await dependencies.showQuickToggleModal(interaction, route.locale, nonce, rows);
    return "handled";
  }

  if (route.action === "parameters-1-open") {
    if (!interaction.isButton()) throw new Error("parameters-1-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
    const nonce = dependencies.createNonce();
    await dependencies.showParameters1Modal(interaction, route.locale, nonce, route.provider, config);
    return "handled";
  }

  if (route.action === "parameters-2-open") {
    if (!interaction.isButton()) throw new Error("parameters-2-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
    const nonce = dependencies.createNonce();
    await dependencies.showParameters2Modal(interaction, route.locale, nonce, route.provider, config);
    return "handled";
  }

  // Choosing a provider opens its fallback modal directly. This select replaced a separate
  // Edit button, so it is the only entry point and must not merely repaint.
  if (route.action === "fallbacks-provider-select") {
    const selectMenu = interaction as StringSelectMenuInteraction;
    const chosenProvider = decodeProviderParam(selectMenu.values[0]);
    // A modal is its own acknowledgement, so this branch must run before the panel controller
    // defers and must read a cached scope rather than forcing a refresh.
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }

    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const config = rows.find((r) => r.provider.toLowerCase() === chosenProvider.toLowerCase()) ?? null;
    const eligibleProviders = await loadUserSavedProvidersForCapability(cachedScope.userId, "text");
    if (!config || !eligibleProviders.some((row) => row.provider.toLowerCase() === chosenProvider.toLowerCase())) {
      await repaint(interaction, {
        locale: route.locale,
        scope: cachedScope,
        category: "models",
        page: "fallbacks",
        dependencies,
        selectedFallbacksProvider: chosenProvider,
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
          detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
        },
      });
      return "handled";
    }

    let availableOptions: Array<{ refKey: string; label: string }> = [];
    try {
      availableOptions = await loadFallbackSelectionOptions(cachedScope.userId, chosenProvider);
    } catch (error) {
      log.warn("Failed to load available models for fallbacks modal", { provider: chosenProvider, error });
    }

    if (availableOptions.length > PERSONAL_FALLBACK_PAGE_SIZE) {
      await interaction.deferUpdate();
      await repaint(interaction, {
        locale: route.locale,
        scope: cachedScope,
        category: "models",
        page: "fallbacks",
        dependencies,
        selectedFallbacksProvider: chosenProvider,
        view: {
          kind: "fallbacks-range",
          provider: chosenProvider,
          rangePage: 0,
          totalOptions: availableOptions.length,
        },
      });
      return "handled";
    }

    const nonce = dependencies.createNonce();
    await dependencies.showFallbacksModal(
      selectMenu,
      route.locale,
      nonce,
      chosenProvider,
      availableOptions,
      config?.fallback_model_refs ?? [],
    );
    return "handled";
  }

  if (route.action === "fallbacks-range-open") {
    if (!interaction.isButton()) throw new Error("fallbacks-range-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const config = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase()) ?? null;
    const eligibleProviders = await loadUserSavedProvidersForCapability(cachedScope.userId, "text");
    if (!config || !eligibleProviders.some((row) => row.provider.toLowerCase() === route.provider.toLowerCase())) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    let availableOptions: Array<{ refKey: string; label: string }> = [];
    try {
      availableOptions = await loadFallbackSelectionOptions(cachedScope.userId, route.provider);
    } catch (error) {
      log.warn("Failed to load available models for fallbacks modal", { provider: route.provider, error });
    }
    if (route.start % 24 !== 0 || route.start >= availableOptions.length) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const slice = availableOptions.slice(route.start, route.start + PERSONAL_FALLBACK_PAGE_SIZE);
    const nonce = dependencies.createNonce();
    await dependencies.showFallbacksModal(
      interaction,
      route.locale,
      nonce,
      route.provider,
      slice,
      config?.fallback_model_refs ?? [],
    );
    return "handled";
  }

  if (route.action === "model-range-open") {
    if (!interaction.isButton()) throw new Error("model-range-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const availableModels = await dependencies.loadAvailableModelsForCapability(
      cachedScope.userId,
      route.provider,
      route.capability,
    );
    if (route.start % PERSONAL_MODEL_PAGE_SIZE !== 0 || route.start >= availableModels.length) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
    const currentConfig = rows.find((r) => r.provider.toLowerCase() === route.provider.toLowerCase());
    let currentModelId: number | null = null;
    if (currentConfig) {
      if (route.capability === "text") currentModelId = currentConfig.llm_id ?? null;
      else if (route.capability === "vision") currentModelId = currentConfig.vision_llm_id ?? null;
      else if (route.capability === "embedding") currentModelId = currentConfig.embedding_model_id ?? null;
      else if (route.capability === "image") currentModelId = currentConfig.diffusion_model_id ?? null;
      else if (route.capability === "image_nai") currentModelId = currentConfig.nai_diffusion_model_id ?? null;
      else if (route.capability === "video") currentModelId = currentConfig.video_model_id ?? null;
    }
    const slice = availableModels.slice(route.start, route.start + PERSONAL_MODEL_PAGE_SIZE);
    const nonce = dependencies.createNonce();
    await dependencies.showModelSelectModal(
      interaction,
      route.locale,
      nonce,
      route.capability,
      route.provider,
      slice,
      currentModelId,
    );
    return "handled";
  }

  if (route.action === "model-provider-select") {
    if (!interaction.isStringSelectMenu()) {
      throw new Error("model-provider-select requires StringSelectMenu interaction");
    }
    const selectMenu = interaction as StringSelectMenuInteraction;
    const chosen = selectMenu.values[0];
    if (chosen === PERSONAL_PROVIDER_RANGE_VALUE) {
      await interaction.deferUpdate();
      const cachedScope = await dependencies.resolveScope(interaction, false);
      if (!cachedScope) {
        await interaction.editReply({
          content: localizer(route.locale, "commands.personal.config.unavailable"),
          components: [],
        });
        return "handled";
      }
      const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
      const displayInfo = await dependencies.loadPersonalModelDisplayInfo(cachedScope.userId, rows, route.capability);
      const providers = displayInfo.eligibleProvidersForCapability[route.capability];
      if (providers.length <= PERSONAL_PROVIDER_DIRECT_LIMIT) {
        await repaint(interaction, {
          locale: route.locale,
          scope: cachedScope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.unavailable"),
            detail: localizer(route.locale, "commands.personal.config.stale_warning"),
          },
          dependencies,
        });
        return "handled";
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: cachedScope,
        category: "models",
        page: "switch",
        dependencies,
        selectedCapability: route.capability,
        view: {
          kind: "model-provider-range",
          capability: route.capability,
          rangePage: 0,
          totalOptions: providers.length,
        },
      });
      return "handled";
    }
    if (chosen !== "__server_default__") {
      const provider = decodeProviderParam(chosen);
      const cachedScope = await dependencies.resolveScope(interaction, false);
      if (!cachedScope) {
        await interaction.reply({
          content: localizer(route.locale, "commands.personal.config.unavailable"),
          flags: MessageFlags.Ephemeral,
        });
        return "handled";
      }
      const availableModels = await dependencies.loadAvailableModelsForCapability(
        cachedScope.userId,
        provider,
        route.capability,
      );

      if (availableModels.length === 0) {
        await interaction.deferUpdate();
        await repaint(interaction, {
          locale: route.locale,
          scope: cachedScope,
          category: "models",
          page: "switch",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.no_models_available_heading"),
            detail: localizer(route.locale, "commands.personal.config.no_models_available_detail", {
              provider: getProviderDisplayName(provider),
            }),
          },
          dependencies,
          selectedCapability: route.capability,
        });
        return "handled";
      }

      if (availableModels.length > PERSONAL_MODEL_PAGE_SIZE) {
        await interaction.deferUpdate();
        await repaint(interaction, {
          locale: route.locale,
          scope: cachedScope,
          category: "models",
          page: "switch",
          dependencies,
          selectedCapability: route.capability,
          view: {
            kind: "model-range",
            capability: route.capability,
            provider,
            rangePage: 0,
            totalOptions: availableModels.length,
          },
        });
        return "handled";
      }

      const rows = await dependencies.loadUserSavedProviders(cachedScope.userId);
      const currentConfig = rows.find((r) => r.provider.toLowerCase() === provider.toLowerCase());
      let currentModelId: number | null = null;
      if (currentConfig) {
        if (route.capability === "text") currentModelId = currentConfig.llm_id ?? null;
        else if (route.capability === "vision") currentModelId = currentConfig.vision_llm_id ?? null;
        else if (route.capability === "embedding") currentModelId = currentConfig.embedding_model_id ?? null;
        else if (route.capability === "image") currentModelId = currentConfig.diffusion_model_id ?? null;
        else if (route.capability === "image_nai") currentModelId = currentConfig.nai_diffusion_model_id ?? null;
        else if (route.capability === "video") currentModelId = currentConfig.video_model_id ?? null;
      }
      const nonce = dependencies.createNonce();
      await dependencies.showModelSelectModal(
        interaction,
        route.locale,
        nonce,
        route.capability,
        provider,
        availableModels,
        currentModelId,
      );
      return "handled";
    }
    // When the selected value is __server_default__, control falls through to the post-defer
    // handler to acknowledge with deferUpdate and update provider assignment.
  }

  if (route.action === "impersonation-open") {
    if (!interaction.isButton()) throw new Error("impersonation-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.unavailable"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showImpersonationModal(
      interaction,
      route.locale,
      nonce,
      cachedScope.user.impersonation_prompt ?? null,
    );
    return "handled";
  }

  if (route.action === "spotlight-set-open") {
    if (!interaction.isButton()) throw new Error("spotlight-set-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
    if (personas.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_no_personas_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    await dependencies.showSpotlightStep1Modal(interaction, route.locale, dependencies.createNonce());
    return "handled";
  }

  if (route.action === "spotlight-set-block") {
    if (!interaction.isButton()) throw new Error("spotlight-set-block requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const blockStart = route.blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
    const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
    if (block.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    await dependencies.showSpotlightSetModal(
      interaction,
      route.locale,
      dependencies.createNonce(),
      route.channelId,
      route.hours,
      route.blockIdx,
      route.fp,
      block,
    );
    return "handled";
  }

  if (route.action === "spot-set-auto") {
    if (!interaction.isButton()) throw new Error("spot-set-auto requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const resolved = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
    if (!resolved) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const selectedPersonas = resolved.selected;
    if (selectedPersonas.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    if (selectedPersonas.length === 1) {
      await interaction.deferUpdate();
      const selectedPersonaIds = selectedPersonas.map((p) => p.id);
      const autoTriggerPersonaId = selectedPersonas[0]?.id ?? null;
      const autoIdx =
        autoTriggerPersonaId === null ? 0 : resolved.block.findIndex((p) => p.id === autoTriggerPersonaId) + 1;
      await repaint(interaction, {
        locale: route.locale,
        scope: cachedScope,
        category: "advanced",
        page: "spotlight",
        dependencies,
        view: {
          kind: "spotlight-set-review",
          channelId: route.channelId,
          hours: route.hours,
          blockIdx: route.blockIdx,
          selectedPersonaIds,
          autoTriggerPersonaId,
          autoIdx,
          mask: route.mask,
          fp: route.fp,
          nonce: dependencies.createNonce(),
        },
      });
      return "handled";
    }
    if (selectedPersonas.length > SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE) {
      await interaction.deferUpdate();
      await repaint(interaction, {
        locale: route.locale,
        scope: cachedScope,
        category: "advanced",
        page: "spotlight",
        dependencies,
        view: {
          kind: "spotlight-auto-range",
          channelId: route.channelId,
          hours: route.hours,
          blockIdx: route.blockIdx,
          mask: route.mask,
          fp: route.fp,
          rangePage: 0,
          totalOptions: selectedPersonas.length,
        },
      });
      return "handled";
    }
    const nonce = dependencies.createNonce();
    await dependencies.showSpotlightAutoTriggerModal(
      interaction,
      route.locale,
      nonce,
      route.channelId,
      route.hours,
      route.blockIdx,
      route.mask,
      route.fp,
      selectedPersonas,
    );
    return "handled";
  }

  if (route.action === "spot-set-auto-range") {
    if (!interaction.isButton()) throw new Error("spot-set-auto-range requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(cachedScope.guildId, cachedScope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const resolvedRange = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
    if (!resolvedRange) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const slice = resolvedRange.selected.slice(route.start, route.start + SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE);
    const nonce = dependencies.createNonce();
    await dependencies.showSpotlightAutoTriggerModal(
      interaction,
      route.locale,
      nonce,
      route.channelId,
      route.hours,
      route.blockIdx,
      route.mask,
      route.fp,
      slice,
    );
    return "handled";
  }

  if (route.action === "spotlight-remove-open") {
    if (!interaction.isButton()) throw new Error("spotlight-remove-open requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const activeSpotlights = await dependencies.loadActiveSpotlights(cachedScope.internalServerId, cachedScope.userId);
    if (activeSpotlights.length === 0) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_none_active"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const fp = computeSpotlightRemoveFingerprint(cachedScope.guildId, cachedScope.userDiscId, activeSpotlights);
    if (activeSpotlights.length <= SPOTLIGHT_REMOVE_PAGE_SIZE) {
      const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
      const guildChannels = interaction.guild?.channels.cache;
      const nonce = dependencies.createNonce();
      await dependencies.showSpotlightRemoveModal(
        interaction,
        route.locale,
        nonce,
        0,
        fp,
        activeSpotlights,
        personas,
        guildChannels,
      );
      return "handled";
    }
    // Above the single-page remove modal limit, fall through to the post-defer range chooser.
  }

  if (route.action === "spot-rem-range") {
    if (!interaction.isButton()) throw new Error("spot-rem-range requires Button interaction");
    const cachedScope = await dependencies.resolveScope(interaction, false);
    if (!cachedScope?.guildId || !cachedScope.internalServerId) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const allActive = await dependencies.loadActiveSpotlights(cachedScope.internalServerId, cachedScope.userId);
    const expectedFp = computeSpotlightRemoveFingerprint(cachedScope.guildId, cachedScope.userDiscId, allActive);
    if (expectedFp !== route.fp) {
      await interaction.reply({
        content: localizer(route.locale, "commands.personal.config.stale_warning"),
        flags: MessageFlags.Ephemeral,
      });
      return "handled";
    }
    const slice = allActive.slice(route.start, route.start + SPOTLIGHT_REMOVE_PAGE_SIZE);
    const personas = await dependencies.loadGuildPersonas(cachedScope.guildId);
    const guildChannels = interaction.guild?.channels.cache;
    const nonce = dependencies.createNonce();
    await dependencies.showSpotlightRemoveModal(
      interaction,
      route.locale,
      nonce,
      route.start,
      route.fp,
      slice,
      personas,
      guildChannels,
    );
    return "handled";
  }

  return "fall-through";
}
