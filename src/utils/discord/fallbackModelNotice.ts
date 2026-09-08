import type { Message, Webhook } from "discord.js";
import type { LlmRow } from "@/types/db/schema";
import type { ToolContext } from "@/types/tool/interfaces";
import { truncateForEmbedDescription } from "@/utils/discord/embedHelper";
import { attachTextDisplayModalCollector, buildTextDisplayModalButton } from "@/utils/discord/textDisplayModal";
import { isNoticeEmbedVisible, routeHiddenToolNotice } from "@/utils/discord/toolProgressNotice";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import { resolveManagedChannelWebhook } from "@/utils/discord/webhook/webhookCore";
import { getChannelDeliveredWebhookIdentity } from "@/utils/discord/stream/channelDeliveryContinuity";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const FALLBACK_DETAILS_BUTTON_ID = "fallback_notice_details";
const DEFAULT_FALLBACK_NOTICE_BUTTON_TIMEOUT_MS = 86_400_000;
const FALLBACK_NOTICE_BUTTON_TIMEOUT_MS = parsePositiveIntegerEnv(
  process.env.FALLBACK_NOTICE_BUTTON_TIMEOUT_MS,
  DEFAULT_FALLBACK_NOTICE_BUTTON_TIMEOUT_MS,
);

export interface FallbackNoticeAttempt {
  modelCodename: string;
  errorDetail: string;
}

interface SendFallbackModelUsageNoticeOptions {
  context: ToolContext;
  failures: FallbackNoticeAttempt[];
  successModel: LlmRow;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Characters reserved for the description text wrapping the failure list (slot/model prefix line),
// so the joined list plus that prefix stays within Discord's embed description limit.
const FAILURE_LIST_DESCRIPTION_RESERVE = 256;

function buildFailureList(locale: string, failures: FallbackNoticeAttempt[]): string {
  const failureList = failures
    .map((failure, index) =>
      localizer(locale, "genai.fallback_used_failure_line", {
        index: index + 1,
        model: `\`${failure.modelCodename}\``,
        error_detail: failure.errorDetail,
      }),
    )
    .join("\n");

  // Cap the combined list to Discord's embed description limit; verbose provider messages across
  // several fallback failures can otherwise overflow the embed.
  return truncateForEmbedDescription(failureList, FAILURE_LIST_DESCRIPTION_RESERVE);
}

function resolveFallbackSlot(context: ToolContext, successModel: LlmRow, failures: FallbackNoticeAttempt[]): number {
  const configuredChainIndex = context.tomoriState.fallback_chain?.findIndex((entry) =>
    entry.kind === "llm"
      ? entry.model.llm_id === successModel.llm_id
      : entry.endpoint.model_ref_id === successModel.llm_id,
  );
  if (configuredChainIndex !== undefined && configuredChainIndex >= 0) {
    return configuredChainIndex + 1;
  }

  const configuredFallbackIndex =
    context.tomoriState.fallback_llms?.findIndex((llm) => llm.llm_id === successModel.llm_id) ?? -1;

  if (configuredFallbackIndex >= 0) {
    return configuredFallbackIndex + 1;
  }

  return Math.max(1, failures.length);
}

export async function sendFallbackModelUsageNotice({
  context,
  failures,
  successModel,
}: SendFallbackModelUsageNoticeOptions): Promise<void> {
  const slot = resolveFallbackSlot(context, successModel, failures);
  const detailsOptions = {
    titleKey: "genai.fallback_used_title",
    descriptionKey: "genai.fallback_used_details_description",
    descriptionVars: {
      slot,
      success_model: successModel.llm_codename,
      failure_list: buildFailureList(context.locale, failures),
    },
    color: ColorCode.INFO,
  } as const;

  if (!isNoticeEmbedVisible(context.tomoriState.config, "fallback_model_usage")) {
    await routeHiddenToolNotice(context, detailsOptions, "Fallback model usage notice");
    return;
  }

  const modalTitle = localizer(context.locale, detailsOptions.titleKey);
  const modalContent = `${localizer(
    context.locale,
    detailsOptions.descriptionKey,
    detailsOptions.descriptionVars,
  )}\n\n-# ${localizer(context.locale, "genai.fallback_used_hide_footer")}`;

  try {
    const buttonLabel = localizer(context.locale, "genai.fallback_used_details_button");
    const buttonRow = buildTextDisplayModalButton(FALLBACK_DETAILS_BUTTON_ID, buttonLabel);
    const disabledButtonRow = buildTextDisplayModalButton(FALLBACK_DETAILS_BUTTON_ID, buttonLabel, true);

    // Resolve thread ID: webhooks targeting a parent channel need it to post into a thread.
    const threadId =
      "isThread" in context.channel && typeof context.channel.isThread === "function" && context.channel.isThread()
        ? context.channel.id
        : undefined;

    let noticeMessage: Message;

    // Post as whoever actually delivered the last message so the button groups with it rather
    // than splitting off under a different author. The recorded username is reused verbatim:
    // it may be the decorated `Persona (sprite)` form chosen by the group-break alternation,
    // and rebuilding the persona's default identity here would produce a different name and
    // cause the split. A null identity means the last delivery was an ordinary bot message, so
    // the notice goes out as the bot too.
    // The main persona has no pre-resolved `context.webhook` (it normally replies as the bot),
    // so when a sprite put it on the webhook path the webhook is resolved lazily here: the
    // lookup is cached, so this costs nothing on the common path.
    const deliveredIdentity = getChannelDeliveredWebhookIdentity(context.channel.id);
    const noticeWebhook: Webhook | undefined = deliveredIdentity
      ? (context.webhook ?? (await resolveManagedChannelWebhook(context.channel)) ?? undefined)
      : undefined;

    if (deliveredIdentity && noticeWebhook) {
      noticeMessage = await sendWebhookMessageWithIdentity(
        noticeWebhook,
        {
          components: [buttonRow],
          ...(threadId ? { threadId } : {}),
        },
        deliveredIdentity,
        threadId ?? noticeWebhook.channelId ?? noticeWebhook.id,
      );
    } else {
      noticeMessage = await context.channel.send({ components: [buttonRow] });
    }

    attachTextDisplayModalCollector({
      message: noticeMessage,
      customId: FALLBACK_DETAILS_BUTTON_ID,
      title: modalTitle,
      content: modalContent,
      timeoutMs: FALLBACK_NOTICE_BUTTON_TIMEOUT_MS,
      logLabel: "Fallback model details",
      onExpire: async () => {
        if (deliveredIdentity && noticeWebhook) {
          await noticeWebhook.editMessage(noticeMessage.id, {
            components: [disabledButtonRow],
            ...(threadId ? { threadId } : {}),
          });
          return;
        }
        await noticeMessage.edit({ components: [disabledButtonRow] });
      },
    });
  } catch (error) {
    log.warn("Failed to send compact fallback model notice", error as Error);
  }
}
