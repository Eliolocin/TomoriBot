import { z } from "zod";
import { BaseTool, type ToolContext, type ToolParameterSchema, type ToolResult } from "@/types/tool/interfaces";
import {
  PERSONA_NAMING_VALUE_MAX_LENGTH,
  USER_IDENTITY_FIELD_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
} from "@/types/personaNaming";
import { PrivacyLevel, type UserRow } from "@/types/db/schema";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { resolveUserTarget } from "@/utils/discord/targetResolver";
import { sendNoticeContainerMessage } from "@/utils/discord/expandableEmbedNotice";
import { userNamingRepository, userRepository } from "@/utils/db/repositories";
import { type UserInfoWriteBatch, userPersonaNamingPairKey } from "@/utils/db/repositories/UserNamingRepository";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { type EffectiveUserNaming, resolveEffectiveUserNaming } from "@/utils/text/userNaming";

const updateUserInfoChangeSchema = z
  .object({
    field: z.enum([
      "nickname",
      "prefix",
      "suffix",
      "gender_identity",
      "pronouns",
      "addressing_style",
      "timezone_offset",
    ]),
    scope: z.enum(["global", "persona"]),
    action: z.enum(["set", "clear", "inherit", "none"]),
    text_value: z.string().max(USER_IDENTITY_FIELD_MAX_LENGTH).optional(),
    number_value: z.number().optional(),
  })
  .strict();

const updateUserInfoInputSchema = z
  .object({
    target_user: z.string().min(1).optional(),
    changes: z.array(updateUserInfoChangeSchema).min(1).max(8),
  })
  .strict();

type UpdateUserInfoChange = z.infer<typeof updateUserInfoChangeSchema>;

function failure(
  context: ToolContext,
  status: string,
  messageKey: string,
  data: Record<string, unknown> = {},
): ToolResult {
  const reason = localizer(context.locale, messageKey);
  return {
    success: false,
    error: reason,
    message: reason,
    data: { status, ...data },
  };
}

function validateChange(change: UpdateUserInfoChange): string | null {
  const text = change.text_value?.trim();
  const globalOnly = ["gender_identity", "pronouns", "addressing_style", "timezone_offset"];
  if (globalOnly.includes(change.field) && change.scope !== "global") {
    return `${change.field} only supports global scope`;
  }
  if (["prefix", "suffix"].includes(change.field)) {
    if (change.number_value !== undefined) return `${change.field} does not accept number_value`;
    if (!["set", "inherit", "none"].includes(change.action)) return `${change.field} has an invalid action`;
    if (change.action === "set" && !text) return `${change.field} set requires text_value`;
    if (text && text.length > PERSONA_NAMING_VALUE_MAX_LENGTH) return `${change.field} is too long`;
    return null;
  }
  if (change.field === "nickname") {
    if (change.number_value !== undefined) return "nickname does not accept number_value";
    if (!["set", "clear"].includes(change.action)) return "nickname has an invalid action";
    if (change.action === "set" && !text) return "nickname set requires text_value";
    if (text && text.length > USER_NICKNAME_MAX_LENGTH) return "nickname is too long";
    return null;
  }
  if (["gender_identity", "pronouns"].includes(change.field)) {
    if (change.number_value !== undefined) return `${change.field} does not accept number_value`;
    if (!["set", "clear"].includes(change.action)) return `${change.field} has an invalid action`;
    if (change.action === "set" && !text) return `${change.field} set requires text_value`;
    return null;
  }
  if (change.field === "addressing_style") {
    if (change.number_value !== undefined) return "addressing_style does not accept number_value";
    if (!["set", "clear"].includes(change.action)) return "addressing_style has an invalid action";
    if (change.action === "set" && !["masculine", "feminine", "neutral"].includes(text ?? "")) {
      return "addressing_style must be masculine, feminine, or neutral";
    }
    return null;
  }
  if (change.text_value !== undefined) return "timezone_offset does not accept text_value";
  if (!["set", "clear"].includes(change.action)) return "timezone_offset has an invalid action";
  if (
    change.action === "set" &&
    (!Number.isInteger(change.number_value) || (change.number_value ?? 0) < -12 || (change.number_value ?? 0) > 14)
  ) {
    return "timezone_offset must be an integer from -12 through 14";
  }
  return null;
}

