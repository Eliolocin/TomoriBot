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
import {
  type UserInfoWriteBatch,
  type UserPersonaNamingPreferencePatch,
  userPersonaNamingPairKey,
} from "@/utils/db/repositories/UserNamingRepository";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { type EffectiveUserNaming, resolveEffectiveUserNaming } from "@/utils/text/userNaming";

/** Fields stored per persona lineage, so each persona can address the same human differently. */
const NAMING_FIELDS = ["nickname", "prefix", "suffix"] as const;
/** Fields with only one storage slot per user; every persona reads the same value. */
const GLOBAL_FIELDS = ["gender_identity", "pronouns", "addressing_style", "timezone_offset"] as const;
const ALL_FIELDS = [...NAMING_FIELDS, ...GLOBAL_FIELDS] as const;

type UserInfoField = (typeof ALL_FIELDS)[number];

const updateUserInfoInputSchema = z
  .object({
    target_user: z.string().min(1).optional(),
    nickname: z.string().max(USER_NICKNAME_MAX_LENGTH).optional(),
    prefix: z.string().max(PERSONA_NAMING_VALUE_MAX_LENGTH).optional(),
    suffix: z.string().max(PERSONA_NAMING_VALUE_MAX_LENGTH).optional(),
    gender_identity: z.string().max(USER_IDENTITY_FIELD_MAX_LENGTH).optional(),
    pronouns: z.string().max(USER_IDENTITY_FIELD_MAX_LENGTH).optional(),
    addressing_style: z.enum(["masculine", "feminine", "neutral"]).optional(),
    timezone_offset: z.number().int().min(-12).max(14).optional(),
    clear: z.array(z.enum(ALL_FIELDS)).max(ALL_FIELDS.length).optional(),
  })
  .strict();

type UpdateUserInfoInput = z.infer<typeof updateUserInfoInputSchema>;

/** What a single field is being changed to. Absent from the plan means it is not being touched. */
type FieldPlan =
  | { field: UserInfoField; cleared: true }
  | { field: UserInfoField; cleared: false; value: string | number };

function failure(
  context: ToolContext,
  status: string,
  messageKey: string,
  data: Record<string, unknown> = {},
): ToolResult {
  const reason = localizer(context.locale, messageKey);
  return { success: false, error: reason, message: reason, data: { status, ...data } };
}

/**
 * Turns the flat input into one entry per touched field.
 *
 * A blank or whitespace-only string is folded into a clear rather than rejected:
 * no field has a meaningful empty value, and treating it as a removal is what the
 * caller obviously meant.
 */
function buildFieldPlans(input: UpdateUserInfoInput): { plans: FieldPlan[]; conflict: boolean } {
  const cleared = new Set<UserInfoField>(input.clear ?? []);
  const plans: FieldPlan[] = [];
  let conflict = false;

  for (const field of ALL_FIELDS) {
    const raw = input[field];
    const trimmed = typeof raw === "string" ? raw.trim() : raw;
    const hasValue = trimmed !== undefined && trimmed !== "";

    if (hasValue && cleared.has(field)) {
      conflict = true;
      continue;
    }
    if (hasValue) {
      plans.push({ field, cleared: false, value: trimmed as string | number });
      continue;
    }
    if (cleared.has(field) || (typeof raw === "string" && trimmed === "")) {
      plans.push({ field, cleared: true });
    }
  }

  return { plans, conflict };
}

/**
 * Strips an affix the caller re-typed into the nickname.
 *
 * A model that only ever sees the joined formatted name will sometimes submit
 * "Master Sparrow" as the nickname while "Master" is already the resolved prefix,
 * which would otherwise render "Master Master Sparrow". Matching is against the
 * resolved affix values only: the nickname is never split on whitespace or
 * punctuation to invent an affix boundary.
 */
export function stripRedundantAffixes(nickname: string, prefix: string, suffix: string): string {
  let value = nickname.trim();
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) {
    const remainder = value.slice(prefix.length).trimStart();
    if (remainder) value = remainder;
  }
  if (suffix && value.toLowerCase().endsWith(suffix.toLowerCase())) {
    const remainder = value.slice(0, value.length - suffix.length).trimEnd();
    if (remainder) value = remainder;
  }
  return value;
}

