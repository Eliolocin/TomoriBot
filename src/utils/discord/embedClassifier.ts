/**
 * Shared embed classification and link-preview extraction utilities.
 *
 * Mirrors the local helpers in `src/events/messageCreate/tomoriChat.ts`
 * (`checkTargetEmbedTitle`, `processLinkEmbed`, `formatSystemProducedEmbedHint`)
 * so they can be reused by offline/debug consumers like `/tool prompt snapshot`
 * without duplicating the locale-scanning logic.
 *
 * The canonical runtime usage still lives inline in tomoriChat.ts: these
 * helpers are feature-parity copies of that behavior.
 */

import type { Embed } from "discord.js";
import { localizer, getSupportedLocales, getLocaleSubKeys, hasLocaleKey } from "@/utils/text/localizer";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";

/** Target embed classifications recognized by the chat pipeline. */
type TargetEmbedType =
  | "memory_learning"
  | "reset"
  | "reminder_set"
  | "system_injection"
  | "scene_directive"
  | "compact_summary"
  | "compact_refresh"
  | "reward"
  | "punish"
  | "user_info_update"
  | "user_moderation";

export type TargetEmbedCheck = { isTarget: true; type: TargetEmbedType } | { isTarget: false; type: null };

/**
 * Returns true when the localized template matches the given title literally,
 * or (when the template contains `{placeholder}` slots) when the title matches
 * the regex form of the template. Used for reminder titles which embed names.
 */
function matchesLocalizedTitleTemplate(template: string, actualTitle: string): boolean {
  if (!template.includes("{")) {
    return actualTitle === template;
  }
  const pattern = new RegExp(`^${escapeRegExp(template).replace(/\\\{[^}]+\\\}/g, ".+?")}$`);
  return pattern.test(actualTitle);
}

/**
 * Collects the `embed_title` of every sub-namespace under `namespace`, skipping the ones the
 * locale does not actually define.
 *
 * The existence check has to come from `hasLocaleKey` rather than from the returned string:
 * a sub-namespace without an `embed_title` resolves to the English title through `localizer`'s
 * per-key fallback, so nothing about the string marks it as absent from this locale.
 */
function collectSubKeyTitles(locale: string, namespace: string): string[] {
  return getLocaleSubKeys(locale, namespace)
    .map((name) => `${namespace}.${name}.embed_title`)
    .filter((key) => hasLocaleKey(locale, key))
    .map((key) => localizer(locale, key));
}

/**
 * Classifies an embed title against the set of bot-produced titles (memory
 * learning, reset, reminder-set, system injection, compact summary/refresh,
 * reward, punish, user info update, user moderation). Scans across ALL
 * supported locales so cross-locale servers still detect bot-produced embeds
 * correctly.
 *
 * @returns An object with isTarget and the matched type
 */
