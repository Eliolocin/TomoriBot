import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import { CooldownType } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { MODERATION_PANEL_RANGE_SIZE, resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import {
  buildMemberAccessModalFieldId,
  buildModerationRemoveModalFieldId,
  buildModerationCustomId,
  buildPersonaChannelAddModalFieldId,
  buildQuotaModalFieldId,
  buildUserBlacklistAddModalFieldId,
  buildWhitelistChannelAddModalFieldId,
  buildWhitelistRoleAddModalFieldId,
  type ModerationCategory,
  type QuotaType,
  type UserBlacklistRemovalTarget,
  type WhitelistPage,
} from "@/utils/discord/moderationPanelCatalog";
import {
  SERVER_MEMBER_PERMISSION_DEFINITIONS,
  type ServerMemberPermissionsCommandConfigState,
} from "@/utils/discord/memberPermissionsConfigMapping";
import { safeModalLocalizer, safeSelectOptionText } from "@/utils/discord/ui/modals";
import {
  buildCategoryButtonRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import type {
  ModerationMemberAccessData,
  ModerationScopeData,
  QuotaConfigState,
} from "@/utils/moderation/moderationOperations";
import { localizer } from "@/utils/text/localizer";

export interface ModerationPanelRenderInput {
  locale: string;
  category: ModerationCategory;
  whitelistPage: WhitelistPage;
  rangeIndex: number;
  data: ModerationScopeData;
  receipt?: PanelReceipt;
  removeTarget?: UserBlacklistRemovalTarget;
  channelRemoveTarget?: string;
  roleRemoveTarget?: string;
}

export interface ModerationPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

function getCooldownTypeSuffix(cooldownType: CooldownType): string {
  switch (cooldownType) {
    case CooldownType.OFF:
      return "off";
    case CooldownType.PER_USER:
      return "per_user";
    case CooldownType.PER_CHANNEL:
      return "per_channel";
    case CooldownType.SERVER_WIDE:
      return "server_wide";
    case CooldownType.STRICT_SERVER_WIDE:
      return "strict_server_wide";
    default:
      return "off";
  }
}

function formatChannelCooldown(
  locale: string,
  cooldownType: CooldownType | null,
  cooldownLength: number | null,
): string {
  if (cooldownType === null || cooldownLength === null) {
    return localizer(locale, "commands.moderation.cooldown_inherited");
  }
  const typeKey = `commands.config.cooldown.type.choice_${getCooldownTypeSuffix(cooldownType)}`;
  const typeName = localizer(locale, typeKey);
  if (cooldownLength === 0) {
    return localizer(locale, "commands.moderation.cooldown_instant", { type: typeName });
  }
  return localizer(locale, "commands.moderation.cooldown_custom", {
    type: typeName,
    length: cooldownLength.toString(),
  });
}

function buildRangeButtons(
  locale: string,
  category: ModerationCategory,
  page: WhitelistPage | "none",
  rangeIndex: number,
  rangeCount: number,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildModerationCustomId("range", locale, category, page, Math.max(0, rangeIndex - 1)),
        label: localizer(locale, "commands.moderation.range_previous"),
        disabled: rangeIndex <= 0,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildModerationCustomId("range", locale, category, page, rangeIndex),
        label: localizer(locale, "commands.moderation.range_indicator", {
          current: rangeIndex + 1,
          total: rangeCount,
        }),
        disabled: true,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildModerationCustomId("range", locale, category, page, Math.min(rangeCount - 1, rangeIndex + 1)),
        label: localizer(locale, "commands.moderation.range_next"),
        disabled: rangeIndex >= rangeCount - 1,
      },
    ],
  };
}

function buildRetryButtonRow(
  locale: string,
  category: ModerationCategory,
  whitelistPage: WhitelistPage,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildModerationCustomId("retry", locale, category, category === "whitelist" ? whitelistPage : "none"),
        label: localizer(locale, "commands.moderation.retry"),
      },
    ],
  };
}