function addChangeToBatch(batch: UserInfoWriteBatch, change: UpdateUserInfoChange): void {
  const text = change.text_value?.trim();
  const personaPatch = batch.persona?.patch;
  if (change.field === "nickname") {
    const value = change.action === "clear" ? null : (text ?? null);
    if (change.scope === "persona" && personaPatch) personaPatch.nickname_override = value;
    else batch.global.user_nickname = value;
  } else if (change.field === "prefix" || change.field === "suffix") {
    const value = change.action === "inherit" ? null : change.action === "none" ? "" : (text ?? "");
    const key = `${change.field}_override` as "prefix_override" | "suffix_override";
    if (change.scope === "persona" && personaPatch) personaPatch[key] = value;
    else batch.global[key] = value;
  } else if (change.field === "timezone_offset") {
    batch.global.timezone_offset = change.action === "clear" ? null : (change.number_value ?? null);
  } else if (change.field === "addressing_style") {
    batch.global.addressing_style = change.action === "clear" ? null : (text as "masculine" | "feminine" | "neutral");
  } else {
    batch.global[change.field] = change.action === "clear" ? null : (text ?? null);
  }
}

/** Whether a global `none` on this affix would be outranked by the user's persona-lineage override. */
function isOutrankedGlobalSuppression(change: UpdateUserInfoChange, naming: EffectiveUserNaming): boolean {
  if (change.scope !== "global" || change.action !== "none") return false;
  if (change.field !== "prefix" && change.field !== "suffix") return false;
  const source = change.field === "prefix" ? naming.prefixSource : naming.suffixSource;
  return source === "persona_preference";
}

/**
 * Makes an explicit `none` actually suppress the affix.
 *
 * A persona-lineage override outranks the global layer, so a global `none` would
 * otherwise commit successfully while the affix kept rendering, which reads to the
 * user as the request being ignored. Only `none` is widened this way: `inherit`
 * genuinely means "fall back", so a lower layer supplying a value again is its
 * correct outcome, not a bug. An explicit persona-scope change in the same batch
 * wins, since that is the model stating the lineage value deliberately.
 */
export function suppressOutrankingOverrides(
  changes: UpdateUserInfoChange[],
  naming: EffectiveUserNaming,
  batch: UserInfoWriteBatch,
): void {
  const patch = batch.persona?.patch;
  if (!patch) return;
  for (const change of changes) {
    if (!isOutrankedGlobalSuppression(change, naming)) continue;
    const key = `${change.field}_override` as "prefix_override" | "suffix_override";
    if (Object.hasOwn(patch, key)) continue;
    patch[key] = null;
  }
}

/**
 * Resolves the affix the batch will leave in place, so the nickname can be
 * de-duplicated against it rather than against a value the batch is replacing.
 * An `inherit` request keeps the currently resolved affix because the layer it
 * falls back to may still supply one.
 */
function pendingAffix(changes: UpdateUserInfoChange[], field: "prefix" | "suffix", current: string): string {
  const change = changes.find((candidate) => candidate.field === field);
  if (!change) return current;
  if (change.action === "set") return change.text_value?.trim() ?? "";
  if (change.action === "none") return "";
  return current;
}

/**
 * Strips an affix the model re-typed into the nickname.
 *
 * A model that only ever sees the joined `formattedName` will sometimes submit
 * "Master Sparrow" as the nickname while "Master" is already the resolved
 * prefix, which would otherwise render "Master Master Sparrow". Matching is
 * against the resolved affix values only: the nickname is never split on
 * whitespace or punctuation to invent an affix boundary.
 */
export function stripRedundantAffixes(changes: UpdateUserInfoChange[], naming: EffectiveUserNaming): void {
  const nicknameChange = changes.find((change) => change.field === "nickname" && change.action === "set");
  const submitted = nicknameChange?.text_value?.trim();
  if (!nicknameChange || !submitted) return;

  let value = submitted;
  const prefix = pendingAffix(changes, "prefix", naming.prefix);
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) {
    const remainder = value.slice(prefix.length).trimStart();
    if (remainder) value = remainder;
  }
  const suffix = pendingAffix(changes, "suffix", naming.suffix);
  if (suffix && value.toLowerCase().endsWith(suffix.toLowerCase())) {
    const remainder = value.slice(0, value.length - suffix.length).trimEnd();
    if (remainder) value = remainder;
  }

  if (value !== submitted) {
    log.info(`update_user_info stripped a redundant affix from the submitted nickname for ${naming.formattedName}`);
    nicknameChange.text_value = value;
  }
}

