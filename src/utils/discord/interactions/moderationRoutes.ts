import {
  ChannelType,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { CooldownType } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction } from "@/utils/discord/interactions/panelController";
import {
  buildMemberAccessModalFieldId,
  buildModerationRemoveModalFieldId,
  buildPersonaChannelAddModalFieldId,
  buildQuotaModalFieldId,
  buildUserBlacklistAddModalFieldId,
  buildWhitelistChannelAddModalFieldId,
  buildWhitelistRoleAddModalFieldId,
  MODERATION_ROUTE_NAMESPACE,
  MODERATION_ROUTE_VERSION,
  parseModerationPanelRoute,
  parseWhitelistPage,
  type ModerationCategory,
  type QuotaType,
  type UserBlacklistRemovalTarget,
  type WhitelistPage,
} from "@/utils/discord/moderationPanelCatalog";
import { SERVER_MEMBER_PERMISSION_DEFINITIONS } from "@/utils/discord/memberPermissionsConfigMapping";
import {
  buildMemberAccessModal,
  buildModerationRemovalModal,
  buildModerationPanelPayload,
  buildPersonaChannelAddModal,
  buildQuotaEditModal,
  buildUserBlacklistAddModal,
  buildWhitelistChannelAddModal,
  buildWhitelistRoleAddModal,
} from "@/utils/discord/ui/moderationPanel";
import {
  showRoutedRawModal,
  takeRawModalChannelSelectValue,
  takeRawModalCheckboxGroupValues,
  takeRawModalSelectValue,
  takeRawModalUserSelectValue,
  takeRawModalRoleSelectValue,
} from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import {
  loadModerationMemberAccessData,
  loadModerationScopeData,
  loadModerationUserBlacklistAddData,
  loadModerationWhitelistChannelAddData,
  moderationOperations,
  type ModerationMemberAccessData,
  type ModerationMemberAccessScopeData,
  type ModerationOperations,
  type ModerationScopeData,
  type ModerationUserBlacklistAddScopeData,
  type ModerationWhitelistChannelAddScopeData,
  type QuotaConfigState,
} from "@/utils/moderation/moderationOperations";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

export interface ModerationRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<ModerationScopeData | null>;
  resolveMemberAccess(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  ): Promise<ModerationMemberAccessScopeData | null>;
  resolveUserBlacklistAdd(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  ): Promise<ModerationUserBlacklistAddScopeData | null>;
  resolveWhitelistChannelAdd(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  ): Promise<ModerationWhitelistChannelAddScopeData | null>;
  resolveWhitelistRoleAdd(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  ): Promise<ModerationWhitelistChannelAddScopeData | null>;
  operations: Pick<
    ModerationOperations,
    | "updateMemberPermissions"
    | "updateServerModelAccess"
    | "addUserToBlacklist"
    | "removeUserFromBlacklist"
    | "removePersonaUserBlock"
    | "removeUserBlacklistBatch"
    | "upsertWhitelistChannel"
    | "removeWhitelistChannel"
    | "addWhitelistRole"
    | "removeWhitelistRole"
    | "replacePersonaChannelWhitelist"
    | "updateQuotaSettings"
  >;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showMemberAccessModal(
    interaction: ButtonInteraction,
    locale: string,
    state: ModerationMemberAccessData,
    nonce: string,
  ): Promise<void>;
  showUserBlacklistAddModal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  showWhitelistChannelAddModal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  showWhitelistRoleAddModal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  showQuotaEditModal(
    interaction: ButtonInteraction,
    locale: string,
    quotaType: QuotaType,
    currentConfig: QuotaConfigState,
    nonce: string,
  ): Promise<void>;
  showRemovalModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    action: "user-blacklist" | "whitelist-channel" | "whitelist-role" | "persona-channel",
    options: Array<{ value: string; label: string; description?: string }>,
  ): Promise<void>;
  showPersonaChannelAddModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    personas: ReadonlyMap<number, string>,
  ): Promise<void>;
  storeRemovalSnapshot(nonce: string, values: string[]): void;
  takeRemovalSnapshot(nonce: string): string[] | undefined;
  takeCheckboxValues(interactionId: string, nonce: string): string[] | undefined;
  takeUserSelectValue(interactionId: string, nonce: string): string | undefined;
  takeChannelSelectValue(interactionId: string, nonce: string): string | undefined;
  takeCooldownTypeSelectValue(interactionId: string, nonce: string): string | undefined;
  takeRoleSelectValue(interactionId: string, nonce: string): string | undefined;
  takeRemovalCheckboxValues(interactionId: string, nonce: string, index: number): string[] | undefined;
  takePersonaChannelPersonaValue(interactionId: string, nonce: string): string | undefined;
  takePersonaChannelChannelValue(interactionId: string, nonce: string): string | undefined;
  resolveUser(
    interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
    userId: string,
  ): Promise<{ id: string; username: string; displayName?: string; bot: boolean } | null>;
  resolveChannel(
    interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
    channelId: string,
  ): Promise<{ id: string; name: string; type: ChannelType } | null>;
  resolveRole(
    interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
    roleId: string,
  ): Promise<{ id: string; name: string } | null>;
}

const removalSnapshots = new Map<string, { values: string[]; expiresAt: number }>();

function storeRemovalSnapshot(nonce: string, values: string[]): void {
  const now = Date.now();
  for (const [key, snapshot] of removalSnapshots) {
    if (snapshot.expiresAt < now) removalSnapshots.delete(key);
  }
  removalSnapshots.set(nonce, { values: [...values], expiresAt: now + 15 * 60_000 });
}

function takeRemovalSnapshot(nonce: string): string[] | undefined {
  const snapshot = removalSnapshots.get(nonce);
  removalSnapshots.delete(nonce);
  return snapshot && snapshot.expiresAt >= Date.now() ? snapshot.values : undefined;
}

function isAuthorized(interaction: GlobalRoutableInteraction | ChatInputCommandInteraction): boolean {
  return Boolean(interaction.guildId && (interaction.memberPermissions?.has("ManageGuild") ?? false));
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

async function defaultResolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  forceRefresh = false,
): Promise<ModerationScopeData | null> {
  if (!interaction.guildId) return null;
  return loadModerationScopeData(interaction.guildId, forceRefresh);
}