export function buildModerationPanelPayload(input: ModerationPanelRenderInput): ModerationPanelPayload {
  const { locale, category, whitelistPage, rangeIndex, data, receipt } = input;

  const categoryButtons = buildCategoryButtonRow(
    [
      {
        id: "member-access",
        label: localizer(locale, "commands.moderation.category_member_access"),
        customId: buildModerationCustomId("category", locale, "member-access"),
      },
      {
        id: "user-blacklist",
        label: localizer(locale, "commands.moderation.category_user_blacklist"),
        customId: buildModerationCustomId("category", locale, "user-blacklist"),
      },
      {
        id: "whitelist",
        label: localizer(locale, "commands.moderation.category_whitelist"),
        customId: buildModerationCustomId("category", locale, "whitelist"),
      },
      {
        id: "quotas",
        label: localizer(locale, "commands.moderation.category_quotas"),
        customId: buildModerationCustomId("category", locale, "quotas"),
      },
    ],
    category,
  );

  const components: ComponentInContainerData[] = [
    categoryButtons,
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, "commands.moderation.title")}`,
    },
  ];

  if (data.readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.moderation.unavailable")}`,
      },
      {
        ...buildRetryButtonRow(locale, category, whitelistPage),
      },
    );

    return {
      components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
      flags: MessageFlags.IsComponentsV2,
    };
  }

  if (category === "member-access") {
    const memteaching = data.memberAccess.serverMemteachingEnabled
      ? localizer(locale, "commands.moderation.member_access_servermemories_enabled")
      : localizer(locale, "commands.moderation.member_access_servermemories_disabled");
    const attributes = data.memberAccess.attributeMemteachingEnabled
      ? localizer(locale, "commands.moderation.member_access_attributelist_enabled")
      : localizer(locale, "commands.moderation.member_access_attributelist_disabled");
    const dialogues = data.memberAccess.sampledialogueMemteachingEnabled
      ? localizer(locale, "commands.moderation.member_access_sampledialogues_enabled")
      : localizer(locale, "commands.moderation.member_access_sampledialogues_disabled");
    const snapshots = data.memberAccess.promptSnapshotEnabled
      ? localizer(locale, "commands.moderation.member_access_promptsnapshot_enabled")
      : localizer(locale, "commands.moderation.member_access_promptsnapshot_disabled");

    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.moderation.member_access_title")}\n${localizer(locale, "commands.moderation.member_access_description")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: [memteaching, attributes, dialogues, snapshots].map((line) => `> ${line}`).join("\n"),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildModerationCustomId("member-access-open", locale),
            label: localizer(locale, "commands.moderation.edit_permissions"),
            disabled: data.readStatus !== "fresh",
          },
        ],
      },
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.moderation.model_access_title")}**
> ${localizer(
          locale,
          data.serverModelAccess.allowServerModels
            ? "commands.moderation.model_access_allowed"
            : "commands.moderation.model_access_personal_required",
        )}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            // Only the transition away from the current policy is offered, so the button always
            // names the change it performs rather than restating the state above it. The route
            // segment names the stored policy rather than the label, so already-open panels keep
            // resolving after copy changes.
            customId: buildModerationCustomId(
              "model-access-set",
              locale,
              data.serverModelAccess.allowServerModels ? "require-personal" : "allow",
            ),
            label: localizer(
              locale,
              data.serverModelAccess.allowServerModels
                ? "commands.moderation.model_access_disable_button"
                : "commands.moderation.model_access_allow_button",
            ),
            disabled: data.readStatus !== "fresh",
          },
        ],
      },
    );
  } else if (category === "user-blacklist") {
    if (input.removeTarget) {
      const target = input.removeTarget;
      if (target.source === "personalization") {
        const isPresent = data.userBlacklist.personalizationUserIds.includes(target.userId);
        if (isPresent) {
          components.push(
            {
              type: ComponentType.TextDisplay,
              content: `### ${localizer(locale, "commands.moderation.user_blacklist_remove_title")}\n${localizer(
                locale,
                "commands.moderation.user_blacklist_remove_personalization_description",
                { user: `<@${target.userId}>` },
              )}`,
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Danger,
                  customId: buildModerationCustomId(
                    "user-blacklist-remove-confirm",
                    locale,
                    "personalization",
                    target.userId,
                  ),
                  label: localizer(locale, "commands.moderation.remove_confirm"),
                  disabled: data.readStatus !== "fresh",
                },
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Secondary,
                  customId: buildModerationCustomId("user-blacklist-remove-cancel", locale),
                  label: localizer(locale, "commands.moderation.cancel"),
                },
              ],
            },
          );
          if (data.readStatus === "stale") {
            components.push(
              buildRetryButtonRow(locale, category, whitelistPage),
              { type: ComponentType.Separator, divider: true, spacing: 1 },
              {
                type: ComponentType.TextDisplay,
                content: withLinePrefix("-# ", localizer(locale, "commands.moderation.stale_warning")),
              },
            );
          }
          return {
            components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
            flags: MessageFlags.IsComponentsV2,
          };
        }
      } else if (target.source === "persona-block") {
        const block = data.userBlacklist.personaBlocks.find(
          (b) => b.persona_id === target.personaId && b.user_disc_id === target.userId,
        );
        if (block) {
          const blockTypeLabel = localizer(locale, `tools.user_block.type_${block.block_type}`);
          components.push(
            {
              type: ComponentType.TextDisplay,
              content: `### ${localizer(locale, "commands.moderation.user_blacklist_remove_title")}\n${localizer(
                locale,
                "commands.moderation.user_blacklist_remove_persona_block_description",
                {
                  user: `<@${target.userId}>`,
                  persona: block.persona_name,
                  type: blockTypeLabel,
                },
              )}`,
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Danger,
                  customId: buildModerationCustomId(
                    "user-blacklist-remove-confirm",
                    locale,
                    "persona-block",
                    target.personaId,
                    target.userId,
                  ),
                  label: localizer(locale, "commands.moderation.remove_confirm"),
                  disabled: data.readStatus !== "fresh",
                },
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Secondary,
                  customId: buildModerationCustomId("user-blacklist-remove-cancel", locale),
                  label: localizer(locale, "commands.moderation.cancel"),
                },
              ],
            },
          );
          if (data.readStatus === "stale") {
            components.push(
              buildRetryButtonRow(locale, category, whitelistPage),
              { type: ComponentType.Separator, divider: true, spacing: 1 },
              {
                type: ComponentType.TextDisplay,
                content: withLinePrefix("-# ", localizer(locale, "commands.moderation.stale_warning")),
              },
            );
          }
          return {
            components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
            flags: MessageFlags.IsComponentsV2,
          };
        }
      }
    }

    const pCount = data.userBlacklist.personalizationUserIds.length;
    const bCount = data.userBlacklist.personaBlocks.length;
    const totalCount = pCount + bCount;

    const rangeCount = Math.max(1, Math.ceil(totalCount / MODERATION_PANEL_RANGE_SIZE));
    const clampedRangeIndex = Math.min(Math.max(rangeIndex, 0), rangeCount - 1);
    const start = clampedRangeIndex * MODERATION_PANEL_RANGE_SIZE;
    const end = start + MODERATION_PANEL_RANGE_SIZE;

    const pStart = Math.min(start, pCount);
    const pEnd = Math.min(end, pCount);
    const visiblePersonalization = pStart < pEnd ? data.userBlacklist.personalizationUserIds.slice(pStart, pEnd) : [];

    const bStart = Math.max(0, Math.min(start - pCount, bCount));
    const bEnd = Math.max(0, Math.min(end - pCount, bCount));
    const visiblePersonaBlocks = bStart < bEnd ? data.userBlacklist.personaBlocks.slice(bStart, bEnd) : [];

    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.moderation.user_blacklist_count", {
        count: totalCount,
      })}`,
    });

    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.moderation.personalization_blacklist_section")}**`,
    });
    if (pCount === 0) {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.moderation.personalization_blacklist_empty"),
      });
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.moderation.personalization_blacklist_description"),
      });
      for (const userId of visiblePersonalization) {
        components.push({ type: ComponentType.TextDisplay, content: `> <@${userId}>` });
      }
    }

    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.moderation.persona_blocks_section")}**`,
    });
    if (bCount === 0) {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.moderation.persona_blocks_empty"),
      });
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.moderation.persona_blocks_description"),
      });
      for (const block of visiblePersonaBlocks) {
        const blockTypeKey = `tools.user_block.type_${block.block_type}`;
        const typeLabel = localizer(locale, blockTypeKey);
        components.push({
          type: ComponentType.TextDisplay,
          content: `> <@${block.user_disc_id}> for **${block.persona_name}** (${typeLabel})`,
        });
      }
    }

    if (rangeCount > 1) {
      components.push(buildRangeButtons(locale, "user-blacklist", "none", clampedRangeIndex, rangeCount));
    }

    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildModerationCustomId("user-blacklist-add-open", locale),
          label: localizer(locale, "commands.moderation.add_blacklist"),
          disabled: data.readStatus !== "fresh",
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildModerationCustomId("user-blacklist-remove-open", locale),
          label: localizer(locale, "commands.moderation.remove_blacklist"),
          disabled: data.readStatus !== "fresh" || totalCount === 0,
        },
      ],
    });
  } else if (category === "whitelist") {
    const pageSelectMenu: ActionRowData<StringSelectMenuComponentData> = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildModerationCustomId("select-page", locale),
          placeholder: localizer(locale, "commands.moderation.select_page_placeholder"),
          options: [
            {
              label: localizer(locale, "commands.moderation.page_channels"),
              value: "channels",
              description: localizer(locale, "commands.moderation.page_channels_description"),
              default: whitelistPage === "channels",
            },
            {
              label: localizer(locale, "commands.moderation.page_personas"),
              value: "persona-channels",
              description: localizer(locale, "commands.moderation.page_persona_channels_description"),
              default: whitelistPage === "persona-channels",
            },
            {
              label: localizer(locale, "commands.moderation.page_roles"),
              value: "roles",
              description: localizer(locale, "commands.moderation.page_roles_description"),
              default: whitelistPage === "roles",
            },
          ],
        },
      ],
    };

    components.push(pageSelectMenu);

    if (whitelistPage === "channels") {
      if (
        input.channelRemoveTarget &&
        data.whitelist.channels.some((c) => c.channel_disc_id === input.channelRemoveTarget)
      ) {
        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `### ${localizer(locale, "commands.moderation.whitelist_channel_remove_title")}\n${localizer(
              locale,
              "commands.moderation.whitelist_channel_remove_description",
              { channel: `<#${input.channelRemoveTarget}>` },
            )}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildModerationCustomId(
                  "whitelist-channel-remove-confirm",
                  locale,
                  input.channelRemoveTarget,
                ),
                label: localizer(locale, "commands.moderation.remove_confirm"),
                disabled: data.readStatus !== "fresh",
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildModerationCustomId("whitelist-channel-remove-cancel", locale),
                label: localizer(locale, "commands.moderation.cancel"),
              },
            ],
          },
        );
      } else {
        const channels = data.whitelist.channels;

        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.moderation.whitelist_channels_count", {
            count: channels.length,
          })}`,
        });

        if (channels.length === 0) {
          components.push({
            type: ComponentType.TextDisplay,
            content: localizer(locale, "commands.moderation.whitelist_channels_empty"),
          });
        } else {
          components.push({
            type: ComponentType.TextDisplay,
            content: localizer(locale, "commands.moderation.whitelist_channels_description"),
          });

          const selection = resolveRangeSelection(channels, rangeIndex, MODERATION_PANEL_RANGE_SIZE);

          for (const channel of selection.visibleItems) {
            const cooldown = formatChannelCooldown(locale, channel.cooldown_type, channel.cooldown_length);
            components.push({
              type: ComponentType.TextDisplay,
              content: `> <#${channel.channel_disc_id}>\n> ${cooldown}`,
            });
          }

          if (selection.rangeCount > 1) {
            components.push(
              buildRangeButtons(locale, "whitelist", "channels", selection.rangeIndex, selection.rangeCount),
            );
          }
        }

        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildModerationCustomId("whitelist-channel-add-open", locale),
              label: localizer(locale, "commands.moderation.add_or_edit_channel"),
              disabled: data.readStatus !== "fresh",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildModerationCustomId("whitelist-channel-remove-open", locale),
              label: localizer(locale, "commands.moderation.remove_channel"),
              disabled: data.readStatus !== "fresh" || channels.length === 0,
            },
          ],
        });
      }
    } else if (whitelistPage === "persona-channels") {
      const personaChannels = data.whitelist.personaChannels;
      const grouped = new Map<number, string[]>();
      for (const entry of personaChannels) {
        const list = grouped.get(entry.persona_id) ?? [];
        list.push(entry.channel_disc_id);
        grouped.set(entry.persona_id, list);
      }

      const groupedList = Array.from(grouped.entries()).map(([personaId, channelIds]) => ({
        personaId,
        personaName: data.whitelist.personaNames.get(personaId) ?? `Persona ${personaId}`,
        channelIds,
      }));

      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.moderation.whitelist_persona_channels_count", {
          count: groupedList.length,
        })}`,
      });

      if (groupedList.length === 0) {
        components.push({
          type: ComponentType.TextDisplay,
          content: localizer(locale, "commands.moderation.whitelist_persona_channels_empty"),
        });
      } else {
        components.push({
          type: ComponentType.TextDisplay,
          content: localizer(locale, "commands.moderation.whitelist_persona_channels_description"),
        });

        const selection = resolveRangeSelection(groupedList, rangeIndex, MODERATION_PANEL_RANGE_SIZE);
        const lines = selection.visibleItems.map((item) => {
          const channelMentions = item.channelIds.map((id) => `<#${id}>`).join(", ");
          return `> ${localizer(locale, "commands.moderation.persona_channels_restriction", {
            persona: item.personaName,
            channels: channelMentions,
          })}`;
        });

        components.push({
          type: ComponentType.TextDisplay,
          content: lines.join("\n"),
        });

        if (selection.rangeCount > 1) {
          components.push(
            buildRangeButtons(locale, "whitelist", "persona-channels", selection.rangeIndex, selection.rangeCount),
          );
        }
      }

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildModerationCustomId("persona-channel-add-open", locale),
            label: localizer(locale, "commands.moderation.add_persona"),
            disabled: data.readStatus !== "fresh",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildModerationCustomId("persona-channel-remove-open", locale),
            label: localizer(locale, "commands.moderation.remove_persona"),
            disabled: data.readStatus !== "fresh" || personaChannels.length === 0,
          },
        ],
      });
    } else if (whitelistPage === "roles") {
      if (input.roleRemoveTarget && data.whitelist.roles.some((role) => role.role_disc_id === input.roleRemoveTarget)) {
        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `### ${localizer(locale, "commands.moderation.whitelist_role_remove_title")}\n${localizer(
              locale,
              "commands.moderation.whitelist_role_remove_description",
              { role: `<@&${input.roleRemoveTarget}>` },
            )}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildModerationCustomId("whitelist-role-remove-confirm", locale, input.roleRemoveTarget),
                label: localizer(locale, "commands.moderation.remove_confirm"),
                disabled: data.readStatus !== "fresh",
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildModerationCustomId("whitelist-role-remove-cancel", locale),
                label: localizer(locale, "commands.moderation.cancel"),
              },
            ],
          },
        );
      } else {
        const roles = data.whitelist.roles;

        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.moderation.whitelist_roles_count", {
            count: roles.length,
          })}`,
        });

        if (roles.length === 0) {
          components.push({
            type: ComponentType.TextDisplay,
            content: localizer(locale, "commands.moderation.whitelist_roles_empty"),
          });
        } else {
          components.push({
            type: ComponentType.TextDisplay,
            content: localizer(locale, "commands.moderation.whitelist_roles_description"),
          });

          const selection = resolveRangeSelection(roles, rangeIndex, MODERATION_PANEL_RANGE_SIZE);
          for (const role of selection.visibleItems) {
            components.push({ type: ComponentType.TextDisplay, content: `> <@&${role.role_disc_id}>` });
          }

          if (selection.rangeCount > 1) {
            components.push(
              buildRangeButtons(locale, "whitelist", "roles", selection.rangeIndex, selection.rangeCount),
            );
          }
        }

        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildModerationCustomId("whitelist-role-add-open", locale),
              label: localizer(locale, "commands.moderation.add_role"),
              disabled: data.readStatus !== "fresh",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildModerationCustomId("whitelist-role-remove-open", locale),
              label: localizer(locale, "commands.moderation.remove_role"),
              disabled: data.readStatus !== "fresh" || roles.length === 0,
            },
          ],
        });
      }
    }
  } else if (category === "quotas") {
    const formatLimit = (limit: number) =>
      limit === 0 ? localizer(locale, "commands.moderation.quota_unlimited") : `\`${limit}\``;

    const quotaSections: ReadonlyArray<{ type: QuotaType; labelKey: string; buttonKey: string }> = [
      {
        type: "text",
        labelKey: "commands.moderation.quotas_text_generation",
        buttonKey: "commands.moderation.edit_text_quotas",
      },
      {
        type: "image",
        labelKey: "commands.moderation.quotas_image_generation",
        buttonKey: "commands.moderation.edit_image_quotas",
      },
      {
        type: "video",
        labelKey: "commands.moderation.quotas_video_generation",
        buttonKey: "commands.moderation.edit_video_quotas",
      },
    ];

    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.moderation.quotas_title")}\n${localizer(locale, "commands.moderation.quotas_description")}`,
    });

    for (const section of quotaSections) {
      const config = data.quotas[section.type];
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, section.labelKey)}**`,
        },
        {
          type: ComponentType.TextDisplay,
          content: [
            `> ${localizer(locale, "commands.moderation.quota_daily_user_limit", { limit: formatLimit(config.daily_user_quota) })}`,
            `> ${localizer(locale, "commands.moderation.quota_serverwide_limit", { limit: formatLimit(config.serverwide_quota) })}`,
            `> ${localizer(locale, "commands.moderation.quota_reset_period", { days: `\`${config.serverwide_quota_resets_in}\`` })}`,
          ].join("\n"),
        },
      );
    }

    components.push({
      type: ComponentType.ActionRow,
      components: quotaSections.map(
        (section): ButtonComponentData => ({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildModerationCustomId("quota-edit-open", locale, section.type),
          label: localizer(locale, section.buttonKey),
          disabled: data.readStatus !== "fresh",
        }),
      ),
    });
  }
  if (data.readStatus === "stale") {
    components.push(
      buildRetryButtonRow(locale, category, whitelistPage),
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("-# ", localizer(locale, "commands.moderation.stale_warning")),
      },
    );
  }

  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildMemberAccessModal(
  locale: string,
  state: ModerationMemberAccessData | ServerMemberPermissionsCommandConfigState,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const configState: ServerMemberPermissionsCommandConfigState =
    "server_memteaching_enabled" in state
      ? state
      : {
          server_memteaching_enabled: state.serverMemteachingEnabled,
          attribute_memteaching_enabled: state.attributeMemteachingEnabled,
          sampledialogue_memteaching_enabled: state.sampledialogueMemteachingEnabled,
          prompt_snapshot_enabled: state.promptSnapshotEnabled,
        };

  const fieldId = buildMemberAccessModalFieldId(nonce);
  const options = SERVER_MEMBER_PERMISSION_DEFINITIONS.map((def) => ({
    value: def.value,
    label: safeSelectOptionText(localizer(locale, def.labelKey), 100),
    description: safeSelectOptionText(localizer(locale, def.descKey), 100),
    default: def.getState(configState),
  }));

  return {
    custom_id: buildModerationCustomId("member-access-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.server.member-permissions.select_embed_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.server.member-permissions.select_placeholder"), 45),
        description: safeModalLocalizer(locale, "commands.server.member-permissions.select_embed_description"),
        component: {
          type: 22,
          custom_id: fieldId,
          min_values: 0,
          max_values: 4,
          required: false,
          options,
        },
      },
    ],
  };
}

export function buildUserBlacklistAddModal(
  locale: string,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const fieldId = buildUserBlacklistAddModalFieldId(nonce);
  return {
    custom_id: buildModerationCustomId("user-blacklist-add-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.moderation.user_blacklist_add_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.user_blacklist_add_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.user_blacklist_add_description"),
        component: {
          type: 5,
          custom_id: fieldId,
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export function buildWhitelistChannelAddModal(
  locale: string,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  return {
    custom_id: buildModerationCustomId("whitelist-channel-add-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_channel_add_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_channel_add_channel_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.whitelist_channel_add_channel_description"),
        component: {
          type: 8,
          custom_id: buildWhitelistChannelAddModalFieldId(nonce, "channel"),
          channel_types: [ChannelType.GuildText],
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_channel_add_type_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.whitelist_channel_add_type_description"),
        component: {
          type: 3,
          custom_id: buildWhitelistChannelAddModalFieldId(nonce, "type"),
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.moderation.whitelist_channel_add_type_placeholder"),
            150,
          ),
          required: false,
          options: [
            {
              label: safeSelectOptionText(localizer(locale, "commands.config.cooldown.type.choice_off"), 100),
              value: "0",
            },
            {
              label: safeSelectOptionText(localizer(locale, "commands.config.cooldown.type.choice_per_user"), 100),
              value: "1",
            },
            {
              label: safeSelectOptionText(localizer(locale, "commands.config.cooldown.type.choice_per_channel"), 100),
              value: "2",
            },
            {
              label: safeSelectOptionText(localizer(locale, "commands.config.cooldown.type.choice_server_wide"), 100),
              value: "3",
            },
          ],
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_channel_add_length_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.whitelist_channel_add_length_description"),
        component: {
          type: 4,
          custom_id: buildWhitelistChannelAddModalFieldId(nonce, "length"),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.moderation.whitelist_channel_add_length_placeholder"),
            100,
          ),
          required: false,
          max_length: 5,
        },
      },
    ],
  };
}

export function buildWhitelistRoleAddModal(
  locale: string,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildModerationCustomId("whitelist-role-add-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_role_add_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.whitelist_role_add_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.whitelist_role_add_description"),
        component: {
          type: 6,
          custom_id: buildWhitelistRoleAddModalFieldId(nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export interface ModerationRemovalOption {
  value: string;
  label: string;
  description?: string;
}

export function buildModerationRemovalModal(
  locale: string,
  nonce: string,
  action: "user-blacklist" | "whitelist-channel" | "whitelist-role" | "persona-channel",
  options: readonly ModerationRemovalOption[],
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const titleKeys = {
    "user-blacklist": "commands.moderation.user_blacklist_bulk_remove_title",
    "whitelist-channel": "commands.moderation.whitelist_channel_bulk_remove_title",
    "whitelist-role": "commands.moderation.whitelist_role_bulk_remove_title",
    "persona-channel": "commands.moderation.persona_channel_remove_title",
  } as const;
  const groupTitleKeys = {
    "user-blacklist": "commands.moderation.remove_user_blacklist_group_title",
    "whitelist-channel": "commands.moderation.remove_whitelist_channel_group_title",
    "whitelist-role": "commands.moderation.remove_whitelist_role_group_title",
    "persona-channel": "commands.moderation.remove_persona_channel_group_title",
  } as const;
  const groupDescriptionKey =
    action === "user-blacklist"
      ? "commands.moderation.remove_blacklist_group_description"
      : "commands.moderation.remove_whitelist_group_description";
  const groups: RawDiscordComponent[] = [];
  for (let index = 0; index < options.length; index += 10) {
    const groupIndex = Math.floor(index / 10);
    const groupOptions = options.slice(index, index + 10);
    groups.push({
      type: 18,
      label: safeSelectOptionText(
        groupIndex === 0
          ? localizer(locale, groupTitleKeys[action])
          : localizer(locale, "commands.moderation.remove_group_continuation", { index: groupIndex }),
        45,
      ),
      ...(groupIndex === 0 ? { description: safeModalLocalizer(locale, groupDescriptionKey) } : {}),
      component: {
        type: 22,
        custom_id: buildModerationRemoveModalFieldId(nonce, groupIndex),
        min_values: 0,
        max_values: groupOptions.length,
        required: false,
        options: groupOptions.map((option) => ({
          value: option.value,
          label: safeSelectOptionText(option.label, 100),
          ...(option.description ? { description: safeSelectOptionText(option.description, 100) } : {}),
          default: true,
        })),
      },
    });
  }
  return {
    custom_id: buildModerationCustomId(`${action}-remove-submit`, locale, nonce),
    title: safeSelectOptionText(localizer(locale, titleKeys[action]), 45),
    components: groups,
  };
}

export function buildPersonaChannelAddModal(
  locale: string,
  nonce: string,
  personas: ReadonlyMap<number, string>,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildModerationCustomId("persona-channel-add-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.moderation.persona_channel_add_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.persona_channel_add_persona_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.persona_channel_add_persona_description"),
        component: {
          type: 3,
          custom_id: buildPersonaChannelAddModalFieldId(nonce, "persona"),
          min_values: 1,
          max_values: 1,
          required: true,
          options: [...personas.entries()].map(([personaId, name]) => ({
            label: safeSelectOptionText(name, 100),
            value: String(personaId),
          })),
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.persona_channel_add_channel_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.persona_channel_add_channel_description"),
        component: {
          type: 8,
          custom_id: buildPersonaChannelAddModalFieldId(nonce, "channel"),
          channel_types: [ChannelType.GuildText],
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
    ],
  };
}

export function buildQuotaEditModal(
  locale: string,
  quotaType: QuotaType,
  currentConfig: QuotaConfigState,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const titleKeys = {
    image: "commands.moderation.quota_modal_image_title",
    text: "commands.moderation.quota_modal_text_title",
    video: "commands.moderation.quota_modal_video_title",
  } as const;

  return {
    custom_id: buildModerationCustomId("quota-edit-submit", locale, quotaType, nonce),
    title: safeSelectOptionText(localizer(locale, titleKeys[quotaType]), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.quota_daily_user_limit_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.quota_daily_user_limit_description"),
        component: {
          type: 4,
          custom_id: buildQuotaModalFieldId(nonce, "daily_user_quota"),
          style: TextInputStyle.Short,
          value: String(currentConfig.daily_user_quota),
          required: true,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.quota_serverwide_limit_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.quota_serverwide_limit_description"),
        component: {
          type: 4,
          custom_id: buildQuotaModalFieldId(nonce, "serverwide_quota"),
          style: TextInputStyle.Short,
          value: String(currentConfig.serverwide_quota),
          required: true,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.moderation.quota_reset_days_label"), 45),
        description: safeModalLocalizer(locale, "commands.moderation.quota_reset_days_description"),
        component: {
          type: 4,
          custom_id: buildQuotaModalFieldId(nonce, "serverwide_quota_resets_in"),
          style: TextInputStyle.Short,
          value: String(currentConfig.serverwide_quota_resets_in),
          required: true,
        },
      },
    ],
  };
}
