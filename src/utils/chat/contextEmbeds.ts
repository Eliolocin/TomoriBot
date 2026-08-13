import type { Embed } from "discord.js";
import type { SimplifiedMessageForContext } from "@/utils/text/contextBuilder";
import {
  checkTargetEmbedTitle,
  formatSystemProducedEmbedHint,
  processLinkEmbed,
} from "@/utils/discord/embedClassifier";
import { extractNoticeTextFromComponents } from "@/utils/discord/componentNoticeReader";
import { ColorCode } from "@/utils/misc/logger";
import { getSupportedLocales, localizer } from "@/utils/text/localizer";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import { truncateForSystemContext } from "@/utils/chat/contextDirectives";

const SELF_DEBUG_ERROR_EMBED_MAX_DESCRIPTION_LENGTH = 1200;
const SELF_DEBUG_ERROR_EMBED_MAX_FIELD_COUNT = 6;
const SELF_DEBUG_ERROR_EMBED_MAX_FIELD_VALUE_LENGTH = 280;
const ERROR_EMBED_COLOR_DECIMAL = Number.parseInt(ColorCode.ERROR.replace("#", ""), 16);

export function processEmbedsFromMessage(args: {
  embeds: readonly Embed[];
  /**
   * The message's Components V2 tree. Required so system notices sent as CV2
   * containers (memory-learning, scheduled-task) stay visible to the LLM , so
   * those messages have an empty `embeds` array, so the embed loop alone would
   * drop them entirely and Tomori would re-run tools she already ran.
   */
  components?: readonly unknown[];
  content: string;
  imageAttachments: SimplifiedMessageForContext["imageAttachments"];
  isTomoriAuthoredMessage: boolean;
  selfDebugEnabled: boolean;
  tomoriNickname: string | null | undefined;
}): { content: string; processedSystemEmbed: boolean } {
  let content = args.content;
  let processedSystemEmbed = false;

  for (const embed of args.embeds) {
    const embedCheck = checkTargetEmbedTitle(embed.title);
    if (embedCheck.isTarget && embed.description) {
      const embedContent = formatTargetEmbedForContext(
        { title: embed.title, description: embed.description },
        embedCheck.type,
        args.tomoriNickname,
      );
      content = content ? `${content}\n${embedContent}` : embedContent;
      processedSystemEmbed = true;
      continue;
    }

    if (args.selfDebugEnabled && args.isTomoriAuthoredMessage) {
      const diagnosticEmbedContent = formatTomoriSelfDebugEmbedAsSystemMessage(embed);
      if (diagnosticEmbedContent) {
        content = content ? `${content}\n${diagnosticEmbedContent}` : diagnosticEmbedContent;
        processedSystemEmbed = true;
      }
      continue;
    }

    if (!args.isTomoriAuthoredMessage) {
      const linkEmbedData = processLinkEmbed(embed);
      if (!linkEmbedData.isLinkPreview) {
        continue;
      }
      if (linkEmbedData.textContent) {
        content = content ? `${content}\n${linkEmbedData.textContent}` : linkEmbedData.textContent;
      }
      if (linkEmbedData.imageInfo) {
        args.imageAttachments.push(linkEmbedData.imageInfo);
      }
      if (linkEmbedData.thumbnailInfo) {
        args.imageAttachments.push(linkEmbedData.thumbnailInfo);
      }
    }
  }

  // Components V2 pass: a CV2 notice carries no embeds at all, so its text has
  // to be reconstructed from the component tree before it can be classified.
  // Runs after the embed loop and is naturally exclusive with it , so Discord
  // rejects messages that mix `embeds` with the IsComponentsV2 flag.
  const notice = extractNoticeTextFromComponents(args.components);
  if (notice?.title && notice.description) {
    const noticeCheck = checkTargetEmbedTitle(notice.title);
    if (noticeCheck.isTarget) {
      const noticeContent = formatTargetEmbedForContext(
        { title: notice.title, description: notice.description },
        noticeCheck.type,
        args.tomoriNickname,
      );
      content = content ? `${content}\n${noticeContent}` : noticeContent;
      processedSystemEmbed = true;
    }
  }

  return { content, processedSystemEmbed };
}

/**
 * Formats a classified system notice into the `[System: ...]` form the LLM sees.
 *
 * Takes a transport-agnostic {title, description} pair rather than an `Embed`
 * so real embeds and reconstructed Components V2 notices produce byte-identical
 * context strings.
 *
 * @param tomoriNickname - Used to strip a leading "Nickname:" prefix from the body.
 */
