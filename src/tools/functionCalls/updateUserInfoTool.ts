import { z } from "zod";
import { BaseTool, type ToolContext, type ToolParameterSchema, type ToolResult } from "@/types/tool/interfaces";
import {
  PERSONA_NAMING_VALUE_MAX_LENGTH,
  USER_IDENTITY_FIELD_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
} from "@/types/personaNaming";
import { PrivacyLevel } from "@/types/db/schema";
import { invalidateUserCache } from "@/utils/cache/userCache";
import { resolveUserTarget } from "@/utils/discord/targetResolver";
import { sendStandardEmbed } from "@/utils/discord/embedHelper";
import { userNamingRepository, userRepository } from "@/utils/db/repositories";
import type { UserInfoWriteBatch } from "@/utils/db/repositories/UserNamingRepository";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const updateUserInfoChangeSchema = z
  .object({
    field: z.enum([
      "nickname",
      "prefix",
      "suffix",
      "gender_identity",
      "pronouns",
      "orientation",
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

function localizedCategories(locale: string, fields: string[]): string {
  return fields.map((field) => localizer(locale, `tools.user_info_update.field_${field}`)).join(", ");
}

async function sendSuccessNotice(context: ToolContext, targetLabel: string, categories: string): Promise<void> {
  if (context.suppressProgressNotices) return;
  try {
    await sendStandardEmbed(
      context.channel,
      context.locale,
      {
        titleKey: "tools.user_info_update.success_title",
        descriptionKey: "tools.user_info_update.success_description",
        descriptionVars: { target_user: targetLabel, categories },
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

function validateChange(change: UpdateUserInfoChange): string | null {
  const text = change.text_value?.trim();
  const globalOnly = ["gender_identity", "pronouns", "orientation", "addressing_style", "timezone_offset"];
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
  if (["gender_identity", "pronouns", "orientation"].includes(change.field)) {
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

export class UpdateUserInfoTool extends BaseTool {
  name = "update_user_info";
  description =
    "Update a registered Discord user's structured profile: nickname, separate prefix/suffix, identity, preferred addressing style, or numeric UTC offset. Use this instead of memory tools for requests such as 'call me X' or pronoun changes. Conventional titles belong in prefix or suffix, not inside nickname. Persona scope applies only to the active persona lineage.";
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
                "orientation",
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
    const batch: UserInfoWriteBatch = {
      global: {},
      ...(hasPersonaChanges ? { persona: { personaLineageId: lineageId as number, patch: {} } } : {}),
    };
    for (const change of parsed.data.changes) addChangeToBatch(batch, change);

    try {
      await userNamingRepository.applyUserInfoBatch(targetUser.user_id, batch);
    } catch {
      return failure(context, "user_info_update_failed", "tools.user_info_update.error_save_failed");
    }
    invalidateUserCache(targetDiscordId);

    const categories = [...new Set(parsed.data.changes.map((change) => change.field))];
    const categoryLabels = localizedCategories(context.locale, categories);
    await sendSuccessNotice(context, targetLabel, categoryLabels);
    const successMessage = localizer(context.locale, "tools.user_info_update.success_description", {
      target_user: targetLabel,
      categories: categoryLabels,
    });
    return {
      success: true,
      message: successMessage,
      data: { status: "user_info_updated", target_user: targetLabel, changed_categories: categories },
    };
  }
}