/** The affix that will be in effect once this batch commits, used to de-duplicate the nickname. */
function pendingAffix(plans: FieldPlan[], field: "prefix" | "suffix", current: string): string {
  const plan = plans.find((candidate) => candidate.field === field);
  if (!plan) return current;
  return plan.cleared ? "" : String(plan.value);
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

/**
 * Routes each field to its own storage. Naming fields are per-lineage so personas can
 * address the same human differently; identity fields have a single slot per user.
 * A cleared affix is stored as an explicit suppression rather than an inherit, so the
 * removal cannot be undone by a lower layer still supplying a value.
 */
function buildBatch(plans: FieldPlan[], lineageId: number | null): UserInfoWriteBatch {
  const namingPatch: UserPersonaNamingPreferencePatch = {};
  const batch: UserInfoWriteBatch = { global: {} };

  for (const plan of plans) {
    switch (plan.field) {
      case "nickname": {
        const value = plan.cleared ? null : String(plan.value);
        if (lineageId != null) namingPatch.nickname_override = value;
        else batch.global.user_nickname = value;
        break;
      }
      case "prefix":
      case "suffix": {
        const key = `${plan.field}_override` as const;
        const value = plan.cleared ? "" : String(plan.value);
        if (lineageId != null) namingPatch[key] = value;
        else batch.global[key] = value;
        break;
      }
      case "timezone_offset":
        batch.global.timezone_offset = plan.cleared ? null : Number(plan.value);
        break;
      case "addressing_style":
        batch.global.addressing_style = plan.cleared
          ? null
          : (String(plan.value) as "masculine" | "feminine" | "neutral");
        break;
      default:
        batch.global[plan.field] = plan.cleared ? null : String(plan.value);
        break;
    }
  }

  if (Object.keys(namingPatch).length > 0 && lineageId != null) {
    batch.persona = { personaLineageId: lineageId, patch: namingPatch };
  }
  return batch;
}

function styleLabel(locale: string, style: string | null | undefined): string | null {
  return style ? localizer(locale, `commands.personal.profile.about.style_${style}`) : null;
}

function previousValueLabel(
  locale: string,
  field: UserInfoField,
  before: UserRow,
  naming: EffectiveUserNaming,
): string {
  const none = localizer(locale, "tools.user_info_update.value_none");
  switch (field) {
    // Naming fields report the value the target actually experienced, not the raw
    // override slot, so the notice reads the way the change felt.
    case "nickname":
      return naming.nickname || none;
    case "prefix":
      return naming.prefix || none;
    case "suffix":
      return naming.suffix || none;
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

function nextValueLabel(locale: string, plan: FieldPlan): string {
  if (plan.cleared) return localizer(locale, "tools.user_info_update.value_cleared");
  if (plan.field === "timezone_offset") return formatUTCOffset(Number(plan.value));
  if (plan.field === "addressing_style") return styleLabel(locale, String(plan.value)) ?? String(plan.value);
  return String(plan.value);
}

/**
 * Builds the numbered list of what changed, followed by the resulting form of address
 * only when that name actually moved. Persona-scoped rows carry the persona's name; an
 * unlabelled row is global, which needs no explanation because global is the unsurprising
 * case. The channel notice quotes the list for contrast while the model-facing copy stays
 * plain, so Discord presentation syntax never reaches a functionResponse.
 */
function buildSuccessBody(
  context: ToolContext,
  plans: FieldPlan[],
  before: UserRow,
  namingBefore: EffectiveUserNaming,
  namingAfter: EffectiveUserNaming,
  targetLabel: string,
  personaScoped: boolean,
): { notice: string; message: string } {
  const locale = context.locale;
  const personaName = context.personaUsername ?? context.tomoriState.persona_nickname;
  const lines = plans.map((plan, index) => {
    const isNaming = personaScoped && (NAMING_FIELDS as readonly string[]).includes(plan.field);
    const fieldLabel = localizer(locale, `tools.user_info_update.field_${plan.field}`);
    return localizer(locale, "tools.user_info_update.change_line", {
      index: index + 1,
      field: isNaming
        ? localizer(locale, "tools.user_info_update.field_persona_scoped", {
            field: fieldLabel,
            persona_name: personaName,
          })
        : fieldLabel,
      previous: previousValueLabel(locale, plan.field, before, namingBefore),
      next: nextValueLabel(locale, plan),
    });
  });

  // Keyed on the rendered name rather than on which fields changed: an
  // addressing-style switch moves the affix with no naming field present, while a
  // pronoun edit leaves the name alone. Reporting it either way would restate the
  // unchanged name as if it were news.
  const nameChanged = namingBefore.formattedName !== namingAfter.formattedName;
  const summary = nameChanged
    ? `\n${localizer(locale, "tools.user_info_update.success_summary", {
        persona_name: personaName,
        target_user: targetLabel,
        formatted_name: namingAfter.formattedName,
      })}`
    : "";

  const intro = localizer(locale, "tools.user_info_update.success_intro");
  // Quoting each line rather than opening a `>>>` block, which would run to the end of
  // the message and pull the summary in with it. The summary reads as the conclusion
  // only from outside the quote.
  const quoted = lines.map((line) => `> ${line}`).join("\n");
  return {
    notice: `${intro}\n${quoted}${summary}`,
    message: `${intro}\n${lines.join("\n")}${summary}`,
  };
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
    "Update a registered Discord user's stored profile. Use this instead of memory tools for requests such as 'call me X' or a pronoun change. Nickname, prefix, and suffix are yours alone, so they change only how you address them; the remaining fields are shared by every persona. A title or honorific belongs in prefix or suffix, never inside nickname. To stop using a title, list 'prefix' or 'suffix' in clear rather than resending the nickname without it. Pass only the fields you are changing.";
  category = "utility" as const;
  requiresFeatureFlag = "user_info_updates";

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      target_user: {
        type: "string",
        description:
          "The user to update, as shown in the current conversation or server. A name, alias, mention, or Discord ID all work. Omit it to update whoever triggered this turn.",
      },
      nickname: {
        type: "string",
        description: "What you call them, with no title or honorific attached.",
      },
      prefix: {
        type: "string",
        description: "Title or honorific placed before the nickname, such as Master or Dad.",
      },
      suffix: {
        type: "string",
        description: "Title or honorific placed after the nickname, such as -san or Jr.",
      },
      gender_identity: {
        type: "string",
        description: "How they describe their own gender, in their words.",
      },
      pronouns: {
        type: "string",
        description: "Pronouns to use for them, such as she/her, they/them, or any.",
      },
      addressing_style: {
        type: "string",
        enum: ["masculine", "feminine", "neutral"],
        description:
          "Which gendered form of your titles to use for them, such as Master versus Mistress. Set it only when they say so; never infer it from their gender or pronouns.",
      },
      timezone_offset: {
        type: "number",
        description: "Their UTC offset in whole hours, from -12 through +14.",
      },
      clear: {
        type: "array",
        items: { type: "string", enum: [...ALL_FIELDS] },
        description: "Fields to remove. A field listed here must not also be given a value.",
      },
    },
    required: [],
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

    const { plans, conflict } = buildFieldPlans(parsed.data);
    if (conflict)
      return failure(context, "user_info_update_duplicate_change", "tools.user_info_update.error_duplicate_change");
    if (plans.length === 0)
      return failure(context, "user_info_update_invalid_change", "tools.user_info_update.error_invalid_changes");

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

    const hasRestrictedSet = plans.some((plan) => !plan.cleared);
    if (targetUser.privacy_level !== PrivacyLevel.MINIMAL && hasRestrictedSet) {
      return failure(context, "user_info_update_privacy_restricted", "tools.user_info_update.error_privacy_restricted");
    }

    const liveDisplayName = await resolveLiveDisplayName(context, targetDiscordId);
    const namingBefore = await resolveNaming(context, targetUser, liveDisplayName);
    if (!requestedTarget) targetLabel = namingBefore.nickname;

    const nicknamePlan = plans.find((plan) => plan.field === "nickname" && !plan.cleared);
    if (nicknamePlan && !nicknamePlan.cleared) {
      nicknamePlan.value = stripRedundantAffixes(
        String(nicknamePlan.value),
        pendingAffix(plans, "prefix", namingBefore.prefix),
        pendingAffix(plans, "suffix", namingBefore.suffix),
      );
    }

    const lineageId = context.tomoriState.persona_lineage_id ?? null;
    const batch = buildBatch(plans, lineageId);

    try {
      await userNamingRepository.applyUserInfoBatch(targetUser.user_id, batch);
    } catch {
      return failure(context, "user_info_update_failed", "tools.user_info_update.error_save_failed");
    }
    invalidateUserCache(targetDiscordId);

    const refreshed = (await userRepository.loadByDiscordId(targetDiscordId).catch(() => null)) ?? targetUser;
    const namingAfter = await resolveNaming(context, refreshed, liveDisplayName);
    const body = buildSuccessBody(
      context,
      plans,
      targetUser,
      namingBefore,
      namingAfter,
      targetLabel,
      lineageId != null,
    );

    await sendSuccessNotice(context, targetLabel, body.notice);
    return {
      success: true,
      message: body.message,
      data: {
        status: "user_info_updated",
        target_user: targetLabel,
        formatted_name: namingAfter.formattedName,
        changed_fields: plans.map((plan) => plan.field),
      },
    };
  }
}
