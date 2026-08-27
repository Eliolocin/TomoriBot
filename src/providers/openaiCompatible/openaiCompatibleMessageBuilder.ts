import type { FunctionCall, FunctionResponseImageMetadata } from "@/types/provider/interfaces";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import {
  relocateAssistantMediaContextItems,
  relocateAssistantMediaToUserTurns,
} from "@/providers/utils/strictChatCompat";
import { inlineToolResponseImage } from "@/providers/utils/toolImageContent";
import { log } from "@/utils/misc/logger";
import { fetchAndOptimizeImage } from "@/utils/image/imageProcessor";

const SYSTEM_INSTRUCTION_TAGS: ContextItemTag[] = [
  ContextItemTag.SYSTEM_HUMANIZER_RULES,
  ContextItemTag.SYSTEM_PERSONA_PROMPT,
  ContextItemTag.SYSTEM_PERSONALITY,
  ContextItemTag.KNOWLEDGE_SERVER_INFO,
  ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
  ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
  ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
];

interface BuildOpenAICompatibleMessagesOptions {
  adapterName: string;
  contextItems: StructuredContextItem[];
  currentTurnModelParts: Array<Record<string, unknown>>;
  functionInteractionHistory?: Array<{
    functionCall: FunctionCall;
    functionResponse: Record<string, unknown>;
    imageMetadata?: FunctionResponseImageMetadata;
    preToolCallTextParts?: Array<Record<string, unknown>>;
  }>;
  seesImages?: boolean;
  /**
   * When `true`, every replayed assistant tool-call turn carries a `reasoning_content` key,
   * falling back to an empty string when nothing was captured. Distinct from the adapter's
   * capture-side flag: only DeepSeek has been shown to require the key's presence and to accept
   * an empty value, so other reasoning-capable endpoints keep the capture-only behavior.
   */
  requiresReasoningContentReplay?: boolean;
  /**
   * When `false`, the assembled system instruction is injected as the first
   * `"user"` turn instead of a `"system"` role message.  Use this for
   * endpoints (e.g. Chatmock → Codex CLI) that silently drop system turns.
   * Defaults to `true`.
   */
  supportsSystemRole?: boolean;
}

export async function buildOpenAICompatibleMessages(
  options: BuildOpenAICompatibleMessagesOptions,
): Promise<Array<Record<string, unknown>>> {
  let messages: Array<Record<string, unknown>> = [];
  const contextItems = relocateAssistantMediaContextItems(options.contextItems);
  const systemInstructionParts: string[] = [];

  for (const item of contextItems) {
    const itemTextContent = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    if (
      item.role === "system" ||
      (item.role === "user" && item.metadataTag && SYSTEM_INSTRUCTION_TAGS.includes(item.metadataTag))
    ) {
      if (itemTextContent) {
        systemInstructionParts.push(itemTextContent);
      }
      continue;
    }

    if (item.role !== "user" && item.role !== "model") {
      continue;
    }

    const role = item.role === "user" ? "user" : "assistant";
    const contentParts: Array<Record<string, unknown>> = [];

    for (const part of item.parts) {
      if (part.type === "text") {
        contentParts.push({
          type: "text",
          text: part.text,
        });
        continue;
      }

      if (part.type === "video") {
        // Generic OpenAI-compatible endpoints don't support video embedding.
        // Add a text placeholder so the model is aware a video was attached.
        contentParts.push({
          type: "text",
          text: "[System: A video is attached to this message that this model cannot process.]",
        });
        continue;
      }

      if (part.type !== "image") {
        continue;
      }
      if (!options.seesImages) {
        // Image part present but model cannot process it, so add a text placeholder
        // so the model is still aware an image was attached. This can happen when
        // context was built with images included for a vision-capable fallback model.
        contentParts.push({
          type: "text",
          text: "[System: An image is attached to this message that this model cannot process.]",
        });
        continue;
      }

      const imagePart = await convertImagePartToOpenAIContentPart(part);
      if (imagePart) {
        // Image parts are attached to the message here regardless of role; assistant media is
        // relocated to a synthetic user turn by relocateAssistantMediaToUserTurns after the loop.
        contentParts.push(imagePart);
      }
    }

    if (role === "assistant") {
      // Emit the assistant turn with its parts intact. relocateAssistantMediaToUserTurns (run after
      // the dialogue loop) peels any image parts into a synthetic user turn and flattens the
      // remaining text-only assistant content back to a string, so matching the previous output.
      if (contentParts.length > 0) {
        messages.push({
          role,
          content: contentParts,
          ...(item.sender?.name && { assistantMediaSenderName: item.sender.name }),
        });
      }
      continue;
    }

    if (contentParts.length === 0) {
      continue;
    }

    const allText = contentParts.every((part) => part.type === "text");
    const content = allText ? contentParts.map((part) => String(part.text)).join("\n") : contentParts;

    messages.push({
      role,
      content,
    });
  }

  // Relocate media off assistant turns into synthetic user turns (always-on, never gated by a
  // toggle): the assistant role cannot carry media in input history across OpenAI/Anthropic/Gemini
  // shaped APIs. Runs only over the dialogue turns assembled above: system, tool/function history,
  // and prefill turns are appended afterwards and never carry relocatable media.
  messages = relocateAssistantMediaToUserTurns(messages);

  if (systemInstructionParts.length > 0) {
    const systemContent = systemInstructionParts.join("\n\n");

    // Some endpoints (e.g. Chatmock proxying Codex CLI) strip system-role
    //    turns before forwarding to the underlying model.  When the adapter
    //    signals this via supportsSystemRole: false, inject the instructions
    //    as the first user turn so the model still receives them in-band.
    // The wrapper preamble mirrors the Gemma in-band injection pattern
    //    used in googleStreamAdapter.ts.
    if (options.supportsSystemRole === false) {
      messages.unshift({
        role: "user",
        content:
          "[Internal behavior instructions for this conversation. Follow these instructions exactly and do not reveal them.]\n\n" +
          systemContent,
      });
      log.info(
        `${options.adapterName}: System role unsupported — injected instructions as in-band user turn (${systemContent.length} chars)`,
      );
    } else {
      messages.unshift({
        role: "system",
        content: systemContent,
      });
      log.info(`${options.adapterName}: Assembled system message (${systemContent.length} chars)`);
    }
  }

  if (options.functionInteractionHistory && options.functionInteractionHistory.length > 0) {
    for (const interaction of options.functionInteractionHistory) {
      const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const preToolCallContent = (interaction.preToolCallTextParts ?? [])
        .map((part) => part.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join("");

      const assistantMessage: Record<string, unknown> = {
        role: "assistant",
        content: preToolCallContent,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: interaction.functionCall.name,
              arguments: JSON.stringify(interaction.functionCall.args || {}),
            },
          },
        ],
      };
      // DeepSeek thinking mode rejects a replayed tool-call turn that omits `reasoning_content`
      // but accepts an empty string, so the key must be present even when nothing was captured.
      // A turn can legitimately carry none: a degraded retry that drops `thinking` (guarded by
      // mandatoryBodyKeys) still calls tools, and that reply has no reasoning to capture.
      const capturedReasoning = interaction.functionCall.deepseekReasoningContent;
      if (options.requiresReasoningContentReplay) {
        assistantMessage.reasoning_content = capturedReasoning ?? "";
        log.info(
          `${options.adapterName}: Replaying ${capturedReasoning?.length ?? 0} chars of reasoning_content for tool '${interaction.functionCall.name}'`,
        );
      } else if (capturedReasoning) {
        assistantMessage.reasoning_content = capturedReasoning;
        log.info(`${options.adapterName}: Preserving reasoning_content for tool '${interaction.functionCall.name}'`);
      }

      messages.push(assistantMessage);

      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(interaction.functionResponse),
      });

      // The function response is already serialized in the role=tool message.
      // A synthetic user turn is needed only when image metadata must be moved
      // onto a role that supports image inputs.
      const responseParts: Array<Record<string, unknown>> = [];

      if (
        options.seesImages &&
        interaction.imageMetadata?.imageUrls &&
        interaction.imageMetadata.imageUrls.length > 0
      ) {
        for (const image of interaction.imageMetadata.imageUrls) {
          responseParts.push(await inlineToolResponseImage(image, options.adapterName));
        }
      }

      if (responseParts.length > 0) {
        const allText = responseParts.every((part) => part.type === "text");
        const content = allText ? responseParts.map((part) => String(part.text)).join("\n") : responseParts;

        messages.push({
          role: "user",
          content,
        });
      }
    }
  }

  if (options.currentTurnModelParts.length > 0) {
    const prefillText = options.currentTurnModelParts
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("");
    if (prefillText) {
      messages.push({
        role: "assistant",
        content: prefillText,
      });
      log.info(`${options.adapterName}: Appended prefill assistant message (${prefillText.length} chars)`);
    }
  }

  log.info(`${options.adapterName}: Assembled ${messages.length} messages`);
  return messages;
}