export function checkTargetEmbedTitle(embedTitle: string | null | undefined): TargetEmbedCheck {
  if (!embedTitle) return { isTarget: false, type: null };

  for (const supportedLocale of getSupportedLocales()) {
    // Memory learning titles (server + personal, all CRUD variants)
    const memoryLearningTitles = [
      localizer(supportedLocale, "genai.self_teach.server_memory_learned_title"),
      localizer(supportedLocale, "genai.self_teach.server_memory_updated_title"),
      localizer(supportedLocale, "genai.self_teach.server_memory_deleted_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_learned_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_updated_title"),
      localizer(supportedLocale, "genai.self_teach.personal_memory_deleted_title"),
    ];

    const reminderSetTitles = [
      localizer(supportedLocale, "reminders.reminder_set_title"),
      localizer(supportedLocale, "reminders.recurring_task_set_title"),
      localizer(supportedLocale, "reminders.task_set_title"),
    ];

    // Tool notices that record an action already taken. Without these the
    // persona cannot see her own past notice on a later turn and re-runs the
    // tool when asked whether she already did it.
    const userModerationTitles = [
      localizer(supportedLocale, "tools.user_block.block_mute_title"),
      localizer(supportedLocale, "tools.user_block.block_block_title"),
      localizer(supportedLocale, "tools.user_block.unmute_success_title"),
      localizer(supportedLocale, "tools.user_block.unblock_success_title"),
    ];

    if (memoryLearningTitles.some((t) => matchesLocalizedTitleTemplate(t, embedTitle))) {
      return { isTarget: true, type: "memory_learning" };
    }

    if (matchesLocalizedTitleTemplate(localizer(supportedLocale, "tools.user_info_update.success_title"), embedTitle)) {
      return { isTarget: true, type: "user_info_update" };
    }

    if (userModerationTitles.some((t) => matchesLocalizedTitleTemplate(t, embedTitle))) {
      return { isTarget: true, type: "user_moderation" };
    }

    // Reset and system-injection titles
    if (embedTitle === localizer(supportedLocale, "commands.refresh.title")) {
      return { isTarget: true, type: "reset" };
    }
    if (embedTitle === localizer(supportedLocale, "commands.bot.impersonate.system_title")) {
      return { isTarget: true, type: "system_injection" };
    }

    // Scene-generation status embed: surfaced to the LLM so it knows a scripted
    //     scene is underway and can read the speaking order / instructions as context.
    if (embedTitle === localizer(supportedLocale, "commands.bot.generate.scene.success_title")) {
      return { isTarget: true, type: "scene_directive" };
    }

    // Reward/punish titles: dynamically discovered from locale sub-keys
    //    so new reward/punish commands are automatically recognized
    const rewardTitles = collectSubKeyTitles(supportedLocale, "commands.reward");
    if (rewardTitles.some((t) => embedTitle === t)) {
      return { isTarget: true, type: "reward" };
    }

    const punishTitles = collectSubKeyTitles(supportedLocale, "commands.punish");
    if (punishTitles.some((t) => embedTitle === t)) {
      return { isTarget: true, type: "punish" };
    }

    // Compact summary (conversation + scene + manual) and compact refresh variants
    const compactSummaryTitle = localizer(supportedLocale, "commands.compact.summary_title");
    const compactSummaryRefreshed = localizer(supportedLocale, "commands.compact.summary_title_refreshed");
    const compactSceneTitle = localizer(supportedLocale, "commands.compact.roleplay_scene_title");
    const compactSceneRefreshed = localizer(supportedLocale, "commands.compact.roleplay_scene_title_refreshed");
    const compactManualTitle = localizer(supportedLocale, "commands.compact.manual_entry_title");
    const compactManualRefreshed = localizer(supportedLocale, "commands.compact.manual_entry_title_refreshed");
    const compactCharacterPrefix = localizer(supportedLocale, "commands.compact.roleplay_character_title_prefix");

    if (embedTitle === compactSummaryTitle || embedTitle === compactSceneTitle || embedTitle === compactManualTitle) {
      return { isTarget: true, type: "compact_summary" };
    }
    if (
      embedTitle === compactSummaryRefreshed ||
      embedTitle === compactSceneRefreshed ||
      embedTitle === compactManualRefreshed
    ) {
      return { isTarget: true, type: "compact_refresh" };
    }
    if (compactCharacterPrefix && embedTitle.startsWith(compactCharacterPrefix)) {
      return { isTarget: true, type: "compact_summary" };
    }

    // Reminder/task set confirmations
    if (reminderSetTitles.some((t) => matchesLocalizedTitleTemplate(t, embedTitle))) {
      return { isTarget: true, type: "reminder_set" };
    }
  }

  return { isTarget: false, type: null };
}

type LinkPreviewImageInfo = {
  url: string;
  proxyUrl: string;
  mimeType: string | null;
  filename: string;
};

