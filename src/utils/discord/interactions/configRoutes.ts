import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReceipt, PanelReceiptTone } from "@/types/discord/panel";
import type { AddressingStyle } from "@/types/personaNaming";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";
import {
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  CONFIG_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE,
  computeTriggerRemoveFingerprint,
  parseConfigPanelRoute,
  type ConfigPage,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { setGuildBotAvatar, setGuildBotNickname } from "@/utils/discord/guildIdentity";
import { beginPanelInteraction } from "@/utils/discord/interactions/panelController";
import {
  isConfigRouteAuthorized,
  resolveConfigActor,
  resolveConfigLanding,
  visibleConfigPages,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import { configPersonaOperations, type GuildIdentityPort } from "@/utils/discord/interactions/configPersonaOperations";
import {
  deniedReceipt,
  repaint,
  resolveSelectedPersona,
  staleReceipt,
  terminalPayload,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import { resolvePersonaPanelAvatar } from "@/utils/discord/personaPanelAvatar";
import {
  buildConfigModalFieldId,
  buildPersonaAvatarModal,
  buildPersonaNamingHabitsModal,
  buildPersonaRenameModal,
  buildTriggerAddModal,
  buildTriggerRemoveCheckboxGroupId,
  buildTriggerRemoveModal,
} from "@/utils/discord/ui/configModals";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues, takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { log } from "@/utils/misc/logger";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

const MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "avatar-open",
  "rename-open",
  "naming-open",
  "trigger-add-open",
  "trigger-remove-open",
]);

function receipt(
  locale: string,
  tone: PanelReceiptTone,
  headingKey: string,
  detailKey: string,
  vars: Record<string, string | number> = {},
): PanelReceipt {
  return {
    tone,
    heading: localizer(locale, headingKey),
    detail: localizer(locale, detailKey, vars),
  };
}

const PROMOTED_AVATAR_OPTIONS = { size: 1024, extension: "png", forceStatic: true } as const;

function createGuildIdentityPort(guildId: string, interaction: GlobalRoutableInteraction): GuildIdentityPort {
  return {
    async setNickname(nickname) {
      return (await setGuildBotNickname(guildId, nickname)).success;
    },
    async setAvatar(avatarDataUri) {
      const result = await setGuildBotAvatar(guildId, avatarDataUri);
      return { ok: result.success, rateLimited: result.error === "rate_limited", details: result.details };
    },
    async currentAvatarReference() {
      // The bot's live guild avatar is what the outgoing main persona actually looked like. A
      // forced fetch avoids a cached member returning the pre-swap image on a repeat promotion.
      const fetched = interaction.client.user
        ? await interaction.guild?.members.fetch({ user: interaction.client.user.id, force: true }).catch(() => null)
        : null;
      return (
        fetched?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        interaction.guild?.members.me?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        interaction.client.user?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        null
      );
    },
  };
}

async function loadWorkspacePersonas(serverDiscId: string, forceRefresh: boolean): Promise<TomoriState[]> {
  const personas = forceRefresh
    ? await personaRepository.loadAllForServer(serverDiscId)
    : await getCachedAllPersonas(serverDiscId);
  return personas.filter((persona) => typeof persona.persona_id === "number");
}

const defaultDependencies: ConfigRouteDependencies = {
  async resolveScope(interaction, forceRefresh = false) {
    const guildId = interaction.guildId ?? null;
    // Every absorbed command keys its workspace this way, so the panel must not invent a different
    // one or a DM's settings would land under a second, empty workspace.
    const serverDiscId = guildId ?? interaction.user.id;
    try {
      const personas = await loadWorkspacePersonas(serverDiscId, forceRefresh);
      if (personas.length === 0) return null;
      return {
        serverDiscId,
        guildId,
        internalServerId: personas[0]?.server_id ?? null,
        actor: resolveConfigActor(interaction),
        personas,
        readStatus: "fresh",
      };
    } catch (error) {
      await log.error("Failed to resolve /config workspace scope", error, {
        errorType: "InteractionRouteError",
        metadata: { serverDiscId },
      });
      return null;
    }
  },
  getPersonaAvatarData: resolvePersonaPanelAvatar,
  operations: configPersonaOperations,
  createGuildIdentity: createGuildIdentityPort,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showModal: (interaction, payload) => {
    if (interaction.isModalSubmit()) throw new Error("A modal submit cannot open another modal");
    return showRoutedRawModal(interaction, payload);
  },
  takeAvatarUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildConfigModalFieldId("avatar", nonce)),
  takeCheckboxValues: takeRawModalCheckboxGroupValues,
};