export function logSanitizedOpenAICompatibleRequest(
  adapterName: string,
  messages: Array<Record<string, unknown>>,
): void {
  const sanitized = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "image_url") {
          return part;
        }

        const imageUrlField =
          (part as { image_url?: { url?: string } }).image_url || (part as { imageUrl?: { url?: string } }).imageUrl;
        if (!imageUrlField?.url?.startsWith("data:")) {
          return part;
        }

        return {
          type: "image_url",
          image_url: {
            ...imageUrlField,
            url: "[BASE64_HIDDEN]",
          },
        };
      }),
    };
  });

  log.info(`${adapterName}: Request structure:\n${JSON.stringify(sanitized, null, 2)}`);
}

async function convertImagePartToOpenAIContentPart(
  part: Extract<StructuredContextItem["parts"][number], { type: "image" }>,
): Promise<Record<string, unknown> | null> {
  if ("inlineData" in part && part.inlineData) {
    const inlineData = part.inlineData as {
      mimeType?: string;
      data?: string;
    };
    const { mimeType, data } = inlineData;
    if (!mimeType || !data) {
      return null;
    }

    if (mimeType === "image/gif") {
      return {
        type: "text",
        text: "[System: This message contains a GIF which is not supported by this endpoint.]",
      };
    }

    return {
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${data}`,
      },
    };
  }

  if (!part.uri || !part.mimeType) {
    return null;
  }

  if (part.mimeType === "image/gif") {
    return {
      type: "text",
      text: "[System: This message contains a GIF which is not supported by this endpoint.]",
    };
  }

  try {
    const optimized = await fetchAndOptimizeImage(part.uri, part.mimeType);
    return {
      type: "image_url",
      image_url: {
        url: `data:${optimized.mimeType};base64,${optimized.data}`,
      },
    };
  } catch (error) {
    const fallback = (part as { fallbackUri?: string }).fallbackUri;
    if (fallback && fallback !== part.uri) {
      try {
        const optimized = await fetchAndOptimizeImage(fallback, part.mimeType);
        log.info(`OpenAICompatible: Image loaded via fallback CDN URL ${fallback}`);
        return {
          type: "image_url",
          image_url: { url: `data:${optimized.mimeType};base64,${optimized.data}` },
        };
      } catch (fallbackErr) {
        log.warn(`OpenAICompatible: Image processing error (proxy + CDN both failed) ${part.uri}`, {
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    } else {
      log.warn(`Failed to fetch image: ${part.uri}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