export type LinkPreviewResult = {
  isLinkPreview: boolean;
  textContent: string | null;
  imageInfo: LinkPreviewImageInfo | null;
  thumbnailInfo: LinkPreviewImageInfo | null;
};

/**
 * Extracts text + image content from an auto-generated Discord link preview
 * embed (e.g., Twitter, YouTube, article card). Returns `isLinkPreview: false`
 * for empty embeds or for embeds already classified as bot-produced (per
 * `checkTargetEmbedTitle`).
 *
 * Kept byte-for-byte consistent with `processLinkEmbed` in tomoriChat.ts so
 * snapshot output matches live-chat conversion.
 */
export function processLinkEmbed(embed: Embed): LinkPreviewResult {
  // Skip entirely empty embeds
  const hasContent = embed.url || embed.title || embed.description || embed.author?.name || embed.fields.length > 0;
  if (!hasContent) {
    return { isLinkPreview: false, textContent: null, imageInfo: null, thumbnailInfo: null };
  }

  // Skip bot-produced system embeds because those are handled separately
  const embedCheck = checkTargetEmbedTitle(embed.title);
  if (embedCheck.isTarget) {
    return { isLinkPreview: false, textContent: null, imageInfo: null, thumbnailInfo: null };
  }

  // Assemble text content from available fields
  const contentParts: string[] = [];
  if (embed.author?.name) contentParts.push(embed.author.name);
  if (embed.title) contentParts.push(embed.title);
  if (embed.description) {
    const maxDescLength = 500;
    contentParts.push(
      embed.description.length > maxDescLength
        ? `${embed.description.substring(0, maxDescLength)}...`
        : embed.description,
    );
  }
  if (embed.fields.length > 0) {
    for (const field of embed.fields) {
      if (field.name || field.value) {
        contentParts.push(field.name && field.value ? `${field.name}: ${field.value}` : field.name || field.value);
      }
    }
  }

  const textContent =
    contentParts.length > 0 ? `[System: Link preview embed content: ${contentParts.join(" - ")}]` : "";

  // Derive image info from embed.image (preferred) or embed.thumbnail (fallback)
  const imageInfo = embed.image?.url ? deriveEmbedImageInfo(embed.image.url, embed.image.proxyURL ?? null) : null;
  const thumbnailInfo =
    !imageInfo && embed.thumbnail?.url
      ? deriveEmbedImageInfo(embed.thumbnail.url, embed.thumbnail.proxyURL ?? null)
      : null;

  return {
    isLinkPreview: true,
    textContent: textContent.trim() || null,
    imageInfo,
    thumbnailInfo,
  };
}

function deriveEmbedImageInfo(rawUrl: string, proxyUrl: string | null): LinkPreviewImageInfo | null {
  try {
    const parsed = new URL(rawUrl);
    let filename = parsed.pathname.split("/").pop() || "embed_image";
    // Strip social-media size suffixes (":large", ":medium", ":small", ":orig")
    filename = filename.replace(/:(large|medium|small|orig)$/, "");

    let mimeType = "image/jpeg";
    const extension = filename.split(".").pop()?.toLowerCase();
    switch (extension) {
      case "png":
        mimeType = "image/png";
        break;
      case "gif":
        mimeType = "image/gif";
        break;
      case "webp":
        mimeType = "image/webp";
        break;
      default:
        mimeType = "image/jpeg";
        break;
    }

    if (!filename.includes(".")) filename = `${filename}.jpg`;

    return {
      url: rawUrl,
      proxyUrl: proxyUrl || rawUrl,
      mimeType,
      filename,
    };
  } catch {
    return null;
  }
}

/**
 * Mirrors `formatSystemProducedEmbedHint` in tomoriChat.ts. Wraps an embed
 * body in the `[System: ...]`-adjacent form that prefixes system-produced
 * embeds before sending to the LLM.
 */
export function formatSystemProducedEmbedHint(embedBody: string): string {
  return `[System: The following content came from a system-produced embed]\n${embedBody}`;
}
