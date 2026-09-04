/**
 * Expandable Components V2 notification helper.
 *
 * Renders a standard notification as a Components V2 container with an optional
 * in-card "Expand" button. The button is attached only when the underlying
 * content exceeds the notice type's truncation threshold. Clicking it replies
 * ephemerally with the full, un-truncated content so users can read everything
 * without cluttering the channel.
 *
 * The generic `sendEmbedWithExpand` is reused by both memory-learning notices
 * (`sendMemoryEmbedWithExpand`) and scheduled-task notices
 * (`sendTaskEmbedWithExpand`); each wrapper supplies its own locale keys,
 * button custom ID, and collector timeout.
 *
 * Mirrors the lifecycle of `fallbackModelNotice.ts`: 24h collector, disable
 * the button on collector end (via webhook token when the message was sent
 * through a persona webhook, otherwise via the bot token).
 */

import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type AnyThreadChannel,
  type BaseGuildTextChannel,
  type BaseGuildVoiceChannel,
  type DMChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
  type TopLevelComponentData,
  type Webhook,
} from "discord.js";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { createStandardEmbed, type WebhookEmbedContext } from "@/utils/discord/embedHelper";
import { buildNoticeContainer } from "@/utils/discord/ui/statusComponents";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/webhookCore";
import { ColorCode, log } from "@/utils/misc/logger";
import { buildTextPreview } from "@/utils/text/textPreview";

type SupportedChannel =
  | TextChannel
  | NewsChannel
  | DMChannel
  | BaseGuildTextChannel
  | AnyThreadChannel
  | BaseGuildVoiceChannel;

// Default character count above which the "Expand" button is attached. Matches
// the truncation applied by the task embed callers.
const DEFAULT_TRUNCATION_THRESHOLD = 200;
// Shared 24h fallback used when a caller does not provide its own timeout.
const DEFAULT_EXPAND_BUTTON_TIMEOUT_MS = 86_400_000;
const DEFAULT_MEMORY_NOTICE_PREVIEW_LIMIT = 600;

// Per-notice-type collector timeouts, each independently configurable via env.
const MEMORY_EXPAND_BUTTON_TIMEOUT_MS = parsePositiveIntegerEnv(
  process.env.MEMORY_EXPAND_BUTTON_TIMEOUT_MS,
  DEFAULT_EXPAND_BUTTON_TIMEOUT_MS,
);
const TASK_EXPAND_BUTTON_TIMEOUT_MS = parsePositiveIntegerEnv(
  process.env.TASK_EXPAND_BUTTON_TIMEOUT_MS,
  DEFAULT_EXPAND_BUTTON_TIMEOUT_MS,
);

/**
 * Characters of memory content shown inline before the notice truncates and
 * offers the expand button. Deliberately below `MAX_MEMORY_LENGTH` (1000) so
 * the button still has a purpose, and far below Discord's 4000-char text
 * display cap so the title, footer, and framing sentence always fit.
 */
export const MEMORY_NOTICE_PREVIEW_LIMIT = parsePositiveIntegerEnv(
  process.env.MEMORY_NOTICE_PREVIEW_LIMIT,
  DEFAULT_MEMORY_NOTICE_PREVIEW_LIMIT,
);

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-notice configuration for {@link sendEmbedWithExpand}. Each notice type
 * (memory, task, …) supplies its own locale keys and a unique button custom ID.
 */
interface ExpandableNoticeConfig {
  /** Discord component custom ID for the expand button (must be unique per notice type). */
  customId: string;
  /** Locale key for the button label. */
  buttonLabelKey: string;
  /** Locale key for the ephemeral expand-popup embed title. */
  expandTitleKey: string;
  /** Character count above which the button is attached. Defaults to {@link DEFAULT_TRUNCATION_THRESHOLD}. */
  truncationThreshold?: number;
  /** Collector lifetime in ms before the button is disabled. */
  timeoutMs: number;
}

// Mirrors the private helper in embedHelper.ts: webhooks targeting threads
// reference the parent channel, so a thread is only usable when its parent
// matches the webhook channel.
function canUseWebhookForChannel(channel: SupportedChannel, webhook: Webhook): boolean {
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    return channel.parentId === webhook.channelId;
  }
  return webhook.channelId === channel.id;
}

/**
 * Builds the public notice's full Components V2 tree from the old standard
 * embed options. The same function is used for initial sends and disabled
 * button edits so a CV2 notice never falls back to a partial component update.
 *
 * @param locale - Locale used for title, body, footer, and button label strings.
 * @param config - Notice-specific button labels and custom ID.
 * @param includeExpandButton - Whether the visible card needs an Expand action.
 * @param expandButtonDisabled - Whether the Expand button should render disabled.
 * @returns A complete Components V2 notice payload.
 */
