import type { ModalSubmitInteraction } from "discord.js";
import { PrivacyLevel } from "@/types/db/schema";
import { performPanelAction } from "@/utils/discord/interactions/panelController";
import { buildPersonalConfigModalFieldId } from "@/utils/discord/ui/personalConfigModals";
import { takeRawModalFileUpload, takeRawModalSelectValue } from "@/utils/discord/ui/modals";
import { MAX_TAG_LENGTH, MAX_TAGS } from "@/utils/image/tagHelpers";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import {
  noChangesReceipt,
  repaint,
  type PersonalConfigPostDeferContext,
} from "@/utils/discord/interactions/personalConfigRouteContext";

export async function handlePersonalConfigProfileWrites(context: PersonalConfigPostDeferContext): Promise<boolean> {
  const { interaction, route, dependencies } = context;

  if (route.action === "language-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = buildPersonalConfigModalFieldId("language", route.nonce);
    const language = takeRawModalSelectValue(modal.id, fieldId) || "en-US";

    const action = await performPanelAction(
      () =>
        dependencies.operations.setLanguage({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          language,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.language.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const langLabel =
        language === "ja"
          ? localizer(route.locale, "commands.personal.config.language_ja")
          : localizer(route.locale, "commands.personal.config.language_en");
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.language_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.language_updated_detail", {
            language: langLabel,
          }),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "general",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "timezone-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = buildPersonalConfigModalFieldId("timezone", route.nonce);
    const rawOffset = modal.fields.getTextInputValue(fieldId).trim();
    const parsedOffset = Number(rawOffset);

    if (Number.isNaN(parsedOffset) || parsedOffset < -12 || parsedOffset > 14) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.invalid_timezone_heading"),
          detail: localizer(route.locale, "commands.personal.config.invalid_timezone_detail"),
        },
        dependencies,
      });
      return true;
    }

    const action = await performPanelAction(
      () =>
        dependencies.operations.setTimezone({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          offset: parsedOffset,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.timezone.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.timezone_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.timezone_updated_detail", {
            timezone: formatUTCOffset(parsedOffset),
          }),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "general",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "timezone-server") {
    const action = await performPanelAction(
      () =>
        dependencies.operations.setTimezone({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          offset: null,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.timezone.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.timezone_cleared_heading"),
          detail: localizer(route.locale, "commands.personal.config.timezone_cleared_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "general",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "naming-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const nicknameRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce)).trim();
    const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
    const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

    const nickname = nicknameRaw || null;
    const prefix = prefixRaw || null;
    const suffix = suffixRaw || null;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setNaming({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          nickname,
          prefix,
          suffix,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.naming.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "general",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "persona-naming-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const nicknameRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("nickname", route.nonce)).trim();
    const prefixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("prefix", route.nonce)).trim();
    const suffixRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("suffix", route.nonce)).trim();

    const nickname = nicknameRaw || null;
    const prefix = prefixRaw || null;
    const suffix = suffixRaw || null;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setPersonaNaming({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          personaLineageId: route.lineageId,
          nickname,
          prefix,
          suffix,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.naming.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "persona",
        selectedLineageId: route.lineageId,
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.naming_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.naming_updated_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "persona",
      selectedLineageId: route.lineageId,
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "about-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const genderRaw = modal.fields
      .getTextInputValue(buildPersonalConfigModalFieldId("gender_identity", route.nonce))
      .trim();
    const pronounsRaw = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("pronouns", route.nonce)).trim();
    const rawStyle = takeRawModalSelectValue(
      modal.id,
      buildPersonalConfigModalFieldId("addressing_style", route.nonce),
    );

    const genderIdentity = genderRaw || null;
    const pronouns = pronounsRaw || null;

    const resolvedStyle =
      rawStyle === "neutral"
        ? context.scope.user.addressing_style === "neutral"
          ? "neutral"
          : null
        : rawStyle === "masculine" || rawStyle === "feminine"
          ? rawStyle
          : null;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setAbout({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          genderIdentity,
          pronouns,
          addressingStyle: resolvedStyle,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.about.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "general",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.about_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.about_updated_detail"),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "general",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "appearance-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const tagsInput = modal.fields.getTextInputValue(buildPersonalConfigModalFieldId("tags", route.nonce));

    const action = await performPanelAction(
      () =>
        dependencies.operations.setAppearance({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          rawTags: tagsInput,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.appearance.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const isCleared = result.tags.length === 0;
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "appearance",
        panelReceipt: {
          tone: "success",
          heading: localizer(
            route.locale,
            isCleared
              ? "commands.personal.config.appearance_cleared_heading"
              : "commands.personal.config.appearance_updated_heading",
          ),
          detail: localizer(
            route.locale,
            isCleared
              ? "commands.personal.config.appearance_cleared_detail"
              : "commands.personal.config.appearance_updated_detail",
          ),
        },
        dependencies,
      });
      return true;
    }

    const tone: "error" = "error";
    let headingKey = "commands.personal.config.write_failed_heading";
    let detailKey = "commands.personal.config.write_failed_detail";
    let vars: Record<string, string | number> | undefined;

    if (result.status === "too-many-tags") {
      headingKey = "commands.personal.config.too_many_tags_heading";
      detailKey = "commands.personal.config.too_many_tags_detail";
      vars = { max: MAX_TAGS };
    } else if (result.status === "tag-too-long") {
      headingKey = "commands.personal.config.tag_too_long_heading";
      detailKey = "commands.personal.config.tag_too_long_detail";
      vars = { max: MAX_TAG_LENGTH };
    } else if (result.status === "invalid-tags") {
      headingKey = "commands.personal.config.invalid_tags_heading";
      detailKey = "commands.personal.config.invalid_tags_detail";
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "appearance",
      panelReceipt: {
        tone,
        heading: localizer(route.locale, headingKey),
        detail: localizer(route.locale, detailKey, vars),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "character-reference-submit" || route.action === "character-reference-clear") {
    const attachment =
      route.action === "character-reference-submit"
        ? (takeRawModalFileUpload(
            (interaction as ModalSubmitInteraction).id,
            buildPersonalConfigModalFieldId("character_reference", route.nonce),
          ) ?? null)
        : null;
    const action = await performPanelAction(
      () =>
        dependencies.operations.replaceCharacterReference({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          previousRef: context.scope.user.nai_char_ref_url ?? null,
          attachment,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.character-reference.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "profile",
        page: "appearance",
        panelReceipt: {
          tone: "success",
          heading: localizer(
            route.locale,
            result.cleared
              ? "commands.novelai.character-reference.cleared_title"
              : "commands.novelai.character-reference.success_title",
          ),
          detail: localizer(
            route.locale,
            result.cleared
              ? "commands.novelai.character-reference.cleared_me_description"
              : "commands.novelai.character-reference.success_me_description",
          ),
        },
        dependencies,
      });
      return true;
    }

    const invalidImage = result.status === "invalid-image";
    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "profile",
      page: "appearance",
      panelReceipt: {
        tone: "error",
        heading: localizer(
          route.locale,
          invalidImage ? result.titleKey : "commands.personal.config.write_failed_heading",
        ),
        detail: localizer(
          route.locale,
          invalidImage ? result.descriptionKey : "commands.personal.config.write_failed_detail",
        ),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "privacy-level-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const fieldId = buildPersonalConfigModalFieldId("privacy_level", route.nonce);
    const selectedValue = takeRawModalSelectValue(modal.id, fieldId) ?? "";
    const requestedLevel = Number.parseInt(selectedValue, 10) as PrivacyLevel;

    const action = await performPanelAction(
      () =>
        dependencies.operations.setPrivacyLevel({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          level: requestedLevel,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.privacy.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const levelName =
        requestedLevel === PrivacyLevel.FULL
          ? localizer(route.locale, "commands.personal.config.privacy_level_full")
          : requestedLevel === PrivacyLevel.PARTIAL
            ? localizer(route.locale, "commands.personal.config.privacy_level_partial")
            : localizer(route.locale, "commands.personal.config.privacy_level_minimal");

      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: {
          tone: "success",
          heading: localizer(route.locale, "commands.personal.config.privacy_updated_heading"),
          detail: localizer(route.locale, "commands.personal.config.privacy_updated_detail", {
            level: levelName,
          }),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "privacy",
      page: "controls",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "crossserver-set") {
    if (context.scope.readStatus !== "fresh") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: {
          tone: "error",
          heading: localizer(route.locale, "commands.personal.config.unavailable"),
          detail: localizer(route.locale, "commands.personal.config.stale_warning"),
        },
        dependencies,
      });
      return true;
    }
    const currentOptIn = Boolean(context.scope.user.shortterm_cache_crossserver_opt_in);
    if (currentOptIn === route.enabled) {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }
    const action = await performPanelAction(
      () =>
        dependencies.operations.setCrossServerStm({
          userId: context.scope.userId,
          userDiscId: context.scope.userDiscId,
          enabled: route.enabled,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "no-changes") {
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: noChangesReceipt(route.locale),
        dependencies,
      });
      return true;
    }

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.crossserver-stm.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const isEnabled = result.enabled;
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: {
          tone: "success",
          heading: localizer(
            route.locale,
            isEnabled
              ? "commands.personal.config.crossserver_enabled_heading"
              : "commands.personal.config.crossserver_disabled_heading",
          ),
          detail: localizer(
            route.locale,
            isEnabled
              ? "commands.personal.config.crossserver_enabled_detail"
              : "commands.personal.config.crossserver_disabled_detail",
          ),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "privacy",
      page: "controls",
      panelReceipt: {
        tone: "error",
        heading: localizer(route.locale, "commands.personal.config.write_failed_heading"),
        detail: localizer(route.locale, "commands.personal.config.write_failed_detail"),
      },
      dependencies,
    });
    return true;
  }

  if (route.action === "crossserver-toggle") {
    const action = await performPanelAction(
      () =>
        dependencies.operations.toggleCrossServerStm({
          userDiscId: context.scope.userDiscId,
        }),
      () => dependencies.resolveScope(interaction, true),
    );
    const result = action.result;
    context.scope = action.state ?? context.scope;

    if (result.status === "success") {
      if (context.scope.internalServerId) {
        dependencies.recordAction({
          action: "personal-config.personal.crossserver-stm.set",
          serverId: context.scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      const isEnabled = result.enabled;
      await repaint(interaction, {
        locale: route.locale,
        scope: context.scope,
        category: "privacy",
        page: "controls",
        panelReceipt: {
          tone: "success",
          heading: localizer(
            route.locale,
            isEnabled
              ? "commands.personal.config.crossserver_enabled_heading"
              : "commands.personal.config.crossserver_disabled_heading",
          ),
          detail: localizer(
            route.locale,
            isEnabled
              ? "commands.personal.config.crossserver_enabled_detail"
              : "commands.personal.config.crossserver_disabled_detail",
          ),
        },
        dependencies,
      });
      return true;
    }

    await repaint(interaction, {
      locale: route.locale,
      scope: context.scope,
      category: "privacy",
      page: "controls",
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