function formatTargetEmbedForContext(
  source: { title: string | null; description: string },
  embedType: ReturnType<typeof checkTargetEmbedTitle>["type"],
  tomoriNickname: string | null | undefined,
): string {
  if (
    embedType === "system_injection" ||
    embedType === "scene_directive" ||
    embedType === "compact_summary" ||
    embedType === "compact_refresh"
  ) {
    const titleLine =
      (embedType === "compact_summary" || embedType === "compact_refresh") && source.title
        ? `## ${source.title}\n`
        : "";
    return `[System: ${titleLine}${source.description}]`;
  }

  let cleanedDescription = source.description ?? "";
  if (tomoriNickname) {
    const botNamePattern = new RegExp(`^${escapeRegExp(tomoriNickname)}:\\s*`, "i");
    if (botNamePattern.test(cleanedDescription)) {
      cleanedDescription = cleanedDescription.replace(botNamePattern, "").trim();
    }
  }

  // Titles of action-record notices carry the target and the action itself, so
  // the body alone would not say who was changed.
  const titledTypes = ["memory_learning", "reminder_set", "user_info_update", "user_moderation"];
  const titleLine = titledTypes.includes(embedType ?? "") && source.title ? `${source.title}\n` : "";
  const embedBody = `${titleLine}${cleanedDescription}`;
  const inlineSystemTypes = ["memory_learning", "reward", "punish", "user_info_update", "user_moderation"];
  return inlineSystemTypes.includes(embedType ?? "")
    ? `[System: ${embedBody}]`
    : formatSystemProducedEmbedHint(embedBody);
}

function checkSelfDebugDiagnosticEmbedTitle(embedTitle: string | null): boolean {
  if (!embedTitle) return false;

  for (const supportedLocale of getSupportedLocales()) {
    const diagnosticTitles = [
      localizer(supportedLocale, "genai.fallback_used_title"),
      localizer(supportedLocale, "genai.error_stream_timeout_title"),
      localizer(supportedLocale, "genai.empty_response_title"),
      localizer(supportedLocale, "genai.max_iterations_title"),
      localizer(supportedLocale, "genai.no_response_title"),
    ];
    if (diagnosticTitles.includes(embedTitle)) {
      return true;
    }
  }

  return false;
}

function shouldIncludeSelfDebugEmbed(embed: Embed): boolean {
  return embed.color === ERROR_EMBED_COLOR_DECIMAL || checkSelfDebugDiagnosticEmbedTitle(embed.title);
}

function formatTomoriSelfDebugEmbedAsSystemMessage(embed: Embed): string | null {
  if (!shouldIncludeSelfDebugEmbed(embed)) {
    return null;
  }

  const isErrorEmbed = embed.color === ERROR_EMBED_COLOR_DECIMAL;
  const lines: string[] = [isErrorEmbed ? "Tomori emitted an error embed." : "Tomori emitted a diagnostic embed."];

  if (embed.title?.trim()) {
    lines.push(`Title: ${truncateForSystemContext(embed.title, 160)}`);
  }
  if (embed.description?.trim()) {
    lines.push(
      `Description: ${truncateForSystemContext(embed.description, SELF_DEBUG_ERROR_EMBED_MAX_DESCRIPTION_LENGTH)}`,
    );
  }
  if (embed.author?.name?.trim()) {
    lines.push(`Embed Author: ${truncateForSystemContext(embed.author.name, 120)}`);
  }

  if (embed.fields.length > 0) {
    const fieldSummary = embed.fields
      .slice(0, SELF_DEBUG_ERROR_EMBED_MAX_FIELD_COUNT)
      .map((field) => {
        const fieldName = field.name?.trim() ? field.name : "Field";
        return `${truncateForSystemContext(fieldName, 90)}: ${truncateForSystemContext(field.value, SELF_DEBUG_ERROR_EMBED_MAX_FIELD_VALUE_LENGTH)}`;
      })
      .join(" | ");
    if (fieldSummary) {
      lines.push(`Fields: ${fieldSummary}`);
    }
    if (embed.fields.length > SELF_DEBUG_ERROR_EMBED_MAX_FIELD_COUNT) {
      lines.push(`Additional fields omitted: ${embed.fields.length - SELF_DEBUG_ERROR_EMBED_MAX_FIELD_COUNT}.`);
    }
  }

  if (embed.footer?.text?.trim()) {
    lines.push(`Footer: ${truncateForSystemContext(embed.footer.text, 220)}`);
  }

  return `[System: ${lines.join("\n")}]`;
}