/**
 * A write must land on exactly the persona its button named. Navigation may fall back to the main
 * persona when a route outlives its row, but a write that fell back would silently mutate a
 * different persona than the one the user was looking at.
 */
function findExactPersona(personas: readonly TomoriState[], personaId: number | null): TomoriState | null {
  if (personaId === null) return null;
  return personas.find((persona) => persona.persona_id === personaId) ?? null;
}

function parseAddressingStyleValue(value: string | null): AddressingStyle | null {
  return value === "masculine" || value === "feminine" || value === "neutral" ? value : null;
}

function personaLocation(route: ConfigPanelRoute): { personaId: number | null; explicitStart?: number } {
  if ("personaId" in route && route.personaId !== undefined) {
    return {
      personaId: route.personaId,
      ...(route.action === "persona-page" ? { explicitStart: route.start } : {}),
    };
  }
  return { personaId: null };
}

async function handleModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<void> {
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  if (!scope) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { personaId } = personaLocation(route);
  const persona = findExactPersona(scope.personas, personaId);
  if (!persona?.persona_id) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nonce = dependencies.createNonce();
  const locale = route.locale;

  switch (route.action) {
    case "avatar-open":
      await dependencies.showModal(interaction, buildPersonaAvatarModal(locale, persona.persona_id, nonce));
      return;
    case "rename-open":
      await dependencies.showModal(
        interaction,
        buildPersonaRenameModal(locale, persona.persona_id, nonce, persona.persona_nickname),
      );
      return;
    case "naming-open":
      await dependencies.showModal(
        interaction,
        buildPersonaNamingHabitsModal(locale, persona.persona_id, route.style, nonce, {
          prefix: persona.naming_config.prefixes[route.style] ?? "",
          suffix: persona.naming_config.suffixes[route.style] ?? "",
          addressTerm: persona.naming_config.addressTerms[route.style] ?? "",
        }),
      );
      return;
    case "trigger-add-open":
      await dependencies.showModal(interaction, buildTriggerAddModal(locale, persona.persona_id, nonce));
      return;
    case "trigger-remove-open": {
      const triggerWords = persona.trigger_words ?? [];
      if (triggerWords.length === 0) {
        await interaction.reply({
          content: localizer(locale, "commands.config.panel.trigger_remove_none_detail"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildTriggerRemoveModal(
          locale,
          persona.persona_id,
          computeTriggerRemoveFingerprint(persona.persona_id, triggerWords),
          nonce,
          triggerWords,
        ),
      );
      return;
    }
  }
}

interface WriteOutcome {
  receipt: PanelReceipt;
  telemetry?: PanelAction;
}

async function runPersonaWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  persona: TomoriState,
  dependencies: ConfigRouteDependencies,
): Promise<WriteOutcome | null> {
  const locale = route.locale;
  const key = (suffix: string) => `commands.config.panel.${suffix}`;
  const guildIdentity = scope.guildId ? dependencies.createGuildIdentity(scope.guildId, interaction) : null;

  switch (route.action) {
    case "rename-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const newNickname = modal.fields.getTextInputValue(buildConfigModalFieldId("nickname", route.nonce));
      const result = await dependencies.operations.rename({
        persona,
        serverDiscId: scope.serverDiscId,
        newNickname,
        guildIdentity,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(locale, "success", key("rename_success_heading"), key("rename_success_detail"), {
              old: result.oldNickname,
              name: result.newNickname,
            }),
            telemetry: "server-config.workspace.persona.rename",
          };
        case "trigger-write-failed":
          return {
            receipt: receipt(locale, "warning", key("rename_success_heading"), key("rename_partial_detail"), {
              old: result.oldNickname,
              name: result.newNickname,
            }),
            telemetry: "server-config.workspace.persona.rename",
          };
        case "unchanged":
          return {
            receipt: receipt(locale, "info", key("no_changes_heading"), key("rename_unchanged_detail"), {
              name: result.nickname,
            }),
          };
        case "name-conflict":
          return {
            receipt: receipt(locale, "error", key("rename_conflict_heading"), key("rename_conflict_detail"), {
              name: result.nickname,
            }),
          };
        case "invalid-length":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("rename_length_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "naming-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const field = (name: string) => modal.fields.getTextInputValue(buildConfigModalFieldId(name, route.nonce));
      const result = await dependencies.operations.setNamingHabits({
        persona,
        serverDiscId: scope.serverDiscId,
        style: route.style,
        prefix: field("prefix"),
        suffix: field("suffix"),
        addressTerm: field("term"),
      });
      if (result.status === "success") {
        return {
          receipt: receipt(locale, "success", key("naming_success_heading"), key("naming_success_detail"), {
            name: persona.persona_nickname,
          }),
          telemetry: "server-config.workspace.persona-naming.set",
        };
      }
      return {
        receipt:
          result.status === "invalid-config"
            ? receipt(locale, "error", key("naming_invalid_heading"), key("naming_invalid_detail"))
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }

    case "trigger-add-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const rawInput = modal.fields.getTextInputValue(buildConfigModalFieldId("triggers", route.nonce));
      const result = await dependencies.operations.addTriggers({
        persona,
        serverDiscId: scope.serverDiscId,
        rawInput,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(locale, "success", key("trigger_add_success_heading"), key("trigger_add_success_detail"), {
              words: result.addedTriggers.join(", "),
              total: result.totalCount,
            }),
            telemetry: "server-config.workspace.persona-trigger.add",
          };
        case "already-exists":
          return {
            receipt: receipt(locale, "info", key("no_changes_heading"), key("trigger_add_exists_detail"), {
              words: result.attempted.join(", "),
            }),
          };
        case "limit-exceeded":
          return {
            receipt: receipt(locale, "error", key("trigger_add_limit_heading"), key("trigger_add_limit_detail"), {
              current: result.currentCount,
              max: result.maxAllowed,
            }),
          };
        case "too-short":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_short_detail")),
          };
        case "content-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_long_detail"), {
              max: result.maxLength,
            }),
          };
        case "no-triggers":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_empty_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "trigger-remove-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const triggerWords = persona.trigger_words ?? [];
      // Unchecked-means-remove derives its removal set from positions in the list the modal
      // presented, so a list that changed under the open modal must fail stale rather than delete a
      // different word than the one the user unchecked.
      if (computeTriggerRemoveFingerprint(persona.persona_id as number, triggerWords) !== route.fp) {
        return { receipt: staleReceipt(locale) };
      }

      const checked = new Set<number>();
      const presentedCount = Math.min(triggerWords.length, CONFIG_TRIGGER_CHECKBOX_CAPACITY);
      const groupCount = Math.ceil(presentedCount / CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE);
      // An undefined group means no checkbox data reached this submit at all, which is a different
      // fact from an empty array. Unchecked-means-remove would read that absence as "the user
      // cleared every box" and delete every presented word, so a submit is acted on only when at
      // least one group actually arrived.
      let hasCheckboxEvidence = false;
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        const values = dependencies.takeCheckboxValues(
          modal.id,
          buildTriggerRemoveCheckboxGroupId(groupIndex, route.nonce),
        );
        if (values === undefined) continue;
        hasCheckboxEvidence = true;
        for (const value of values) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed)) checked.add(parsed);
        }
      }
      if (!hasCheckboxEvidence) return { receipt: staleReceipt(locale) };

      const removedIndices = triggerWords.flatMap((_, index) =>
        index < presentedCount && !checked.has(index) ? [index] : [],
      );

      const result = await dependencies.operations.removeTriggers({
        persona,
        serverDiscId: scope.serverDiscId,
        removedIndices,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            key("trigger_remove_success_heading"),
            key("trigger_remove_success_detail"),
            { words: result.removedTriggers.join(", ") },
          ),
          telemetry: "server-config.workspace.persona-trigger.remove",
        };
      }
      return {
        receipt:
          result.status === "no-removals"
            ? receipt(locale, "info", key("no_changes_heading"), key("trigger_remove_none_detail"))
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }

    case "avatar-submit": {
      const modal = interaction as ModalSubmitInteraction;
      if (!scope.guildId || !guildIdentity) return null;
      const attachment = dependencies.takeAvatarUpload(modal.id, route.nonce) ?? null;
      const result = await dependencies.operations.replaceAvatar({
        persona,
        serverDiscId: scope.serverDiscId,
        guildId: scope.guildId,
        attachment,
        guildIdentity,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("avatar_success_heading"),
              result.cleared ? key("avatar_cleared_detail") : key("avatar_success_detail"),
              { name: persona.persona_nickname },
            ),
            telemetry: "server-config.workspace.persona-avatar.set",
          };
        case "memory-critical":
          return { receipt: receipt(locale, "error", key("avatar_busy_heading"), key("avatar_busy_detail")) };
        case "quota-exceeded":
          return { receipt: receipt(locale, "error", key("avatar_quota_heading"), key("avatar_quota_detail")) };
        case "invalid-image":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.reason === "file-too-large" ? key("avatar_too_large_detail") : key("avatar_format_detail"),
            ),
          };
        case "download-failed":
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_download_detail")) };
        case "conversion-failed":
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_conversion_detail")) };
        case "guild-avatar-rate-limited":
          return {
            receipt: receipt(locale, "warning", key("avatar_rate_limited_heading"), key("avatar_rate_limited_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_failed_detail")) };
      }
    }

    case "promote-confirm": {
      if (!scope.guildId || !guildIdentity) return null;
      const mainPersona = scope.personas.find((candidate) => candidate.is_alter !== true) ?? null;
      const result = await dependencies.operations.promoteToMain({
        alterPersona: persona,
        mainPersona,
        serverDiscId: scope.serverDiscId,
        guildId: scope.guildId,
        guildIdentity,
      });
      if (result.status === "success") {
        const degraded = !result.nicknameSynced || (result.avatarAttempted && !result.avatarSynced);
        return {
          receipt: receipt(
            locale,
            degraded ? "warning" : "success",
            key("promote_success_heading"),
            degraded ? key("promote_partial_detail") : key("promote_success_detail"),
            { name: result.newMainNickname, old: result.formerMainNickname },
          ),
          telemetry: "server-config.workspace.persona.promote",
        };
      }
      return {
        receipt:
          result.status === "not-alter" || result.status === "no-main-persona"
            ? staleReceipt(locale)
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }
  }

  return null;
}

