/**
 * Image Generation Tool
 * Allows TomoriBot to generate images using the active provider's native image API
 * Supports text-to-image, and image-to-image only when the active provider supports it
 */

import { AttachmentBuilder } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { log, ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { resolveAvatarByIdentity, type ResolvedAvatarData } from "@/utils/discord/avatarResolver";
import { buildGeneratedImageComponentsV2Payload } from "@/utils/discord/generatedImageMessage";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import {
  buildImageToolNoticeDescription,
  buildReferencedMessageUrl,
  sendToolProgressNotice,
} from "@/utils/discord/toolProgressNotice";
import {
  BaseTool,
  type Tool,
  type ToolAssemblyContext,
  type ToolContext,
  type ToolParameterSchema,
  type ToolResult,
} from "../../types/tool/interfaces";
import { createToolVariant } from "@/tools/assembly";
import {
  resolveImageToolCapabilities,
  type ImageToolCapabilities,
} from "@/tools/functionCalls/generateImageToolCapabilities";
import { checkImageQuota, incrementImageQuota, type QuotaCheckResult } from "../../utils/quota/imageQuotaManager";
import { statRepository } from "@/utils/db/repositories";
import { resolveProviderFeatureImplementation } from "@/utils/provider/providerInfoRegistry";
import { resolveNativeImageGenerationCapability } from "@/utils/provider/providerCapabilityResolver";
import { generateCustomImageViaEndpoint } from "@/providers/custom/customEndpointDispatcher";
import { generateOpenRouterImage } from "@/providers/openrouter/openrouterImageGeneration";
import { ZAI_CODING_IMAGES_GENERATIONS_URL, ZAI_GENERAL_IMAGES_GENERATIONS_URL } from "@/providers/zai/zaiShared";
import { getResolvedCapabilityModelId, resolveCapabilityCredentials } from "@/utils/provider/credentialResolver";
import { formatCustomEndpointModelDisplay } from "@/utils/provider/customProviderUtils";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import { llmModelRepo } from "@/utils/db/repositories/LlmModelRepository";
import { MessageIdMap } from "@/utils/text/messageIdMap";
import type { ProviderNativeImageGenerationResult } from "@/types/provider/featureInterfaces";
import { optimizeImageBuffer } from "@/utils/image/imageProcessor";
import type { CustomEndpointRow } from "@/types/db/schema";
import { readImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";
import { extractImagesFromMessage } from "@/utils/image/imageExtractor";

const IMAGE_REFERENCE_MAX_COUNT = Number.parseInt(process.env.IMAGE_REFERENCE_MAX_COUNT ?? "3", 10);
const IMAGE_REFERENCE_MAX_TOTAL_BYTES = Number.parseInt(process.env.IMAGE_REFERENCE_MAX_TOTAL_BYTES ?? "6291456", 10);
const IMAGE_REFERENCE_TINY_MAX_BYTES = Number.parseInt(process.env.IMAGE_REFERENCE_TINY_MAX_BYTES ?? "950000", 10);
const IMAGE_REFERENCE_MAX_SINGLE_BYTES = Number.parseInt(process.env.IMAGE_REFERENCE_MAX_SINGLE_BYTES ?? "2097152", 10);

type ImageReference = {
  mimeType: string;
  data: string;
  sourceType?: "message" | "avatar";
};

const IMAGE_TO_IMAGE_PARAMETER_NAMES = ["media_id", "target_identity", "denoise"] as const;
const INPAINT_PARAMETER_NAMES = [
  "inpaint",
  "mask_prompt",
  "clothing_segment_categories",
  "clothing_mode",
  "mask_threshold",
  "mask_grow",
  "mask_feather",
  "cfg",
  "mask_mode",
  "inpaint_preset",
  "inpaint_mode",
] as const;
const OUTPAINT_PARAMETER_NAMES = [
  "outpaint",
  "outpaint_strategy",
  "outpaint_amount",
  "outpaint_left_prompt",
  "outpaint_right_prompt",
  "outpaint_top_prompt",
  "outpaint_bottom_prompt",
  "extend_direction",
  "extend_pixels",
  "outpaint_overlap",
  "outpaint_zoom_scale",
] as const;

function getSupportedImageModeLabels(capabilities: ImageToolCapabilities): string[] {
  const labels = [];
  if (capabilities.textToImage) labels.push("text-to-image");
  if (capabilities.imageToImage) labels.push("image-to-image");
  if (capabilities.inpaint) labels.push("inpainting");
  if (capabilities.outpaint) labels.push("outpainting");
  return labels;
}

function buildImageToolDescription(capabilities: ImageToolCapabilities): string {
  const modeList = getSupportedImageModeLabels(capabilities).join(", ");
  const negativePromptNote = capabilities.negativePrompt
    ? " Default negative image tags are sent through the backend negative-prompt channel."
    : " This backend has no declared negative-prompt channel, so default negative image tags are not sent.";
  return `Generate images using the active image backend (${capabilities.sourceLabel}). This schema only exposes supported modes for the configured backend: ${modeList}.${negativePromptNote} Sends the result directly to Discord.`;
}

/**
 * Join mode labels into a human-readable list ("a", "a or b", "a, b, or c").
 * Keeps capability-specific parameter guidance limited to supported modes.
 * @returns Comma/"or"-joined list, or empty string when no modes are supported
 */
function formatModeList(modes: string[]): string {
  if (modes.length <= 1) {
    return modes[0] ?? "";
  }
  if (modes.length === 2) {
    return `${modes[0]} or ${modes[1]}`;
  }
  return `${modes.slice(0, -1).join(", ")}, or ${modes[modes.length - 1]}`;
}

/**
 * Build the `prompt` description, appending edit-mode guidance only for modes
 * the active backend supports. Prevents inpaint/outpaint instructions from
 * leaking into backends (e.g. text-to-image-only) that cannot perform them.
 * @param capabilities - Resolved backend capabilities
 * @returns Capability-trimmed prompt description
 */
function buildImagePromptDescription(capabilities: ImageToolCapabilities): string {
  let description =
    "Describe the desired image. Include relevant Physical Appearance context for known users/personas.";
  // Only mention inpaint guidance when the backend can inpaint
  if (capabilities.inpaint) {
    description += " For inpaint, describe only the local replacement.";
  }
  // Only mention outpaint guidance when the backend can outpaint
  if (capabilities.outpaint) {
    description += " For outpaint, describe what should continue into the new canvas.";
  }
  return description;
}

/**
 * Build the `media_id` description, listing only the reference-consuming modes
 * the active backend supports (img2img, inpaint, outpaint).
 * @param capabilities - Resolved backend capabilities
 * @returns Capability-trimmed media_id description
 */
function buildImageMediaIdDescription(capabilities: ImageToolCapabilities): string {
  const referenceModes: string[] = [];
  if (capabilities.imageToImage) referenceModes.push("img2img");
  if (capabilities.inpaint) referenceModes.push("inpaint");
  if (capabilities.outpaint) referenceModes.push("outpaint");
  const modeList = formatModeList(referenceModes);
  return modeList ? `Reference media ID such as media_1. Use for ${modeList}.` : "Reference media ID such as media_1.";
}

/**
 * Build the `denoise` description, naming only the strength-controlled modes
 * the active backend supports. Outpaint runs through the inpaint path, so it is
 * folded into the inpaint label.
 * @param capabilities - Resolved backend capabilities
 * @returns Capability-trimmed denoise description
 */
function buildImageDenoiseDescription(capabilities: ImageToolCapabilities): string {
  const strengthModes: string[] = [];
  if (capabilities.imageToImage) strengthModes.push("img2img");
  if (capabilities.inpaint || capabilities.outpaint) strengthModes.push("inpaint");
  const label = strengthModes.join("/") || "img2img";
  const capitalized = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  return `${capitalized} strength from 0 to 1. Lower preserves more.`;
}

/**
 * Resolve a capability-aware description override for parameters whose static
 * text references modes that may be unsupported by the active backend.
 * @param parameterName - Schema property name
 * @param capabilities - Resolved backend capabilities
 * @returns Override description, or null to keep the static description as-is
 */
function resolveImageParameterDescription(parameterName: string, capabilities: ImageToolCapabilities): string | null {
  switch (parameterName) {
    case "prompt":
      return buildImagePromptDescription(capabilities);
    case "media_id":
      return buildImageMediaIdDescription(capabilities);
    case "denoise":
      return buildImageDenoiseDescription(capabilities);
    default:
      return null;
  }
}

function includeImageParameter(parameterName: string, capabilities: ImageToolCapabilities): boolean {
  if (parameterName === "prompt" || parameterName === "aspect_ratio") {
    return true;
  }

  if (IMAGE_TO_IMAGE_PARAMETER_NAMES.includes(parameterName as (typeof IMAGE_TO_IMAGE_PARAMETER_NAMES)[number])) {
    return capabilities.imageToImage || capabilities.inpaint || capabilities.outpaint;
  }

  if (INPAINT_PARAMETER_NAMES.includes(parameterName as (typeof INPAINT_PARAMETER_NAMES)[number])) {
    return capabilities.inpaint || capabilities.outpaint;
  }

  if (OUTPAINT_PARAMETER_NAMES.includes(parameterName as (typeof OUTPAINT_PARAMETER_NAMES)[number])) {
    return capabilities.outpaint;
  }

  return false;
}

function buildImageToolParameters(tool: Tool, capabilities: ImageToolCapabilities): ToolParameterSchema {
  const properties: ToolParameterSchema["properties"] = {};

  for (const [parameterName, parameterSchema] of Object.entries(tool.parameters.properties)) {
    if (!includeImageParameter(parameterName, capabilities)) {
      continue;
    }

    // Override descriptions that reference unsupported modes; clone the schema so
    // the shared static class definition is never mutated in place.
    const overriddenDescription = resolveImageParameterDescription(parameterName, capabilities);
    properties[parameterName] = overriddenDescription
      ? { ...parameterSchema, description: overriddenDescription }
      : parameterSchema;
  }

  return {
    ...tool.parameters,
    properties,
    required: tool.parameters.required.filter((parameterName) => parameterName in properties),
  };
}

export function buildGenerateImageToolVariant(tool: Tool, capabilities: ImageToolCapabilities | null): Tool | null {
  if (
    !capabilities ||
    (!capabilities.textToImage && !capabilities.imageToImage && !capabilities.inpaint && !capabilities.outpaint)
  ) {
    return null;
  }

  return createToolVariant(tool, {
    description: buildImageToolDescription(capabilities),
    parameters: buildImageToolParameters(tool, capabilities),
  });
}

/**
 * Tool for generating images using the active provider's native image API
 */
export class GenerateImageTool extends BaseTool {
  name = "generate_image";
  description =
    "Generate, edit, or outpaint an image. Sends the result directly to Discord. When depicting known users or personas, use their Physical Appearance context.";
  category = "utility" as const;
  requiresFeatureFlag = "image_gen";

  // Keep these schema descriptions short. Long tool descriptions get injected into
  // every model call and were starting to drown out the user's actual request.
  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Describe the desired image. Include relevant Physical Appearance context for known users/personas. For inpaint, describe only the local replacement. For outpaint, describe what should continue into the new canvas.",
      },
      media_id: {
        type: "string",
        description: "Reference media ID such as media_1. Use for img2img, inpaint, or outpaint.",
      },
      inpaint: {
        type: "boolean",
        description: "Set true only for localized edits. Do not set for outpaint.",
      },
      mask_prompt: {
        type: "string",
        description:
          "For inpaint: simplest generic noun for the existing target. Use 'body', 'dress', 'earring', or 'background'; avoid possessives/adjectives like 'the baby's body'. Do not describe the requested change.",
      },
      clothing_segment_categories: {
        type: "array",
        description:
          "Clothing-parser categories for clothing targets. For dresses, include Dress, Upper-clothes, and Skirt.",
        items: {
          type: "string",
          enum: [
            "Hat",
            "Sunglasses",
            "Upper-clothes",
            "Skirt",
            "Dress",
            "Belt",
            "Pants",
            "Bag",
            "Scarf",
            "Left-shoe",
            "Right-shoe",
          ],
        },
      },
      clothing_mode: {
        type: "boolean",
        description: "Set true for clothing, worn accessories, jewelry, or paired wearable items.",
      },
      mask_threshold: {
        type: "number",
        description: "Inpaint detection threshold. Lower is broader; higher is stricter.",
      },
      mask_grow: {
        type: "number",
        description: "Mask expansion in pixels.",
      },
      mask_feather: {
        type: "number",
        description: "Mask feather in pixels.",
      },
      cfg: {
        type: "number",
        description: "Prompt guidance. Higher follows the prompt more strongly.",
      },
      denoise: {
        type: "number",
        description: "Img2img/inpaint strength from 0 to 1. Lower preserves more.",
      },
      mask_mode: {
        type: "string",
        description: "Use target to edit the mask_prompt region; background edits surroundings while protecting it.",
        enum: ["target", "background"],
      },
      inpaint_preset: {
        type: "string",
        description: "Inpaint category. Prefer presets over raw tuning.",
        enum: ["small_detail", "tight_recolor", "broad_recolor", "background", "extend"],
      },
      inpaint_mode: {
        type: "string",
        description: "Inpaint behavior: normal edits the mask, extend grows nearby content, outpaint expands canvas.",
        enum: ["normal", "extend", "outpaint"],
      },
      outpaint: {
        type: "boolean",
        description:
          "Set true to expand the canvas. Requires media_id or target_identity. Do not also set inpaint=true.",
      },
      outpaint_strategy: {
        type: "string",
        description: "Outpaint strategy. full_canvas is the default.",
        enum: ["full_canvas", "edge_extend", "zoom_out"],
      },
      outpaint_amount: {
        type: "string",
        description: "Canvas expansion preset: slight, moderate, large, or dramatic.",
        enum: ["slight", "moderate", "large", "dramatic"],
      },
      outpaint_left_prompt: {
        type: "string",
        description: "Left-edge outpaint guidance.",
      },
      outpaint_right_prompt: {
        type: "string",
        description: "Right-edge outpaint guidance.",
      },
      outpaint_top_prompt: {
        type: "string",
        description: "Top-edge outpaint guidance.",
      },
      outpaint_bottom_prompt: {
        type: "string",
        description: "Bottom-edge outpaint guidance.",
      },
      extend_direction: {
        type: "string",
        description:
          "Extension direction. Use all for zoom-out/pull-back requests, or one edge for directional expansions.",
        enum: ["down", "up", "left", "right", "down_left", "down_right", "up_left", "up_right", "all"],
      },
      extend_pixels: {
        type: "number",
        description: "Approximate extension size in pixels. Prefer outpaint_amount when possible.",
      },
      outpaint_overlap: {
        type: "number",
        description: "Optional outpaint transition overlap in pixels.",
      },
      outpaint_zoom_scale: {
        type: "number",
        description: "Optional zoom-out source scale from 0.5 to 0.95.",
      },
      target_identity: {
        type: "array",
        description:
          "One or more user/persona identities whose avatars should be used as references (e.g. ['Aphel', 'Miku']). Each name is resolved to that user's or persona's avatar.",
        items: {
          type: "string",
        },
      },
      aspect_ratio: {
        type: "string",
        description: "Aspect ratio. Default is 1:1.",
        enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      },
    },
    required: ["prompt"],
  };

  /**
   * Standard image generation is available for any tool-capable chat model.
   * The actual execution provider is resolved from the configured image slot.
   * @returns Always true, so actual availability is gated by config + credential resolution
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Hide the tool unless a standard image slot is configured for the active state.
   */
  isAvailableForContext(_provider: string, context?: ToolContext): boolean {
    return (context?.tomoriState.config.diffusion_model_id ?? null) !== null;
  }

  async assembleForContext(context: ToolAssemblyContext): Promise<Tool | null> {
    const capabilities = await resolveImageToolCapabilities(context.state);
    return buildGenerateImageToolVariant(this, capabilities);
  }

  /**
   * Check if image generation is enabled in Tomori config
   * @returns True if image generation is enabled
   */
  protected isEnabled(context: ToolContext): boolean {
    return context.tomoriState.config.imagegen_enabled;
  }

  private shouldUseInpaint(args: Record<string, unknown>): boolean {
    if (
      typeof args.mask_mode === "string" ||
      typeof args.mask_prompt === "string" ||
      typeof args.inpaint_preset === "string"
    ) {
      return true;
    }
    if (typeof args.inpaint_mode === "string" && ["extend", "outpaint"].includes(args.inpaint_mode.toLowerCase())) {
      return true;
    }
    // Outpaint is implemented by providers as a reference-image edit with a
    // generated padding mask, so it intentionally uses the inpaint-capable path.
    if (args.outpaint === true) {
      return true;
    }
    if (typeof args.outpaint === "string" && args.outpaint.toLowerCase() === "true") {
      return true;
    }
    if (args.inpaint === true) {
      return true;
    }
    if (typeof args.inpaint === "string") {
      return args.inpaint.toLowerCase() === "true";
    }

    return false;
  }

  private shouldUseOutpaint(args: Record<string, unknown>): boolean {
    if (args.outpaint === true) {
      return true;
    }
    if (typeof args.outpaint === "string" && args.outpaint.toLowerCase() === "true") {
      return true;
    }
    return typeof args.inpaint_mode === "string" && args.inpaint_mode.toLowerCase() === "outpaint";
  }

  private isExplicitInpaintTrue(args: Record<string, unknown>): boolean {
    if (args.inpaint === true) {
      return true;
    }
    return typeof args.inpaint === "string" && args.inpaint.toLowerCase() === "true";
  }

  private resolveOutpaintDirection(prompt: string, direction: string | null, strategy: string | null): string | null {
    if (strategy === "zoom_out") {
      return "all";
    }
    if (direction && direction !== "all") {
      return direction;
    }
    const normalizedPrompt = prompt.toLowerCase();
    const explicitlyZoomOut =
      /\b(?:zoom out|pull back|wider shot|wide shot|wide[-\s]?angle(?: shot)?|wide framing|wider view|wide view|more distant shot)\b/.test(
        normalizedPrompt,
      );
    const explicitlyAllDirections = /\b(?:all directions|all sides|every side|around the whole image)\b/.test(
      normalizedPrompt,
    );
    if (explicitlyZoomOut || explicitlyAllDirections) {
      return "all";
    }

    if (
      /\b(?:legs?|feet|foot|shoes?|boots?|knees?|calves|thighs?|lower body|lower half|full[-\s]?body|full outfit|whole outfit|entire outfit|entire silhouette|floor|ground|below|underneath)\b/.test(
        normalizedPrompt,
      )
    ) {
      return "down";
    }
    if (/\b(?:sky|clouds?|ceiling|headroom|top of (?:the )?head|above)\b/.test(normalizedPrompt)) {
      return "up";
    }
    return direction;
  }

  private resolveOutpaintStrategy(prompt: string, strategy: string | null): string | null {
    const normalizedStrategy =
      strategy
        ?.trim()
        .toLowerCase()
        .replace(/[-\s]+/g, "_") ?? "";
    if (
      normalizedStrategy === "full_canvas" ||
      normalizedStrategy === "edge_extend" ||
      normalizedStrategy === "zoom_out"
    ) {
      return normalizedStrategy;
    }
    if (/\b(?:full[-\s]?canvas|novelai[-\s]?style|expanded[-\s]?canvas)\b/i.test(prompt)) {
      return "full_canvas";
    }
    if (
      /\b(?:zoom out|pull back|wider shot|wide shot|wide[-\s]?angle(?: shot)?|wide framing|wider view|wide view|more distant shot|full[-\s]?body|full outfit|whole outfit|entire outfit|entire silhouette)\b/i.test(
        prompt,
      )
    ) {
      return "full_canvas";
    }
    return null;
  }

  private formatOutpaintDirection(direction: string | null): string {
    const normalized = direction?.trim().toLowerCase() || "down";
    if (normalized === "all") {
      return "all directions";
    }
    return normalized.replaceAll("_", " ");
  }

  private formatNoticeValue(value: string, maxLength = 120): string {
    const cleaned = value.replaceAll("`", "'").replace(/\s+/g, " ").trim();
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3).trimEnd()}...` : cleaned;
  }

  private buildEffectivePrompt(prompt: string, styleTags: readonly string[], inpaint: boolean): string {
    const cleanedPrompt = prompt.trim();
    const cleanedStyleTags = styleTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    if (cleanedStyleTags.length === 0) {
      return cleanedPrompt;
    }

    const styleGuidance = cleanedStyleTags.join(", ");
    if (inpaint) {
      return `Image style guidance to preserve/apply where compatible: ${styleGuidance}\n\nLocal edit request: ${cleanedPrompt}`;
    }

    return `Image style guidance: ${styleGuidance}\n\nUser request: ${cleanedPrompt}`;
  }

  private buildEffectiveNegativePrompt(tags: readonly string[] | null | undefined): string | undefined {
    const cleanedTags = tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0) ?? [];
    return cleanedTags.length > 0 ? cleanedTags.join(", ") : undefined;
  }

  private customEndpointSupportsNegativePrompt(endpoint: CustomEndpointRow | undefined): boolean {
    if (!endpoint) {
      return false;
    }

    return readImageEndpointSupports(endpoint).negative_prompt;
  }

  private parseClampedNumber(value: unknown, min: number, max: number): number | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  private parseOptionalBoolean(value: unknown): boolean | null {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }

    return null;
  }

  /**
   * Normalize the `target_identity` argument into an ordered, de-duplicated list
   * of identity strings. Accepts the new string-array form, a single string
   * (legacy/lenient models), and the deprecated `user_id` alias.
   * @param args - Raw tool arguments
   * @returns Trimmed, case-insensitively de-duplicated identity names
   */
  private parseTargetIdentities(args: Record<string, unknown>): string[] {
    const raw = args.target_identity ?? args.user_id;
    const collected: string[] = [];

    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === "string") {
          collected.push(entry);
        }
      }
    } else if (typeof raw === "string") {
      collected.push(raw);
    }

    // Trim, drop empties, and de-duplicate while preserving first-seen order
    const seen = new Set<string>();
    const identities: string[] = [];
    for (const candidate of collected) {
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      identities.push(trimmed);
    }

    return identities;
  }

  private resolveMediaId(rawMediaId: string | undefined, context: ToolContext): string | undefined {
    if (!rawMediaId) {
      return undefined;
    }

    return MessageIdMap.isOpaqueKey(rawMediaId)
      ? (context.messageIdMap ?? context.streamContext?.messageIdMap)?.resolve(rawMediaId)
      : rawMediaId;
  }

  private shouldSuppressThoughtLogDiagnostic(context: ToolContext): boolean {
    if (!context.tomoriState.config.thought_log_channel_disc_id) {
      return true;
    }
    if (
      "isDMBased" in context.channel &&
      typeof context.channel.isDMBased === "function" &&
      context.channel.isDMBased()
    ) {
      return true;
    }

    const privateChannelIds = context.tomoriState.config.private_channel_ids ?? [];
    const parentId = context.channel.isThread() ? context.channel.parentId : null;
    return (
      privateChannelIds.includes(context.channel.id) || (parentId !== null && privateChannelIds.includes(parentId))
    );
  }

  private async sendDiagnosticImagesToThoughtLog(
    context: ToolContext,
    diagnostics: ProviderNativeImageGenerationResult["diagnosticImages"],
    prompt: string,
  ): Promise<void> {
    if (!diagnostics?.length || this.shouldSuppressThoughtLogDiagnostic(context)) {
      return;
    }

    const thoughtLogChannelId = context.tomoriState.config.thought_log_channel_disc_id;
    if (!thoughtLogChannelId) {
      return;
    }

    const thoughtLogChannel = await context.client.channels.fetch(thoughtLogChannelId).catch(() => null);
    if (
      !thoughtLogChannel ||
      !("send" in thoughtLogChannel) ||
      typeof thoughtLogChannel.send !== "function" ||
      ("isDMBased" in thoughtLogChannel &&
        typeof thoughtLogChannel.isDMBased === "function" &&
        thoughtLogChannel.isDMBased())
    ) {
      log.warn(`GenerateImageTool: Thought log channel ${thoughtLogChannelId} is missing. Skipping diagnostic image.`);
      return;
    }

    const promptPreview = prompt.length > 700 ? `${prompt.slice(0, 697).trimEnd()}...` : prompt;
    const sourceLine = context.message?.url ?? context.channel.toString();
    for (const [index, diagnostic] of diagnostics.entries()) {
      const extension = diagnostic.mimeType === "image/jpeg" ? "jpg" : "png";
      const attachment = new AttachmentBuilder(Buffer.from(diagnostic.imageData, "base64"), {
        name: diagnostic.filename ?? `inpaint_mask_${index + 1}.${extension}`,
      });
      await thoughtLogChannel.send({
        content: [
          `**Image generation diagnostic:** ${diagnostic.label}`,
          ...(diagnostic.details ? [`**Settings**\n${diagnostic.details}`] : []),
          `Source: ${sourceLine}`,
          `Prompt: ${promptPreview}`,
        ].join("\n"),
        files: [attachment],
      });
    }
  }

  /**
   * Get the diffusion model codename from the database via repository
   * @returns The model codename string (e.g., "gemini-2.5-flash-image")
   */
  private async getDiffusionModelCodename(diffusionModelId: number): Promise<string> {
    const model = await llmModelRepo.loadDiffusionModelById(diffusionModelId);

    if (!model) {
      throw new Error(`Diffusion model not found in database: ${diffusionModelId}`);
    }

    return model.codename;
  }

  private async sendGeneratedImage(
    context: ToolContext,
    attachment: AttachmentBuilder,
    attachmentFilename: string,
    elapsedMs: number,
    referencedIdentities: string[] = [],
  ): Promise<import("discord.js").Message> {
    const threadId =
      "isThread" in context.channel && typeof context.channel.isThread === "function" && context.channel.isThread()
        ? context.channel.id
        : undefined;
    const componentsPayload = buildGeneratedImageComponentsV2Payload(
      attachmentFilename,
      elapsedMs,
      context.locale,
      referencedIdentities,
    );

    if (context.webhook && context.personaUsername) {
      try {
        return await sendWebhookMessageWithIdentity(
          context.webhook,
          {
            files: [attachment],
            ...componentsPayload,
            withComponents: true,
            ...(threadId ? { threadId } : {}),
          },
          {
            username: context.personaUsername,
            avatarUrl: context.personaAvatarUrl,
            avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
          },
        );
      } catch (error) {
        log.warn("Failed to send generated image via webhook with Components V2, retrying without components", error);
        try {
          return await sendWebhookMessageWithIdentity(
            context.webhook,
            {
              files: [attachment],
              ...(threadId ? { threadId } : {}),
            },
            {
              username: context.personaUsername,
              avatarUrl: context.personaAvatarUrl,
              avatarDataUri: context.personaAvatarUrl?.startsWith("data:image/") ? context.personaAvatarUrl : undefined,
            },
          );
        } catch (fallbackError) {
          log.warn("Failed to send generated image via webhook, falling back to bot message", fallbackError as Error);
        }
      }
    }

    try {
      return await context.channel.send({
        files: [attachment],
        ...componentsPayload,
      });
    } catch (error) {
      log.warn("Failed to send generated image with Components V2, falling back to attachment-only message", error);
      return await context.channel.send({ files: [attachment] });
    }
  }

  /**
   * Execute image generation
   * @param args - Arguments containing prompt, optional media_id, and optional aspect_ratio
   * @returns Promise resolving to tool result with generated image
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const startedAtMs = Date.now();

    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
      };
    }

    if (!this.isEnabled(context)) {
      return {
        success: false,
        error: "Image generation is disabled for this server",
        message: "Image generation is not enabled for this server.",
      };
    }

    const userDiscId = context.userId || context.message?.author.id || "";
    if (!userDiscId) {
      return {
        success: false,
        error: "Unable to identify user for quota checking",
      };
    }

    const prompt = args.prompt as string;
    const rawMediaId = args.media_id as string | undefined;
    const messageId = this.resolveMediaId(rawMediaId, context);
    const targetIdentities = this.parseTargetIdentities(args);
    const requestedAspectRatio = typeof args.aspect_ratio === "string" ? args.aspect_ratio : null;
    let aspectRatio = requestedAspectRatio || "1:1";
    const usesReferences = !!(messageId || targetIdentities.length > 0);
    const inpaint = this.shouldUseInpaint(args);
    const outpaint = this.shouldUseOutpaint(args);
    const explicitInpaint = this.isExplicitInpaintTrue(args);
    const maskPrompt = (args.mask_prompt as string | undefined)?.trim() || (outpaint ? "main foreground object" : null);
    const maskThreshold = this.parseClampedNumber(args.mask_threshold, 0, 1);
    const maskGrow = this.parseClampedNumber(args.mask_grow, 0, 128);
    const maskFeather = this.parseClampedNumber(args.mask_feather, 0, 100);
    const clothingSegmentCategories = Array.isArray(args.clothing_segment_categories)
      ? args.clothing_segment_categories.filter((category): category is string => typeof category === "string")
      : null;
    const clothingMode = this.parseOptionalBoolean(args.clothing_mode);
    const cfg = this.parseClampedNumber(args.cfg, 0, 30);
    const denoise = this.parseClampedNumber(args.denoise, 0, 1);
    const maskMode = typeof args.mask_mode === "string" ? args.mask_mode : null;
    const inpaintPreset = typeof args.inpaint_preset === "string" ? args.inpaint_preset : null;
    const inpaintMode = outpaint ? "outpaint" : typeof args.inpaint_mode === "string" ? args.inpaint_mode : null;
    const rawOutpaintStrategy = typeof args.outpaint_strategy === "string" ? args.outpaint_strategy : null;
    const outpaintStrategy = outpaint ? this.resolveOutpaintStrategy(prompt, rawOutpaintStrategy) : rawOutpaintStrategy;
    const outpaintAmount = typeof args.outpaint_amount === "string" ? args.outpaint_amount : null;
    const rawExtendDirection = typeof args.extend_direction === "string" ? args.extend_direction : null;
    const extendDirection = outpaint
      ? this.resolveOutpaintDirection(prompt, rawExtendDirection, outpaintStrategy)
      : rawExtendDirection;
    const extendPixels = this.parseClampedNumber(args.extend_pixels, 0, 512);
    const outpaintOverlap = this.parseClampedNumber(args.outpaint_overlap, 0, 256);
    const outpaintZoomScale = this.parseClampedNumber(args.outpaint_zoom_scale, 0.5, 0.95);
    const outpaintLeftPrompt =
      typeof args.outpaint_left_prompt === "string" ? args.outpaint_left_prompt.trim() || null : null;
    const outpaintRightPrompt =
      typeof args.outpaint_right_prompt === "string" ? args.outpaint_right_prompt.trim() || null : null;
    const outpaintTopPrompt =
      typeof args.outpaint_top_prompt === "string" ? args.outpaint_top_prompt.trim() || null : null;
    const outpaintBottomPrompt =
      typeof args.outpaint_bottom_prompt === "string" ? args.outpaint_bottom_prompt.trim() || null : null;
    const effectivePrompt = this.buildEffectivePrompt(
      prompt,
      context.tomoriState.config.image_default_positive_tags ?? [],
      inpaint,
    );
    const effectiveNegativePrompt = this.buildEffectiveNegativePrompt(
      context.tomoriState.config.image_default_negative_tags,
    );

    if (rawMediaId && !messageId) {
      return {
        success: false,
        error: `Unknown media_id: "${rawMediaId}".`,
      };
    }
    if (inpaint && !usesReferences) {
      return {
        success: false,
        error: "Inpaint requires media_id or target_identity.",
      };
    }
    if (outpaint && explicitInpaint) {
      return {
        success: false,
        error:
          "Outpaint requests must not also set inpaint=true. Use outpaint=true or inpaint_mode='outpaint' by itself; the ComfyUI provider will use the required inpaint-style workflow internally.",
      };
    }
    if (inpaint && !outpaint && !maskPrompt) {
      return {
        success: false,
        error: "Inpaint requires mask_prompt describing the existing region to edit.",
      };
    }

    // Default to allowed; overwritten below for server-credential users
    let quotaCheck: QuotaCheckResult = { allowed: true };

    try {
      // Resolve credentials first so we can skip server quota for personal BYOK users
      const creds = await resolveCapabilityCredentials(context.tomoriState.server_id, "image-standard", {
        userId: context.internalUserId ?? null,
      });

      // Personal BYOK users bring their own API quota, so bypass server quota entirely
      if (creds.source === "server") {
        quotaCheck = await checkImageQuota(context.tomoriState.server_id, userDiscId);
      }

      if (!quotaCheck.allowed) {
        let errorMessage = "";
        let resetInfo = "";

        if (quotaCheck.resetTime) {
          const now = new Date();
          const resetTime = quotaCheck.resetTime;
          const hoursUntilReset = Math.ceil((resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));

          if (hoursUntilReset < 24) {
            resetInfo = localizer(context.locale, "tools.generate_image.quota_resets_in_hours", {
              hours: hoursUntilReset.toString(),
            });
          } else {
            const daysUntilReset = Math.ceil(hoursUntilReset / 24);
            resetInfo = localizer(context.locale, "tools.generate_image.quota_resets_in_days", {
              days: daysUntilReset.toString(),
            });
          }
        }

        if (quotaCheck.reason === "user_quota_exceeded") {
          errorMessage = localizer(context.locale, "tools.generate_image.user_quota_exceeded", {
            reset_info: resetInfo,
          });
        } else if (quotaCheck.reason === "serverwide_quota_exceeded") {
          errorMessage = localizer(context.locale, "tools.generate_image.serverwide_quota_exceeded", {
            reset_info: resetInfo,
          });
        } else {
          errorMessage = localizer(context.locale, "tools.generate_image.quota_exceeded_generic");
        }

        return {
          success: false,
          error: "Image generation quota exceeded",
          message: errorMessage,
        };
      }

      const diffusionModelId =
        getResolvedCapabilityModelId(creds, "image-standard") ?? context.tomoriState.config.diffusion_model_id;

      if (!diffusionModelId) {
        return {
          success: false,
          error:
            "No diffusion model configured for this server. Please run the setup command or configure an API key to enable image generation.",
        };
      }

      const modelCodename = await this.getDiffusionModelCodename(diffusionModelId);
      const displayModelName = creds.customEndpoint
        ? formatCustomEndpointModelDisplay(creds.customEndpoint)
        : modelCodename;

      log.info(`Using diffusion model: ${modelCodename} for image generation`);

      const apiKey = creds.apiKey;
      const executionProvider = creds.provider;
      const appliedNegativePrompt = this.customEndpointSupportsNegativePrompt(creds.customEndpoint)
        ? effectiveNegativePrompt
        : undefined;

      const referenceImages: ImageReference[] = [];
      // Resolved avatar metadata, in request order, for every identity that was
      // successfully fetched. Used to surface referenced users in the notice/embed.
      const avatarReferences: ResolvedAvatarData[] = [];

      if (messageId) {
        log.info(`Extracting images from message ${messageId} for image-to-image generation`);
        const messageImages = await extractImagesFromMessage(messageId, context);
        referenceImages.push(...messageImages.map((image) => ({ ...image, sourceType: "message" as const })));
        log.info(`Using ${messageImages.length} reference image(s) from message ${messageId} for generation`);
      }

      // Skip avatar references during inpaint when a message image is the edit source, so
      // the source image already defines the layout being edited.
      const allowAvatarReference = targetIdentities.length > 0 && !(inpaint && !!messageId);

      if (allowAvatarReference) {
        const failedIdentities: string[] = [];

        // Resolve each requested identity to an avatar, normalizing gif → png at
        //    the URL level via forceStatic (same behavior as peek_profile_picture).
        for (const identity of targetIdentities) {
          try {
            const avatarData = await resolveAvatarByIdentity(identity, context, {
              forceStatic: true,
            });
            const avatarBase64 = await this.fetchAndConvertImageToBase64(avatarData.avatarUrl, context.abortSignal);
            referenceImages.push({
              mimeType: "image/png",
              data: avatarBase64,
              sourceType: "avatar",
            });
            avatarReferences.push(avatarData);
            const avatarTypeLabel =
              avatarData.sourceType === "persona"
                ? "persona"
                : avatarData.sourceType === "webhook"
                  ? "webhook"
                  : "user";
            log.info(`Added profile picture reference for ${avatarTypeLabel} ${avatarData.username} (${identity})`);
          } catch (avatarErr) {
            log.error(`Failed to fetch profile picture for identity ${identity}`, avatarErr as Error);
            failedIdentities.push(identity);
          }
        }

        // Only fail outright when every reference source came up empty; otherwise
        //    continue with whatever references (message images / other avatars) resolved.
        if (failedIdentities.length > 0) {
          if (referenceImages.length === 0) {
            return {
              success: false,
              error: "Failed to fetch profile picture for target_identity",
              message: `Could not fetch an avatar for: ${failedIdentities.join(", ")}. Please confirm the name(s) or persona(s) and try again.`,
            };
          }
          log.warn(
            `Continuing image generation without target_identit${failedIdentities.length > 1 ? "ies" : "y"} ${failedIdentities
              .map((identity) => `"${identity}"`)
              .join(", ")} because other reference image(s) are available`,
          );
        }
      }

      const normalizedReferenceImages = await this.normalizeReferenceImages(referenceImages, {
        keepAtLeastOne: inpaint,
      });
      if (normalizedReferenceImages.length !== referenceImages.length) {
        log.info(
          `Reference images normalized from ${referenceImages.length} to ${normalizedReferenceImages.length} to avoid oversized requests`,
        );
      }
      referenceImages.length = 0;
      referenceImages.push(...normalizedReferenceImages);
      if (inpaint && !requestedAspectRatio && referenceImages.length > 0) {
        const referenceAspectRatio = await this.inferReferenceImageAspectRatio(referenceImages[0]);
        if (referenceAspectRatio) {
          aspectRatio = referenceAspectRatio;
          log.info(`Inpaint aspect ratio inferred from reference image: ${aspectRatio}`);
        }
      }

      // Avatars are appended after message references and normalized in order, so the
      // avatars that survived the count/byte caps are a prefix of the resolved list.
      const survivingAvatarCount = referenceImages.filter((reference) => reference.sourceType === "avatar").length;
      const usedAvatarReferences = avatarReferences.slice(0, survivingAvatarCount);
      const referencedIdentityNames = usedAvatarReferences.map((avatarReference) => avatarReference.username);

      if (!context.suppressProgressNotices) {
        const actualUsesReferences = referenceImages.length > 0;
        const baseNoticeDescription = localizer(
          context.locale,
          actualUsesReferences
            ? "tools.image.generating_with_references_description"
            : "tools.image.generating_description",
        );
        const referencedMessageUrl = messageId ? buildReferencedMessageUrl(context, messageId) : null;
        const messageReferenceCount = referenceImages.filter((reference) => reference.sourceType === "message").length;
        const extraNoticeLines: string[] = [];
        const imageModeKey = outpaint
          ? "tools.image.mode_outpaint"
          : inpaint
            ? "tools.image.mode_inpaint"
            : actualUsesReferences
              ? "tools.image.mode_img2img"
              : "tools.image.mode_txt2img";
        const modeNoticeLine = localizer(context.locale, "tools.image.notice_mode_line", {
          mode: localizer(context.locale, imageModeKey),
        });
        if (outpaint) {
          extraNoticeLines.push(
            localizer(context.locale, "tools.image.notice_outpaint_direction_line", {
              direction: this.formatOutpaintDirection(extendDirection),
            }),
          );
        }
        if (inpaint && !outpaint && maskPrompt) {
          extraNoticeLines.push(`Mask: \`${this.formatNoticeValue(maskPrompt)}\``);
        }
        if (messageReferenceCount > 0) {
          extraNoticeLines.push(
            referencedMessageUrl
              ? localizer(context.locale, "tools.image.notice_reference_line", {
                  message_url: referencedMessageUrl,
                })
              : localizer(context.locale, "tools.image.notice_reference_count_line", {
                  count: messageReferenceCount.toString(),
                }),
          );
        }
        if (referencedIdentityNames.length > 0) {
          extraNoticeLines.push(
            localizer(context.locale, "tools.image.notice_avatar_reference_line", {
              name: referencedIdentityNames.join(", "),
            }),
          );
        }
        if (referenceImages.length > 1) {
          extraNoticeLines.push(
            localizer(context.locale, "tools.image.notice_reference_count_line", {
              count: referenceImages.length.toString(),
            }),
          );
        }
        extraNoticeLines.push("");
        extraNoticeLines.push(localizer(context.locale, "tools.image.notice_image_tags_tip_line"));
        await sendToolProgressNotice(
          context,
          "image_generation",
          {
            titleKey: "tools.image.generating_title",
            description: buildImageToolNoticeDescription(
              context.locale,
              baseNoticeDescription,
              displayModelName,
              prompt,
              localizer(context.locale, "tools.image.generating_footer"),
              extraNoticeLines,
              [modeNoticeLine],
            ),
            color: ColorCode.INFO,
          },
          "GenerateImageTool",
        );
      }

      const providerReferenceImages = referenceImages.map(({ mimeType, data }) => ({ mimeType, data }));

      log.info(
        `Generating image with ${executionProvider} via ${displayModelName}: "${effectivePrompt.substring(0, 100)}${effectivePrompt.length > 100 ? "..." : ""}" (aspect ratio: ${aspectRatio})`,
      );
      log.info(
        `GenerateImageTool image edit settings ${JSON.stringify({
          inpaint,
          maskPrompt,
          maskThreshold: inpaint ? maskThreshold : null,
          maskGrow: inpaint ? maskGrow : null,
          maskFeather: inpaint ? maskFeather : null,
          clothingMode: inpaint ? clothingMode : null,
          clothingSegmentCategories: inpaint ? clothingSegmentCategories : null,
          outpaint: inpaint ? outpaint : null,
          outpaintStrategy: inpaint ? outpaintStrategy : null,
          outpaintAmount: inpaint ? outpaintAmount : null,
          outpaintOverlap: inpaint ? outpaintOverlap : null,
          outpaintZoomScale: inpaint ? outpaintZoomScale : null,
          outpaintDirectionalPrompts:
            inpaint && outpaint
              ? {
                  left: outpaintLeftPrompt !== null,
                  right: outpaintRightPrompt !== null,
                  top: outpaintTopPrompt !== null,
                  bottom: outpaintBottomPrompt !== null,
                }
              : null,
          extendDirection: inpaint ? extendDirection : null,
          extendPixels: inpaint ? extendPixels : null,
          cfg: inpaint ? cfg : null,
          denoise: usesReferences ? denoise : null,
        })}`,
      );

      let generatedImageData: string | null = null;
      let referenceImagesUsed = providerReferenceImages.length > 0;
      let referenceImagesIgnoredReason = "";
      const imageGenerationImplementation = resolveProviderFeatureImplementation(executionProvider, "imageGeneration");
      const nativeImageProvider =
        executionProvider === "vertex" || executionProvider === "vertexexpress"
          ? await resolveNativeImageGenerationCapability(executionProvider)
          : null;

      if (creds.customEndpoint) {
        try {
          const result = await generateCustomImageViaEndpoint({
            endpoint: creds.customEndpoint,
            apiKey,
            prompt: effectivePrompt,
            negativePrompt: appliedNegativePrompt,
            aspectRatio,
            referenceImages: providerReferenceImages.length > 0 ? providerReferenceImages : undefined,
            inpaint,
            maskPrompt,
            maskThreshold,
            maskGrow,
            maskFeather,
            cfg,
            denoise,
            inpaintMaskMode: maskMode,
            inpaintPreset,
            inpaintMode,
            outpaint,
            outpaintStrategy,
            outpaintAmount,
            outpaintOverlap,
            outpaintZoomScale,
            outpaintLeftPrompt,
            outpaintRightPrompt,
            outpaintTopPrompt,
            outpaintBottomPrompt,
            inpaintExtendDirection: extendDirection,
            inpaintExtendPixels: extendPixels,
            clothingMode,
            clothingSegmentCategories,
          });
          generatedImageData = result.imageData;
          await this.sendDiagnosticImagesToThoughtLog(context, result.diagnosticImages, effectivePrompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const tooLarge =
            msg.toLowerCase().includes("request entity too large") ||
            msg.includes("413") ||
            msg.toLowerCase().includes("payload too large");
          if (tooLarge && providerReferenceImages.length > 0) {
            log.warn("Custom endpoint request was too large; retrying with tiny single-reference payload");
            const tinyRef = await this.buildTinyReferenceImage(providerReferenceImages[0]);
            const retryResult = await generateCustomImageViaEndpoint({
              endpoint: creds.customEndpoint,
              apiKey,
              prompt: effectivePrompt,
              negativePrompt: appliedNegativePrompt,
              aspectRatio,
              referenceImages: [tinyRef],
              inpaint,
              maskPrompt,
              maskThreshold,
              maskGrow,
              maskFeather,
              cfg,
              denoise,
              inpaintMaskMode: maskMode,
              inpaintPreset,
              inpaintMode,
              outpaint,
              outpaintStrategy,
              outpaintAmount,
              outpaintOverlap,
              outpaintZoomScale,
              outpaintLeftPrompt,
              outpaintRightPrompt,
              outpaintTopPrompt,
              outpaintBottomPrompt,
              inpaintExtendDirection: extendDirection,
              inpaintExtendPixels: extendPixels,
              clothingMode,
              clothingSegmentCategories,
            });
            generatedImageData = retryResult.imageData;
            await this.sendDiagnosticImagesToThoughtLog(context, retryResult.diagnosticImages, effectivePrompt);
          } else {
            throw err;
          }
        }
      } else if (nativeImageProvider) {
        const result = await nativeImageProvider.generateNativeImage({
          apiKey,
          model: modelCodename,
          prompt: effectivePrompt,
          negativePrompt: appliedNegativePrompt,
          aspectRatio,
          ...(providerReferenceImages.length > 0 ? { referenceImages: providerReferenceImages } : {}),
        });
        generatedImageData = result.imageData;
      } else if (imageGenerationImplementation === "openrouter") {
        // Use OpenRouter API
        const result = await generateOpenRouterImage({
          apiKey,
          modelCodename,
          prompt: effectivePrompt,
          aspectRatio,
          ...(providerReferenceImages.length > 0 ? { referenceImages: providerReferenceImages } : {}),
          ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
        });
        generatedImageData = result.imageData;
      } else if (imageGenerationImplementation === "google") {
        // Use Google Gemini API
        const ai = new GoogleGenAI({ apiKey });
        const chat = ai.chats.create({
          model: modelCodename,
        });

        const messagePayload: {
          message: string;
          media?: Array<{ mimeType: string; data: string }>;
          config?: {
            responseModalities: string[];
            imageConfig: {
              aspectRatio: string;
            };
          };
        } = {
          message: effectivePrompt,
          config: {
            responseModalities: ["IMAGE"],
            imageConfig: {
              aspectRatio: aspectRatio,
            },
          },
        };

        if (providerReferenceImages.length > 0) {
          messagePayload.media = providerReferenceImages;
        }

        const response = await chat.sendMessage(messagePayload);

        if (response?.candidates && response.candidates.length > 0 && response.candidates[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
              generatedImageData = part.inlineData.data ?? null;
              break;
            }
          }
        }
      } else if (imageGenerationImplementation === "zai") {
        // Use Z.ai native image generation API
        if (providerReferenceImages.length > 0) {
          referenceImagesUsed = false;
          referenceImagesIgnoredReason =
            " Reference images were ignored because the active provider's image endpoint is text-to-image only.";
        }
        const { generateZaiNativeImage } = await import("@/providers/zai/zaiImageGeneration");
        const result = await generateZaiNativeImage({
          apiKey,
          model: modelCodename,
          prompt: effectivePrompt,
          negativePrompt: appliedNegativePrompt,
          aspectRatio,
          endpointUrl:
            executionProvider === "zaicoding" ? ZAI_CODING_IMAGES_GENERATIONS_URL : ZAI_GENERAL_IMAGES_GENERATIONS_URL,
        });
        generatedImageData = result.imageData;
      } else if (imageGenerationImplementation === "nvidia") {
        // Use NVIDIA native image generation API
        if (providerReferenceImages.length > 0) {
          referenceImagesUsed = false;
          referenceImagesIgnoredReason =
            " Reference images were ignored because the active provider's image endpoint is text-to-image only.";
        }
        const { generateNvidiaNativeImage } = await import("@/providers/nvidia/nvidiaImageGeneration");
        const result = await generateNvidiaNativeImage({
          apiKey,
          model: modelCodename,
          prompt: effectivePrompt,
          negativePrompt: appliedNegativePrompt,
          aspectRatio,
          referenceImages: providerReferenceImages.length > 0 ? providerReferenceImages : undefined,
        });
        generatedImageData = result.imageData;
      } else {
        return {
          success: false,
          error: `Image generation is not implemented for provider ${executionProvider}`,
        };
      }

      if (!generatedImageData) {
        return {
          success: false,
          error: "No image data received from API. The generation may have been blocked or failed.",
        };
      }

      const imageBuffer = Buffer.from(generatedImageData, "base64");
      const attachmentFilename = `generated_${Date.now()}.png`;
      const attachment = new AttachmentBuilder(imageBuffer, {
        name: attachmentFilename,
      });

      const sentMessage = await this.sendGeneratedImage(
        context,
        attachment,
        attachmentFilename,
        Date.now() - startedAtMs,
        referencedIdentityNames,
      );

      log.success("Successfully generated and sent image to Discord");

      // Increment quota after successful generation (server providers only)
      if (creds.source === "server") {
        await incrementImageQuota(context.tomoriState.server_id, userDiscId);
      }
      // Record canonical generation telemetry for all providers; quotas enforce limits only.
      if (context.internalUserId) {
        statRepository.recordStat({
          serverId: context.tomoriState.server_id,
          userId: context.internalUserId,
          lineageId: context.tomoriState.persona_lineage_id ?? 0,
          metric: "image_generated",
          metricKey: modelCodename,
        });
      }

      // Note: We intentionally DO NOT include imageMetadata for generated images
      // because Discord CDN URLs are protected and cannot be fetched by external
      // servers (like OpenRouter). The model doesn't need to see its own generated
      // output - it just needs confirmation that the generation succeeded.
      // The text message includes the Discord message ID for reference.

      let successMessage = `Successfully generated and sent image to Discord (message ID: ${sentMessage.id}). The image has been created based on your prompt${
        referenceImagesUsed ? " and the reference image(s)" : ""
      }.`;
      if (referenceImagesIgnoredReason) {
        successMessage += referenceImagesIgnoredReason;
      }

      if (quotaCheck.userRemaining !== undefined) {
        const remainingText = localizer(context.locale, "tools.generate_image.quota_remaining", {
          remaining: quotaCheck.userRemaining.toString(),
        });
        successMessage += ` ${remainingText}`;
      }

      return {
        success: true,
        message: successMessage,
        // imageMetadata intentionally omitted to avoid 403 errors when OpenRouter tries to fetch Discord CDN URLs
        // End the LLM turn immediately when this tool is the target of a hidden agent turn
        endTurn: context.streamContext?.endTurnAfterTools?.includes(this.name) ?? false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Localize errors, but fall back to readable defaults if the localizer
      // isn't initialized or a key is missing (to avoid leaking locale keys)
      const getReadableError = (key: string, fallback: string): string => {
        const localized = localizer(context.locale, key);
        return localized === key ? fallback : localized;
      };

      log.error("Image generation failed:", error as Error);

      if (
        errorMessage.includes("billing") ||
        errorMessage.includes("payment") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("PERMISSION_DENIED")
      ) {
        return {
          success: false,
          error: getReadableError("errors.google.400_billing_default_message", "Billing is required for this service"),
        };
      }

      if (errorMessage.includes("safety") || errorMessage.includes("blocked") || errorMessage.includes("RECITATION")) {
        return {
          success: false,
          error: getReadableError(
            "genai.google.content_blocked_default_message",
            "Your content was blocked by safety filters",
          ),
        };
      }

      return {
        success: false,
        error: `Failed to generate image: ${errorMessage}`,
      };
    }
  }
  /**
   * Fetch an image URL and convert to base64 (used for profile pictures)
   */
  private async fetchAndConvertImageToBase64(imageUrl: string, abortSignal?: AbortSignal): Promise<string> {
    const dataUrlMatches = imageUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (dataUrlMatches?.[1]) {
      return dataUrlMatches[1];
    }

    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      throw new Error(`Profile picture URL is not fetchable: ${imageUrl.split(":")[0] || "unknown"} protocol`);
    }

    const response = await safeDownload(imageUrl, {
      maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
      timeoutMs: 15_000,
      externalSignal: abortSignal,
    });
    if (!response.success || !response.buffer) {
      throw new Error(`Failed to fetch image: ${response.details ?? response.error ?? "unknown error"}`);
    }

    return response.buffer.toString("base64");
  }

  private async normalizeReferenceImages(
    referenceImages: ImageReference[],
    options?: { keepAtLeastOne?: boolean },
  ): Promise<ImageReference[]> {
    // Provider payload limits are easier to hit with Discord images than with
    // generated references. Downscale instead of failing when a user posts a
    // high-resolution source image, especially for inpaint/outpaint.
    const normalized: ImageReference[] = [];
    let totalBytes = 0;
    const capped = referenceImages.slice(0, IMAGE_REFERENCE_MAX_COUNT);
    if (referenceImages.length > IMAGE_REFERENCE_MAX_COUNT) {
      log.warn(
        `Reference image count ${referenceImages.length} exceeded cap ${IMAGE_REFERENCE_MAX_COUNT}; keeping first ${IMAGE_REFERENCE_MAX_COUNT}`,
      );
    }

    for (const ref of capped) {
      try {
        const raw = Buffer.from(ref.data, "base64");
        const optimized = await optimizeImageBuffer(raw, ref.mimeType || "image/jpeg");
        const optimizedBytes = Buffer.byteLength(optimized.data, "base64");
        const effectiveMaxBytes = Math.min(
          IMAGE_REFERENCE_MAX_SINGLE_BYTES,
          Math.max(1, IMAGE_REFERENCE_MAX_TOTAL_BYTES - totalBytes),
        );
        const normalizedRef =
          optimizedBytes > effectiveMaxBytes
            ? await this.buildReferenceImageWithinByteLimit(optimized, effectiveMaxBytes)
            : optimized;
        const normalizedBytes = Buffer.byteLength(normalizedRef.data, "base64");
        if (totalBytes + normalizedBytes > IMAGE_REFERENCE_MAX_TOTAL_BYTES) {
          if (normalized.length === 0 && options?.keepAtLeastOne) {
            log.warn(
              `Keeping first downscaled oversize reference image (${normalizedBytes} bytes) for inpaint fallback to avoid empty reference set`,
            );
            normalized.push({
              ...ref,
              mimeType: normalizedRef.mimeType,
              data: normalizedRef.data,
            });
            totalBytes += normalizedBytes;
            continue;
          }
          log.warn(
            `Skipping reference image (${normalizedBytes} bytes) to stay under total cap ${IMAGE_REFERENCE_MAX_TOTAL_BYTES} bytes`,
          );
          continue;
        }
        totalBytes += normalizedBytes;
        normalized.push({
          ...ref,
          mimeType: normalizedRef.mimeType,
          data: normalizedRef.data,
        });
      } catch (err) {
        log.warn("Failed to normalize one reference image, skipping it", err as Error);
      }
    }

    if (normalized.length === 0 && referenceImages.length > 0) {
      const first = referenceImages[0];
      const fallbackBytes = Buffer.byteLength(first.data, "base64");
      if (fallbackBytes <= IMAGE_REFERENCE_MAX_TOTAL_BYTES || options?.keepAtLeastOne) {
        const fallback =
          fallbackBytes > IMAGE_REFERENCE_MAX_SINGLE_BYTES || fallbackBytes > IMAGE_REFERENCE_MAX_TOTAL_BYTES
            ? await this.buildReferenceImageWithinByteLimit(
                first,
                Math.min(IMAGE_REFERENCE_MAX_SINGLE_BYTES, IMAGE_REFERENCE_MAX_TOTAL_BYTES),
              )
            : first;
        const fallbackNormalizedBytes = Buffer.byteLength(fallback.data, "base64");
        if (fallbackNormalizedBytes > IMAGE_REFERENCE_MAX_TOTAL_BYTES) {
          log.warn(
            `Keeping oversize fallback reference image (${fallbackNormalizedBytes} bytes) because keepAtLeastOne=true`,
          );
        }
        normalized.push({
          ...first,
          mimeType: fallback.mimeType,
          data: fallback.data,
        });
      }
    }

    return normalized;
  }

  private async buildReferenceImageWithinByteLimit(
    referenceImage: {
      mimeType: string;
      data: string;
    },
    maxBytes: number,
  ): Promise<{ mimeType: string; data: string }> {
    const input = Buffer.from(referenceImage.data, "base64");
    let quality = 82;
    for (const maxDim of [2048, 1792, 1536, 1280, 1024, 896, 768, 640]) {
      const encoded = await sharp(input)
        .rotate()
        .resize({
          width: maxDim,
          height: maxDim,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (encoded.byteLength <= maxBytes) {
        log.info(
          `Downscaled reference image to fit payload cap: max ${maxDim}px, ${encoded.byteLength} bytes <= ${maxBytes}`,
        );
        return {
          mimeType: "image/jpeg",
          data: encoded.toString("base64"),
        };
      }
      quality = Math.max(45, quality - 6);
    }

    const finalBuffer = await sharp(input)
      .rotate()
      .resize({
        width: 512,
        height: 512,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 42, mozjpeg: true })
      .toBuffer();
    log.warn(
      `Reference image still exceeds desired payload cap after downscale (${finalBuffer.byteLength} > ${maxBytes})`,
    );
    return {
      mimeType: "image/jpeg",
      data: finalBuffer.toString("base64"),
    };
  }

  private async buildTinyReferenceImage(referenceImage: {
    mimeType: string;
    data: string;
  }): Promise<{ mimeType: string; data: string }> {
    const input = Buffer.from(referenceImage.data, "base64");
    let quality = 72;
    for (const maxDim of [1024, 896, 768, 640, 512]) {
      const encoded = await sharp(input)
        .resize({
          width: maxDim,
          height: maxDim,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (encoded.byteLength <= IMAGE_REFERENCE_TINY_MAX_BYTES) {
        return {
          mimeType: "image/jpeg",
          data: encoded.toString("base64"),
        };
      }
      quality = Math.max(45, quality - 8);
    }

    const finalBuffer = await sharp(input)
      .resize({
        width: 512,
        height: 512,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 42, mozjpeg: true })
      .toBuffer();
    return {
      mimeType: "image/jpeg",
      data: finalBuffer.toString("base64"),
    };
  }

  private async inferReferenceImageAspectRatio(referenceImage: {
    mimeType: string;
    data: string;
  }): Promise<string | null> {
    try {
      const metadata = await sharp(Buffer.from(referenceImage.data, "base64")).metadata();
      if (!metadata.width || !metadata.height) {
        return null;
      }
      const divisor = this.greatestCommonDivisor(metadata.width, metadata.height);
      return `${Math.round(metadata.width / divisor)}:${Math.round(metadata.height / divisor)}`;
    } catch (err) {
      log.warn("Failed to infer reference image aspect ratio", err as Error);
      return null;
    }
  }

  private greatestCommonDivisor(a: number, b: number): number {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
      const next = x % y;
      x = y;
      y = next;
    }
    return x || 1;
  }
}