async function resolveLiveDisplayName(context: ToolContext, targetDiscordId: string): Promise<string> {
  if (context.guildId) {
    const guild = context.client?.guilds.cache.get(context.guildId);
    const member =
      guild?.members.cache.get(targetDiscordId) ?? (await guild?.members.fetch(targetDiscordId).catch(() => null));
    if (member) return member.displayName;
  }
  const user = context.client?.users.cache.get(targetDiscordId);
  return user?.globalName ?? user?.username ?? targetDiscordId;
}

async function resolveNaming(
  context: ToolContext,
  userRow: UserRow,
  liveDisplayName: string,
): Promise<EffectiveUserNaming> {
  const lineageId = context.tomoriState.persona_lineage_id;
  const preference =
    lineageId != null && userRow.user_id
      ? (
          await userNamingRepository
            .loadPreferences([{ userId: userRow.user_id, personaLineageId: lineageId }])
            .catch(() => null)
        )?.get(userPersonaNamingPairKey(userRow.user_id, lineageId))
      : undefined;
  return resolveEffectiveUserNaming({
    global: {
      userNickname: userRow.user_nickname ?? null,
      prefixOverride: userRow.prefix_override ?? null,
      suffixOverride: userRow.suffix_override ?? null,
      addressingStyle: userRow.addressing_style ?? null,
    },
    liveDisplayName,
    persona: context.tomoriState.naming_config,
    preference,
  });
}

function styleLabel(locale: string, style: string | null | undefined): string | null {
  if (!style) return null;
  return localizer(locale, `commands.personal.profile.about.style_${style}`);
}

/** Renders a stored affix override, where null means inherit and "" means an explicit suppression. */
function affixOverrideLabel(locale: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return localizer(locale, "tools.user_info_update.value_inherit");
  return value || localizer(locale, "tools.user_info_update.value_none");
}

function previousValueLabel(
  locale: string,
  change: UpdateUserInfoChange,
  before: UserRow,
  personaScoped: boolean,
): string {
  const none = localizer(locale, "tools.user_info_update.value_none");
  switch (change.field) {
    case "nickname":
      return personaScoped ? localizer(locale, "tools.user_info_update.value_inherit") : before.user_nickname || none;
    case "prefix":
      return personaScoped
        ? localizer(locale, "tools.user_info_update.value_inherit")
        : affixOverrideLabel(locale, before.prefix_override);
    case "suffix":
      return personaScoped
        ? localizer(locale, "tools.user_info_update.value_inherit")
        : affixOverrideLabel(locale, before.suffix_override);
    case "gender_identity":
      return before.gender_identity || none;
    case "pronouns":
      return before.pronouns || none;
    case "addressing_style":
      return (
        styleLabel(locale, before.addressing_style) ?? localizer(locale, "tools.user_info_update.value_unspecified")
      );
    default:
      return before.timezone_offset != null ? formatUTCOffset(before.timezone_offset) : none;
  }
}

function nextValueLabel(locale: string, change: UpdateUserInfoChange): string {
  const text = change.text_value?.trim();
  if (change.action === "clear") return localizer(locale, "tools.user_info_update.value_cleared");
  if (change.action === "inherit") return localizer(locale, "tools.user_info_update.value_inherit");
  if (change.action === "none") return localizer(locale, "tools.user_info_update.value_none");
  if (change.field === "timezone_offset") return formatUTCOffset(change.number_value ?? 0);
  if (change.field === "addressing_style") return styleLabel(locale, text) ?? text ?? "";
  return text ?? "";
}

/**
 * Builds the notice/return body: a numbered list of what changed followed by the
 * resulting form of address. The resulting name is always included, including
 * for identity-only edits, because an addressing-style switch moves the affix
 * without any naming field appearing in the list.
 */