async function defaultResolveMemberAccess(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<ModerationMemberAccessScopeData | null> {
  if (!interaction.guildId) return null;
  return loadModerationMemberAccessData(interaction.guildId);
}

async function defaultResolveUserBlacklistAdd(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<ModerationUserBlacklistAddScopeData | null> {
  if (!interaction.guildId) return null;
  return loadModerationUserBlacklistAddData(interaction.guildId);
}

async function defaultResolveWhitelistChannelAdd(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
): Promise<ModerationWhitelistChannelAddScopeData | null> {
  if (!interaction.guildId) return null;
  return loadModerationWhitelistChannelAddData(interaction.guildId);
}

async function defaultResolveUser(
  interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
  userId: string,
): Promise<{ id: string; username: string; displayName?: string; bot: boolean } | null> {
  if (interaction.guild) {
    try {
      const member = await interaction.guild.members.fetch(userId);
      const user = member?.user;
      return user ? { id: user.id, username: user.username, displayName: member.displayName, bot: user.bot } : null;
    } catch {
      return null;
    }
  }
  if ("client" in interaction && interaction.client) {
    try {
      const user = await interaction.client.users.fetch(userId);
      return user
        ? { id: user.id, username: user.username, displayName: user.globalName ?? user.username, bot: user.bot }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function defaultResolveChannel(
  interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
  channelId: string,
): Promise<{ id: string; name: string; type: ChannelType } | null> {
  if (interaction.guild) {
    try {
      const channel = await interaction.guild.channels.fetch(channelId);
      return channel && "name" in channel && channel.type !== undefined
        ? { id: channel.id, name: (channel as { name: string }).name, type: channel.type }
        : null;
    } catch {
      return null;
    }
  }
  if ("client" in interaction && interaction.client) {
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      return channel && "name" in channel && channel.type !== undefined
        ? { id: channel.id, name: (channel as { name: string }).name, type: channel.type }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function defaultResolveRole(
  interaction: ModalSubmitInteraction | GlobalRoutableInteraction | ChatInputCommandInteraction,
  roleId: string,
): Promise<{ id: string; name: string } | null> {
  if (!interaction.guild) return null;
  try {
    const role = await interaction.guild.roles.fetch(roleId);
    return role ? { id: role.id, name: role.name } : null;
  } catch {
    return null;
  }
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.moderation.changed_receipt"),
    detail: localizer(locale, "commands.moderation.changed_receipt_detail"),
  };
}

function changedWhitelistStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.moderation.whitelist_changed_receipt"),
    detail: localizer(locale, "commands.moderation.whitelist_changed_receipt_detail"),
  };
}

function formatGuildMemberLabel(user: { username: string; displayName?: string } | null): string {
  if (!user) return "Unknown member";
  const displayName = user.displayName?.trim();
  return displayName && displayName.toLocaleLowerCase() !== user.username.toLocaleLowerCase()
    ? `${displayName} (${user.username})`
    : user.username;
}

async function repaint(
  interaction: GlobalRoutableInteraction,
  locale: string,
  category: ModerationCategory,
  whitelistPage: WhitelistPage,
  rangeIndex: number,
  data: ModerationScopeData,
  panelReceipt?: PanelReceipt,
  removeTarget?: UserBlacklistRemovalTarget,
  channelRemoveTarget?: string,
  roleRemoveTarget?: string,
): Promise<void> {
  await interaction.editReply(
    buildModerationPanelPayload({
      locale,
      category,
      whitelistPage,
      rangeIndex,
      data,
      receipt: panelReceipt,
      removeTarget,
      channelRemoveTarget,
      roleRemoveTarget,
    }),
  );
}

export function createModerationInteractionRoute(
  overrides: Partial<ModerationRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: ModerationRouteDependencies = {
    resolveScope: defaultResolveScope,
    resolveMemberAccess: defaultResolveMemberAccess,
    resolveUserBlacklistAdd: defaultResolveUserBlacklistAdd,
    resolveWhitelistChannelAdd: defaultResolveWhitelistChannelAdd,
    resolveWhitelistRoleAdd: defaultResolveWhitelistChannelAdd,
    operations: moderationOperations,
    recordAction: (input) => {
      void recordPanelActionStat(input);
    },
    createNonce: () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    showMemberAccessModal: (interaction, locale, state, nonce) =>
      showRoutedRawModal(interaction, buildMemberAccessModal(locale, state, nonce)),
    showUserBlacklistAddModal: (interaction, locale, nonce) =>
      showRoutedRawModal(interaction, buildUserBlacklistAddModal(locale, nonce)),
    showWhitelistChannelAddModal: (interaction, locale, nonce) =>
      showRoutedRawModal(interaction, buildWhitelistChannelAddModal(locale, nonce)),
    showWhitelistRoleAddModal: (interaction, locale, nonce) =>
      showRoutedRawModal(interaction, buildWhitelistRoleAddModal(locale, nonce)),
    showQuotaEditModal: (interaction, locale, quotaType, currentConfig, nonce) =>
      showRoutedRawModal(interaction, buildQuotaEditModal(locale, quotaType, currentConfig, nonce)),
    showRemovalModal: (interaction, locale, nonce, action, options) =>
      showRoutedRawModal(interaction, buildModerationRemovalModal(locale, nonce, action, options)),
    showPersonaChannelAddModal: (interaction, locale, nonce, personas) =>
      showRoutedRawModal(interaction, buildPersonaChannelAddModal(locale, nonce, personas)),
    storeRemovalSnapshot,
    takeRemovalSnapshot,
    takeCheckboxValues: (interactionId, nonce) =>
      takeRawModalCheckboxGroupValues(interactionId, buildMemberAccessModalFieldId(nonce)),
    takeUserSelectValue: (interactionId, nonce) =>
      takeRawModalUserSelectValue(interactionId, buildUserBlacklistAddModalFieldId(nonce)),
    takeChannelSelectValue: (interactionId, nonce) =>
      takeRawModalChannelSelectValue(interactionId, buildWhitelistChannelAddModalFieldId(nonce, "channel")),
    takeCooldownTypeSelectValue: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildWhitelistChannelAddModalFieldId(nonce, "type")),
    takeRoleSelectValue: (interactionId, nonce) =>
      takeRawModalRoleSelectValue(interactionId, buildWhitelistRoleAddModalFieldId(nonce)),
    takeRemovalCheckboxValues: (interactionId, nonce, index) =>
      takeRawModalCheckboxGroupValues(interactionId, buildModerationRemoveModalFieldId(nonce, index)),
    takePersonaChannelPersonaValue: (interactionId, nonce) =>
      takeRawModalSelectValue(interactionId, buildPersonaChannelAddModalFieldId(nonce, "persona")),
    takePersonaChannelChannelValue: (interactionId, nonce) =>
      takeRawModalChannelSelectValue(interactionId, buildPersonaChannelAddModalFieldId(nonce, "channel")),
    resolveUser: defaultResolveUser,
    resolveChannel: defaultResolveChannel,
    resolveRole: defaultResolveRole,
    ...overrides,
  };

  return {
    namespace: MODERATION_ROUTE_NAMESPACE,
    version: MODERATION_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseModerationPanelRoute(parsed);
      if (!route) {
        throw new Error(`Malformed moderation panel route: ${interaction.customId}`);
      }

      const expectsSelect = route.action === "select-page";
      const expectsModal =
        route.action === "member-access-submit" ||
        route.action === "user-blacklist-add-submit" ||
        route.action === "user-blacklist-remove-submit" ||
        route.action === "whitelist-channel-add-submit" ||
        route.action === "whitelist-channel-remove-submit" ||
        route.action === "whitelist-role-add-submit" ||
        route.action === "whitelist-role-remove-submit" ||
        route.action === "persona-channel-add-submit" ||
        route.action === "persona-channel-remove-submit" ||
        route.action === "quota-edit-submit";
      if (expectsSelect && !interaction.isStringSelectMenu()) {
        throw new Error(`Moderation ${route.action} route requires a String Select interaction`);
      }
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error(`Moderation ${route.action} route requires a modal submission`);
      }
      if (!expectsSelect && !expectsModal && !interaction.isButton()) {
        throw new Error(`Moderation ${route.action} route requires a button interaction`);
      }

      if (route.action === "member-access-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveMemberAccess(interaction);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showMemberAccessModal(
          interaction as ButtonInteraction,
          route.locale,
          scope.memberAccess,
          nonce,
        );
        return;
      }

      if (route.action === "user-blacklist-add-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveUserBlacklistAdd(interaction);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!scope.personalMemoriesEnabled) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.user_blacklist_add_personalization_disabled_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showUserBlacklistAddModal(interaction as ButtonInteraction, route.locale, nonce);
        return;
      }

      if (route.action === "user-blacklist-add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          dependencies.takeUserSelectValue(modal.id, route.nonce);
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const rawTargetUserId = dependencies.takeUserSelectValue(modal.id, route.nonce);

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (rawTargetUserId === undefined || !/^\d{17,20}$/.test(rawTargetUserId)) {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_failed"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_invalid_input"),
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_failed"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        if (!scope.userBlacklist.personalMemoriesEnabled) {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "warning",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_personalization_disabled"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_personalization_disabled_detail"),
          });
          return;
        }

        const targetUser = await dependencies.resolveUser(modal, rawTargetUserId);
        if (!targetUser) {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_failed"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_invalid_user"),
          });
          return;
        }

        if (targetUser.bot) {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_cannot_blacklist_bot"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_cannot_blacklist_bot_detail", {
              user_name: targetUser.username,
              user_id: targetUser.id,
            }),
          });
          return;
        }

        const result = await dependencies.operations.addUserToBlacklist({
          guildId: scope.guildId,
          serverId: scope.serverId,
          targetUserId: targetUser.id,
          isBot: targetUser.bot,
          personalMemoriesEnabled: scope.userBlacklist.personalMemoriesEnabled,
        });

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        let panelReceipt: PanelReceipt;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.user-blacklist.add",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
          panelReceipt = {
            tone: "success",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_success"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_success_detail", {
              user_name: targetUser.username,
              user_id: targetUser.id,
            }),
          };
        } else if (result.status === "already_blacklisted") {
          panelReceipt = {
            tone: "info",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_already_blacklisted"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_already_blacklisted_detail", {
              user_name: targetUser.username,
              user_id: targetUser.id,
            }),
          };
        } else if (result.status === "bot") {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_cannot_blacklist_bot"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_cannot_blacklist_bot_detail", {
              user_name: targetUser.username,
              user_id: targetUser.id,
            }),
          };
        } else if (result.status === "personalization_disabled") {
          panelReceipt = {
            tone: "warning",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_personalization_disabled"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_personalization_disabled_detail"),
          };
        } else {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_failed"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_failed_detail"),
          };
        }

        await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "model-access-set") {
        // Acknowledge before any read or write: Discord drops an unacknowledged interaction after
        // three seconds, and under a slow database the write would land while the user is told the
        // application did not respond, inviting a second click on a policy that already changed.
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "member-access", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.model_access_failed"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const result = await dependencies.operations.updateServerModelAccess({
          guildId: scope.guildId,
          serverId: scope.serverId,
          currentAllowServerModels: scope.serverModelAccess.allowServerModels,
          allowServerModels: route.allowServerModels,
        });

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.model-access.set",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }

        const panelReceipt: PanelReceipt =
          result.status === "success"
            ? {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.model_access_updated"),
                detail: localizer(
                  route.locale,
                  result.allowServerModels
                    ? "commands.moderation.model_access_updated_allowed"
                    : "commands.moderation.model_access_updated_personal",
                ),
              }
            : result.status === "unchanged"
              ? {
                  tone: "info",
                  heading: localizer(route.locale, "commands.moderation.model_access_unchanged"),
                  detail: localizer(route.locale, "commands.moderation.model_access_unchanged_detail"),
                }
              : {
                  tone: "error",
                  heading: localizer(route.locale, "commands.moderation.model_access_failed"),
                  detail: localizer(route.locale, "commands.moderation.model_access_failed_detail"),
                };

        await repaint(interaction, route.locale, "member-access", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "member-access-submit") {
        const modal = interaction as ModalSubmitInteraction;
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          dependencies.takeCheckboxValues(modal.id, route.nonce);
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const rawValues = dependencies.takeCheckboxValues(modal.id, route.nonce);

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (rawValues === undefined) {
          await repaint(interaction, route.locale, "member-access", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.member_access_failed"),
            detail: localizer(route.locale, "commands.moderation.member_access_invalid_input"),
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "member-access", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.member_access_failed"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const recognizedValues = new Set(SERVER_MEMBER_PERMISSION_DEFINITIONS.map((def) => def.value));
        const selectedValues = rawValues.filter((val) => recognizedValues.has(val));

        const result = await dependencies.operations.updateMemberPermissions({
          guildId: scope.guildId,
          serverId: scope.serverId,
          currentState: scope.memberAccess,
          selectedValues,
        });

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        let panelReceipt: PanelReceipt;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.member-access.set",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
          panelReceipt = {
            tone: "success",
            heading: localizer(route.locale, "commands.moderation.member_access_updated"),
            detail: localizer(route.locale, "commands.moderation.member_access_updated_detail"),
          };
        } else if (result.status === "unchanged") {
          panelReceipt = {
            tone: "info",
            heading: localizer(route.locale, "commands.moderation.member_access_unchanged"),
            detail: localizer(route.locale, "commands.moderation.member_access_unchanged_detail"),
          };
        } else {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.member_access_failed"),
            detail: localizer(route.locale, "commands.moderation.member_access_failed_detail"),
          };
        }

        await repaint(interaction, route.locale, "member-access", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "user-blacklist-remove-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope || scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(
              route.locale,
              scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const values = [
          ...scope.userBlacklist.personalizationUserIds.map((id) => `u:${id}`),
          ...scope.userBlacklist.personaBlocks.map((block) => `b:${block.persona_id}:${block.user_disc_id}`),
        ];
        if (values.length === 0 || values.length > 50) {
          await interaction.reply({
            content: localizer(
              route.locale,
              values.length > 50
                ? "commands.moderation.remove_modal_limit"
                : "commands.moderation.remove_nothing_changed_detail",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const options = await Promise.all(
          values.map(async (value) => {
            const parts = value.split(":");
            const userId = parts.at(-1) ?? "";
            const user = await dependencies.resolveUser(interaction, userId);
            if (parts[0] === "u")
              return { value, label: formatGuildMemberLabel(user), description: "Personalization blacklist" };
            const personaId = Number(parts[1]);
            return {
              value,
              label: formatGuildMemberLabel(user),
              description: scope.whitelist.personaNames.get(personaId) ?? "Persona restriction",
            };
          }),
        );
        const nonce = dependencies.createNonce();
        dependencies.storeRemovalSnapshot(nonce, values);
        await dependencies.showRemovalModal(
          interaction as ButtonInteraction,
          route.locale,
          nonce,
          "user-blacklist",
          options,
        );
        return;
      }

      if (route.action === "user-blacklist-remove-submit") {
        await interaction.deferUpdate();
        const presented = dependencies.takeRemovalSnapshot(route.nonce);
        const kept = new Set<string>();
        for (let index = 0; index < 5; index++) {
          for (const value of dependencies.takeRemovalCheckboxValues(interaction.id, route.nonce, index) ?? [])
            kept.add(value);
        }
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope || !presented || scope.readStatus !== "fresh") {
          await interaction.editReply(
            terminalPayload(route.locale, scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup"),
          );
          return;
        }
        const current = new Set([
          ...scope.userBlacklist.personalizationUserIds.map((id) => `u:${id}`),
          ...scope.userBlacklist.personaBlocks.map((block) => `b:${block.persona_id}:${block.user_disc_id}`),
        ]);
        const removed = presented.filter((value) => !kept.has(value) && current.has(value));
        const personalizationUserIds = removed.filter((value) => value.startsWith("u:")).map((value) => value.slice(2));
        const personaBlockKeys = removed
          .filter((value) => value.startsWith("b:"))
          .flatMap((value) => {
            const [, personaId, userDiscId] = value.split(":");
            return personaId && userDiscId ? [{ personaId: Number(personaId), userDiscId }] : [];
          });
        const result =
          removed.length === 0
            ? null
            : await dependencies.operations.removeUserBlacklistBatch({
                guildId: scope.guildId,
                serverId: scope.serverId,
                personalizationUserIds,
                personaBlockKeys,
              });
        if (result && result.status === "success") {
          if (result.removedPersonalizationCount > 0) {
            dependencies.recordAction({
              action: "moderation.workspace.user-blacklist.remove",
              serverId: scope.serverId,
              userDiscId: interaction.user?.id ?? "",
            });
          }
          if (result.removedPersonaBlocks.length > 0) {
            dependencies.recordAction({
              action: "moderation.workspace.persona-block.remove",
              serverId: scope.serverId,
              userDiscId: interaction.user?.id ?? "",
            });
          }
        }
        const receipt: PanelReceipt =
          result?.status === "failure"
            ? {
                tone: "error",
                heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed"),
                detail: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed_detail"),
              }
            : removed.length === 0
              ? {
                  tone: "info",
                  heading: localizer(route.locale, "commands.moderation.remove_nothing_changed"),
                  detail: localizer(route.locale, "commands.moderation.remove_nothing_changed_detail"),
                }
              : {
                  tone: "success",
                  heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_success"),
                  detail: localizer(route.locale, "commands.moderation.user_blacklist_remove_success_detail", {
                    count: removed.length,
                  }),
                };
        scope = (await dependencies.resolveScope(interaction, false)) ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, receipt);
        return;
      }

      if (route.action === "user-blacklist-remove-prompt") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus === "unavailable") {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope);
          return;
        }

        const target = route.target;
        let isPresent = false;
        if (target.source === "personalization") {
          isPresent = scope.userBlacklist.personalizationUserIds.includes(target.userId);
        } else if (target.source === "persona-block") {
          isPresent = scope.userBlacklist.personaBlocks.some(
            (b) => b.persona_id === target.personaId && b.user_disc_id === target.userId,
          );
        }

        if (!isPresent) {
          await repaint(
            interaction,
            route.locale,
            "user-blacklist",
            "channels",
            0,
            scope,
            changedStateReceipt(route.locale),
          );
          return;
        }

        await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, undefined, target);
        return;
      }

      if (route.action === "user-blacklist-remove-cancel") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope);
        return;
      }

      if (route.action === "user-blacklist-remove-confirm") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const target = route.target;
        let isPresent = false;
        let targetPersonaName = "";
        if (target.source === "personalization") {
          isPresent = scope.userBlacklist.personalizationUserIds.includes(target.userId);
        } else if (target.source === "persona-block") {
          const matchingBlock = scope.userBlacklist.personaBlocks.find(
            (b) => b.persona_id === target.personaId && b.user_disc_id === target.userId,
          );
          if (matchingBlock) {
            isPresent = true;
            targetPersonaName = matchingBlock.persona_name;
          }
        }

        if (!isPresent) {
          await repaint(
            interaction,
            route.locale,
            "user-blacklist",
            "channels",
            0,
            scope,
            changedStateReceipt(route.locale),
          );
          return;
        }

        const resolvedUser = await dependencies.resolveUser(interaction, target.userId);
        const displayName = resolvedUser?.username ?? `<@${target.userId}>`;

        let panelReceipt: PanelReceipt;
        if (target.source === "personalization") {
          const result = await dependencies.operations.removeUserFromBlacklist({
            guildId: scope.guildId,
            serverId: scope.serverId,
            targetUserId: target.userId,
          });
          if (result.status === "success") {
            dependencies.recordAction({
              action: "moderation.workspace.user-blacklist.remove",
              serverId: scope.serverId,
              userDiscId: interaction.user?.id ?? "",
            });
            panelReceipt = {
              tone: "success",
              heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_success"),
              detail: localizer(
                route.locale,
                "commands.moderation.user_blacklist_remove_personalization_success_detail",
                { user_name: displayName },
              ),
            };
          } else if (result.status === "not_found") {
            panelReceipt = changedStateReceipt(route.locale);
          } else {
            panelReceipt = {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed"),
              detail: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed_detail"),
            };
          }
        } else {
          const result = await dependencies.operations.removePersonaUserBlock({
            guildId: scope.guildId,
            serverId: scope.serverId,
            personaId: target.personaId,
            targetUserId: target.userId,
          });
          if (result.status === "success") {
            dependencies.recordAction({
              action: "moderation.workspace.persona-block.remove",
              serverId: scope.serverId,
              userDiscId: interaction.user?.id ?? "",
            });
            panelReceipt = {
              tone: "success",
              heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_success"),
              detail: localizer(
                route.locale,
                "commands.moderation.user_blacklist_remove_persona_block_success_detail",
                {
                  user_name: displayName,
                  persona_name: targetPersonaName || `Persona ${target.personaId}`,
                },
              ),
            };
          } else if (result.status === "not_found") {
            panelReceipt = changedStateReceipt(route.locale);
          } else {
            panelReceipt = {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed"),
              detail: localizer(route.locale, "commands.moderation.user_blacklist_remove_failed_detail"),
            };
          }
        }

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        await repaint(interaction, route.locale, "user-blacklist", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "whitelist-channel-add-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveWhitelistChannelAdd(interaction);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const nonce = dependencies.createNonce();
        await dependencies.showWhitelistChannelAddModal(interaction as ButtonInteraction, route.locale, nonce);
        return;
      }

      if (route.action === "whitelist-channel-add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        await interaction.deferUpdate();

        const rawChannelId = dependencies.takeChannelSelectValue(modal.id, route.nonce);
        const rawCooldownType = dependencies.takeCooldownTypeSelectValue(modal.id, route.nonce);
        let rawCooldownLength: string | undefined;
        try {
          rawCooldownLength = modal.fields.getTextInputValue(
            buildWhitelistChannelAddModalFieldId(route.nonce, "length"),
          );
        } catch {
          rawCooldownLength = undefined;
        }

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (!rawChannelId || !/^\d{17,20}$/.test(rawChannelId)) {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.user_blacklist_add_invalid_input"),
            detail: localizer(route.locale, "commands.moderation.user_blacklist_add_invalid_input"),
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.unavailable"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const targetChannel = await dependencies.resolveChannel(modal, rawChannelId);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_invalid_channel"),
          });
          return;
        }

        let parsedCooldownType: CooldownType | null = null;
        if (rawCooldownType !== undefined && rawCooldownType !== "") {
          if (!/^[0-3]$/.test(rawCooldownType)) {
            await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_invalid_type"),
            });
            return;
          }
          parsedCooldownType = Number(rawCooldownType) as CooldownType;
        }

        let parsedCooldownLength: number | null = null;
        if (rawCooldownLength !== undefined && rawCooldownLength.trim() !== "") {
          const trimmed = rawCooldownLength.trim();
          if (!/^\d+$/.test(trimmed)) {
            await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_invalid_length"),
            });
            return;
          }
          const parsed = Number(trimmed);
          if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 86400) {
            await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_invalid_length"),
            });
            return;
          }
          parsedCooldownLength = parsed;
        }

        const channelAddScope = await dependencies.resolveWhitelistChannelAdd(interaction);
        if (
          !channelAddScope ||
          channelAddScope.readStatus !== "fresh" ||
          channelAddScope.guildId !== scope.guildId ||
          channelAddScope.serverId !== scope.serverId
        ) {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.unavailable"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const result = await dependencies.operations.upsertWhitelistChannel({
          guildId: channelAddScope.guildId,
          serverId: channelAddScope.serverId,
          channelId: targetChannel.id,
          requestedCooldownType: parsedCooldownType,
          requestedCooldownLength: parsedCooldownLength,
          serverConfig: channelAddScope.config,
        });

        let panelReceipt: PanelReceipt;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-channel.add",
            serverId: channelAddScope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
          panelReceipt = {
            tone: "success",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_success"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_success_detail", {
              channel_name: targetChannel.name,
              channel_id: targetChannel.id,
            }),
          };
        } else if (result.status === "unchanged") {
          panelReceipt = {
            tone: "info",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_unchanged"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_unchanged_detail", {
              channel_name: targetChannel.name,
              channel_id: targetChannel.id,
            }),
          };
        } else {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed_detail"),
          };
        }

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "whitelist-channel-remove-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope || scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(
              route.locale,
              scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const values = scope.whitelist.channels.map((row) => `c:${row.channel_disc_id}`);
        if (values.length === 0 || values.length > 50) {
          await interaction.reply({
            content: localizer(
              route.locale,
              values.length > 50
                ? "commands.moderation.remove_modal_limit"
                : "commands.moderation.remove_nothing_changed_detail",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const options = await Promise.all(
          scope.whitelist.channels.map(async (row) => {
            const channel = await dependencies.resolveChannel(interaction, row.channel_disc_id);
            return { value: `c:${row.channel_disc_id}`, label: channel?.name ?? "Unknown channel" };
          }),
        );
        const nonce = dependencies.createNonce();
        dependencies.storeRemovalSnapshot(nonce, values);
        await dependencies.showRemovalModal(
          interaction as ButtonInteraction,
          route.locale,
          nonce,
          "whitelist-channel",
          options,
        );
        return;
      }

      if (route.action === "whitelist-channel-remove-submit") {
        await interaction.deferUpdate();
        const presented = dependencies.takeRemovalSnapshot(route.nonce);
        const kept = new Set<string>();
        for (let index = 0; index < 5; index++)
          for (const value of dependencies.takeRemovalCheckboxValues(interaction.id, route.nonce, index) ?? [])
            kept.add(value);
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope || !presented || scope.readStatus !== "fresh") {
          await interaction.editReply(
            terminalPayload(route.locale, scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup"),
          );
          return;
        }
        const current = new Set(scope.whitelist.channels.map((row) => `c:${row.channel_disc_id}`));
        const candidateIds = presented
          .filter((value) => !kept.has(value) && current.has(value))
          .map((value) => value.slice(2));
        const ids: string[] = [];
        for (const channelId of candidateIds) {
          const channel = await dependencies.resolveChannel(interaction, channelId);
          if (channel?.type === ChannelType.GuildText) ids.push(channelId);
        }
        let failed = false;
        let successCount = 0;
        for (const channelId of ids) {
          const result = await dependencies.operations.removeWhitelistChannel({
            guildId: scope.guildId,
            serverId: scope.serverId,
            channelId,
          });
          if (result.status === "success") successCount++;
          if (result.status === "failure") failed = true;
        }
        if (successCount > 0) {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-channel.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const receipt: PanelReceipt = failed
          ? {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed_detail"),
            }
          : ids.length === 0
            ? {
                tone: "info",
                heading: localizer(route.locale, "commands.moderation.remove_nothing_changed"),
                detail: localizer(route.locale, "commands.moderation.remove_nothing_changed_detail"),
              }
            : {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.whitelist_channel_remove_success"),
                detail: localizer(route.locale, "commands.moderation.whitelist_channel_remove_batch_success_detail", {
                  count: ids.length,
                }),
              };
        scope = (await dependencies.resolveScope(interaction, false)) ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, receipt);
        return;
      }

      if (route.action === "whitelist-channel-remove-prompt") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus === "unavailable") {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope);
          return;
        }

        const isPresent = scope.whitelist.channels.some((c) => c.channel_disc_id === route.channelId);
        if (!isPresent) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "channels",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        const resolvedChannel = await dependencies.resolveChannel(interaction, route.channelId);
        if (!resolvedChannel || resolvedChannel.type !== ChannelType.GuildText) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "channels",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          "whitelist",
          "channels",
          0,
          scope,
          undefined,
          undefined,
          route.channelId,
        );
        return;
      }

      if (route.action === "whitelist-channel-remove-cancel") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        await repaint(interaction, route.locale, "whitelist", "channels", 0, scope);
        return;
      }

      if (route.action === "whitelist-channel-remove-confirm") {
        await interaction.deferUpdate();

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.unavailable"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const isPresent = scope.whitelist.channels.some((c) => c.channel_disc_id === route.channelId);
        if (!isPresent) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "channels",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        const resolvedChannel = await dependencies.resolveChannel(interaction, route.channelId);
        if (!resolvedChannel || resolvedChannel.type !== ChannelType.GuildText) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "channels",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        const displayName = resolvedChannel.name;

        const result = await dependencies.operations.removeWhitelistChannel({
          guildId: scope.guildId,
          serverId: scope.serverId,
          channelId: route.channelId,
        });

        let panelReceipt: PanelReceipt;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-channel.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
          panelReceipt = {
            tone: "success",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_remove_success"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_remove_success_detail", {
              channel_name: displayName,
            }),
          };
        } else if (result.status === "not_found") {
          panelReceipt = changedWhitelistStateReceipt(route.locale);
        } else {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed_detail"),
          };
        }

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        await repaint(interaction, route.locale, "whitelist", "channels", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "whitelist-role-add-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveWhitelistRoleAdd(interaction);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await dependencies.showWhitelistRoleAddModal(
          interaction as ButtonInteraction,
          route.locale,
          dependencies.createNonce(),
        );
        return;
      }

      if (route.action === "whitelist-role-add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        await interaction.deferUpdate();
        const rawRoleId = dependencies.takeRoleSelectValue(modal.id, route.nonce);

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }
        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.unavailable"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }
        if (!rawRoleId || !/^\d{17,20}$/.test(rawRoleId)) {
          await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_role_add_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_role_add_invalid_input"),
          });
          return;
        }

        const role = await dependencies.resolveRole(modal, rawRoleId);
        if (!role) {
          await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_role_add_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_role_add_invalid_input"),
          });
          return;
        }
        if (role.id === scope.guildId) {
          await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.whitelist_role_add_failed"),
            detail: localizer(route.locale, "commands.moderation.whitelist_role_add_everyone"),
          });
          return;
        }

        const writeScope = await dependencies.resolveWhitelistRoleAdd(interaction);
        if (
          !writeScope ||
          writeScope.readStatus !== "fresh" ||
          writeScope.guildId !== scope.guildId ||
          writeScope.serverId !== scope.serverId
        ) {
          await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.unavailable"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        const currentRole = await dependencies.resolveRole(modal, role.id);
        if (!currentRole || currentRole.id === writeScope.guildId) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "roles",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        const result = await dependencies.operations.addWhitelistRole({
          guildId: writeScope.guildId,
          serverId: writeScope.serverId,
          roleId: currentRole.id,
        });
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-role.add",
            serverId: writeScope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const roleMention = `<@&${currentRole.id}>`;
        const panelReceipt: PanelReceipt =
          result.status === "success"
            ? {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.whitelist_role_add_success"),
                detail: localizer(route.locale, "commands.moderation.whitelist_role_add_success_detail", {
                  role: roleMention,
                }),
              }
            : result.status === "unchanged"
              ? {
                  tone: "info",
                  heading: localizer(route.locale, "commands.moderation.whitelist_role_add_unchanged"),
                  detail: localizer(route.locale, "commands.moderation.whitelist_role_add_unchanged_detail", {
                    role: roleMention,
                  }),
                }
              : {
                  tone: "error",
                  heading: localizer(route.locale, "commands.moderation.whitelist_role_add_failed"),
                  detail: localizer(route.locale, "commands.moderation.whitelist_role_add_failed_detail"),
                };

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "whitelist-role-remove-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope || scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(
              route.locale,
              scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const values = scope.whitelist.roles.map((row) => `r:${row.role_disc_id}`);
        if (values.length === 0 || values.length > 50) {
          await interaction.reply({
            content: localizer(
              route.locale,
              values.length > 50
                ? "commands.moderation.remove_modal_limit"
                : "commands.moderation.remove_nothing_changed_detail",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const options = await Promise.all(
          scope.whitelist.roles.map(async (row) => {
            const role = await dependencies.resolveRole(interaction, row.role_disc_id);
            return { value: `r:${row.role_disc_id}`, label: role?.name ?? "Unknown role" };
          }),
        );
        const nonce = dependencies.createNonce();
        dependencies.storeRemovalSnapshot(nonce, values);
        await dependencies.showRemovalModal(
          interaction as ButtonInteraction,
          route.locale,
          nonce,
          "whitelist-role",
          options,
        );
        return;
      }

      if (route.action === "whitelist-role-remove-submit") {
        await interaction.deferUpdate();
        const presented = dependencies.takeRemovalSnapshot(route.nonce);
        const kept = new Set<string>();
        for (let index = 0; index < 5; index++)
          for (const value of dependencies.takeRemovalCheckboxValues(interaction.id, route.nonce, index) ?? [])
            kept.add(value);
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope || !presented || scope.readStatus !== "fresh") {
          await interaction.editReply(
            terminalPayload(route.locale, scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup"),
          );
          return;
        }
        const current = new Set(scope.whitelist.roles.map((row) => `r:${row.role_disc_id}`));
        const candidateIds = presented
          .filter((value) => !kept.has(value) && current.has(value))
          .map((value) => value.slice(2));
        const ids: string[] = [];
        for (const roleId of candidateIds) {
          const role = await dependencies.resolveRole(interaction, roleId);
          if (role && role.id !== scope.guildId) ids.push(roleId);
        }
        let failed = false;
        let successCount = 0;
        for (const roleId of ids) {
          const result = await dependencies.operations.removeWhitelistRole({
            guildId: scope.guildId,
            serverId: scope.serverId,
            roleId,
          });
          if (result.status === "success") successCount++;
          if (result.status === "failure") failed = true;
        }
        if (successCount > 0) {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-role.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const receipt: PanelReceipt = failed
          ? {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_role_remove_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_role_remove_failed_detail"),
            }
          : ids.length === 0
            ? {
                tone: "info",
                heading: localizer(route.locale, "commands.moderation.remove_nothing_changed"),
                detail: localizer(route.locale, "commands.moderation.remove_nothing_changed_detail"),
              }
            : {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.whitelist_role_remove_success"),
                detail: localizer(route.locale, "commands.moderation.whitelist_role_remove_batch_success_detail", {
                  count: ids.length,
                }),
              };
        scope = (await dependencies.resolveScope(interaction, false)) ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, receipt);
        return;
      }

      if (route.action === "whitelist-role-remove-prompt") {
        await interaction.deferUpdate();
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }
        const isPresent = scope.whitelist.roles.some((role) => role.role_disc_id === route.roleId);
        const role = await dependencies.resolveRole(interaction, route.roleId);
        if (scope.readStatus !== "fresh" || !isPresent || !role || role.id === scope.guildId) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "roles",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          "whitelist",
          "roles",
          0,
          scope,
          undefined,
          undefined,
          undefined,
          role.id,
        );
        return;
      }

      if (route.action === "whitelist-role-remove-cancel") {
        await interaction.deferUpdate();
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }
        await repaint(interaction, route.locale, "whitelist", "roles", 0, scope);
        return;
      }

      if (route.action === "whitelist-role-remove-confirm") {
        await interaction.deferUpdate();
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }
        const isPresent = scope.whitelist.roles.some((role) => role.role_disc_id === route.roleId);
        const role = await dependencies.resolveRole(interaction, route.roleId);
        if (scope.readStatus !== "fresh" || !isPresent || !role || role.id === scope.guildId) {
          await repaint(
            interaction,
            route.locale,
            "whitelist",
            "roles",
            0,
            scope,
            changedWhitelistStateReceipt(route.locale),
          );
          return;
        }

        const result = await dependencies.operations.removeWhitelistRole({
          guildId: scope.guildId,
          serverId: scope.serverId,
          roleId: role.id,
        });
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.whitelist-role.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const roleMention = `<@&${role.id}>`;
        const panelReceipt: PanelReceipt =
          result.status === "success"
            ? {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.whitelist_role_remove_success"),
                detail: localizer(route.locale, "commands.moderation.whitelist_role_remove_success_detail", {
                  role: roleMention,
                }),
              }
            : result.status === "not_found"
              ? changedWhitelistStateReceipt(route.locale)
              : {
                  tone: "error",
                  heading: localizer(route.locale, "commands.moderation.whitelist_role_remove_failed"),
                  detail: localizer(route.locale, "commands.moderation.whitelist_role_remove_failed_detail"),
                };

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "roles", 0, scope, panelReceipt);
        return;
      }

      if (route.action === "persona-channel-add-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope || scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(
              route.locale,
              scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await dependencies.showPersonaChannelAddModal(
          interaction as ButtonInteraction,
          route.locale,
          dependencies.createNonce(),
          scope.whitelist.personaNames,
        );
        return;
      }

      if (route.action === "persona-channel-add-submit") {
        await interaction.deferUpdate();
        const personaValue = dependencies.takePersonaChannelPersonaValue(interaction.id, route.nonce);
        const channelId = dependencies.takePersonaChannelChannelValue(interaction.id, route.nonce);
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        let scope = await dependencies.resolveScope(interaction, false);
        const personaId = personaValue && /^\d+$/.test(personaValue) ? Number(personaValue) : 0;
        const channel = channelId ? await dependencies.resolveChannel(interaction, channelId) : null;
        if (
          !scope ||
          scope.readStatus !== "fresh" ||
          !scope.whitelist.personaNames.has(personaId) ||
          !channel ||
          channel.type !== ChannelType.GuildText
        ) {
          await interaction.editReply(
            terminalPayload(route.locale, scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup"),
          );
          return;
        }
        const currentIds = scope.whitelist.personaChannels
          .filter((row) => row.persona_id === personaId)
          .map((row) => row.channel_disc_id);
        const selectedChannelIds = new Set([...currentIds, channel.id]);
        const result = await dependencies.operations.replacePersonaChannelWhitelist({
          guildId: scope.guildId,
          serverId: scope.serverId,
          personaId,
          selectedChannelIds,
          availableChannelIds: [...selectedChannelIds],
        });
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.persona-channel.add",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const persona = scope.whitelist.personaNames.get(personaId) ?? "Persona";
        const receipt: PanelReceipt =
          result.status === "failure"
            ? {
                tone: "error",
                heading: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed"),
                detail: localizer(route.locale, "commands.moderation.whitelist_channel_add_failed_detail"),
              }
            : result.status === "unchanged"
              ? {
                  tone: "info",
                  heading: localizer(route.locale, "commands.moderation.persona_channel_add_unchanged"),
                  detail: localizer(route.locale, "commands.moderation.remove_nothing_changed_detail"),
                }
              : {
                  tone: "success",
                  heading: localizer(route.locale, "commands.moderation.persona_channel_add_success"),
                  detail: localizer(route.locale, "commands.moderation.persona_channel_add_success_detail", {
                    channel: `<#${channel.id}>`,
                    persona,
                  }),
                };
        scope = (await dependencies.resolveScope(interaction, false)) ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "persona-channels", 0, scope, receipt);
        return;
      }

      if (route.action === "persona-channel-remove-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope || scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(
              route.locale,
              scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const values = scope.whitelist.personaChannels.map((row) => `p:${row.persona_id}:${row.channel_disc_id}`);
        if (values.length === 0 || values.length > 50) {
          await interaction.reply({
            content: localizer(
              route.locale,
              values.length > 50
                ? "commands.moderation.remove_modal_limit"
                : "commands.moderation.remove_nothing_changed_detail",
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const options = await Promise.all(
          scope.whitelist.personaChannels.map(async (row) => {
            const channel = await dependencies.resolveChannel(interaction, row.channel_disc_id);
            return {
              value: `p:${row.persona_id}:${row.channel_disc_id}`,
              label: scope.whitelist.personaNames.get(row.persona_id) ?? "Persona",
              description: channel?.name ?? "Unknown channel",
            };
          }),
        );
        const nonce = dependencies.createNonce();
        dependencies.storeRemovalSnapshot(nonce, values);
        await dependencies.showRemovalModal(
          interaction as ButtonInteraction,
          route.locale,
          nonce,
          "persona-channel",
          options,
        );
        return;
      }

      if (route.action === "persona-channel-remove-submit") {
        await interaction.deferUpdate();
        const presented = dependencies.takeRemovalSnapshot(route.nonce);
        const kept = new Set<string>();
        for (let index = 0; index < 5; index++)
          for (const value of dependencies.takeRemovalCheckboxValues(interaction.id, route.nonce, index) ?? [])
            kept.add(value);
        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }
        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope || !presented || scope.readStatus !== "fresh") {
          await interaction.editReply(
            terminalPayload(route.locale, scope ? "commands.moderation.unavailable" : "commands.moderation.not_setup"),
          );
          return;
        }
        const currentValues = new Set(
          scope.whitelist.personaChannels.map((row) => `p:${row.persona_id}:${row.channel_disc_id}`),
        );
        const removed = new Set(presented.filter((value) => !kept.has(value) && currentValues.has(value)));
        const affectedPersonaIds = new Set([...removed].map((value) => Number(value.split(":")[1])));
        let failed = false;
        let successCount = 0;
        for (const personaId of affectedPersonaIds) {
          const currentIds = scope.whitelist.personaChannels
            .filter((row) => row.persona_id === personaId)
            .map((row) => row.channel_disc_id);
          const selectedChannelIds = new Set(currentIds.filter((id) => !removed.has(`p:${personaId}:${id}`)));
          const result = await dependencies.operations.replacePersonaChannelWhitelist({
            guildId: scope.guildId,
            serverId: scope.serverId,
            personaId,
            selectedChannelIds,
            availableChannelIds: currentIds,
          });
          if (result.status === "success") successCount++;
          if (result.status === "failure") failed = true;
        }
        if (successCount > 0) {
          dependencies.recordAction({
            action: "moderation.workspace.persona-channel.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
        }
        const receipt: PanelReceipt = failed
          ? {
              tone: "error",
              heading: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed"),
              detail: localizer(route.locale, "commands.moderation.whitelist_channel_remove_failed_detail"),
            }
          : removed.size === 0
            ? {
                tone: "info",
                heading: localizer(route.locale, "commands.moderation.remove_nothing_changed"),
                detail: localizer(route.locale, "commands.moderation.remove_nothing_changed_detail"),
              }
            : {
                tone: "success",
                heading: localizer(route.locale, "commands.moderation.persona_channel_remove_success"),
                detail: localizer(route.locale, "commands.moderation.persona_channel_remove_success_detail", {
                  count: removed.size,
                }),
              };
        scope = (await dependencies.resolveScope(interaction, false)) ?? { ...scope, readStatus: "unavailable" };
        await repaint(interaction, route.locale, "whitelist", "persona-channels", 0, scope, receipt);
        return;
      }

      if (route.action === "quota-edit-open") {
        if (!isAuthorized(interaction)) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.permission_denied"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.not_setup"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (scope.readStatus !== "fresh") {
          await interaction.reply({
            content: localizer(route.locale, "commands.moderation.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const nonce = dependencies.createNonce();
        const currentConfig = scope.quotas[route.quotaType];
        await dependencies.showQuotaEditModal(
          interaction as ButtonInteraction,
          route.locale,
          route.quotaType,
          currentConfig,
          nonce,
        );
        return;
      }

      if (route.action === "quota-edit-submit") {
        const modal = interaction as ModalSubmitInteraction;
        await interaction.deferUpdate();

        let rawDailyUserQuota: string | undefined;
        let rawServerwideQuota: string | undefined;
        let rawResetDays: string | undefined;

        try {
          rawDailyUserQuota = modal.fields.getTextInputValue(buildQuotaModalFieldId(route.nonce, "daily_user_quota"));
        } catch {
          rawDailyUserQuota = undefined;
        }

        try {
          rawServerwideQuota = modal.fields.getTextInputValue(buildQuotaModalFieldId(route.nonce, "serverwide_quota"));
        } catch {
          rawServerwideQuota = undefined;
        }

        try {
          rawResetDays = modal.fields.getTextInputValue(
            buildQuotaModalFieldId(route.nonce, "serverwide_quota_resets_in"),
          );
        } catch {
          rawResetDays = undefined;
        }

        if (!isAuthorized(interaction)) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied"));
          return;
        }

        let scope = await dependencies.resolveScope(interaction, false);
        if (!scope) {
          await interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup"));
          return;
        }

        if (scope.readStatus !== "fresh") {
          await repaint(interaction, route.locale, "quotas", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.quota_edit_failed"),
            detail: localizer(route.locale, "commands.moderation.stale_warning"),
          });
          return;
        }

        if (
          rawDailyUserQuota === undefined ||
          rawServerwideQuota === undefined ||
          rawResetDays === undefined ||
          !/^\d+$/.test(rawDailyUserQuota.trim()) ||
          !/^\d+$/.test(rawServerwideQuota.trim()) ||
          !/^\d+$/.test(rawResetDays.trim())
        ) {
          await repaint(interaction, route.locale, "quotas", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.quota_edit_failed"),
            detail: localizer(route.locale, "commands.moderation.quota_edit_invalid_input"),
          });
          return;
        }

        const dailyUserQuota = Number(rawDailyUserQuota.trim());
        const serverwideQuota = Number(rawServerwideQuota.trim());
        const serverwideQuotaResetsIn = Number(rawResetDays.trim());

        if (
          dailyUserQuota < 0 ||
          dailyUserQuota > 100 ||
          serverwideQuota < 0 ||
          serverwideQuota > 99999 ||
          serverwideQuotaResetsIn < 1 ||
          serverwideQuotaResetsIn > 365
        ) {
          await repaint(interaction, route.locale, "quotas", "channels", 0, scope, {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.quota_edit_failed"),
            detail: localizer(route.locale, "commands.moderation.quota_edit_invalid_input"),
          });
          return;
        }

        const currentConfig = scope.quotas[route.quotaType];
        if (
          currentConfig.daily_user_quota === dailyUserQuota &&
          currentConfig.serverwide_quota === serverwideQuota &&
          currentConfig.serverwide_quota_resets_in === serverwideQuotaResetsIn
        ) {
          const typeNameKey = {
            image: "commands.moderation.quota_type_image",
            text: "commands.moderation.quota_type_text",
            video: "commands.moderation.quota_type_video",
          }[route.quotaType];
          const typeName = localizer(route.locale, typeNameKey);

          await repaint(interaction, route.locale, "quotas", "channels", 0, scope, {
            tone: "info",
            heading: localizer(route.locale, "commands.moderation.quota_edit_unchanged", { type: typeName }),
            detail: localizer(route.locale, "commands.moderation.quota_edit_unchanged_detail", {
              type: typeName,
              type_lower: typeName.toLowerCase(),
            }),
          });
          return;
        }

        const result = await dependencies.operations.updateQuotaSettings({
          serverId: scope.serverId,
          quotaType: route.quotaType,
          dailyUserQuota,
          serverwideQuota,
          serverwideQuotaResetsIn,
        });

        const typeNameKey = {
          image: "commands.moderation.quota_type_image",
          text: "commands.moderation.quota_type_text",
          video: "commands.moderation.quota_type_video",
        }[route.quotaType];
        const typeName = localizer(route.locale, typeNameKey);

        let panelReceipt: PanelReceipt;
        if (result.status === "success") {
          dependencies.recordAction({
            action: "moderation.workspace.quota.set",
            serverId: scope.serverId,
            userDiscId: interaction.user?.id ?? "",
          });
          panelReceipt = {
            tone: "success",
            heading: localizer(route.locale, "commands.moderation.quota_edit_success", { type: typeName }),
            detail: localizer(route.locale, "commands.moderation.quota_edit_success_detail", {
              type: typeName,
              type_lower: typeName.toLowerCase(),
            }),
          };
        } else {
          panelReceipt = {
            tone: "error",
            heading: localizer(route.locale, "commands.moderation.quota_edit_failed"),
            detail: localizer(route.locale, "commands.moderation.quota_edit_failed_detail"),
          };
        }

        const reloadedScope = await dependencies.resolveScope(interaction, false);
        scope = reloadedScope ?? { ...scope, readStatus: "unavailable" };

        await repaint(interaction, route.locale, "quotas", "channels", 0, scope, panelReceipt);
        return;
      }

      const scope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => isAuthorized(interaction),
        onDenied: () => interaction.editReply(terminalPayload(route.locale, "commands.moderation.permission_denied")),
        load: () => dependencies.resolveScope(interaction, route.action === "retry"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.moderation.not_setup")),
      });

      if (!scope) return;

      if (route.action === "category") {
        await repaint(interaction, route.locale, route.category, "channels", 0, scope);
        return;
      }

      if (route.action === "select-page") {
        const selectedValue = (interaction as StringSelectMenuInteraction).values[0];
        const page = parseWhitelistPage(selectedValue) ?? "channels";
        await repaint(interaction, route.locale, "whitelist", page, 0, scope);
        return;
      }

      if (route.action === "page") {
        await repaint(interaction, route.locale, "whitelist", route.page, 0, scope);
        return;
      }

      if (route.action === "range") {
        const page = route.page === "none" ? "channels" : route.page;
        await repaint(interaction, route.locale, route.category, page, route.rangeIndex, scope);
        return;
      }

      if (route.action === "retry") {
        const page = route.page === "none" ? "channels" : route.page;
        await repaint(interaction, route.locale, route.category, page, 0, scope);
        return;
      }
    },
  };
}

export const moderationInteractionRoute = createModerationInteractionRoute();

export type ModerationPanelPayloadOrTerminal =
  | ReturnType<typeof buildModerationPanelPayload>
  | InteractionEditReplyOptions;

export async function buildInitialModerationPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  deps: Pick<ModerationRouteDependencies, "resolveScope"> = { resolveScope: defaultResolveScope },
): Promise<ModerationPanelPayloadOrTerminal> {
  if (!interaction.guildId) {
    return terminalPayload(locale, "commands.moderation.guild_only") as ModerationPanelPayloadOrTerminal;
  }

  if (!isAuthorized(interaction)) {
    return terminalPayload(locale, "commands.moderation.permission_denied") as ModerationPanelPayloadOrTerminal;
  }

  const scope = await deps.resolveScope(interaction);
  if (!scope) {
    return terminalPayload(locale, "commands.moderation.not_setup") as ModerationPanelPayloadOrTerminal;
  }

  return buildModerationPanelPayload({
    locale,
    category: "member-access",
    whitelistPage: "channels",
    rangeIndex: 0,
    data: scope,
  });
}

export async function executeModerationCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  buildPanel: typeof buildInitialModerationPanel = buildInitialModerationPanel,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buildPanel(interaction, locale));
}