export function createConfigInteractionRoute(overrides: Partial<ConfigRouteDependencies> = {}): GlobalInteractionRoute {
  const dependencies: ConfigRouteDependencies = { ...defaultDependencies, ...overrides };

  return {
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseConfigPanelRoute(parsed);
      if (!route) throw new Error(`Malformed config panel route: ${interaction.customId}`);

      const expectsSelect =
        route.action === "page" || route.action === "persona-select" || route.action === "naming-style-select";
      const expectsModal =
        route.action === "avatar-submit" ||
        route.action === "rename-submit" ||
        route.action === "naming-submit" ||
        route.action === "trigger-add-submit" ||
        route.action === "trigger-remove-submit";

      if (expectsSelect && !interaction.isStringSelectMenu()) {
        throw new Error(`Config ${route.action} route requires a String Select interaction`);
      }
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error(`Config ${route.action} route requires a modal submission`);
      }
      if (!expectsSelect && !expectsModal && !interaction.isButton()) {
        throw new Error(`Config ${route.action} route requires a button interaction`);
      }

      // The actor comes from the interaction rather than the workspace, so a forged custom ID is
      // rejected before any repository read.
      const actor = resolveConfigActor(interaction);

      if (MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleModalOpen(interaction, route, dependencies, actor);
        return;
      }

      const scope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => isConfigRouteAuthorized(route, actor),
        onDenied: async () => {
          const landing = resolveConfigLanding(actor);
          const fallbackScope = await dependencies.resolveScope(interaction, false);
          if (!fallbackScope) {
            await interaction.editReply(terminalPayload(route.locale, "commands.config.panel.unavailable"));
            return;
          }
          await repaint(interaction, {
            locale: route.locale,
            scope: fallbackScope,
            category: landing.category,
            page: landing.page,
            selectedPersonaId: resolveSelectedPersona(fallbackScope.personas, null)?.persona_id ?? null,
            receipt: deniedReceipt(route.locale),
            dependencies,
          });
        },
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.config.panel.unavailable")),
      });
      if (!scope) return;

      const { personaId, explicitStart } = personaLocation(route);
      // A String Select's custom ID names the selection that produced it; the new choice arrives in
      // the submitted values, so reading the route here would make every select a no-op.
      const selectedValue = interaction.isStringSelectMenu() ? (interaction.values[0] ?? null) : null;

      let category = "category" in route ? route.category : "persona";
      let page: ConfigPage = "page" in route ? route.page : "general";
      if (route.action === "page" && selectedValue) {
        const candidate = selectedValue as ConfigPage;
        if (visibleConfigPages(route.category, actor).includes(candidate)) page = candidate;
        category = route.category;
      }

      let namingStyle: AddressingStyle | undefined = "style" in route ? route.style : undefined;
      if (route.action === "naming-style-select") {
        namingStyle = parseAddressingStyleValue(selectedValue) ?? "neutral";
      }

      let requestedPersonaId = personaId;
      if (route.action === "persona-select" && selectedValue) {
        const candidate = Number(selectedValue);
        if (Number.isSafeInteger(candidate) && scope.personas.some((p) => p.persona_id === candidate)) {
          requestedPersonaId = candidate;
        }
      }

      const persona = resolveSelectedPersona(scope.personas, requestedPersonaId);

      if (route.action === "promote-view") {
        const target = findExactPersona(scope.personas, requestedPersonaId);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "persona",
          page: "general",
          selectedPersonaId: target?.persona_id ?? persona?.persona_id ?? null,
          dependencies,
          ...(target?.is_alter === true && target.persona_id
            ? {
                view: {
                  kind: "promote-confirm" as const,
                  personaId: target.persona_id,
                  nonce: dependencies.createNonce(),
                },
              }
            : { receipt: staleReceipt(route.locale) }),
        });
        return;
      }

      const writeTarget = findExactPersona(scope.personas, requestedPersonaId);
      if (writeTarget) {
        const outcome = await runPersonaWrite(interaction, route, scope, writeTarget, dependencies);
        if (outcome) {
          // Repaint from a fresh read rather than the pre-write scope, so the panel can never show a
          // value the write did not actually produce.
          const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
          if (outcome.telemetry && refreshed.internalServerId) {
            dependencies.recordAction({
              action: outcome.telemetry,
              serverId: refreshed.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope: refreshed,
            category: "persona",
            page: "general",
            selectedPersonaId:
              resolveSelectedPersona(refreshed.personas, writeTarget.persona_id ?? null)?.persona_id ?? null,
            namingStyle,
            receipt: outcome.receipt,
            dependencies,
          });
          return;
        }
      }

      await repaint(interaction, {
        locale: route.locale,
        scope,
        category,
        page,
        selectedPersonaId: persona?.persona_id ?? null,
        personaSelectStart: explicitStart,
        namingStyle,
        dependencies,
      });
    },
  };
}

export const configInteractionRoute = createConfigInteractionRoute();
