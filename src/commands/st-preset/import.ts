import {
  MessageFlags,
  type Attachment,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { localizer } from "@/utils/text/localizer";
import { findUnsupportedPresetMacros } from "@/utils/text/stPresetEngine";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeDownload } from "@/utils/security/safeDownload";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import type { UserRow, ErrorContext, StPresetNodeRow } from "@/types/db/schema";

/** Maximum file size for preset JSON uploads (in MB) */
const MAX_PRESET_FILE_SIZE_MB = 2;

/** Maximum allowed preset name length (derived from filename) */
const MAX_PRESET_NAME_LENGTH = 100;
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
interface RawSTPreset {
  prompts?: RawSTPromptNode[];
  prompt_order?: {
    character_id: number;
    order: RawSTPromptOrderEntry[];
  }[];
  [key: string]: unknown;
}

/**
 * Configure the /st-preset import subcommand.
 * Accepts a required JSON file attachment containing a SillyTavern preset.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("import")
    .setDescription(localizer("en-US", "commands.st-preset.import.description"))
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription(localizer("en-US", "commands.st-preset.import.file_description"))
        .setRequired(true),
    );

/**
 * Validate that the attachment is a JSON file.
 * @returns Validation result with optional error key
 */
function validateAttachment(attachment: Attachment): {
  isValid: boolean;
  errorKey?: string;
} {
  const filename = attachment.name?.toLowerCase() ?? "";

  if (!filename.endsWith(".json")) {
    return { isValid: false, errorKey: "invalid_format" };
  }

  // Check content type if provided (Discord may not always set this)
  if (attachment.contentType && !attachment.contentType.includes("json")) {
    return { isValid: false, errorKey: "invalid_format" };
  }

  return { isValid: true };
}

/**
 * Determine whether a prompt node is comment-only (produces no output).
 * Comment-only nodes contain only `{{// ... }}` blocks and `{{trim}}` macros.
 * @param content - The raw content string from the prompt node
 * @returns True if the content resolves to empty after macro processing
 */
function isCommentOnly(content: string): boolean {
  return COMMENT_ONLY_REGEX.test(content.trim());
}

/**
 * Strips the .json extension and truncates to MAX_PRESET_NAME_LENGTH.
 * @param filename - Original filename from the Discord attachment
 */
function derivePresetName(filename: string): string {
  const name = filename.replace(/\.json$/i, "").trim();
  return name.length > MAX_PRESET_NAME_LENGTH ? name.slice(0, MAX_PRESET_NAME_LENGTH) : name;
}

