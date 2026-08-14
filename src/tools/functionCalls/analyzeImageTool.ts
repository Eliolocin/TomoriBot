/**
 * Vision analysis tool for non-vision chat models.
 * Delegates image analysis to a configured vision model via the same provider's API.
 * Only available when: (1) a vision model is configured AND (2) the active chat model cannot see images.
 */

import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";
import { escapeMarkdown } from "discord.js";
import { BaseTool } from "@/types/tool/interfaces";
import type { ToolContext, ToolResult, ToolParameterSchema } from "@/types/tool/interfaces";
import { log, ColorCode } from "@/utils/misc/logger";
import { sendToolProgressNotice } from "@/utils/discord/toolProgressNotice";
import { MessageIdMap } from "@/utils/text/messageIdMap";
import { llmModelRepo } from "@/utils/db/repositories";
import {
  toZaiApiModelName,
  ZAI_CODING_CHAT_COMPLETIONS_URL,
  ZAI_GENERAL_CHAT_COMPLETIONS_URL,
} from "@/providers/zai/zaiShared";
import { getResolvedCapabilityModelId, resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import { downloadDiscoveredImage, resolveMessageImageUrls } from "@/utils/image/imageExtractor";

/**
 * Provider-to-chat-completions-URL mapping for OpenAI-compatible providers.
 * Google uses its own SDK and is handled separately.
 */
const PROVIDER_CHAT_COMPLETIONS_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  zai: ZAI_GENERAL_CHAT_COMPLETIONS_URL,
  zaicoding: ZAI_CODING_CHAT_COMPLETIONS_URL,
  deepseek: "https://api.deepseek.com/chat/completions",
};

/** Discord message ID pattern (17-19 digit snowflake) */
const DISCORD_ID_PATTERN = /^\d{17,19}$/;

/** Default prompt sent to the vision model when no custom prompt is provided */
const DEFAULT_VISION_PROMPT =
  "Describe what you see in this image in detail. Include any text, objects, people, colors, and notable elements.";

/** Maximum total size of all images in bytes (default: 10 MiB) to avoid API rejections. */
const MAX_TOTAL_IMAGE_BYTES = MEDIA_LIMITS.MAX_MEDIA_SIZE_MB * 1024 * 1024;

/** Maximum wall-clock time for image extraction and vision inference (default: 60 seconds). */
const parsedVisionAnalysisTimeoutMs = Number.parseInt(process.env.VISION_ANALYSIS_TIMEOUT_MS ?? "", 10);
const VISION_ANALYSIS_TIMEOUT_MS =
  Number.isFinite(parsedVisionAnalysisTimeoutMs) && parsedVisionAnalysisTimeoutMs > 0
    ? parsedVisionAnalysisTimeoutMs
    : 60_000;

/**
 * Resolves the model identifier the vision backend will accept.
 *
 * A custom endpoint's `llm_codename` is a locally synthesized label
 * (`custom-s2-gemini-text-google-gemini-3-5-flash-lite`); the id the backend accepts lives on
 * the endpoint row, so sending the codename is rejected as an unknown model. This mirrors the
 * text path's resolution in `customProvider`, which falls back to the codename for backends
 * that ignore the field entirely (KoboldCpp and similar).
 */
export function resolveVisionApiModelName(
  provider: string,
  llmCodename: string,
  customEndpointModelName?: string | null,
): string {
  if (provider === "zai" || provider === "zaicoding") {
    return toZaiApiModelName(llmCodename);
  }

  return customEndpointModelName?.trim() || llmCodename;
}

/**
 * Built-in tool that analyzes images using a dedicated vision model.
 * Allows non-vision chat models (e.g., Z.ai glm-5) to understand images
 * by routing the analysis through a vision-capable model (e.g., Z.ai glm-4.6v).
 */
export class AnalyzeImageTool extends BaseTool {
  name = "analyze_image";
  description =
    "Analyze images in a Discord message using AI vision. Use this only when the user explicitly asks about the image or when unseen visual details are necessary to answer correctly. Do not call it just because an image is present.";
  category = "utility" as const;
  requiresFollowUp = true;

