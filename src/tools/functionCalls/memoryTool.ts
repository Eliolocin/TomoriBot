/**
 * Memory/Learning Tool
 * Allows the AI to learn and remember new information for future interactions
 */

import { log } from "../../utils/misc/logger";
import { BaseTool, type ToolContext, type ToolResult, type ToolParameterSchema } from "../../types/tool/interfaces";
import { invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import { invalidateUserCache } from "../../utils/cache/userCache";
import { resolveUserTarget } from "@/utils/discord/targetResolver";

/**
 * Tool for remembering and learning new information during conversations
 */
export class MemoryTool extends BaseTool {
  name = "create_long_term_memory";
  description =
    "Use this function when you identify a new, distinct piece of information, fact, preference, or instruction during the conversation that seems important to remember for future interactions. This helps you learn and adapt. Specify if the information is a general server-wide fact or something specific about a user. Avoid saving information that is already known or redundant. IMPORTANT: Use {bot} instead of hardcoded bot names and {user} instead of hardcoded user names in your memory content to prevent confusion when names change. Be proactive in remembering user or server preferences, interests, and facts. Do not wait for the user to ask you to remember things and be proactive but avoid saving PII (real names, addresses, and contact info)";
  category = "memory" as const;
  requiresFeatureFlag = "self_teaching";

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      memory_content: {
        type: "string",
        description:
          "The specific piece of information, fact, or preference to remember. Be concise and clear. Write in third-person. Use {user} to refer to the target user and {bot} to refer to yourself; never hardcode names. Example: '{user} likes dogs' or '{bot} should greet {user} formally'.",
      },
      memory_scope: {
        type: "string",
        description:
          "Specify the scope of this memory. Use 'server_wide' for general information applicable to the whole server, or 'target_user' for information specific to a particular user.",
        enum: ["server_wide", "target_user"],
      },
      target_user: {
        type: "string",
        description:
          "If memory_scope is 'target_user', provide the target user's name as shown in the current conversation or server. Use natural names, not IDs.",
      },
    },
    required: ["memory_content", "memory_scope"],
  };

  /**
   * Check if memory tool is available for the given provider
   * @returns True if provider supports memory functionality
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Check if self-teaching functionality is enabled in Tomori config
   * @returns True if self-teaching is enabled
   */
  protected isEnabled(context: ToolContext): boolean {
    return context.tomoriState.config.self_teaching_enabled;
  }

  /**
   * Execute memory storage
   * @param args - Arguments containing memory details
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
        data: {
          status: "memory_save_failed_invalid_args",
          reason: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
        },
      };
    }

    if (!this.isEnabled(context)) {
      return {
        success: false,
        error: "Self-teaching is disabled for this server",
        data: {
          status: "memory_save_failed_disabled",
          reason: "Self-teaching functionality is disabled for this server",
        },
      };
    }

    let memoryContentArg = args.memory_content as string;
    const memoryScopeArg = args.memory_scope as "server_wide" | "target_user";
    const targetUserArg = args.target_user as string | undefined;
    const legacyTargetUserDiscordIdArg = args.target_user_discord_id as string | undefined;
    const legacyTargetUserNicknameArg = args.target_user_nickname as string | undefined;
    const requestedTargetUser =
      targetUserArg?.trim() || legacyTargetUserNicknameArg?.trim() || legacyTargetUserDiscordIdArg?.trim();

    const { MEMORY_NOTICE_PREVIEW_LIMIT, sendMemoryEmbedWithExpand } = await import(
      "../../utils/discord/expandableEmbedNotice"
    );
    const { ColorCode } = await import("../../utils/misc/logger");
    const { convertMentions } = await import("../../utils/text/contextBuilder");
    const { buildTextPreview } = await import("@/utils/text/textPreview");
    const { sanitizeUnknownTemplatePlaceholders } = await import("@/utils/text/processors/mentionProcessor");

    const { validateMemoryContent } = await import("@/utils/misc/memoryLimits");
    const { personalMemoryRepository, serverMemoryRepository, userRepository } = await import(
      "@/utils/db/repositories"
    );

    const tomoriState = context.tomoriState;
    const resolvedUserId = context.message?.author?.id || context.userId;
    const userRow = resolvedUserId ? await userRepository.loadByDiscordId(resolvedUserId) : null;

    if (!tomoriState || !userRow?.user_id || !tomoriState.server_id || !tomoriState.persona_id || !resolvedUserId) {
      // Log which specific value is missing for diagnostics
      const missing = [
        !tomoriState && "tomoriState",
        !userRow && "userRow",
        userRow && !userRow.user_id && "userRow.user_id",
        tomoriState && !tomoriState.server_id && "tomoriState.server_id",
        tomoriState && !tomoriState.persona_id && "tomoriState.persona_id",
        !resolvedUserId && "resolvedUserId",
      ].filter(Boolean);
      log.error(`Critical state missing before handling create_long_term_memory: [${missing.join(", ")}]`);
      return {
        success: false,
        error: "Internal bot error: Critical state information is missing",
        data: {
          status: "memory_save_failed_internal_error",
          reason: "Internal bot error: Critical state information is missing",
        },
      };
    }

    const personaNickname =
      context.personaUsername || tomoriState.persona_nickname || context.client.user?.username || "TomoriBot";

    if (typeof memoryContentArg !== "string" || !memoryContentArg.trim()) {
      return {
        success: false,
        error: "The 'memory_content' argument was missing, empty, or not a string",
        data: {
          status: "memory_save_failed_invalid_args",
          reason: "The 'memory_content' argument was missing, empty, or not a string",
        },
      };
    }

    if (typeof memoryScopeArg !== "string" || !["server_wide", "target_user"].includes(memoryScopeArg)) {
      return {
        success: false,
        error: "The 'memory_scope' argument was missing or invalid. Must be 'server_wide' or 'target_user'",
        data: {
          status: "memory_save_failed_invalid_args",
          reason: "The 'memory_scope' argument was missing or invalid. Must be 'server_wide' or 'target_user'",
        },
      };
    }

    let effectiveScope = memoryScopeArg;
    let resolvedTargetUserId: string | undefined;
    let resolvedTargetUserLabel: string | undefined;

    if (effectiveScope === "target_user") {
      if (!requestedTargetUser) {
        return {
          success: false,
          error: "The 'target_user' argument is required when 'memory_scope' is 'target_user'.",
          data: {
            status: "memory_save_failed_invalid_args",
            scope: "target_user",
            reason: "The 'target_user' argument is required when 'memory_scope' is 'target_user'.",
          },
        };
      }

      const userResolution = await resolveUserTarget(requestedTargetUser, context);
      if (userResolution.status === "ambiguous") {
        return {
          success: false,
          error: `Multiple users match "${requestedTargetUser}". Please clarify which one you mean: ${userResolution.candidates.map((candidate) => candidate.label).join(", ")}.`,
          data: {
            status: "memory_save_failed_ambiguous_user",
            scope: "target_user",
            reason: "Multiple users matched the requested target.",
            candidates: userResolution.candidates.map((candidate) => candidate.label),
          },
        };
      }

      if (userResolution.status === "not_found") {
        return {
          success: false,
          error: `Could not find a user matching "${requestedTargetUser}" in this conversation or server.`,
          data: {
            status: "memory_save_failed_user_not_found",
            scope: "target_user",
            reason: "The requested user was not found in this conversation or server.",
          },
        };
      }

      resolvedTargetUserId = userResolution.targetId;
      resolvedTargetUserLabel = userResolution.displayLabel;

      if (resolvedTargetUserId === context.client.user?.id || requestedTargetUser.toLowerCase() === "self") {
        log.info("Memory tool: Bot tried to save a personal memory about itself — falling back to server_wide scope");
        effectiveScope = "server_wide";
        resolvedTargetUserId = undefined;
        resolvedTargetUserLabel = undefined;
      } else if (userResolution.isBridgeUser) {
        const bridgeDisplayName = userResolution.displayLabel.replace(/\s+\(Matrix\)$/u, "");

        if (memoryContentArg.includes("{user}")) {
          const substitutedMemoryContent = memoryContentArg.replaceAll("{user}", bridgeDisplayName);
          if (substitutedMemoryContent !== memoryContentArg) {
            memoryContentArg = substitutedMemoryContent;
            log.info(
              `Memory tool: Replaced {user} with "${bridgeDisplayName}" before bridge target_user fallback to server_wide`,
            );
          }
        }

        effectiveScope = "server_wide";
        resolvedTargetUserId = undefined;
        resolvedTargetUserLabel = undefined;
      }
    }

    // Sanitize unknown {word} placeholders (e.g. {bredrumb}), so the LLM sometimes wraps
    // usernames in braces imitating {user}. Strip the braces so the name appears plainly.
    const memoryContent = sanitizeUnknownTemplatePlaceholders(memoryContentArg.trim());

    // Validate memory content length after any bridge/self fallback rewrites.
    const contentValidation = validateMemoryContent(memoryContent);
    if (!contentValidation.isValid) {
      return {
        success: false,
        error:
          contentValidation.error === "CONTENT_EMPTY"
            ? "Memory content cannot be empty"
            : `Memory content is too long. Maximum length is ${contentValidation.maxAllowed} characters.`,
        data: {
          status: "memory_save_failed_invalid_content",
          reason:
            contentValidation.error === "CONTENT_EMPTY"
              ? "Memory content cannot be empty"
              : `Memory content exceeds maximum length of ${contentValidation.maxAllowed} characters`,
        },
      };
    }

    // Guard: lineage_id=0 is reserved for global memories, never a valid persona ID.
    // The schema migration repairs this, but block the write if it somehow persists.
    if (tomoriState.persona_lineage_id === 0) {
      log.error(
        `Self-teach blocked: Tomori ${tomoriState.persona_id} has persona_lineage_id=0. Schema migration may not have run.`,
      );
      return {
        success: false,
        error: "Internal configuration error: this persona has an invalid lineage ID.",
        data: {
          status: "memory_save_failed_internal_error",
          reason: "Persona lineage ID is 0, which is reserved for global memories. Schema migration may not have run.",
        },
      };
    }

    if (effectiveScope === "server_wide") {
      try {
        const serverLimitCheck = await serverMemoryRepository.checkServerMemoryLimit(
          tomoriState.server_id,
          tomoriState.persona_lineage_id,
        );
        if (!serverLimitCheck.isValid) {
          return {
            success: false,
            error: `Server memory limit reached. This server can have up to ${serverLimitCheck.maxAllowed} memories (currently: ${serverLimitCheck.currentCount}).`,
            data: {
              status: "memory_save_failed_limit_exceeded",
              scope: "server_wide",
              current_count: serverLimitCheck.currentCount,
              max_allowed: serverLimitCheck.maxAllowed,
              reason: `Server memory limit of ${serverLimitCheck.maxAllowed} memories has been reached. Please inform the user that they need to use '/memories' to remove some memories before I can learn new ones.`,
            },
          };
        }

        const dbResult = await serverMemoryRepository.add(
          tomoriState.server_id,
          tomoriState.persona_id,
          tomoriState.persona_lineage_id,
          userRow.user_id,
          memoryContent,
        );

        if (dbResult) {
          log.success(
            `Tomori self-taught a server memory for her own persona lineage (ID: ${dbResult.server_memory_id}): "${memoryContent}"`,
          );

          // Process memory content for display (convert {user} and {bot} tokens to actual names)
          // Security: Ensure we have a valid server ID to prevent user data mixing
          const serverId = "guild" in context.channel ? context.channel.guild.id : context.userId;
          if (!serverId) {
            throw new Error("Critical security error: No valid server or user ID available for memory processing");
          }
          const processedMemoryContent = await convertMentions(
            memoryContent,
            context.client,
            serverId,
            userRow.user_nickname ?? context.message?.author.displayName ?? userRow.user_disc_id,
            tomoriState.persona_nickname, // Use bot's current nickname for {bot} replacement
            tomoriState?.config.personal_memories_enabled,
          );
          const memoryPreview = buildTextPreview(processedMemoryContent, MEMORY_NOTICE_PREVIEW_LIMIT);

          // The expand helper uses the same preview limit, letting users read
          // the full memory ephemerally without channel clutter.
          await sendMemoryEmbedWithExpand(
            context.channel,
            context.locale,
            {
              color: ColorCode.SUCCESS,
              titleKey: "genai.self_teach.server_memory_learned_title",
              titleVars: {
                persona_nickname: personaNickname,
              },
              descriptionKey: "genai.self_teach.server_memory_learned_description",
              descriptionVars: {
                memory_content: memoryPreview.text,
              },
              footerKey: "genai.self_teach.server_memory_footer",
            },
            processedMemoryContent,
            {
              webhook: context.webhook,
              personaUsername: context.personaUsername,
              personaAvatarUrl: context.personaAvatarUrl,
            },
          );

          // Invalidate TomoriState cache so next message includes new memory
          invalidateTomoriStateCache(serverId);

          return {
            success: true,
            message: "Memory saved successfully",
            data: {
              status: "memory_saved_successfully",
              scope: "server_wide",
              content_saved: memoryContent,
              memory_id: dbResult.server_memory_id,
            },
          };
        }

        log.error("Failed to save server memory via self-teach (DB error)");
        return {
          success: false,
          error: "Database operation failed to save server memory",
          data: {
            status: "memory_save_failed_db_error",
            scope: "server_wide",
            reason: "Database operation failed to save server memory",
          },
        };
      } catch (error) {
        log.error("Database error during server memory save", error as Error);
        return {
          success: false,
          error: "Database error occurred while saving memory",
          data: {
            status: "memory_save_failed_db_error",
            scope: "server_wide",
            reason: "Database error occurred",
          },
        };
      }
    } else if (effectiveScope === "target_user") {
      try {
        const targetUserRow = await userRepository.loadByDiscordId(resolvedTargetUserId as string);

        if (!targetUserRow?.user_id) {
          log.warn(`Self-teach: Resolved target user ${resolvedTargetUserId} not found in Tomori records`);
          return {
            success: false,
            error: `I don't know ${resolvedTargetUserLabel} yet, so I cannot save a personal memory for them.`,
            data: {
              status: "memory_save_failed_user_not_found",
              scope: "target_user",
              reason: "I can only save personal memories for users I already know.",
            },
          };
        }
        const targetUserDisplayName =
          resolvedTargetUserLabel || targetUserRow.user_nickname || targetUserRow.user_disc_id;

        // Check if user has opted out of personalization (privacy setting)
        const { PrivacyLevel } = await import("../../types/db/schema");
        const userPrivacyLevel = await userRepository.getPrivacyLevel(resolvedTargetUserId as string);

        // Block self-teaching for PARTIAL and FULL privacy levels
        if (userPrivacyLevel === PrivacyLevel.PARTIAL || userPrivacyLevel === PrivacyLevel.FULL) {
          log.info(
            `Self-teach blocked: User ${resolvedTargetUserId} (${targetUserDisplayName}) has privacy level ${userPrivacyLevel}`,
          );
          return {
            success: false,
            error: `Cannot save personal memory: ${targetUserDisplayName} has privacy restrictions.`,
            data: {
              status: "memory_save_failed_privacy_restricted",
              scope: "target_user",
              reason: `The user ${targetUserDisplayName} has chosen to restrict personal memory storage. I cannot save personal memories about them unless they change their privacy settings using '/personal config'.`,
            },
          };
        }

        // Check personal memory limit before adding
        const personalLimitCheck = await personalMemoryRepository.checkPersonalMemoryLimit(
          targetUserRow.user_id,
          tomoriState.persona_lineage_id,
          true,
        );
        if (!personalLimitCheck.isValid) {
          return {
            success: false,
            error: `Personal memory limit reached. Users can have up to ${personalLimitCheck.maxAllowed} personal memories (currently: ${personalLimitCheck.currentCount}).`,
            data: {
              status: "memory_save_failed_limit_exceeded",
              scope: "target_user",
              target_user: targetUserDisplayName,
              current_count: personalLimitCheck.currentCount,
              max_allowed: personalLimitCheck.maxAllowed,
              reason: `Personal memory limit of ${personalLimitCheck.maxAllowed} memories has been reached for this user. Please inform the user that they need to use '/personal memories' to remove some of their memories before I can learn new ones about them.`,
            },
          };
        }

        // Save personal memory (from tomoriChat.ts:1262-1335)
        const dbResult = await personalMemoryRepository.add(
          targetUserRow.user_id,
          tomoriState.persona_lineage_id,
          memoryContent,
        );

        if (dbResult) {
          log.success(
            `Tomori self-taught a personal memory for ${targetUserDisplayName} (Discord ID: ${resolvedTargetUserId}, Internal ID: ${targetUserRow.user_id}): "${memoryContent}"`,
          );

          // Process memory content for display (convert {user} and {bot} tokens to actual names)
          // Security: Ensure we have a valid server ID to prevent user data mixing
          const serverId = "guild" in context.channel ? context.channel.guild.id : context.userId;
          if (!serverId) {
            throw new Error("Critical security error: No valid server or user ID available for memory processing");
          }
          const processedMemoryContent = await convertMentions(
            memoryContent,
            context.client,
            serverId,
            targetUserDisplayName, // Use target user's name for {user} replacement
            tomoriState.persona_nickname, // Use bot's current nickname for {bot} replacement
            tomoriState?.config.personal_memories_enabled,
          );
          const memoryPreview = buildTextPreview(processedMemoryContent, MEMORY_NOTICE_PREVIEW_LIMIT);

          // Determine footer key based on personalization settings
          const personalizationEnabled = tomoriState?.config.personal_memories_enabled ?? true;
          // Security: Ensure we have a valid server ID to prevent user data mixing
          const serverDiscId = "guild" in context.channel ? context.channel.guild.id : context.userId;
          if (!serverDiscId) {
            throw new Error("Critical security error: No valid server or user ID available for blacklist checking");
          }
          const targetUserIsBlacklisted =
            (await userRepository.isBlacklisted(serverDiscId, resolvedTargetUserId as string)) ?? false;

          let personalMemoryFooterKey: string;
          if (!personalizationEnabled) {
            personalMemoryFooterKey = "genai.self_teach.personal_memory_footer_personalization_disabled";
          } else if (targetUserIsBlacklisted) {
            personalMemoryFooterKey = "genai.self_teach.personal_memory_footer_user_blacklisted";
          } else {
            personalMemoryFooterKey = "genai.self_teach.personal_memory_footer_manage";
          }

          // Invalidate user cache so next message includes new memory
          // Done before the notification notice so cache is always fresh even if the send fails
          invalidateUserCache(resolvedTargetUserId as string);

          // Send notification notice (non-fatal: missing permissions won't block the memory save).
          try {
            await sendMemoryEmbedWithExpand(
              context.channel,
              context.locale,
              {
                color: ColorCode.SUCCESS,
                titleKey: "genai.self_teach.personal_memory_learned_title",
                titleVars: {
                  user_nickname: targetUserDisplayName,
                  persona_nickname: personaNickname,
                },
                descriptionKey: "genai.self_teach.personal_memory_learned_description",
                descriptionVars: {
                  user_nickname: targetUserDisplayName,
                  memory_content: memoryPreview.text,
                },
                footerKey: personalMemoryFooterKey,
              },
              processedMemoryContent,
              {
                webhook: context.webhook,
                personaUsername: context.personaUsername,
                personaAvatarUrl: context.personaAvatarUrl,
              },
            );
          } catch (embedError) {
            log.warn("Failed to send personal memory notification notice (non-fatal)", embedError as Error);
          }

          return {
            success: true,
            message: "Memory saved successfully",
            data: {
              status: "memory_saved_successfully",
              scope: "target_user",
              target_user: targetUserDisplayName,
              memory_id: dbResult.personal_memory_id,
              content_saved: memoryContent,
            },
          };
        }

        log.error(`Failed to save personal memory for ${targetUserDisplayName} via self-teach (DB error)`);
        return {
          success: false,
          error: "Database operation failed to save personal memory for the target user",
          data: {
            status: "memory_save_failed_db_error",
            scope: "target_user",
            reason: "Database operation failed to save personal memory for the target user",
          },
        };
      } catch (error) {
        log.error("Error during target_user memory processing", error as Error);
        return {
          success: false,
          error: "Error occurred while processing user-specific memory",
          data: {
            status: "memory_save_failed_error",
            scope: "target_user",
            reason: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    }

    // This should never be reached due to validation above
    return {
      success: false,
      error: "Invalid memory scope",
      data: {
        status: "memory_save_failed_invalid_scope",
        reason: "Memory scope validation failed",
      },
    };
  }
}
