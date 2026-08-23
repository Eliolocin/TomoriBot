import type { StPresetNodeRow } from "@/types/db/schema";
import { findUnsupportedPresetMacros } from "@/utils/text/stPresetEngine";

/** Maximum file size for preset JSON uploads in MB */
export const MAX_PRESET_FILE_SIZE_MB = 2;

/** Maximum allowed preset name length (derived from filename) */
export const MAX_PRESET_NAME_LENGTH = 100;
const LEGACY_POST_HISTORY_INJECTION_ORDER = 10_000;
const LEGACY_STORY_TRIM_REGEX = /\{\{trim\}\}/gi;
const LEGACY_STORY_BLOCK_REGEX = /\{\{#if\s+([a-zA-Z_][\w]*)\}\}([\s\S]*?)\{\{\/if\}\}/gi;

/**
 * Regex to detect comment-only content in SillyTavern nodes.
 * Matches content that is purely `{{// ... }}` blocks and `{{trim}}` macros
 * with optional whitespace: meaning the node produces no output after
 * template resolution.
 */
const COMMENT_ONLY_REGEX = /^(\s*\{\{\/\/[^}]*\}\}\s*|\s*\{\{trim\}\}\s*)+$/;

/** Raw prompt node from SillyTavern preset JSON */
interface RawSTPromptNode {
  identifier: string;
  name: string;
  role?: string;
  content?: string;
  system_prompt?: boolean;
  marker?: boolean;
  enabled?: boolean;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  forbid_overrides?: boolean;
}

/** Entry in the prompt_order array */
interface RawSTPromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

/** Top-level structure of a SillyTavern preset JSON */
export interface RawSTPreset {
  prompts?: RawSTPromptNode[];
  prompt_order?: {
    character_id: number;
    order: RawSTPromptOrderEntry[];
  }[];
  [key: string]: unknown;
}

/** Result of parsing a preset, including nodes and filtering stats */
export interface ParseResult {
  nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[];
  /** Number of comment-only nodes included (stored but never injected into the prompt) */
  commentOnlyCount: number;
  /** Number of non-marker nodes disabled by the preset's prompt_order */
  disabledByPreset: number;
  /** Number of synthetic nodes added from legacy prompt fields */
  legacyNodeCount: number;
  /** Source format that was accepted by the importer */
  sourceKind: "modern" | "legacy_text_completion";
}

type JsonObject = Record<string, unknown>;
type PresetSourceKind = "modern" | "legacy_text_completion";

export interface NormalizedPresetShape {
  preset: RawSTPreset;
  sourceKind: PresetSourceKind;
  syntheticNodeCount: number;
}

/**
 * Validate that the attachment filename and optional content type indicate a JSON file.
 */
export function validateAttachment(
  filename: string,
  contentType?: string | null,
): {
  isValid: boolean;
  errorKey?: string;
} {
  const lowerFilename = filename.toLowerCase();

  if (!lowerFilename.endsWith(".json")) {
    return { isValid: false, errorKey: "invalid_format" };
  }

  // Check content type if provided (Discord may not always set this)
  if (contentType && !contentType.includes("json")) {
    return { isValid: false, errorKey: "invalid_format" };
  }

  return { isValid: true };
}

/**
 * Determine whether a prompt node is comment-only (produces no output).
 * Comment-only nodes contain only `{{// ... }}` blocks and `{{trim}}` macros.
 */
export function isCommentOnly(content: string): boolean {
  return COMMENT_ONLY_REGEX.test(content.trim());
}

/**
 * Strips the .json extension and truncates to MAX_PRESET_NAME_LENGTH.
 */
export function derivePresetName(filename: string): string {
  const name = filename
    .trim()
    .replace(/\.json$/i, "")
    .trim();
  return name.length > MAX_PRESET_NAME_LENGTH ? name.slice(0, MAX_PRESET_NAME_LENGTH) : name;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonObject;
}

function getStringField(obj: JsonObject | null, key: string): string | null {
  if (!obj) {
    return null;
  }

  const value = obj[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeLegacyStorySegment(content: string): string {
  return content.replace(LEGACY_STORY_TRIM_REGEX, "");
}

function hasMeaningfulLegacyStorySegment(content: string): boolean {
  return sanitizeLegacyStorySegment(content).trim().length > 0;
}

function createLegacyContentNode(identifier: string, name: string, content: string): RawSTPromptNode | null {
  const sanitizedContent = sanitizeLegacyStorySegment(content);
  if (sanitizedContent.trim().length === 0) {
    return null;
  }

  return {
    identifier,
    name,
    role: "system",
    content: sanitizedContent,
    enabled: true,
  };
}

function createLegacyMarkerNode(identifier: string, name: string): RawSTPromptNode {
  return {
    identifier,
    name,
    role: "system",
    marker: true,
    enabled: true,
  };
}

function buildLegacyTextCompletionPreset(raw: RawSTPreset): NormalizedPresetShape | null {
  const root = asObject(raw);
  const context = asObject(root?.context);
  const sysprompt = asObject(root?.sysprompt);

  const storyString = getStringField(context, "story_string");
  const syspromptContent = getStringField(sysprompt, "content");
  if (!storyString || !syspromptContent) {
    return null;
  }

  const prompts: RawSTPromptNode[] = [];
  let syntheticNodeCount = 0;
  let contentNodeIndex = 0;
  const usedMarkers = new Set<string>();

  const addContentNode = (name: string, content: string) => {
    const identifierSuffix = contentNodeIndex;
    contentNodeIndex += 1;
    const identifier = `legacyTextContent_${identifierSuffix}`;
    const node = createLegacyContentNode(identifier, name, content);
    if (!node) {
      return;
    }

    prompts.push(node);
    syntheticNodeCount++;
  };

  const addMarkerNode = (identifier: string, name: string) => {
    if (usedMarkers.has(identifier)) {
      return;
    }

    usedMarkers.add(identifier);
    prompts.push(createLegacyMarkerNode(identifier, name));
    syntheticNodeCount++;
  };

  const insertPlaceholderNodes = (
    body: string,
    placeholder: string,
    prefixName: string,
    replacementNodes: RawSTPromptNode[],
    suffixName = prefixName,
  ) => {
    const lowerBody = body.toLowerCase();
    const lowerPlaceholder = placeholder.toLowerCase();
    const placeholderIndex = lowerBody.indexOf(lowerPlaceholder);
    if (placeholderIndex === -1) {
      addContentNode(prefixName, body);
      return;
    }

    const prefix = body.slice(0, placeholderIndex);
    const suffix = body.slice(placeholderIndex + placeholder.length);

    addContentNode(`${prefixName} Prefix`, prefix);
    for (const node of replacementNodes) {
      if (node.marker) {
        addMarkerNode(node.identifier, node.name);
      } else if (node.content) {
        addContentNode(node.name, node.content);
      }
    }
    addContentNode(`${suffixName} Suffix`, suffix);
  };

  let lastIndex = 0;
  for (const match of storyString.matchAll(LEGACY_STORY_BLOCK_REGEX)) {
    const matchIndex = match.index ?? 0;
    const precedingLiteral = storyString.slice(lastIndex, matchIndex);
    if (hasMeaningfulLegacyStorySegment(precedingLiteral)) {
      addContentNode("Legacy Story Text", precedingLiteral);
    }

    const blockKey = match[1]?.trim().toLowerCase();
    const blockBody = match[2] ?? "";

    switch (blockKey) {
      case "system":
        insertPlaceholderNodes(blockBody, "{{system}}", "Legacy System Prompt", [
          createLegacyMarkerNode("main", "Main System Prompt"),
          {
            identifier: "legacyImportedSystemPrompt",
            name: "Imported Legacy System Prompt",
            role: "system",
            content: syspromptContent,
            enabled: true,
          },
        ]);
        break;
      case "wibefore":
        insertPlaceholderNodes(blockBody, "{{wiBefore}}", "Legacy World Info Before", [
          createLegacyMarkerNode("worldInfoBefore", "World Info Before"),
        ]);
        break;
      case "wiafter":
        insertPlaceholderNodes(blockBody, "{{wiAfter}}", "Legacy World Info After", [
          createLegacyMarkerNode("worldInfoAfter", "World Info After"),
        ]);
        break;
      case "description":
        insertPlaceholderNodes(blockBody, "{{description}}", "Legacy Character Description", [
          createLegacyMarkerNode("charDescription", "Character Description"),
        ]);
        break;
      case "personality":
        insertPlaceholderNodes(blockBody, "{{personality}}", "Legacy Character Personality", [
          createLegacyMarkerNode("charPersonality", "Character Personality"),
        ]);
        break;
      case "mesexamples":
        insertPlaceholderNodes(blockBody, "{{mesExamples}}", "Legacy Example Dialogue", [
          createLegacyMarkerNode("dialogueExamples", "Example Dialogues"),
        ]);
        break;
      case "persona":
      case "scenario":
      case "anchorbefore":
      case "anchorafter":
        break;
      default:
        if (hasMeaningfulLegacyStorySegment(blockBody)) {
          addContentNode(`Legacy ${blockKey ?? "Story"} Block`, blockBody);
        }
        break;
    }

    lastIndex = matchIndex + match[0].length;
  }

  const trailingLiteral = storyString.slice(lastIndex);
  if (hasMeaningfulLegacyStorySegment(trailingLiteral)) {
    addContentNode("Legacy Story Tail", trailingLiteral);
  }

  addMarkerNode("chatHistory", "Chat History");

  if (prompts.length === 0) {
    return null;
  }

  return {
    preset: {
      ...raw,
      prompts,
      prompt_order: [
        {
          character_id: 100001,
          order: prompts.map((prompt) => ({
            identifier: prompt.identifier,
            enabled: prompt.enabled !== false,
          })),
        },
      ],
    },
    sourceKind: "legacy_text_completion",
    syntheticNodeCount,
  };
}

export function normalizePresetShape(raw: RawSTPreset): NormalizedPresetShape | null {
  if (Array.isArray(raw.prompts) && raw.prompts.length > 0) {
    return {
      preset: raw,
      sourceKind: "modern",
      syntheticNodeCount: 0,
    };
  }

  return buildLegacyTextCompletionPreset(raw);
}

/**
 * Some modern ST preset exports still carry legacy post-history fields outside
 * the Prompt Manager `prompts` array. Import them as synthetic depth nodes so
 * the existing preset pipeline can handle them normally.
 */
function buildLegacyPromptNodes(raw: RawSTPreset, prompts: RawSTPromptNode[]): RawSTPromptNode[] {
  const root = asObject(raw);
  const sysprompt = asObject(root?.sysprompt);
  const context = asObject(root?.context);

  const existingDepthContents = new Set(
    prompts
      .filter((prompt) => prompt.marker !== true && (prompt.injection_position ?? 0) === 1)
      .map((prompt) => prompt.content?.trim())
      .filter((content): content is string => Boolean(content)),
  );
  const seenLegacyContents = new Set<string>();

  const candidates: Array<{
    content: string | null;
    identifier: string;
    name: string;
  }> = [
    {
      identifier: "legacyPostHistory",
      name: "Legacy Post-History",
      content: getStringField(root, "post_history"),
    },
    {
      identifier: "legacySyspromptPostHistory",
      name: "Legacy Sysprompt Post-History",
      content: getStringField(sysprompt, "post_history"),
    },
    {
      identifier: "legacyContextPostHistory",
      name: "Legacy Context Post-History",
      content: getStringField(context, "post_history"),
    },
  ];

  const legacyNodes: RawSTPromptNode[] = [];
  for (const candidate of candidates) {
    if (!candidate.content) {
      continue;
    }

    if (seenLegacyContents.has(candidate.content) || existingDepthContents.has(candidate.content)) {
      continue;
    }

    seenLegacyContents.add(candidate.content);
    legacyNodes.push({
      identifier: candidate.identifier,
      name: candidate.name,
      role: "system",
      content: candidate.content,
      enabled: true,
      injection_position: 1,
      injection_depth: 0,
      // Keep legacy post-history last among same-depth injections.
      injection_order: LEGACY_POST_HISTORY_INJECTION_ORDER,
    });
  }

  return legacyNodes;
}

/**
 * Parse a raw SillyTavern preset JSON into storable nodes.
 *
 * Processing pipeline:
 * 1. Build a lookup map from the `prompts` array (identifier -> node data)
 * 2. Walk the `prompt_order` for character_id 100001 (user-prompt order)
 *    to determine sequence and default enabled states
 * 3. Flag comment-only nodes with `is_comment: true` (stored but never injected)
 * 4. Return ordered nodes ready for DB insertion, plus filtering stats
 */
export function parsePresetNodes(normalizedPreset: NormalizedPresetShape): ParseResult | null {
  const basePrompts = normalizedPreset.preset.prompts;
  if (!Array.isArray(basePrompts) || basePrompts.length === 0) {
    return null;
  }

  const legacyPromptNodes = buildLegacyPromptNodes(normalizedPreset.preset, basePrompts);
  const prompts = [...basePrompts, ...legacyPromptNodes];
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return null;
  }

  const promptMap = new Map<string, RawSTPromptNode>();
  for (const prompt of prompts) {
    if (prompt.identifier) {
      promptMap.set(prompt.identifier, prompt);
    }
  }

  // Find the user-prompt order (character_id 100001)
  // Falls back to character_id 100000 (system prompt order) if 100001 is missing
  const promptOrders = normalizedPreset.preset.prompt_order;
  let orderEntries: RawSTPromptOrderEntry[] | null = null;

  if (Array.isArray(promptOrders)) {
    const userOrder = promptOrders.find((po) => po.character_id === 100001);
    const systemOrder = promptOrders.find((po) => po.character_id === 100000);
    const baseOrderEntries = userOrder?.order ?? systemOrder?.order ?? null;
    if (baseOrderEntries) {
      orderEntries = [
        ...baseOrderEntries,
        ...legacyPromptNodes.map((prompt) => ({
          identifier: prompt.identifier,
          enabled: prompt.enabled !== false,
        })),
      ];
    }
  }

  if (!orderEntries) {
    orderEntries = prompts.map((p) => ({
      identifier: p.identifier,
      enabled: p.enabled !== false,
    }));
  }

  const nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[] = [];
  let nodeOrder = 0;
  let commentOnlyCount = 0;
  let disabledByPreset = 0;

  for (const entry of orderEntries) {
    const prompt = promptMap.get(entry.identifier);
    if (!prompt) continue;

    const content = prompt.content ?? "";
    const isMarker = prompt.marker === true;

    // Flag comment-only nodes: stored in DB and visible in the toggle UI,
    // but never injected into the prompt regardless of enabled state
    const isComment = !isMarker && isCommentOnly(content);
    if (isComment) {
      commentOnlyCount++;
    }

    if (!isMarker && !isComment && !entry.enabled) {
      disabledByPreset++;
    }

    nodes.push({
      identifier: prompt.identifier,
      name: prompt.name ?? prompt.identifier,
      role: prompt.role ?? "system",
      content,
      is_marker: isMarker,
      is_enabled: entry.enabled,
      is_comment: isComment,
      node_order: nodeOrder++,
      injection_position: prompt.injection_position ?? 0,
      injection_depth: prompt.injection_depth ?? 4,
      injection_order: prompt.injection_order ?? 100,
    });
  }

  if (nodes.length === 0) return null;
  return {
    nodes,
    commentOnlyCount,
    disabledByPreset,
    legacyNodeCount: normalizedPreset.syntheticNodeCount + legacyPromptNodes.length,
    sourceKind: normalizedPreset.sourceKind,
  };
}

export function summarizeMacroLabels(labels: string[], maxLabels = 4): string {
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= maxLabels) {
    return sorted.join(", ");
  }

  const remaining = sorted.length - maxLabels;
  return `${sorted.slice(0, maxLabels).join(", ")} +${remaining} more`;
}

export function collectUnsupportedEnabledMacros(nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[]): string[] {
  const labels = new Set<string>();

  for (const node of nodes) {
    if (!node.is_enabled || node.is_marker || node.is_comment) {
      continue;
    }

    for (const label of findUnsupportedPresetMacros(node.content)) {
      labels.add(label);
    }
  }

  return [...labels];
}