function buildNoticeComponents(
  locale: string,
  embedOptions: StandardEmbedOptions,
  config: ExpandableNoticeConfig,
  includeExpandButton: boolean,
  expandButtonDisabled = false,
): TopLevelComponentData[] {
  return buildNoticeContainer({
    locale,
    color: embedOptions.color ?? ColorCode.INFO,
    titleKey: embedOptions.titleKey,
    titleVars: embedOptions.titleVars,
    descriptionKey: embedOptions.descriptionKey,
    description: embedOptions.description,
    descriptionVars: embedOptions.descriptionVars,
    footerKey: embedOptions.footerKey,
    footerVars: embedOptions.footerVars,
    button: includeExpandButton
      ? {
          customId: config.customId,
          labelKey: config.buttonLabelKey,
          style: ButtonStyle.Secondary,
          disabled: expandButtonDisabled,
        }
      : undefined,
  });
}

/**
 * Sends a notification as a Components V2 notice container, attaching an
 * in-card "Expand" button when the full content exceeds the truncation
 * threshold. The button shows the full content as an ephemeral reply when
 * clicked. Callers normally use one of the thin wrappers
 * (`sendMemoryEmbedWithExpand`, `sendTaskEmbedWithExpand`) which pre-fill the
 * notice-specific {@link ExpandableNoticeConfig}.
 *
 * @param channel - Destination channel (supports the same channel types as `sendStandardEmbed`).
 * @param locale - Locale used for the button label, expand-popup title, and embed strings.
 *   The caller is responsible for placing the already-truncated content into `descriptionVars`:
 *   this helper does not modify the embed body.
 * @param fullContent - The full, already-processed content (e.g. post-{user}/{bot} substitution).
 *   Used both to decide whether to show the button and as the body of the ephemeral expand reply.
 * @param config - Notice-specific locale keys, button custom ID, threshold, and collector timeout.
 * @param webhookContext - Optional persona webhook identity, identical to `sendStandardEmbed`.
 */
async function deliverNoticeComponents(
  channel: SupportedChannel,
  components: TopLevelComponentData[],
  webhookContext: WebhookEmbedContext | undefined,
  locale: string,
): Promise<{ message: Message | null; sentViaWebhook: boolean; threadId: string | undefined }> {
  const payload = validateAndFallbackPanelPayload({ components, flags: MessageFlags.IsComponentsV2 as const }, locale);
  // Persona webhooks live on the parent channel and need `threadId` to post
  // into a thread.
  const threadId =
    "isThread" in channel && typeof channel.isThread === "function" && channel.isThread() ? channel.id : undefined;

  // Try webhook-persona delivery first so the notice appears under the same
  // identity as the AI response, then fall back to a plain bot message.
  const webhook = webhookContext?.webhook;
  const useWebhook = Boolean(webhook && webhookContext?.personaUsername && canUseWebhookForChannel(channel, webhook));

  if (useWebhook && webhook && webhookContext) {
    try {
      const message = await sendWebhookMessageWithIdentity(
        webhook,
        {
          ...payload,
          withComponents: true,
          ...(threadId ? { threadId } : {}),
        },
        {
          username: webhookContext.personaUsername,
          avatarUrl: webhookContext.personaAvatarUrl,
          avatarDataUri: webhookContext.personaAvatarUrl?.startsWith("data:image/")
            ? webhookContext.personaAvatarUrl
            : undefined,
        },
      );
      return { message, sentViaWebhook: true, threadId };
    } catch (error) {
      log.warn("CV2 notice: webhook send failed, falling back to plain bot message", error as Error);
    }
  }

  try {
    const message = await channel.send(payload);
    return { message, sentViaWebhook: false, threadId };
  } catch (error) {
    log.warn("CV2 notice: channel send failed", error as Error);
    return { message: null, sentViaWebhook: false, threadId };
  }
}

/**
 * Sends a plain Components V2 notice card with no expand button.
 *
 * Tool notices use this rather than `sendStandardEmbed` because a legacy embed
 * description has no divider primitive, so a footer cannot be separated from the
 * body by anything but blank lines. The CV2 container emits a real `Separator`
 * before `footerKey`.
 */
export async function sendNoticeContainerMessage(
  channel: SupportedChannel,
  locale: string,
  embedOptions: StandardEmbedOptions,
  webhookContext?: WebhookEmbedContext,
): Promise<void> {
  const components = buildNoticeContainer({
    locale,
    color: embedOptions.color ?? ColorCode.INFO,
    titleKey: embedOptions.titleKey,
    titleVars: embedOptions.titleVars,
    descriptionKey: embedOptions.descriptionKey,
    description: embedOptions.description,
    descriptionVars: embedOptions.descriptionVars,
    footerKey: embedOptions.footerKey,
    footerVars: embedOptions.footerVars,
  });
  await deliverNoticeComponents(channel, components, webhookContext, locale);
}