function buildSuccessBody(
  context: ToolContext,
  changes: UpdateUserInfoChange[],
  before: UserRow,
  after: EffectiveUserNaming,
  targetLabel: string,
): string {
  const locale = context.locale;
  const personaName = context.personaUsername ?? context.tomoriState.persona_nickname;
  const lines = changes.map((change, index) => {
    const personaScoped = change.scope === "persona";
    const fieldLabel = localizer(locale, `tools.user_info_update.field_${change.field}`);
    const scopedLabel = personaScoped
      ? localizer(locale, "tools.user_info_update.field_persona_scoped", {
          field: fieldLabel,
          persona_name: personaName,
        })
      : fieldLabel;
    return localizer(locale, "tools.user_info_update.change_line", {
      index: index + 1,
      field: scopedLabel,
      previous: previousValueLabel(locale, change, before, personaScoped),
      next: nextValueLabel(locale, change),
    });
  });
  const summary = localizer(locale, "tools.user_info_update.success_summary", {
    persona_name: personaName,
    target_user: targetLabel,
    formatted_name: after.formattedName,
  });
  return `${localizer(locale, "tools.user_info_update.success_intro")}\n${lines.join("\n")}\n\n${summary}`;
}

async function sendSuccessNotice(context: ToolContext, targetLabel: string, body: string): Promise<void> {
  if (context.suppressProgressNotices || !context.channel) return;
  try {
    await sendNoticeContainerMessage(
      context.channel,
      context.locale,
      {
        titleKey: "tools.user_info_update.success_title",
        titleVars: { target_user: targetLabel },
        description: body,
        footerKey: "tools.user_info_update.success_footer",
        footerVars: { target_user: targetLabel },
        color: ColorCode.SUCCESS,
      },
      {
        webhook: context.webhook,
        personaUsername: context.personaUsername,
        personaAvatarUrl: context.personaAvatarUrl,
      },
    );
  } catch (error) {
    log.warn("Failed to send the user info update notice", error as Error);
  }
}

