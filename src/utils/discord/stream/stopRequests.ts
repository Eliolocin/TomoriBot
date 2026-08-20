import type { Client, Message } from "discord.js";
import type { StreamStopReason } from "@/types/provider/interfaces";
import type { StreamState } from "@/types/stream/types";
import { log } from "@/utils/misc/logger";

export type StreamStopContext = {
  originalStopMessage: Message;
  client: Client;
};

export type StreamStopRequest = {
  channelId: string;
  timestamp: number;
  requesterId: string;
  type: "stop" | "follow_up";
  stopContext?: StreamStopContext;
};

const activeStopRequests = new Map<string, StreamStopRequest>();

/**
 * Requester ids raised by the delivery layer itself rather than by a user or another turn.
 *
 * These are scoped to the stream that raised them: unlike a `/kill`, they carry no
 * stopContext and have no meaning once that stream ends, so any exit path that does not
 * surface them as a stop must clear them before the next turn reads the registry.
 */
export const INTERNAL_STOP_REQUESTER_IDS: ReadonlySet<string> = new Set([
  "speaker_guard",
  "send_message_limit",
  "flush_limit",
]);

export function isSilentSpeakerGuardStop(requesterId: string | undefined, state: StreamState): boolean {
  return requesterId === "speaker_guard" && state.messageSentCount === 0 && !state.accumulatedText.trim();
}

function getStopReasonFromRequesterId(requesterId?: string): StreamStopReason {
  switch (requesterId) {
    case undefined:
    case "system":
      return "system_request";
    case "speaker_guard":
      return "speaker_guard";
    case "send_message_limit":
      return "send_message_limit";
    case "flush_limit":
      return "flush_limit";
    default:
      return "user_request";
  }
}

export function getStopReason(stopRequest: StreamStopRequest | undefined): StreamStopReason {
  if (!stopRequest || stopRequest.type !== "stop") {
    return "unknown";
  }

  return getStopReasonFromRequesterId(stopRequest.requesterId);
}

export function requestStop(channelId: string, requesterId?: string, stopContext?: StreamStopContext): boolean {
  const stopReason = getStopReasonFromRequesterId(requesterId);
  log.info(
    `Stop request received for channel ${channelId} (reason: ${stopReason}, requester: ${requesterId || "system"})`,
  );

  activeStopRequests.set(channelId, {
    channelId,
    timestamp: Date.now(),
    requesterId: requesterId || "system",
    type: "stop",
    stopContext,
  });

  return true;
}

export function hasStopRequest(channelId: string): boolean {
  return activeStopRequests.has(channelId);
}

export function peekStopRequest(channelId: string): StreamStopRequest | undefined {
  return activeStopRequests.get(channelId);
}

export function deleteStopRequest(channelId: string): void {
  activeStopRequests.delete(channelId);
}

export function clearStopRequest(channelId: string): void {
  const stopRequest = activeStopRequests.get(channelId);
  if (!stopRequest) return;

  if (stopRequest.stopContext) {
    log.info(`Stop request acknowledged for channel ${channelId}; preserving context for follow-up response.`);
    return;
  }

  activeStopRequests.delete(channelId);
  log.info(`Cleared stop request for channel ${channelId}`);
}

export function getAndClearStopContext(channelId: string): StreamStopContext | null {
  const stopRequest = activeStopRequests.get(channelId);
  if (stopRequest?.stopContext) {
    const context = stopRequest.stopContext;
    activeStopRequests.delete(channelId);
    log.info(`Retrieved and cleared stop context for channel ${channelId}`);
    return context;
  }

  return null;
}

export function requestFollowUp(channelId: string, requesterId: string): boolean {
  const existing = activeStopRequests.get(channelId);
  if (existing?.type === "stop") {
    log.info(`Follow-up request for channel ${channelId} ignored; stop request already active.`);
    return false;
  }

  activeStopRequests.set(channelId, {
    channelId,
    timestamp: Date.now(),
    requesterId,
    type: "follow_up",
  });

  log.info(`Follow-up interrupt request registered for channel ${channelId} by user ${requesterId}.`);
  return true;
}

export function isFollowUpRequest(channelId: string): boolean {
  return activeStopRequests.get(channelId)?.type === "follow_up";
}

export function cleanupOldStopRequests(maxAgeMs: number = 5 * 60 * 1000): void {
  const now = Date.now();
  for (const [channelId, stopRequest] of activeStopRequests.entries()) {
    if (now - stopRequest.timestamp > maxAgeMs) {
      activeStopRequests.delete(channelId);
      log.info(`Cleaned up old stop request for channel ${channelId}`);
    }
  }
}
