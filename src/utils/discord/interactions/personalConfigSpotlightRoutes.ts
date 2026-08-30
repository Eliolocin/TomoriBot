import { ChannelType, type ModalSubmitInteraction } from "discord.js";
import { performPanelAction } from "@/utils/discord/interactions/panelController";
import {
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  computeSpotlightRemoveFingerprint,
  computeSpotlightSetFingerprint,
  encodeSpotlightMask,
} from "@/utils/discord/personalConfigPanelCatalog";
import { buildPersonalConfigModalFieldId } from "@/utils/discord/ui/personalConfigModals";
import { takeRawModalCheckboxGroupValues, takeRawModalSelectValue } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
import {
  noChangesReceipt,
  repaint,
  resolveSpotlightBlockSelection,
  type PersonalConfigPostDeferContext,
} from "@/utils/discord/interactions/personalConfigRouteContext";

export async function handlePersonalConfigSpotlightRoutes(context: PersonalConfigPostDeferContext): Promise<boolean> {
  const { interaction, route, dependencies } = context;

  if (route.action === "spotlight-set-step1" || route.action === "spotlight-set-block-page") {
    if (!context.scope.guildId || !context.scope.internalServerId) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }

    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const fp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);

    let channelId: string;
    let hours: number;
    let chooserPage = 0;

    if (route.action === "spotlight-set-block-page") {
      if (fp !== route.fp) {
        await repaint(interaction, {
          locale: route.locale,
          scope: context.scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.unavailable"),
            detail: localizer(route.locale, "commands.personal.config.stale_warning"),
          },
          dependencies,
        });
        return true;
      }
      channelId = route.channelId;
      hours = route.hours;
      chooserPage = route.chooserPage;
    } else {
      const modal = interaction as ModalSubmitInteraction;
      const rawChannelId = takeRawModalSelectValue(modal.id, buildPersonalConfigModalFieldId("channel", route.nonce));
      if (!rawChannelId || !/^\d{17,20}$/.test(rawChannelId)) {
        await repaint(interaction, {
          locale: route.locale,
          scope: context.scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
            detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
          },
          dependencies,
        });
        return true;
      }
      const rawHours = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("hours", route.nonce)).trim();
      const parsedHours = Number.parseInt(rawHours, 10);
      if (Number.isNaN(parsedHours) || parsedHours < 0 || !/^\d+$/.test(rawHours)) {
        await repaint(interaction, {
          locale: route.locale,
          scope: context.scope,
          category: "advanced",
          page: "spotlight",
          panelReceipt: {
            tone: "error",
            heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_heading"),
            detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_hours_detail"),
          },
          dependencies,
        });
        return true;
      }
      channelId = rawChannelId;
      hours = parsedHours;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
      view: {
        kind: "spotlight-persona-select",
        channelId,
        hours,
        fp,
        totalPersonas: personas.length,
        chooserPage,
      },
    });
    return true;
  }

  if (route.action === "spotlight-set-submit") {
    if (!interaction.isModalSubmit()) throw new Error("spotlight-set-submit requires ModalSubmit interaction");
    const modal = interaction as ModalSubmitInteraction;
    if (!context.scope.guildId || !context.scope.internalServerId) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);
    const blockStart = route.blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
    const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
    if (expectedFp !== route.fp || block.length === 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    let bitmask = 0n;
    const selectedPersonaIds: number[] = [];
    for (let g = 0; g < SPOTLIGHT_PERSONA_PAGE_SIZE / 10; g++) {
      const groupValues = takeRawModalCheckboxGroupValues(
        modal.id,
        buildPersonalConfigModalFieldId(`personas_${g}`, route.nonce),
      );
      if (!groupValues) continue;
      for (const val of groupValues) {
        const pid = Number.parseInt(val, 10);
        const indexInBlock = block.findIndex((p) => p.id === pid);
        if (indexInBlock >= 0) {
          bitmask |= 1n << BigInt(indexInBlock);
          selectedPersonaIds.push(pid);
        }
      }
    }

    if (selectedPersonaIds.length === 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
      view: {
        kind: "spotlight-set-review",
        channelId: route.channelId,
        hours: route.hours,
        blockIdx: route.blockIdx,
        selectedPersonaIds,
        autoTriggerPersonaId: null,
        autoIdx: 0,
        mask: encodeSpotlightMask(bitmask),
        fp: route.fp,
        nonce: dependencies.createNonce(),
      },
    });
    return true;
  }

  if (route.action === "spot-set-auto-sub") {
    if (!interaction.isModalSubmit()) throw new Error("spot-set-auto-sub requires ModalSubmit interaction");
    const modal = interaction as ModalSubmitInteraction;
    if (!context.scope.guildId || !context.scope.internalServerId) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const resolvedSub = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
    if (!resolvedSub) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const selectedPersonaIds = resolvedSub.selected.map((p) => p.id);

    const autoFieldId = buildPersonalConfigModalFieldId("auto_trigger", route.nonce);
    const rawAutoId = takeRawModalSelectValue(modal.id, autoFieldId) ?? "0";
    const autoTriggerId = Number.parseInt(rawAutoId, 10);
    const validAutoId =
      !Number.isNaN(autoTriggerId) && autoTriggerId > 0 && selectedPersonaIds.includes(autoTriggerId)
        ? autoTriggerId
        : null;
    const validAutoIdx = validAutoId === null ? 0 : resolvedSub.block.findIndex((p) => p.id === validAutoId) + 1;

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
      view: {
        kind: "spotlight-set-review",
        channelId: route.channelId,
        hours: route.hours,
        blockIdx: route.blockIdx,
        selectedPersonaIds,
        autoTriggerPersonaId: validAutoId,
        autoIdx: validAutoIdx,
        mask: route.mask,
        fp: route.fp,
        nonce: dependencies.createNonce(),
      },
    });
    return true;
  }

  if (route.action === "spot-set-cf") {
    const serverId = context.scope.internalServerId;
    if (!context.scope.guildId || serverId === null) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    // The channel arrives from the custom ID, so the select menu that produced it is not a guard.
    // A spotlight belongs to one guild text channel, and the write is keyed on the raw snowflake.
    const confirmChannel = interaction.guild?.channels.cache.get(route.channelId);
    if (!confirmChannel || confirmChannel.type !== ChannelType.GuildText) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_invalid_channel_detail"),
        },
        dependencies,
      });
      return true;
    }

    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const resolvedConfirm = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
    if (!resolvedConfirm) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const selectedPersonaIds = resolvedConfirm.selected.map((p) => p.id);
    if (selectedPersonaIds.length === 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_no_selection_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_no_selection_detail"),
        },
        dependencies,
      });
      return true;
    }

    // The auto-trigger travels as a position inside the presented block rather than a persona ID,
    // because 50 explicit IDs do not fit beside a snowflake and a fingerprint in 100 characters.
    const autoPersona = route.autoIdx > 0 ? (resolvedConfirm.block[route.autoIdx - 1] ?? null) : null;

    // Silently writing null here would contradict the review page the user just confirmed, so a
    // chosen auto-trigger that no longer resolves is surfaced instead of dropped.
    if (route.autoIdx > 0 && (autoPersona === null || !selectedPersonaIds.includes(autoPersona.id))) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_auto_stale_detail"),
        },
        dependencies,
      });
      return true;
    }
    const autoTriggerPersonaId = autoPersona?.id ?? null;
    const expiresAt = route.hours === 0 ? null : new Date(Date.now() + route.hours * 60 * 60 * 1000);

    const action = await performPanelAction(
      () =>
        dependencies.operations.setSpotlight({
          serverId,
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          channelId: route.channelId,
          personaIds: selectedPersonaIds,
          autoTriggerPersonaId,
          expiresAt,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "no-changes") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "info",
          heading: localizer(route.locale, "commands.personal.config.no_changes_heading"),
          detail: localizer(route.locale, "commands.personal.config.no_changes_detail"),
        },
        dependencies,
      });
      return true;
    }

    if (result.status === "success") {
      dependencies.recordAction({
        action: "personal-config.personal.spotlight.set",
        serverId,
        userDiscId: interaction.user.id,
      });
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.spotlight_saved_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_saved_detail", {
            channel: route.channelId,
          }),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "spotlight-set-cancel") {
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
    });
    return true;
  }

  if (route.action === "spotlight-remove-open") {
    if (!context.scope.guildId || !context.scope.internalServerId) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    const activeSpotlights = await dependencies.loadActiveSpotlights(
      context.scope.internalServerId,
      context.scope.userId,
    );
    if (activeSpotlights.length > SPOTLIGHT_REMOVE_PAGE_SIZE) {
      const fp = computeSpotlightRemoveFingerprint(context.scope.guildId, context.scope.userDiscId, activeSpotlights);
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        dependencies,
        view: {
          kind: "spotlight-remove-range",
          rangePage: 0,
          totalOptions: activeSpotlights.length,
          fp,
        },
      });
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
    });
    return true;
  }

  if (route.action === "spotlight-remove-page") {
    const serverId = context.scope.internalServerId;
    if (!context.scope.guildId || serverId === null) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, context.scope.userId);
    const expectedFp = computeSpotlightRemoveFingerprint(
      context.scope.guildId,
      context.scope.userDiscId,
      activeSpotlights,
    );
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
      view: {
        kind: "spotlight-remove-range",
        rangePage: route.chooserPage,
        totalOptions: activeSpotlights.length,
        fp: route.fp,
      },
    });
    return true;
  }

  if (route.action === "spotlight-remove-cancel") {
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
    });
    return true;
  }

  if (route.action === "spot-set-auto-page") {
    const serverId = context.scope.internalServerId;
    if (!context.scope.guildId || serverId === null) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const bitmask = BigInt(`0x${route.mask}`);
    const selectedPersonas = personas.filter((_, i) => (bitmask & (1n << BigInt(i))) !== 0n);
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
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
        rangePage: route.chooserPage,
        totalOptions: selectedPersonas.length,
      },
    });
    return true;
  }

  if (route.action === "spot-set-auto-cancel") {
    const serverId = context.scope.internalServerId;
    if (!context.scope.guildId || serverId === null) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    const personas = await dependencies.loadGuildPersonas(context.scope.guildId);
    const expectedFp = computeSpotlightSetFingerprint(context.scope.guildId, context.scope.userDiscId, personas);
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const resolvedCancel = resolveSpotlightBlockSelection(personas, route.blockIdx, route.mask);
    if (!resolvedCancel) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const selectedPersonaIds = resolvedCancel.selected.map((p) => p.id);
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      dependencies,
      view: {
        kind: "spotlight-set-review",
        channelId: route.channelId,
        hours: route.hours,
        blockIdx: route.blockIdx,
        selectedPersonaIds,
        autoTriggerPersonaId: null,
        autoIdx: 0,
        mask: route.mask,
        fp: route.fp,
        nonce: dependencies.createNonce(),
      },
    });
    return true;
  }

  if (route.action === "spotlight-remove-submit") {
    if (!interaction.isModalSubmit()) throw new Error("spotlight-remove-submit requires ModalSubmit interaction");
    const modal = interaction as ModalSubmitInteraction;
    const serverId = context.scope.internalServerId;
    if (!context.scope.guildId || serverId === null) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.spotlight_guild_only_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_guild_only_detail"),
        },
        dependencies,
      });
      return true;
    }
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }

    const activeSpotlights = await dependencies.loadActiveSpotlights(serverId, context.scope.userId);
    const expectedFp = computeSpotlightRemoveFingerprint(
      context.scope.guildId,
      context.scope.userDiscId,
      activeSpotlights,
    );
    if (expectedFp !== route.fp) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const presentedSlice = activeSpotlights.slice(route.start, route.start + SPOTLIGHT_REMOVE_PAGE_SIZE);
    const keptChannelIds = new Set<string>();
    const presentedChannelIds: string[] = [];

    for (let g = 0; g < 5 && g * 10 < presentedSlice.length; g++) {
      const chunk = presentedSlice.slice(g * 10, (g + 1) * 10);
      for (const entry of chunk) {
        presentedChannelIds.push(entry.channelDiscId);
      }
      const groupValues = takeRawModalCheckboxGroupValues(
        modal.id,
        buildPersonalConfigModalFieldId(`spotlights_${g}`, route.nonce),
      );
      if (groupValues) {
        for (const val of groupValues) {
          keptChannelIds.add(val);
        }
      }
    }

    const removedChannelIds = presentedChannelIds.filter((chId) => !keptChannelIds.has(chId));
    if (removedChannelIds.length === 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.operations.removeSpotlights({
          serverId,
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          channelIds: removedChannelIds,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      dependencies.recordAction({
        action: "personal-config.personal.spotlight.remove",
        serverId,
        userDiscId: interaction.user.id,
      });
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.spotlight_removed_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_removed_detail", {
            removed_count: result.removedCount,
          }),
        },
        dependencies,
      });
      return true;
    }

    if (result.status === "partial-failure") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "advanced",
        page: "spotlight",
        panelReceipt: {
          tone: "warning",
          heading: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_heading"),
          detail: localizer(route.locale, "commands.personal.config.spotlight_partial_removal_detail", {
            removed_count: result.removedCount,
            failed_count: result.failedCount,
          }),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "advanced",
      page: "spotlight",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  return false;
}