export class UpdateUserInfoTool extends BaseTool {
  name = "update_user_info";
  description =
    "Update a registered Discord user's structured profile: nickname, separate prefix/suffix, identity, preferred addressing style, or numeric UTC offset. Use this instead of memory tools for requests such as 'call me X' or pronoun changes. The participant list names each user's prefix and suffix separately from their nickname; to stop using a title, set that prefix or suffix to action 'none' rather than rewriting the nickname without it. Conventional titles belong in prefix or suffix, not inside nickname. Persona scope applies only to the active persona lineage.";
  category = "utility" as const;
  requiresFeatureFlag = "user_info_updates";

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      target_user: {
        type: "string",
        description:
          "Optional user name, alias, mention, or Discord ID. Omit only to update the human who triggered this turn. Never use all or everyone.",
      },
      changes: {
        type: "array",
        description: "Atomic list of explicit changes. One invalid item rejects the entire list.",
        items: {
          type: "object",
          properties: {
            field: {
              type: "string",
              enum: [
                "nickname",
                "prefix",
                "suffix",
                "gender_identity",
                "pronouns",
                "addressing_style",
                "timezone_offset",
              ],
            },
            scope: { type: "string", enum: ["global", "persona"] },
            action: { type: "string", enum: ["set", "clear", "inherit", "none"] },
            text_value: {
              type: "string",
              description: "Value for text fields. For addressing_style use masculine, feminine, or neutral.",
            },
            number_value: { type: "number", description: "Integer UTC offset from -12 through 14." },
          },
          required: ["field", "scope", "action"],
        },
      },
    },
    required: ["changes"],
  };

  isAvailableFor(): boolean {
    return true;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!(context.tomoriState.config.user_info_updates_enabled ?? true)) {
      return failure(context, "user_info_updates_disabled", "tools.user_info_update.error_disabled");
    }
    const parsed = updateUserInfoInputSchema.safeParse(args);
    if (!parsed.success)
      return failure(context, "user_info_update_invalid_args", "tools.user_info_update.error_invalid_changes");

    const requestedTarget = parsed.data.target_user?.trim();
    if (requestedTarget && ["all", "everyone", "everybody"].includes(requestedTarget.toLowerCase())) {
      return failure(context, "user_info_update_invalid_target", "tools.user_info_update.error_specific_target");
    }

    const seen = new Set<string>();
    for (const change of parsed.data.changes) {
      const error = validateChange(change);
      if (error)
        return failure(context, "user_info_update_invalid_change", "tools.user_info_update.error_invalid_changes");
      const key = `${change.scope}:${change.field}`;
      if (seen.has(key))
        return failure(context, "user_info_update_duplicate_change", "tools.user_info_update.error_duplicate_change");
      seen.add(key);
    }

    let targetDiscordId = context.userId;
    let targetLabel = "the triggering user";
    if (requestedTarget) {
      const resolution = await resolveUserTarget(requestedTarget, context);
      if (resolution.status === "ambiguous") {
        return failure(context, "user_info_update_ambiguous_target", "tools.user_info_update.error_ambiguous_target", {
          candidates: resolution.candidates.map((candidate) => candidate.label),
        });
      }
      if (resolution.status === "not_found" || resolution.isBridgeUser) {
        return failure(context, "user_info_update_target_not_found", "tools.user_info_update.error_target_not_found");
      }
      targetDiscordId = resolution.targetId;
      targetLabel = resolution.displayLabel;
    }
    if (!targetDiscordId)
      return failure(context, "user_info_update_invalid_target", "tools.user_info_update.error_target_not_found");
    if (!context.guildId && targetDiscordId !== context.userId) {
      return failure(context, "user_info_update_dm_target_restricted", "tools.user_info_update.error_dm_target");
    }

    const targetUser = await userRepository.loadByDiscordId(targetDiscordId);
    if (!targetUser?.user_id) {
      return failure(context, "user_info_update_unregistered_target", "tools.user_info_update.error_unregistered");
    }

    const hasRestrictedSet = parsed.data.changes.some((change) => !["clear", "inherit"].includes(change.action));
    if (targetUser.privacy_level !== PrivacyLevel.MINIMAL && hasRestrictedSet) {
      return failure(context, "user_info_update_privacy_restricted", "tools.user_info_update.error_privacy_restricted");
    }

    const hasPersonaChanges = parsed.data.changes.some((change) => change.scope === "persona");
    const lineageId = context.tomoriState.persona_lineage_id;
    if (hasPersonaChanges && lineageId == null) {
      return failure(context, "user_info_update_missing_persona", "tools.user_info_update.error_missing_persona");
    }

    const liveDisplayName = await resolveLiveDisplayName(context, targetDiscordId);
    const namingBefore = await resolveNaming(context, targetUser, liveDisplayName);
    if (!requestedTarget) targetLabel = namingBefore.nickname;
    stripRedundantAffixes(parsed.data.changes, namingBefore);

    const needsSuppression =
      lineageId != null && parsed.data.changes.some((change) => isOutrankedGlobalSuppression(change, namingBefore));
    const batch: UserInfoWriteBatch = {
      global: {},
      ...(hasPersonaChanges || needsSuppression
        ? { persona: { personaLineageId: lineageId as number, patch: {} } }
        : {}),
    };
    for (const change of parsed.data.changes) addChangeToBatch(batch, change);
    suppressOutrankingOverrides(parsed.data.changes, namingBefore, batch);

    try {
      await userNamingRepository.applyUserInfoBatch(targetUser.user_id, batch);
    } catch {
      return failure(context, "user_info_update_failed", "tools.user_info_update.error_save_failed");
    }
    invalidateUserCache(targetDiscordId);

    const refreshed = (await userRepository.loadByDiscordId(targetDiscordId).catch(() => null)) ?? targetUser;
    const namingAfter = await resolveNaming(context, refreshed, liveDisplayName);
    const body = buildSuccessBody(context, parsed.data.changes, targetUser, namingAfter, targetLabel);

    await sendSuccessNotice(context, targetLabel, body);
    return {
      success: true,
      message: body,
      data: {
        status: "user_info_updated",
        target_user: targetLabel,
        formatted_name: namingAfter.formattedName,
        changed_categories: [...new Set(parsed.data.changes.map((change) => change.field))],
      },
    };
  }
}
