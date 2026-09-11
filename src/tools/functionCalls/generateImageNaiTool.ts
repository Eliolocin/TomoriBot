/**
 * NovelAI Image Generation Tool
 * Generates images using NovelAI's diffusion models with imageboard-style tag prompts.
 * Supports positioned multi-character generation for V4 models via `characters[]`.
 *
 * Inpainting mode (Phase 2):
 * When `media_id` + `edit_target` are provided, the tool enters inpaint mode:
 * 1. Extracts the image from the referenced Discord message
 * 2. Calls Gemini segmentation to identify the edit target region
 * 3. Generates a mask (white = redraw, black = preserve)
 * 4. Sends image + mask to NovelAI's infill endpoint with an inpainting model
 */

import { AttachmentBuilder } from "discord.js";
import JSZip from "jszip";
import { log, ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import { buildGeneratedImageComponentsV2Payload } from "@/utils/discord/generatedImageMessage";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import {
  buildImageToolNoticeDescription,
  buildReferencedMessageUrl,
  sendToolProgressNotice,
} from "@/utils/discord/toolProgressNotice";
import { BaseTool, type ToolContext, type ToolResult, type ToolParameterSchema } from "../../types/tool/interfaces";
import { sql } from "../../utils/db/client";
import { decryptApiKey } from "../../utils/security/crypto";
import { checkImageQuota, incrementImageQuota, type QuotaCheckResult } from "../../utils/quota/imageQuotaManager";
import { llmProviderRepo, statRepository, userRepository } from "@/utils/db/repositories";
import { extractImagesFromMessage } from "../../utils/image/imageExtractor";
import { segmentImage } from "../../utils/image/segmentationService";
import { resolveNaiImageParams, type EffectiveNaiImageParams } from "@/utils/image/naiImageParams";
import { normalizeNaiReferenceImage } from "@/utils/image/imageProcessor";
import { resolveNaiDiffusionModel } from "@/utils/image/naiDiffusionModels";
import {
  NAI_CHAR_REF_INFO_EXTRACTED,
  NAI_CHAR_REF_STRENGTH,
  NAI_DEFAULT_NEGATIVE_PROMPT,
  classifyNaiImageError,
  generateNovelAiImage,
  usesNaiStructuredPromptFormat,
  type NaiGenerationCharacterPayload,
} from "@/utils/image/naiImageGeneration";
import { loadCharRefAsBase64 } from "@/utils/storage/charrefStorage";
import {
  CredentialUnavailableError,
  getResolvedCapabilityModelId,
  resolveCapabilityCredentials,
} from "@/utils/provider/credentialResolver";

// Disabled by default because the suggest-tags endpoint is currently unstable and
// can hurt generation reliability; enable again once the API is consistently healthy.
const NAI_IMAGE_ENABLE_TAG_RESOLUTION =
  (process.env.NAI_IMAGE_ENABLE_TAG_RESOLUTION || "false").toLowerCase() === "true";
// Inpainting strength: denoising level for the masked region (0.0-1.0).
// 1.0 fully redraws the masked area from the prompt with no original pixel bleed-through.
// Lower values preserve more of the original structure but cause color blending artifacts
// when the edit changes colors (e.g. white hair → red hair at 0.7 produces grey).
const NAI_INPAINT_STRENGTH = Number.parseFloat(process.env.NAI_INPAINT_STRENGTH || "1.0");
const NAI_ENABLE_CHAR_REFERENCES = (process.env.NAI_ENABLE_CHAR_REFERENCES || "true").toLowerCase() === "true";
// Intentionally disabled: profile-driven autofill can conflict with inline tags the
// LLM picks from context. The LLM reads Physical Appearance tags from context and writes them
// directly into `tags`, so no DB merge needed.  Re-enable only after conflict resolution
// strategy is designed and validated.
const NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL = false;
const NAI_ENABLE_PROFILE_CHARACTER_REMOVE_TAGS = false;
const NAI_IMAGE_BASE_URL = "https://image.novelai.net";

/** Pattern to detect Japanese characters for language selection in tag suggestion */
const JAPANESE_CHAR_PATTERN = /[\u3000-\u9FFF\uF900-\uFAFF]/;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const POSITION_TO_COORD = {
  "far-left": 0.1,
  left: 0.3,
  center: 0.5,
  right: 0.7,
  "far-right": 0.9,
  top: 0.1,
  upper: 0.3,
  middle: 0.5,
  lower: 0.7,
  bottom: 0.9,
} as const;

type CharacterXPosition = "far-left" | "left" | "center" | "right" | "far-right";
type CharacterYPosition = "top" | "upper" | "middle" | "lower" | "bottom";

interface GenerateImageNaiCharacterArg {
  id?: string;
  tags?: string;
  remove_tags?: string | string[];
  spoken_text?: string;
  x: CharacterXPosition;
  y: CharacterYPosition;
}

interface NAIIdentityProfile {
  tags: string[];
  refUrl: string | null;
}

type UserProfileRepository = Pick<typeof userRepository, "loadByDiscordId">;

export async function loadUserNaiProfileByDiscordId(
  userDiscId: string,
  repository: UserProfileRepository = userRepository,
): Promise<NAIIdentityProfile | null> {
  const user = await repository.loadByDiscordId(userDiscId);
  if (!user) {
    return null;
  }

  return {
    tags: user.physical_appearance_tags ?? [],
    refUrl: user.nai_char_ref_url ?? null,
  };
}

function buildCharacterNoticeLines(locale: string, characters: GenerateImageNaiCharacterArg[]): string[] {
  return characters
    .map((character, index) => {
      const tags = typeof character.tags === "string" ? character.tags.trim() : "";
      if (!tags) {
        return "";
      }

      return localizer(locale, "tools.image.notice_character_prompt_line", {
        index: (index + 1).toString(),
        prompt: `\`${tags}\``,
      });
    })
    .filter((line) => line.length > 0);
}

/**
 * Response shape from NovelAI's suggest-tags endpoint
 */
interface SuggestTagsResponse {
  tags: Array<{
    tag: string;
    confidence: number;
    count: number;
  }>;
}

/**
 * Tool for generating images using NovelAI's diffusion models.
 * Uses imageboard-style tag prompts instead of natural language descriptions.
 */
export class GenerateImageNaiTool extends BaseTool {
  name = "generate_image_nai";
  description =
    "Generate an anime-styled AI image with NovelAI diffusion's uncensored models. Use this only when the user explicitly asks you to make, draw, generate, create, edit, or continue an image; do not call it for casual visual discussion. If the user asks you to make/draw/generate an image and this tool is available, call this tool instead of only describing the image. Put shared scene, background, composition, camera, lighting, atmosphere, and style tags in 'prompt'. Use 'characters' for visible people in the image, and describe each character fully in that character's 'tags'. When known users or personas have Physical Appearance context, copy the relevant comma-separated tags into the matching character tags.";
  category = "utility" as const;
  requiresFeatureFlag = "image_gen";
  requiresFollowUp = true; // Allow model to generate a text response after image is sent, preventing orphaned self-reply

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Imageboard-style tags for the shared scene: background, composition, camera, lighting, atmosphere, style, and quality, separated by commas (e.g. 'indoors, wooden chair, dutch angle'). When 'characters' is provided, keep this scene-level only; put each character's appearance, action, interaction, nudity/outfit state, and other per-character details in that character's 'tags'. For inpainting, describe what should replace the masked region.",
      },
      artist: {
        type: "string",
        description:
          "Optional comma-separated artist names to emulate their art style (e.g. 'jjune, wanke'). Do not fill up if user did not explicitly mention a style.",
      },
      location: {
        type: "string",
        description: "Optional comma-separated location/background setting tags (e.g. 'park, cherry blossoms').",
      },
      orientation: {
        type: "string",
        description:
          "Image orientation/aspect ratio. 'portrait' (832x1216), 'landscape' (1216x832), or 'square' (1024x1024). Default: portrait. Ignored in inpaint mode (uses source image dimensions).",
        enum: ["portrait", "landscape", "square"],
      },
      characters: {
        type: "array",
        description:
          "Visible characters in the image. Each array item is one character instance. In multi-character scenes, give every intended visible character its own entry and its own role tags. Always describe that character's full appearance plus what they are doing in that same entry's 'tags', especially exact name tag if it exists (eg. hataya misuzu, hatsune miku). If Physical Appearance tags for a known character are shown in conversation context, copy the relevant ones into 'tags'.",
        items: {
          type: "object",
          properties: {
            tags: {
              type: "string",
              description:
                "Required. Imageboard-style tags for this character. Include the full appearance plus that character's role in the scene: hair, eyes, outfit or nude state, body traits, pose, action, expression, gaze, and interaction as needed, and then add [brackets] to strengthen tags to the model, and {braces} to weaken them if needed (eg. '1girl, {{chibi}}, black hair, ponytail, brown eyes, medium breasts, white shirt, black skirt, [[school uniform]], eating, hotdog, sitting'). In multi-character scenes, every visible character needs their own full tags. If Physical Appearance tags for a known character are shown in conversation context, copy them here to the correct corresponding character before adding scene-specific actions or expressions. For erotic scenes, omit relevant clothing tags and directly use explicit tags saying what's visible and what the act/position is (eg. 'nude, pussy, penis, sex') when that is the intended result.",
            },
            spoken_text: {
              type: "string",
              description:
                "Optional speech/dialogue text this character is saying (e.g. 'Hello there!'). Only use this if user explicitly asks for it. Only English is available.",
            },
            x: {
              type: "string",
              description: "Horizontal position.",
              enum: ["far-left", "left", "center", "right", "far-right"],
            },
            y: {
              type: "string",
              description: "Vertical position.",
              enum: ["top", "upper", "middle", "lower", "bottom"],
            },
          },
          required: ["tags", "x", "y"],
        },
      },
      /* Inpainting parameters temporarily disabled
      media_id: {
        type: "string",
        description:
          "Optional: The media reference ID (e.g., media_1) from the system hint for the message containing the image to edit. When provided with edit_target, enables inpainting mode. The first image found in the message (attachment, embed, sticker, or emoji) will be used as the source.",
      },
      edit_target: {
        type: "string",
        description:
          "Optional: Natural language description of the region to edit (e.g. 'background', 'hair', 'cat'). Required when media_id is provided. Gemini AI will segment this region to create an inpainting mask.",
      },
      */
    },
    required: ["prompt"],
  };

  /**
   * NovelAI image generation is available for any provider that supports tools.
   * When the active provider is not 'novelai', the tool requires a NovelAI opt API key
   * (checked by the tool registry's post-filtering in getAvailableToolsWithMCP).
   * @returns Always true, so actual availability is gated by opt key check in the registry
   */
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  /**
   * Hide the tool unless a NovelAI image slot is configured for the active state.
   */
  isAvailableForContext(_provider: string, context?: ToolContext): boolean {
    return (context?.tomoriState.config.nai_diffusion_model_id ?? null) !== null;
  }

  /**
   * Check if image generation is enabled in Tomori config
   * @returns True if image generation feature flag is enabled
   */
  protected isEnabled(context: ToolContext): boolean {
    return context.tomoriState.config.imagegen_enabled;
  }

  /**
   * Sends a generated image to the Discord channel via webhook (for persona avatar) or direct message.
   * Prefers webhook for consistent persona appearance, falls back to bot message.
   */
  private async sendGeneratedImage(
    context: ToolContext,
    attachment: AttachmentBuilder,
    attachmentFilename: string,
    elapsedMs: number,
  ): Promise<import("discord.js").Message> {
    const threadId =
      "isThread" in context.channel && typeof context.channel.isThread === "function" && context.channel.isThread()
        ? context.channel.id
        : undefined;
    const componentsPayload = buildGeneratedImageComponentsV2Payload(attachmentFilename, elapsedMs, context.locale);

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
        log.warn(
          "Failed to send NAI generated image via webhook with Components V2, retrying without components",
          error,
        );
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
          log.warn(
            "Failed to send NAI generated image via webhook, falling back to bot message",
            fallbackError as Error,
          );
        }
      }
    }

    try {
      return await context.channel.send({
        files: [attachment],
        ...componentsPayload,
      });
    } catch (error) {
      log.warn("Failed to send NAI generated image with Components V2, falling back to attachment-only message", error);
      return await context.channel.send({ files: [attachment] });
    }
  }

  /**
   * Calls NovelAI's suggest-tags API to normalize a single tag.
   * Automatically detects Japanese characters for language selection.
   * @param tag - The raw tag to normalize
   * @returns The best-matching normalized tag, or the original if suggestion fails
   */
  private async suggestTag(tag: string, model: string, apiKey: string): Promise<string> {
    try {
      const lang = JAPANESE_CHAR_PATTERN.test(tag) ? "jp" : "en";

      const response = await fetch(`${NAI_IMAGE_BASE_URL}/ai/generate-image/suggest-tags`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: tag,
          lang,
        }),
      });

      if (!response.ok) {
        log.warn(`NAI suggest-tags failed for "${tag}": ${response.status} ${response.statusText}`);
        return tag;
      }

      const data = (await response.json()) as SuggestTagsResponse;

      if (data.tags && data.tags.length > 0) {
        const bestMatch = data.tags.reduce((best, current) => (current.confidence > best.confidence ? current : best));
        return bestMatch.tag;
      }

      return tag;
    } catch (error) {
      log.warn(`NAI suggest-tags error for "${tag}": ${(error as Error).message}`);
      return tag;
    }
  }

  /**
   * Normalizes all tags in the prompt by calling the suggest-tags API in parallel.
   * Each tag is independently resolved; failures fall back to the original tag.
   * @param tags - Array of raw tags to normalize
   * @returns Array of normalized tags in the same order
   */
  private async normalizeTags(tags: string[], model: string, apiKey: string): Promise<string[]> {
    const results = await Promise.allSettled(tags.map((tag) => this.suggestTag(tag, model, apiKey)));

    return results.map((result, index) => (result.status === "fulfilled" ? result.value : tags[index]));
  }

  /**
   * Checks whether the given model codename is a v4+ model that requires the v4_prompt format.
   * V4 models use a structured caption object instead of a flat prompt string.
   * @returns True if the model requires v4_prompt format
   */
  /**
   * Derive the inpainting model codename from the base model.
   * NovelAI inpainting models use a `-inpainting` suffix and are NOT stored
   * in the `image_diffusion_models` table, so the codename is derived at runtime.
   * @param baseCodename - Base model codename (e.g. "nai-diffusion-4-5-curated")
   * @returns Inpainting model codename (e.g. "nai-diffusion-4-5-curated-inpainting")
   */
  private getInpaintingModelCodename(baseCodename: string): string {
    return `${baseCodename}-inpainting`;
  }

  /**
   * @returns Decrypted Google API key, or null if unavailable
   */
  private async resolveGoogleApiKey(context: ToolContext): Promise<string | null> {
    const savedGoogleConfig = await llmProviderRepo.loadSavedProviderConfig(context.tomoriState.server_id, "google");
    if (savedGoogleConfig?.api_key) {
      return await decryptApiKey(savedGoogleConfig.api_key, savedGoogleConfig.key_version || 1);
    }

    return null;
  }

  private parsePersonaIdentifier(rawId: string): number | null {
    const prefixedMatch = rawId.match(/^persona:(\d+)$/i);
    if (prefixedMatch) {
      return Number.parseInt(prefixedMatch[1], 10);
    }

    if (/^\d+$/.test(rawId) && !DISCORD_SNOWFLAKE_PATTERN.test(rawId)) {
      return Number.parseInt(rawId, 10);
    }

    return null;
  }

  private async loadPersonaNaiProfile(serverId: number, personaId: number): Promise<NAIIdentityProfile | null> {
    const rows = await sql<
      Array<{
        physical_appearance_tags: string[] | null;
        nai_char_ref_url: string | null;
      }>
    >`
			SELECT physical_appearance_tags, nai_char_ref_url
			FROM personas
			WHERE server_id = ${serverId}
			  AND persona_id = ${personaId}
			LIMIT 1
		`;

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      tags: row.physical_appearance_tags ?? [],
      refUrl: row.nai_char_ref_url,
    };
  }

  private validateCharacterArgs(characters: GenerateImageNaiCharacterArg[], context: ToolContext): string | null {
    for (const [index, character] of characters.entries()) {
      const hasId = typeof character.id === "string" && character.id.trim().length > 0;
      const hasTags = typeof character.tags === "string" && character.tags.trim().length > 0;

      if (!hasId && !hasTags) {
        return localizer(context.locale, "tools.generate_image_nai.character_requires_id_or_tags", {
          index: (index + 1).toString(),
        });
      }
    }

    return null;
  }

  private async buildCharacterPayload(
    characters: GenerateImageNaiCharacterArg[],
    context: ToolContext,
  ): Promise<NaiGenerationCharacterPayload> {
    const allowCharacterReferences =
      NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL && NAI_ENABLE_CHAR_REFERENCES && characters.length === 1;
    const charCaptions: NaiGenerationCharacterPayload["charCaptions"] = [];
    const negativeCharCaptions: NaiGenerationCharacterPayload["negativeCharCaptions"] = [];
    const characterPrompts: NaiGenerationCharacterPayload["characterPrompts"] = [];
    const referenceImages: string[] = [];
    const referenceStrengths: number[] = [];
    const referenceInfoExtracted: number[] = [];
    let skippedReferenceBecauseDisabled = false;
    let skippedReferenceBecauseMultiCharacter = false;
    let skippedReferenceBecauseTagRemoval = false;
    const seenCharacterIds = new Set<string>();

    for (const character of characters) {
      const rawId = typeof character.id === "string" ? character.id.trim() : undefined;
      const clientUserId = context.client.user?.id;
      const normalizedId = NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL
        ? (rawId === "self" || (clientUserId && rawId === clientUserId && context.tomoriState.persona_id != null)) &&
          context.tomoriState.persona_id
          ? `persona:${context.tomoriState.persona_id}`
          : rawId
        : undefined;

      if (
        NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL &&
        rawId &&
        clientUserId &&
        rawId === clientUserId &&
        context.tomoriState.persona_id != null
      ) {
        log.info(
          `[NAI] Remapped bot user ID ${rawId} to active persona persona:${context.tomoriState.persona_id} for character profile resolution`,
        );
      }

      if (!NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL && rawId) {
        log.info(
          `[NAI] Character ${charCaptions.length + 1} provided id=${rawId}, but profile-driven character autofill is currently disabled; using inline tags only`,
        );
      }

      if (normalizedId) {
        if (seenCharacterIds.has(normalizedId)) {
          log.warn(
            `[NAI] Duplicate character id=${normalizedId} detected in one generation request; each characters[] entry is treated as a separate character instance, so remove_tags and tags do not carry across entries`,
          );
        } else {
          seenCharacterIds.add(normalizedId);
        }
      }

      let resolvedTags: string[] = [];
      let refImageBase64: string | null = null;

      if (normalizedId) {
        const personaId = this.parsePersonaIdentifier(normalizedId);
        let foundProfile = false;

        if (personaId !== null) {
          const personaProfile = await this.loadPersonaNaiProfile(context.tomoriState.server_id, personaId);
          foundProfile = personaProfile !== null;
          resolvedTags = personaProfile?.tags ?? [];

          if (personaProfile?.refUrl && allowCharacterReferences) {
            refImageBase64 = await loadCharRefAsBase64(personaProfile.refUrl);
          } else if (personaProfile?.refUrl) {
            if (NAI_ENABLE_CHAR_REFERENCES) {
              skippedReferenceBecauseMultiCharacter = true;
            } else {
              skippedReferenceBecauseDisabled = true;
            }
          }
        } else if (DISCORD_SNOWFLAKE_PATTERN.test(normalizedId)) {
          const userProfile = await loadUserNaiProfileByDiscordId(normalizedId);
          foundProfile = userProfile !== null;
          resolvedTags = userProfile?.tags ?? [];

          if (userProfile?.refUrl && allowCharacterReferences) {
            refImageBase64 = await loadCharRefAsBase64(userProfile.refUrl);
          } else if (userProfile?.refUrl) {
            if (NAI_ENABLE_CHAR_REFERENCES) {
              skippedReferenceBecauseMultiCharacter = true;
            } else {
              skippedReferenceBecauseDisabled = true;
            }
          }
        } else {
          throw new Error(
            localizer(context.locale, "tools.generate_image_nai.invalid_character_identity", {
              id: normalizedId,
            }),
          );
        }

        if (!foundProfile) {
          log.warn(
            `[NAI] No saved character profile was found for id=${normalizedId}; using only inline character tags for this entry`,
          );
        } else if (resolvedTags.length === 0) {
          log.warn(
            `[NAI] Saved character profile for id=${normalizedId} has no physical appearance tags; inline action tags alone may render as a generic character`,
          );
        }
      }

      const manualTags =
        typeof character.tags === "string"
          ? character.tags
              .split(/[,\u3001]/)
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0)
          : [];
      const removeTags = NAI_ENABLE_PROFILE_CHARACTER_REMOVE_TAGS
        ? typeof character.remove_tags === "string"
          ? character.remove_tags
              .split(/[,\u3001]/)
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0 && tag.toLowerCase() !== "none")
          : Array.isArray(character.remove_tags)
            ? character.remove_tags.flatMap((tag) =>
                typeof tag === "string"
                  ? tag
                      .split(/[,\u3001]/)
                      .map((innerTag) => innerTag.trim())
                      .filter((innerTag) => innerTag.length > 0 && innerTag.toLowerCase() !== "none")
                  : [],
              )
            : []
        : [];
      if (
        !NAI_ENABLE_PROFILE_CHARACTER_REMOVE_TAGS &&
        ((typeof character.remove_tags === "string" &&
          character.remove_tags.trim().length > 0 &&
          character.remove_tags.trim().toLowerCase() !== "none") ||
          (Array.isArray(character.remove_tags) &&
            character.remove_tags.some((tag) => typeof tag === "string" && tag.trim().length > 0)))
      ) {
        log.info(
          `[NAI] Character ${charCaptions.length + 1} provided remove_tags, but remove-tag suppression is currently disabled; using inline tags only`,
        );
      }
      if (manualTags.length === 0) {
        throw new Error(
          "Each generate_image_nai character now requires inline tags describing that character's appearance and role in the scene.",
        );
      }
      const removeTagSet = new Set(removeTags.map((tag) => tag.toLowerCase()));
      if (normalizedId && removeTags.length > 0 && manualTags.length === 0) {
        log.warn(
          `[NAI] Character ${charCaptions.length + 1} uses remove_tags without replacement tags; removing old appearance tags alone does not imply a new state, so NovelAI may invent defaults unless the desired replacement is added in tags`,
        );
      }
      const matchedResolvedRemoveTags = resolvedTags.filter((tag) => removeTagSet.has(tag.toLowerCase()));
      const matchedManualRemoveTags = manualTags.filter((tag) => removeTagSet.has(tag.toLowerCase()));
      const matchedRemoveTags = [...matchedManualRemoveTags, ...matchedResolvedRemoveTags];
      const unmatchedRemoveTags = removeTags.filter(
        (tag) =>
          !manualTags.some((manualTag) => manualTag.toLowerCase() === tag.toLowerCase()) &&
          !resolvedTags.some((resolvedTag) => resolvedTag.toLowerCase() === tag.toLowerCase()),
      );
      const filteredManualTags = manualTags.filter((tag) => !removeTagSet.has(tag.toLowerCase()));
      const filteredResolvedTags = resolvedTags.filter((tag) => !removeTagSet.has(tag.toLowerCase()));
      const finalTags = [...filteredManualTags, ...filteredResolvedTags].join(", ");
      const negativeTags = removeTags.join(", ");
      const logCharacterId =
        normalizedId ?? (rawId && !NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL ? `ignored(${rawId})` : "manual");
      const center = {
        x: POSITION_TO_COORD[character.x],
        y: POSITION_TO_COORD[character.y],
      };

      log.info(
        `[NAI] Character payload ${charCaptions.length + 1}: id=${logCharacterId}, tags="${finalTags.substring(0, 200)}${finalTags.length > 200 ? "..." : ""}", remove_tags="${negativeTags.substring(0, 200)}${negativeTags.length > 200 ? "..." : ""}"`,
      );
      if (NAI_ENABLE_PROFILE_CHARACTER_AUTOFILL || NAI_ENABLE_PROFILE_CHARACTER_REMOVE_TAGS) {
        log.info(
          `[NAI] Character resolution ${charCaptions.length + 1}: profile_tags="${resolvedTags.join(", ").substring(0, 240)}${resolvedTags.join(", ").length > 240 ? "..." : ""}", matched_remove_tags="${matchedRemoveTags.join(", ").substring(0, 240)}${matchedRemoveTags.join(", ").length > 240 ? "..." : ""}", unmatched_remove_tags="${unmatchedRemoveTags.join(", ").substring(0, 240)}${unmatchedRemoveTags.join(", ").length > 240 ? "..." : ""}"`,
        );
      }
      log.info(`[NAI][debug] Character ${charCaptions.length + 1} full positive tags: ${finalTags}`);
      log.info(`[NAI][debug] Character ${charCaptions.length + 1} full negative tags: ${negativeTags}`);

      charCaptions.push({
        char_caption: finalTags,
        centers: [center],
      });
      negativeCharCaptions.push({
        char_caption: negativeTags,
        centers: [center],
      });
      characterPrompts.push({
        center,
        enabled: true,
        prompt: finalTags,
        uc: negativeTags,
      });

      if (refImageBase64 && removeTags.length > 0) {
        skippedReferenceBecauseTagRemoval = true;
        refImageBase64 = null;
      }

      if (refImageBase64) {
        try {
          const normalizedRefBuffer = await normalizeNaiReferenceImage(Buffer.from(refImageBase64, "base64"));
          referenceImages.push(normalizedRefBuffer.toString("base64"));
          referenceStrengths.push(NAI_CHAR_REF_STRENGTH);
          referenceInfoExtracted.push(NAI_CHAR_REF_INFO_EXTRACTED);
        } catch (error) {
          log.warn("[NAI] Failed to normalize character reference image; continuing without this reference", error);
        }
      }
    }

    if (skippedReferenceBecauseDisabled) {
      log.warn(
        "[NAI] Character references resolved but skipped because NAI_ENABLE_CHAR_REFERENCES is disabled; positioned character prompting will continue without saved reference images",
      );
    }
    if (skippedReferenceBecauseMultiCharacter) {
      log.warn(
        "[NAI] Character references were skipped because multi-character generations use whole-image reference guidance; positioned character prompting will continue with character tags only",
      );
    }
    if (skippedReferenceBecauseTagRemoval) {
      log.warn(
        "[NAI] Character references were skipped because remove_tags was used; saved refs can reinforce suppressed appearance traits, so positioned character prompting will continue with tags plus per-character negatives only",
      );
    }

    return {
      useCoords: charCaptions.length > 1,
      charCaptions,
      negativeCharCaptions,
      characterPrompts,
      referenceImages,
      referenceStrengths,
      referenceInfoExtracted,
    };
  }

  /**
   * Calls NovelAI's infill (inpainting) endpoint with a source image and mask.
   *
   * Flow:
   * 1. Build infill request payload with inpainting model, image, and mask
   * 2. Send POST request to NovelAI image generation endpoint
   * 3. Extract the resulting PNG from the ZIP response
   *
   * @param prompt - Tag prompt describing what to draw in the masked region
   * @param imageBase64 - Base64-encoded source image
   * @param maskBase64 - Base64-encoded mask (white = redraw, black = preserve)
   * @returns Buffer containing the inpainted PNG image data
   */
  private async generateInpaintImage(
    apiKey: string,
    model: string,
    prompt: string,
    negativePrompt: string,
    imageBase64: string,
    maskBase64: string,
    width: number,
    height: number,
    imageParams: EffectiveNaiImageParams,
  ): Promise<Buffer> {
    const seed = Math.floor(Math.random() * 2147483647);

    let requestPayload: Record<string, unknown>;

    if (usesNaiStructuredPromptFormat(model)) {
      requestPayload = {
        action: "infill",
        input: prompt,
        model,
        parameters: {
          prompt,
          negative_prompt: negativePrompt,
          seed,
          n_samples: 1,
          width,
          height,
          steps: imageParams.steps,
          scale: imageParams.scale,
          uncond_scale: 0.0,
          cfg_rescale: imageParams.cfgRescale,
          sampler: imageParams.sampler,
          noise_schedule: imageParams.noiseSchedule,
          legacy_v3_extend: false,
          image: imageBase64,
          mask: maskBase64,
          add_original_image: true,
          strength: NAI_INPAINT_STRENGTH,
          reference_information_extracted_multiple: [],
          reference_strength_multiple: [],
          v4_prompt: {
            caption: {
              base_caption: prompt,
              char_captions: [],
            },
            use_coords: false,
            use_order: true,
            legacy_uc: false,
          },
          v4_negative_prompt: {
            caption: {
              base_caption: negativePrompt,
              char_captions: [],
            },
            use_coords: false,
            use_order: false,
            legacy_uc: false,
          },
          controlnet_strength: 1.0,
          controlnet_model: null,
          dynamic_thresholding: false,
          dynamic_thresholding_percentile: 0.999,
          dynamic_thresholding_mimic_scale: 10.0,
          sm: false,
          sm_dyn: false,
          skip_cfg_above_sigma: null,
          skip_cfg_below_sigma: 0.0,
          lora_unet_weights: null,
          lora_clip_weights: null,
          deliberate_euler_ancestral_bug: false,
          prefer_brownian: true,
          cfg_sched_eligibility: "enable_for_post_summer_samplers",
          explike_fine_detail: false,
          minimize_sigma_inf: false,
          uncond_per_vibe: true,
          wonky_vibe_correlation: true,
          version: 1,
          uc: negativePrompt,
          request_type: "PromptGenerateRequest",
        },
      };
    } else {
      requestPayload = {
        action: "infill",
        input: prompt,
        model,
        parameters: {
          width,
          height,
          steps: imageParams.steps,
          scale: imageParams.scale,
          sampler: imageParams.sampler,
          noise_schedule: imageParams.noiseSchedule,
          n_samples: 1,
          seed,
          image: imageBase64,
          mask: maskBase64,
          add_original_image: true,
          strength: NAI_INPAINT_STRENGTH,
          negative_prompt: negativePrompt,
        },
      };
    }

    log.info(`[NAI] Inpainting with model "${model}" (seed: ${seed})`);

    const response = await fetch(`${NAI_IMAGE_BASE_URL}/ai/generate-image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      const correlationId = response.headers.get("x-correlation-id");
      const errorText = await response.text().catch(() => "");
      const snippet = errorText.slice(0, 500);
      throw new Error(
        `NovelAI inpainting failed (${response.status} ${response.statusText})${correlationId ? ` [correlation-id: ${correlationId}]` : ""}: ${snippet}`,
      );
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBuffer);

    const pngFileName = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith(".png"));

    if (!pngFileName) {
      throw new Error("NovelAI inpainting response ZIP did not contain a PNG file");
    }

    const pngData = await zip.files[pngFileName].async("nodebuffer");
    return Buffer.from(pngData);
  }

  /**
   * Execute NovelAI image generation.
   *
   * Flow:
   * 1. Validate parameters and feature flag
   * 2. Check image quota
   * 3. Get diffusion model and decrypt API key
   * 4. Resolve base scene tags and optional positioned character identities
   * 5. Resolve prompt tags via suggest-tags API (optional; disabled by default)
   * 6. Generate image via NAI API
   * 7. Send image to Discord channel
   * 8. Increment quota and return success
   *
   * @param args - Tool arguments (prompt, orientation, characters, inpaint params)
   * @returns Tool result with success/error status
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
    const orientation = (args.orientation as string) || "portrait";
    const artistRaw = (args.artist as string | undefined)?.trim();
    const locationRaw = (args.location as string | undefined)?.trim();
    const characters = Array.isArray(args.characters) ? (args.characters as GenerateImageNaiCharacterArg[]) : [];
    const messageId = args.media_id as string | undefined;
    const editTarget = args.edit_target as string | undefined;

    const isInpaintMode = !!(messageId && editTarget);
    const characterValidationError = this.validateCharacterArgs(characters, context);

    if (characterValidationError) {
      return {
        success: false,
        error: characterValidationError,
      };
    }

    // Default to allowed; overwritten below for server-credential users
    let quotaCheck: QuotaCheckResult = { allowed: true };

    try {
      // Resolve credentials first so we can skip server quota for personal BYOK users
      const creds = await resolveCapabilityCredentials(context.tomoriState.server_id, "image-nai", {
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

      const resolvedConfig = {
        ...context.tomoriState.config,
        nai_diffusion_model_id:
          getResolvedCapabilityModelId(creds, "image-nai") ?? context.tomoriState.config.nai_diffusion_model_id,
      };

      // Resolve the dedicated NovelAI diffusion model slot.
      const resolvedModel = await resolveNaiDiffusionModel(resolvedConfig);
      if (!resolvedModel) {
        return {
          success: false,
          error: localizer(context.locale, "tools.generate_image_nai.model_not_configured"),
        };
      }
      const baseModelCodename = resolvedModel.codename;

      log.info(
        `Using NAI diffusion model: ${baseModelCodename} (source: ${resolvedModel.source}) for ${isInpaintMode ? "inpainting" : "image generation"}`,
      );

      if (characters.length > 0 && !usesNaiStructuredPromptFormat(baseModelCodename)) {
        return {
          success: false,
          error: localizer(context.locale, "tools.generate_image_nai.characters_require_v4"),
        };
      }

      const apiKey = creds.apiKey;

      if (!context.suppressProgressNotices) {
        const baseNoticeDescription = localizer(
          context.locale,
          isInpaintMode ? "tools.image.editing_description" : "tools.image.generating_description",
          isInpaintMode ? { edit_target: editTarget as string } : undefined,
        );
        const extraNoticeLines: string[] = [];
        if (messageId) {
          const referencedMessageUrl = buildReferencedMessageUrl(context, messageId);
          extraNoticeLines.push(
            referencedMessageUrl
              ? localizer(context.locale, "tools.image.notice_reference_line", {
                  message_url: referencedMessageUrl,
                })
              : localizer(context.locale, "tools.image.notice_reference_count_line", {
                  count: "1",
                }),
          );
        }
        extraNoticeLines.push(...buildCharacterNoticeLines(context.locale, characters));
        extraNoticeLines.push("");
        extraNoticeLines.push(localizer(context.locale, "tools.image.notice_image_tags_tip_line"));
        await sendToolProgressNotice(
          context,
          isInpaintMode ? "image_editing" : "image_generation",
          {
            titleKey: isInpaintMode ? "tools.image.editing_title" : "tools.image.generating_title",
            description: buildImageToolNoticeDescription(
              context.locale,
              baseNoticeDescription,
              baseModelCodename,
              prompt,
              localizer(context.locale, "tools.image.generating_footer"),
              extraNoticeLines,
            ),
            color: ColorCode.INFO,
          },
          "GenerateImageNaiTool",
        );
      }

      // Build base scene tag list, so server style tags are trusted and should
      //    bypass suggest-tags normalization. Character tags are handled separately
      //    through v4_prompt.caption.char_captions when characters[] is provided.
      const effectiveImageParams = resolveNaiImageParams(context.tomoriState.config);
      const styleTags = context.tomoriState.config.image_default_positive_tags ?? [];
      const configuredNegativeTags = context.tomoriState.config.image_default_negative_tags ?? [];
      const effectiveNegativePrompt =
        configuredNegativeTags.length > 0 ? configuredNegativeTags.join(", ") : NAI_DEFAULT_NEGATIVE_PROMPT;

      if (configuredNegativeTags.length === 0) {
        log.info("[NAI] Server negative tags are empty; using fallback negative prompt from env");
      }

      const modelTags = prompt
        .split(/[,\u3001]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const trustedTags = [...styleTags];

      // Resolve only the model-provided tags via suggest-tags API when enabled
      const resolvedModelTags = NAI_IMAGE_ENABLE_TAG_RESOLUTION
        ? await this.normalizeTags(modelTags, baseModelCodename, apiKey)
        : modelTags;

      if (!NAI_IMAGE_ENABLE_TAG_RESOLUTION) {
        log.info("[NAI] Tag resolution via suggest-tags is disabled; using raw model-provided tags");
      }

      // Prepend artist:/location: prefixed tags when provided (trusted, skip normalization)
      const specialPrefixTags: string[] = [];
      if (artistRaw) {
        for (const name of artistRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          specialPrefixTags.push(`artist:${name}`);
        }
      }
      if (locationRaw) {
        for (const loc of locationRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          specialPrefixTags.push(`location:${loc}`);
        }
      }

      // Combine: trusted tags first (as-is), then resolved/raw model tags
      const normalizedTags = [...specialPrefixTags, ...trustedTags, ...resolvedModelTags];

      // Build spoken text section for the base prompt when characters have dialogue.
      // NAI expects "text, english text" tags, a natural-language attribution line per
      // speaking character, and a trailing "Text: ..." line (newline-separated if multiple).
      const spokenEntries: { index: number; text: string }[] = [];
      for (let i = 0; i < characters.length; i++) {
        const raw = characters[i].spoken_text;
        const trimmed = typeof raw === "string" ? raw.trim() : "";
        if (trimmed) {
          spokenEntries.push({ index: i, text: trimmed });
        }
      }

      if (spokenEntries.length > 0) {
        normalizedTags.push("text", "english text");
      }

      let normalizedPrompt = normalizedTags.join(", ");

      if (spokenEntries.length > 0) {
        const ordinals = [
          "first",
          "second",
          "third",
          "fourth",
          "fifth",
          "sixth",
          "seventh",
          "eighth",
          "ninth",
          "tenth",
        ];
        const attributions = spokenEntries.map(({ index, text }) => {
          const label =
            characters.length === 1 ? "The character" : `The ${ordinals[index] ?? `#${index + 1}`} character`;
          return `${label} is saying "${text}"`;
        });
        const combinedDialogue = spokenEntries.map(({ text }) => text).join(" ");

        normalizedPrompt += `. ${attributions.join(", and ")}. Text: ${combinedDialogue}`;
      }
      log.info(
        `[NAI] Normalized prompt: "${normalizedPrompt.substring(0, 200)}${normalizedPrompt.length > 200 ? "..." : ""}"`,
      );

      let characterPayload: NaiGenerationCharacterPayload | undefined;
      if (!isInpaintMode && characters.length > 0) {
        characterPayload = await this.buildCharacterPayload(characters, context);
        log.info(
          `[NAI] Resolved ${characterPayload.charCaptions?.length ?? 0} character(s) with ${characterPayload.referenceImages?.length ?? 0} reference image(s)`,
        );
        log.info(`[NAI][debug] Full base prompt: ${normalizedPrompt}`);
        log.info(`[NAI][debug] Full base negative prompt: ${effectiveNegativePrompt}`);
      } else if (isInpaintMode && characters.length > 0) {
        log.info(
          "[NAI] Ignoring characters[] during inpainting; the source image already contains the character layout",
        );
      }

      let imageBuffer: Buffer;

      if (isInpaintMode) {
        log.info(`[NAI] Inpaint mode: extracting image from message ${messageId}, target="${editTarget}"`);

        const extractedImages = await extractImagesFromMessage(messageId, context);

        const sourceImage = extractedImages[0];

        const googleApiKey = await this.resolveGoogleApiKey(context);
        if (!googleApiKey) {
          return {
            success: false,
            error: localizer(context.locale, "tools.generate_image_nai.no_google_api_key"),
          };
        }

        log.info(`[NAI] Calling Gemini segmentation for target: "${editTarget}"`);

        const segResult = await segmentImage(
          sourceImage.data,
          sourceImage.mimeType,
          editTarget,
          googleApiKey,
          usesNaiStructuredPromptFormat(baseModelCodename),
        );

        log.info(
          `[NAI] Segmentation complete: ${segResult.segmentCount} segment(s) found [${segResult.labels.join(", ")}]`,
        );

        // If debug mode is enabled, DM the invoking user the mask and bbox overlay
        if ((segResult.debugMaskBuffer || segResult.debugOverlayBuffer) && context.userId) {
          try {
            const debugUser = await context.client.users.fetch(context.userId);
            const debugFiles: AttachmentBuilder[] = [];
            const ts = Date.now();

            if (segResult.debugOverlayBuffer) {
              debugFiles.push(
                new AttachmentBuilder(segResult.debugOverlayBuffer, {
                  name: `inpaint_bbox_debug_${ts}.png`,
                }),
              );
            }

            if (segResult.debugMaskBuffer) {
              debugFiles.push(
                new AttachmentBuilder(segResult.debugMaskBuffer, {
                  name: `inpaint_mask_debug_${ts}.png`,
                }),
              );
            }

            await debugUser.send({
              content: `**[NAI Inpaint Debug]** Segmentation for "${editTarget}" (${segResult.segmentCount} segment(s): ${segResult.labels.join(", ")})\nImage 1: Bounding box overlay | Image 2: Binary mask`,
              files: debugFiles,
            });
            log.info("[NAI] Sent debug segmentation images to user via DM");
          } catch (dmErr) {
            log.warn("[NAI] Failed to send debug DM (user may have DMs disabled)", dmErr as Error);
          }
        }

        const inpaintModel = this.getInpaintingModelCodename(baseModelCodename);

        imageBuffer = await this.generateInpaintImage(
          apiKey,
          inpaintModel,
          normalizedPrompt,
          effectiveNegativePrompt,
          sourceImage.data,
          segResult.maskBase64,
          segResult.imageWidth,
          segResult.imageHeight,
          effectiveImageParams,
        );

        log.success(`[NAI] Inpainting complete with model "${inpaintModel}"`);
      } else {
        imageBuffer = await generateNovelAiImage({
          apiKey,
          model: baseModelCodename,
          prompt: normalizedPrompt,
          negativePrompt: effectiveNegativePrompt,
          orientation,
          imageParams: effectiveImageParams,
          characterPayload,
          abortSignal: context.abortSignal,
        });
      }

      const filePrefix = isInpaintMode ? "nai_inpainted" : "nai_generated";
      const attachmentFilename = `${filePrefix}_${Date.now()}.png`;
      const attachment = new AttachmentBuilder(imageBuffer, {
        name: attachmentFilename,
      });

      const sentMessage = await this.sendGeneratedImage(
        context,
        attachment,
        attachmentFilename,
        Date.now() - startedAtMs,
      );

      log.success(`Successfully ${isInpaintMode ? "inpainted" : "generated"} and sent NAI image to Discord`);

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
          // Key by the base NAI model codename (inpaint variants collapse into their
          // base model) for a per-model breakdown at read time.
          metricKey: baseModelCodename,
        });
      }

      let successMessage: string;

      if (isInpaintMode) {
        successMessage = `Good job! The inpainted image has been generated and sent directly to the Discord chat (message ID: ${sentMessage.id}). The user can already see it, so do NOT generate another image unless asked. The edit targeted "${editTarget}" and applied tags: "${normalizedPrompt.substring(0, 100)}${normalizedPrompt.length > 100 ? "..." : ""}".`;
      } else {
        successMessage = `Good job! The image has been generated and sent directly to the Discord chat (message ID: ${sentMessage.id}). The user can already see it, so do NOT generate another image unless asked. The image was created using tags: "${normalizedPrompt.substring(0, 100)}${normalizedPrompt.length > 100 ? "..." : ""}".`;
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
        // imageMetadata intentionally omitted, so Discord CDN URLs are protected
        // End the LLM turn immediately when this tool is the target of a hidden agent turn
        endTurn: context.streamContext?.endTurnAfterTools?.includes(this.name) ?? false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorKind = classifyNaiImageError(error);

      log.error(`NAI ${isInpaintMode ? "inpainting" : "image generation"} failed:`, error as Error);

      if (errorKind === "quota") {
        return {
          success: false,
          error: localizer(context.locale, "tools.generate_image_nai.provider_quota_exceeded"),
        };
      }

      if (error instanceof CredentialUnavailableError && error.reason === "missing_model_id") {
        return {
          success: false,
          error: localizer(context.locale, "tools.generate_image_nai.model_not_configured"),
        };
      }

      if (errorKind === "auth") {
        return {
          success: false,
          error: "NovelAI API authentication failed. Please check your API key and subscription status.",
        };
      }

      if (errorKind === "rate_limit") {
        return {
          success: false,
          error: "NovelAI API rate limit reached. Please try again in a moment.",
        };
      }

      if (errorMessage.includes("segmentation") || errorMessage.includes("segment")) {
        return {
          success: false,
          error: `Segmentation failed: ${errorMessage}`,
        };
      }

      return {
        success: false,
        error: `Failed to ${isInpaintMode ? "inpaint" : "generate"} NAI image: ${errorMessage}`,
      };
    }
  }
}