async function sendEmbedWithExpand(
  channel: SupportedChannel,
  locale: string,
  embedOptions: StandardEmbedOptions,
  fullContent: string,
  config: ExpandableNoticeConfig,
  webhookContext?: WebhookEmbedContext,
): Promise<void> {
  const truncationThreshold = config.truncationThreshold ?? DEFAULT_TRUNCATION_THRESHOLD;
  const thresholdPreview = buildTextPreview(fullContent, truncationThreshold);
  const fenceSafeContent = buildTextPreview(fullContent, Number.MAX_SAFE_INTEGER).text;
  const shouldAttachExpandButton = thresholdPreview.truncated;

  // Teardown reuses the complete Components V2 tree with only the button
  // disabled, keeping the message in one rendering mode.
  const activeComponents = buildNoticeComponents(locale, embedOptions, config, shouldAttachExpandButton);
  const disabledComponents = shouldAttachExpandButton
    ? buildNoticeComponents(locale, embedOptions, config, true, true)
    : activeComponents;
  const disabledPayload = validateAndFallbackPanelPayload(
    { components: disabledComponents, flags: MessageFlags.IsComponentsV2 as const },
    locale,
  );

  const {
    message: noticeMessage,
    sentViaWebhook,
    threadId,
  } = await deliverNoticeComponents(channel, activeComponents, webhookContext, locale);
  const webhook = webhookContext?.webhook;

  // Short content was not truncated, so there is no collector to wire.
  if (!noticeMessage || !shouldAttachExpandButton) {
    return;
  }

  // Build the ephemeral "full content" embed once: reused for every click.
  //    Wrap the content in a fenced code block so newlines and any markdown
  //    inside the content are preserved without being interpreted.
  const fullEmbed = createStandardEmbed(locale, {
    color: embedOptions.color ?? ColorCode.INFO,
    titleKey: config.expandTitleKey,
    description: `\`\`\`\n${fenceSafeContent}\n\`\`\``,
  });

  // Wire the button collector. Any non-bot user may click, so the full content
  //    is already shown to everyone in the channel (truncated), so ephemeral
  //    expansion is not a privacy escalation.
  const collector = noticeMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: config.timeoutMs,
    filter: (interaction) => interaction.customId === config.customId && !interaction.user.bot,
  });

  collector.on("collect", async (interaction) => {
    try {
      await interaction.reply({
        embeds: [fullEmbed],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      log.warn("Expand button reply failed", error as Error);
    }
  });

  collector.on("end", async () => {
    if (!noticeMessage) return;
    // Webhook-sent messages can only be edited through the webhook token.
    if (sentViaWebhook && webhook) {
      await webhook
        .editMessage(noticeMessage.id, {
          ...disabledPayload,
          withComponents: true,
          ...(threadId ? { threadId } : {}),
        })
        .catch((err: unknown) =>
          log.warn("[ExpandEmbed] Failed to disable expand button via webhook after collector end", err),
        );
    } else {
      await noticeMessage
        .edit({
          ...disabledPayload,
        })
        .catch((err: unknown) => log.warn("[ExpandEmbed] Failed to disable expand button after collector end", err));
    }
  });
}

/**
 * Memory-learning wrapper for {@link sendEmbedWithExpand}. Attaches a
 * "Show Full Memory" button when the processed memory content exceeds the
 * truncation threshold.
 *
 * @param locale - Locale for button label, expand title, and embed strings.
 * @param fullMemoryContent - Full, processed (post-{user}/{bot}) memory content.
 * @param webhookContext - Optional persona webhook identity.
 */
export async function sendMemoryEmbedWithExpand(
  channel: SupportedChannel,
  locale: string,
  embedOptions: StandardEmbedOptions,
  fullMemoryContent: string,
  webhookContext?: WebhookEmbedContext,
): Promise<void> {
  await sendEmbedWithExpand(
    channel,
    locale,
    embedOptions,
    fullMemoryContent,
    {
      customId: "memory_notice_expand",
      buttonLabelKey: "genai.self_teach.expand_memory_button",
      expandTitleKey: "genai.self_teach.expand_memory_title",
      truncationThreshold: MEMORY_NOTICE_PREVIEW_LIMIT,
      timeoutMs: MEMORY_EXPAND_BUTTON_TIMEOUT_MS,
    },
    webhookContext,
  );
}

/**
 * Scheduled-task wrapper for {@link sendEmbedWithExpand}. Attaches a
 * "Show Full Task" button when the task/reminder purpose exceeds the
 * truncation threshold (created, updated, and deleted task notices).
 *
 * @param locale - Locale for button label, expand title, and embed strings.
 * @param fullReminderPurpose - Full, un-truncated reminder/task purpose.
 * @param webhookContext - Optional persona webhook identity.
 */
export async function sendTaskEmbedWithExpand(
  channel: SupportedChannel,
  locale: string,
  embedOptions: StandardEmbedOptions,
  fullReminderPurpose: string,
  webhookContext?: WebhookEmbedContext,
): Promise<void> {
  await sendEmbedWithExpand(
    channel,
    locale,
    embedOptions,
    fullReminderPurpose,
    {
      customId: "task_notice_expand",
      buttonLabelKey: "reminders.expand_task_button",
      expandTitleKey: "reminders.expand_task_title",
      timeoutMs: TASK_EXPAND_BUTTON_TIMEOUT_MS,
    },
    webhookContext,
  );
}