/** Result of parsing a preset, including nodes and filtering stats */
interface ParseResult {
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

interface NormalizedPresetShape {
  preset: RawSTPreset;
  sourceKind: PresetSourceKind;
  syntheticNodeCount: number;
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

function normalizePresetShape(raw: RawSTPreset): NormalizedPresetShape | null {
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
 * 1. Build a lookup map from the `prompts` array (identifier → node data)
 * 2. Walk the `prompt_order` for character_id 100001 (user-prompt order)
 *    to determine sequence and default enabled states
 * 3. Flag comment-only nodes with `is_comment: true` (stored but never injected)
 * 4. Return ordered nodes ready for DB insertion, plus filtering stats
 *
 * @param raw - Parsed SillyTavern preset JSON
 * @returns Parse result with nodes and stats, or null if the preset is invalid
 */
function parsePresetNodes(normalizedPreset: NormalizedPresetShape): ParseResult | null {
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
  //    Falls back to character_id 100000 (system prompt order) if 100001 is missing
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

function summarizeMacroLabels(labels: string[], maxLabels = 4): string {
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= maxLabels) {
    return sorted.join(", ");
  }

  const remaining = sorted.length - maxLabels;
  return `${sorted.slice(0, maxLabels).join(", ")} +${remaining} more`;
}

function collectUnsupportedEnabledMacros(nodes: Omit<StPresetNodeRow, "node_id" | "preset_id">[]): string[] {
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

/**
 * Execute /st-preset import.
 * Downloads the attached JSON file, validates it as a SillyTavern preset,
 * parses prompt nodes from the prompt_order, and stores the preset + nodes
 * in the database for this server.
 *
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const serverId = interaction.guild?.id ?? interaction.user.id;
  const tomoriState = await getCachedTomoriState(serverId);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  const validation = validateAttachment(attachment);
  if (!validation.isValid) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.st-preset.import.invalid_file_title",
      descriptionKey: `commands.st-preset.import.${validation.errorKey}`,
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const maxSizeBytes = MAX_PRESET_FILE_SIZE_MB * 1024 * 1024;
  if (attachment.size && attachment.size > maxSizeBytes) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.st-preset.import.file_too_large_title",
      descriptionKey: "commands.st-preset.import.file_too_large_description",
      descriptionVars: { max_size: MAX_PRESET_FILE_SIZE_MB.toString() },
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply (download + parsing may take a moment)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const downloadResult = await safeDownload(attachment.url, {
      maxSizeMB: MAX_PRESET_FILE_SIZE_MB,
      timeoutMs: 15000,
      knownSize: attachment.size,
    });

    if (!downloadResult.success || !downloadResult.buffer) {
      await interaction.editReply({
        content: localizer(locale, "commands.st-preset.import.download_failed"),
      });
      return;
    }

    let rawPreset: RawSTPreset;
    try {
      rawPreset = JSON.parse(downloadResult.buffer.toString("utf-8"));
    } catch {
      await interaction.editReply({
        content: localizer(locale, "commands.st-preset.import.invalid_json"),
      });
      return;
    }

    const normalizedPreset = normalizePresetShape(rawPreset);
    if (!normalizedPreset) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.st-preset.import.not_a_preset_title",
        descriptionKey: "commands.st-preset.import.not_a_preset_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const parseResult = parsePresetNodes(normalizedPreset);
    if (!parseResult) {
      await interaction.editReply({
        content: localizer(locale, "commands.st-preset.import.no_nodes"),
      });
      return;
    }

    const { nodes, commentOnlyCount, disabledByPreset, legacyNodeCount, sourceKind } = parseResult;

    const presetName = derivePresetName(attachment.name ?? "Unnamed Preset");

    const preset = await presetRepository.insertPresetWithNodes(tomoriState.server_id, presetName, rawPreset, nodes);

    if (!preset) {
      await interaction.editReply({
        content: localizer(locale, "general.errors.unknown_error_description"),
      });
      return;
    }

    if (preset.preset_id) {
      await presetRepository.setActivePreset(tomoriState.server_id, preset.preset_id);
    }

    const markerCount = nodes.filter((n) => n.is_marker).length;
    const toggleableCount = nodes.filter((n) => !n.is_marker).length;
    // Excludes comment-only nodes: they never inject regardless of enabled state
    const enabledCount = nodes.filter((n) => n.is_enabled && !n.is_marker && !n.is_comment).length;

    const unsupportedEnabledMacros = collectUnsupportedEnabledMacros(nodes);

    const filterNotes: string[] = [];
    if (commentOnlyCount > 0) {
      filterNotes.push(
        localizer(locale, "commands.st-preset.import.note_comment_only", {
          count: commentOnlyCount.toString(),
        }),
      );
    }
    if (disabledByPreset > 0) {
      filterNotes.push(
        localizer(locale, "commands.st-preset.import.note_disabled_by_preset", {
          count: disabledByPreset.toString(),
        }),
      );
    }
    if (unsupportedEnabledMacros.length > 0) {
      filterNotes.push(
        localizer(locale, "commands.st-preset.import.note_unsupported_macros", {
          macros: summarizeMacroLabels(unsupportedEnabledMacros),
        }),
      );
    }
    if (sourceKind === "legacy_text_completion") {
      filterNotes.push(localizer(locale, "commands.st-preset.import.note_legacy_text_completion"));
    }
    const notes = filterNotes.length > 0 ? filterNotes.join("\n") : "";

    if (legacyNodeCount > 0) {
      log.info(`[ST Preset Import] Added ${legacyNodeCount} synthetic prompt node(s) from legacy preset compatibility`);
    }
    if (unsupportedEnabledMacros.length > 0) {
      log.warn(
        `[ST Preset Import] "${presetName}" contains unsupported macro(s) in enabled nodes: ${unsupportedEnabledMacros.join(", ")}`,
      );
    }
    if (sourceKind === "legacy_text_completion") {
      log.info(`[ST Preset Import] "${presetName}" was converted from a legacy text-completions preset shape`);
    }

    const stPresetToggleMention = commandRegistry.getCommandMention("st-preset", "node", "toggle");
    const stPresetRemoveMention = commandRegistry.getCommandMention("st-preset", "remove");
    const helpStPresetMention = commandRegistry.getCommandMention("help");

    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.st-preset.import.success_title",
      descriptionKey: "commands.st-preset.import.success_description",
      descriptionVars: {
        name: presetName,
        total: nodes.length.toString(),
        markers: markerCount.toString(),
        toggleable: toggleableCount.toString(),
        enabled: enabledCount.toString(),
        notes,
        stPresetToggle: stPresetToggleMention,
        stPresetRemove: stPresetRemoveMention,
        helpStPreset: helpStPresetMention,
      },
      color: ColorCode.SUCCESS,
    });

    log.success(
      `[ST Preset Import] "${presetName}" imported for server ${serverId} — ${nodes.length} nodes (${toggleableCount} toggleable, ${markerCount} markers, ${commentOnlyCount} comment-only, ${disabledByPreset} disabled by preset)`,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: null,
      personaId: null,
      errorType: "CommandExecutionError",
      metadata: { command: "st-preset import" },
    };
    await log.error("Error executing /st-preset import", error as Error, context);

    await interaction.editReply({
      content: localizer(locale, "general.errors.unknown_error_description"),
    });
  }
}
