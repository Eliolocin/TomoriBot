/**
 * Shared embed detection utilities for identifying bot-generated system embeds.
 * Extracts the refresh/reset marker detection logic from tomoriChat.ts so it
 * can be reused by the history fetcher and other utilities.
 */

import type { Embed, Message } from "discord.js";
import { localizer, getSupportedLocales } from "@/utils/text/localizer";

/**
 * Checks whether a single embed is a "refresh marker": an embed that signals
 * a conversation reset or compact-refresh boundary.
 *
 * Matches the following localizer keys across all supported locales:
 * - `commands.refresh.title` (conversation reset)
 * - `commands.tool.compact.summary_title_refreshed` (compact summary refresh)
 * - `commands.tool.compact.roleplay_scene_title_refreshed` (compact scene refresh)
 *
 * @returns True if the embed is a refresh/reset marker
 */
export function isRefreshMarkerEmbed(embed: Embed): boolean {
  const title = embed.title;
  if (!title) return false;

  for (const supportedLocale of getSupportedLocales()) {
    const resetTitle = localizer(supportedLocale, "commands.refresh.title");
    if (title === resetTitle) return true;

    const compactSummaryRefreshed = localizer(supportedLocale, "commands.tool.compact.summary_title_refreshed");
    if (title === compactSummaryRefreshed) return true;

    const compactSceneRefreshed = localizer(supportedLocale, "commands.tool.compact.roleplay_scene_title_refreshed");
    if (title === compactSceneRefreshed) return true;

    const compactManualRefreshed = localizer(supportedLocale, "commands.tool.compact.manual_entry_title_refreshed");
    if (title === compactManualRefreshed) return true;
  }

  return false;
}

/**
 * Classifies a refresh marker embed as either a plain reset (`/refresh`) or a
 * compact-refresh (`/compact_refresh`). The distinction matters when slicing
 * history: plain resets drop the marker itself, compact-refreshes keep it
 * (since the compact summary IS the new conversation opener).
 *
 * @returns "compact_refresh" if the embed is a compact-summary refresh marker,
 *          "reset" if it's a plain `/refresh` marker, null otherwise
 */
function classifyRefreshMarkerEmbed(embed: Embed): "reset" | "compact_refresh" | null {
  const title = embed.title;
  if (!title) return null;

  for (const supportedLocale of getSupportedLocales()) {
    // Plain reset from /refresh
    if (title === localizer(supportedLocale, "commands.refresh.title")) {
      return "reset";
    }
    // Compact refresh markers: summary, scene, or manual refresh
    if (
      title === localizer(supportedLocale, "commands.tool.compact.summary_title_refreshed") ||
      title === localizer(supportedLocale, "commands.tool.compact.roleplay_scene_title_refreshed") ||
      title === localizer(supportedLocale, "commands.tool.compact.manual_entry_title_refreshed")
    ) {
      return "compact_refresh";
    }
  }

  return null;
}

/**
 * Walks an array of Discord messages from newest to oldest, finds the most
 * recent reset/refresh marker, and returns the sub-range that should be used
 * as conversation history.
 *
 * Exactly mirrors the slicing logic in `tomoriChat.ts`:
 *   - If no marker is found: return the full array
 *   - `reset` marker: slice starts at `resetIndex + 1` (drop the marker itself)
 *   - `compact_refresh` marker: slice starts at `resetIndex` (keep the marker:
 *     it carries the compact summary that replaces old history)
 *
 * @param messages - Messages in chronological order (oldest first, newest last)
 * @returns An object with the sliced messages and the marker type (or null if none)
 */
export function sliceMessagesAtResetMarker<T extends Pick<Message, "embeds">>(
  messages: T[],
): { sliced: T[]; markerType: "reset" | "compact_refresh" | null; markerIndex: number } {
  let resetIndex = -1;
  let markerType: "reset" | "compact_refresh" | null = null;

  // Walk from newest to oldest to find the most recent marker
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const embed of messages[i].embeds) {
      const classified = classifyRefreshMarkerEmbed(embed);
      if (classified) {
        resetIndex = i;
        markerType = classified;
        break;
      }
    }
    if (resetIndex !== -1) break;
  }

  // Compute startIndex based on marker type (or 0 if no marker)
  const startIndex = resetIndex === -1 ? 0 : markerType === "compact_refresh" ? resetIndex : resetIndex + 1;
  return {
    sliced: messages.slice(startIndex),
    markerType,
    markerIndex: resetIndex,
  };
}
