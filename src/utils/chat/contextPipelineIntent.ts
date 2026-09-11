import { buildChatTurnContext as buildBaseChatTurnContext } from "@/utils/chat/contextPipeline";
import type { ChatTurn, ChatTurnContext } from "@/utils/chat/types";
import { hasExplicitLongTermMemoryIntent } from "@/utils/memory/explicitLongTermMemoryIntent";
import { isShortTermMemoryMaintenanceDue } from "@/utils/memory/shortTermMemoryMaintenance";
import { resolveDeliberateToolMode } from "@/utils/tools/deliberateToolMode";

const SHORT_TERM_MEMORY_TOOL_NAME = "update_short_term_memory";

/**
 * Builds one chat-turn context while treating a due STM refresh as autonomous
 * Deliberate Tool Mode intent.
 *
 * `contextPipeline` already admits names in `endTurnAfterTools` into the DTM
 * allowlist before its fail-closed gate. We use that existing pre-context path as
 * a temporary intent carrier, then remove the temporary end-turn behavior before
 * generation starts. This keeps the resulting tool allowlist exact without making
 * STM depend on user keywords:
 *
 * - no user intent + STM not due -> no tools
 * - user tool intent + STM not due -> user-requested tools only
 * - no user intent + STM due -> update_short_term_memory only
 * - user tool intent + STM due -> user-requested tools + update_short_term_memory
 */
export async function buildChatTurnContext(turn: ChatTurn): Promise<ChatTurnContext> {
  const incoming = turn.lockedTurn.admission.incoming;
  const deliberateToolModeActive = resolveDeliberateToolMode(
    turn.persona.config.deliberate_tool_mode,
    turn.userRow.personal_deliberate_tool_mode ?? "follow",
  );

  const manualOverrides = incoming.manualStreamingContextOverrides;
  const toolsExplicitlyDisabled = manualOverrides?.disableAllTools === true || turn.isUserImpersonation;

  if (!deliberateToolModeActive || toolsExplicitlyDisabled) {
    return buildBaseChatTurnContext(turn);
  }

  const maintenanceDue = await isShortTermMemoryMaintenanceDue({
    triggeringUserId: turn.userDiscId,
    currentChannelId: turn.lockedTurn.channelId,
    currentServerId: turn.isDMChannel ? "DM" : turn.serverDiscId,
    tomoriState: turn.persona,
    explicitLongTermMemoryIntent: hasExplicitLongTermMemoryIntent(incoming.message.content),
    disableShortTermMemoryUpdate: manualOverrides?.disableShortTermMemoryUpdate,
  });

  if (!maintenanceDue) {
    return buildBaseChatTurnContext(turn);
  }

  const originalEndTurnAfterTools = manualOverrides?.endTurnAfterTools ?? [];
  const carriedEndTurnAfterTools = Array.from(new Set([...originalEndTurnAfterTools, SHORT_TERM_MEMORY_TOOL_NAME]));
  const carriedIncoming = {
    ...incoming,
    manualStreamingContextOverrides: {
      ...manualOverrides,
      endTurnAfterTools: carriedEndTurnAfterTools,
    },
  };
  const carriedTurn: ChatTurn = {
    ...turn,
    lockedTurn: {
      ...turn.lockedTurn,
      admission: {
        ...turn.lockedTurn.admission,
        incoming: carriedIncoming,
      },
    },
  };

  const context = await buildBaseChatTurnContext(carriedTurn);

  // `endTurnAfterTools` is only the pre-context carrier here. Preserve an STM
  // end-turn request if the caller genuinely supplied one, otherwise remove our
  // temporary marker before tool execution.
  if (!originalEndTurnAfterTools.includes(SHORT_TERM_MEMORY_TOOL_NAME)) {
    const remainingEndTurnAfterTools = context.streamingContext.endTurnAfterTools?.filter(
      (toolName) => toolName !== SHORT_TERM_MEMORY_TOOL_NAME,
    );
    if (remainingEndTurnAfterTools?.length) {
      context.streamingContext.endTurnAfterTools = remainingEndTurnAfterTools;
    } else {
      delete context.streamingContext.endTurnAfterTools;
    }
  }

  // Do not leak the temporary cloned incoming overrides to post-turn effects.
  context.turn = turn;
  return context;
}