  // Only expose to non-vision models during context building (system prompt tool list).
  // The full vision_llm check happens in isAvailableForContext() at execution time.
  requiredModelCapabilities = { sees_images: false as const };

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      media_id: {
        type: "string",
        description:
          "The media reference ID (e.g., media_1) from the system hint for the message containing the image(s) to analyze.",
      },
      prompt: {
        type: "string",
        description:
          "Optional question or instruction for the vision model (e.g., 'What text is in this image?' or 'Describe the mood of this photo'). Ask only for the specific visual detail needed. If omitted, a general description is returned.",
      },
    },
    required: ["media_id"],
  };

  /**
   * Basic provider check: available for all providers.
   * The real gating logic is in isAvailableForContext().
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Context-aware availability check.
   * Only expose this tool when:
   * - A vision model is configured (tomoriState.vision_llm exists)
   * - The active chat model does NOT support images (sees_images = false)
   */
  isAvailableForContext(_provider: string, context: ToolContext): boolean {
    const hasVisionModel = !!context.tomoriState?.vision_llm;
    const chatModelSeesImages = context.tomoriState?.llm?.sees_images ?? false;

    // Only available when vision model is set AND chat model can't see images
    return hasVisionModel && !chatModelSeesImages;
  }

  /**
   * Execute the image analysis.
   * 1. Validate parameters and context
   * 2. Extract images from the Discord message
   * 3. Decrypt the API key
   * 4. Route the images to the vision model's API
   * 5. Return the analysis result
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawMediaId = args.media_id as string;
    const messageId = MessageIdMap.isOpaqueKey(rawMediaId) ? context.messageIdMap?.resolve(rawMediaId) : rawMediaId;
    const prompt = (args.prompt as string) || DEFAULT_VISION_PROMPT;

    if (!rawMediaId || (!DISCORD_ID_PATTERN.test(rawMediaId) && !MessageIdMap.isOpaqueKey(rawMediaId))) {
      return {
        success: false,
        error: `Invalid media_id: "${rawMediaId}". Expected a media reference ID (for example media_1) or Discord message ID.`,
      };
    }

    if (!messageId || !DISCORD_ID_PATTERN.test(messageId)) {
      return {
        success: false,
        error: `Unknown media_id: "${rawMediaId}".`,
      };
    }

    const timeoutSignal = AbortSignal.timeout(VISION_ANALYSIS_TIMEOUT_MS);
    const analysisSignal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeoutSignal]) : timeoutSignal;

    try {
      const creds = await resolveCapabilityCredentials(context.tomoriState.server_id, "vision", {
        userId: context.internalUserId ?? null,
      });
      const visionLlmId = getResolvedCapabilityModelId(creds, "vision") ?? context.tomoriState.config.vision_llm_id;
      const visionLlm =
        visionLlmId === context.tomoriState.vision_llm?.llm_id
          ? context.tomoriState.vision_llm
          : visionLlmId
            ? await llmModelRepo.loadById(visionLlmId)
            : null;

      if (!visionLlm) {
        return {
          success: false,
          error: "No vision model configured. Use /model vision to set one.",
        };
      }

      const provider = visionLlm.llm_provider.toLowerCase();
      const apiModelName = resolveVisionApiModelName(
        provider,
        visionLlm.llm_codename,
        creds.customEndpoint?.model_name,
      );

      await sendToolProgressNotice(
        context,
        "image_analysis",
        {
          titleKey: "tools.vision.analyzing_title",
          descriptionKey: "tools.vision.analyzing_description",
          descriptionVars: {
            model: escapeMarkdown(apiModelName),
          },
          footerKey: "tools.vision.analyzing_footer",
          color: ColorCode.INFO,
        },
        "AnalyzeImageTool",
      );

      // Extract images from the Discord message
      const images = await this.extractImagesFromMessage(messageId, context, analysisSignal);

      const apiKey = creds.apiKey;

      let analysisResult: string;

      if (provider === "google") {
        analysisResult = await this.callGoogleVision(apiKey, apiModelName, images, prompt, analysisSignal);
      } else {
        // OpenAI-compatible providers (openrouter, zai, zaicoding, deepseek, custom)
        const endpointUrl = this.getEndpointUrl(provider, context, creds.customEndpoint?.endpoint_url ?? null);
        analysisResult = await this.callOpenAICompatibleVision(
          apiKey,
          apiModelName,
          endpointUrl,
          images,
          prompt,
          analysisSignal,
        );
      }

      log.info(`Vision analysis completed: ${images.length} image(s) analyzed via ${provider}/${apiModelName}`);

      return {
        success: true,
        data: analysisResult,
        message: analysisResult,
      };
    } catch (error) {
      const timedOut = timeoutSignal.aborted && !context.abortSignal?.aborted;
      const errorMessage = timedOut
        ? `Image analysis timed out after ${VISION_ANALYSIS_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      log.error(`Vision analysis failed for message ${messageId}:`, error as Error);
      return {
        success: false,
        error: `Image analysis failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Resolve the chat completions endpoint URL for a given provider.
   * Uses the static map for known providers, falls back to custom endpoint.
   * @param context - Tool context (for custom endpoint URL)
   * @returns Chat completions URL
   */
  private getEndpointUrl(provider: string, context: ToolContext, customEndpointUrl?: string | null): string {
    const knownUrl = PROVIDER_CHAT_COMPLETIONS_URLS[provider];
    if (knownUrl) return knownUrl;

    const customUrl = customEndpointUrl ?? context.tomoriState.config.custom_endpoint_url;
    if (customUrl) {
      return customUrl.endsWith("/chat/completions") ? customUrl : `${customUrl}/chat/completions`;
    }

    // Fallback: OpenAI default
    return "https://api.openai.com/v1/chat/completions";
  }

  /**
   * Call an OpenAI-compatible vision API (Z.ai, OpenRouter, DeepSeek, Custom).
   * Sends images as base64-encoded data URLs in the content array.
   * @param images - Array of base64-encoded image data
   * @param signal - Combined turn-cancellation and vision-analysis timeout signal
   */
  private async callOpenAICompatibleVision(
    apiKey: string,
    model: string,
    endpointUrl: string,
    images: Array<{ mimeType: string; data: string }>,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const contentParts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

    for (const image of images) {
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.data}`,
        },
      });
    }

    const requestBody = {
      model,
      messages: [
        {
          role: "user",
          content: contentParts,
        },
      ],
      max_tokens: 1024,
    };

    const response = await fetchUserRemoteUrl(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Vision API returned ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Vision API returned an empty response. The model may not support image inputs.");
    }

    return content;
  }

  /**
   * Call Google GenAI vision API using the official SDK.
   * @param model - Model name (e.g., "gemini-2.0-flash")
   * @param images - Array of base64-encoded image data
   * @param signal - Combined turn-cancellation and vision-analysis timeout signal
   */
  private async callGoogleVision(
    apiKey: string,
    model: string,
    images: Array<{ mimeType: string; data: string }>,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const genAI = new GoogleGenAI({ apiKey });

    const parts: Part[] = [{ text: prompt }];
    for (const image of images) {
      parts.push({
        inlineData: {
          data: image.data,
          mimeType: image.mimeType,
        },
      });
    }

    const result = await genAI.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { abortSignal: signal },
    });

    const text = result.text;
    if (!text) {
      throw new Error("Google Vision API returned an empty response.");
    }

    return text;
  }

  /**
   * Extract images from a Discord message and convert to base64 format.
   *
   * Discovery is delegated to the shared {@link resolveMessageImageUrls} helper,
   * which scans attachments, embeds, stickers, custom emojis, Components V2 media,
   * and the direct reply target when needed. The download loop below stays local
   * because vision payloads enforce a cumulative byte budget and skip re-optimization.
   * @param context - Tool execution context with channel access
   * @param signal - Combined turn-cancellation and vision-analysis timeout signal
   * @returns Array of objects with mimeType and base64 data
   */
  private async extractImagesFromMessage(
    messageId: string,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<Array<{ mimeType: string; data: string }>> {
    // Discover images on the message, or on its direct reply target when the
    //    reply itself is text-only.
    const { imageUrls, sourceMessageId } = await resolveMessageImageUrls(messageId, context);

    log.info(`Found ${imageUrls.length} image(s) in message ${sourceMessageId} for vision analysis`);

    const inlineDataArray: Array<{ mimeType: string; data: string }> = [];
    let totalBytes = 0;

    for (const imageInfo of imageUrls) {
      try {
        const imageResponse = await downloadDiscoveredImage(imageInfo, {
          maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
          timeoutMs: 15_000,
          externalSignal: signal,
        });
        if (!imageResponse.success || !imageResponse.buffer) {
          log.warn(`Failed to fetch image from ${imageInfo.source}: ${imageResponse.details ?? imageResponse.error}`);
          continue;
        }

        const imageBuffer = imageResponse.buffer;

        if (totalBytes + imageBuffer.byteLength > MAX_TOTAL_IMAGE_BYTES) {
          log.warn(`Skipping image from ${imageInfo.source}: would exceed ${MAX_TOTAL_IMAGE_BYTES} byte limit`);
          continue;
        }

        totalBytes += imageBuffer.byteLength;
        const base64Data = imageBuffer.toString("base64");

        inlineDataArray.push({
          mimeType: imageInfo.mimeType,
          data: base64Data,
        });

        log.info(`Fetched image from ${imageInfo.source} (${imageBuffer.byteLength} bytes)`);
      } catch (imgErr) {
        log.warn(`Failed to process image from ${imageInfo.source}:`, imgErr as Error);
      }
    }

    if (inlineDataArray.length === 0) {
      throw new Error(`Failed to process any images from message ${sourceMessageId}`);
    }

    return inlineDataArray;
  }
}
