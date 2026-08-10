/**
 * Preset-Driven Context Builder
 *
 * When a SillyTavern preset is active, this module rearranges and augments
 * the native context output according to the preset's node order.
 *
 * Strategy: "Build-Then-Rearrange"
 *   1. Call native buildContext() to get all TomoriBot blocks (already tagged with metadataTag)
 *   2. Group output items by metadataTag into buckets
 *   3. Walk the preset's resolved nodes, pulling from the right bucket for each marker
 *   4. Insert resolved custom preset nodes at their declared positions
 *   5. Handle depth injection by merging into specific dialogue history items
 *   6. Flush any remaining TomoriBot-only blocks at anchor points
 *
 * This avoids refactoring the 2800+ line contextBuilder.ts while reusing all existing logic.
 */

import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { CachedPresetData } from "@/utils/cache/stPresetCache";
import { resolvePresetMacros, type MacroContext, type ResolvedNode } from "./stPresetEngine";
import { convertMentions } from "./contextBuilder";
import { log } from "@/utils/misc/logger";
import type { Client } from "discord.js";
import type { ToolPromptMacroResolver } from "@/utils/tools/toolPromptMacros";

/**
 * Parameters for building macro context from the current TomoriBot state.
 * These are extracted from the native buildContext() params.
 */
interface PresetMacroParams {
  /** Triggerer's display name for {{user}} */
  triggererName: string;
  /** Bot/persona display name for {{char}} */
  tomoriNickname: string;
  /** Personality attributes for {{personality}} */
  tomoriAttributes: string[];
  /** Persona-specific prompt for {{description}} */
  personaPrompt: string | null | undefined;
  /** Sample dialogues in/out for {{mesExamples}} */
  sampleDialoguesIn: string[];
  sampleDialoguesOut: string[];
  /** Most recent user message for {{lastChatMessage}} */
  lastUserMessage: string;
}

/**
 * Parameters needed for converting mentions in custom node content.
 */
interface MentionParams {
  client: Client;
  guildId: string;
  triggererName: string;
  triggererFormattedName: string;
  triggererAddressTerm: string;
  botName: string;
  personalMemoriesEnabled: boolean;
  toolPromptMacroResolver?: ToolPromptMacroResolver;
}

/**
 * Maps well-known ST marker identifiers to the ContextItemTag(s) they represent.
 * When the preset walker encounters a marker, it pulls items from the corresponding bucket.
 */
const MARKER_TO_TAGS: Record<string, ContextItemTag[]> = {
  // Primary character blocks. The per-channel append-mode prompt rides with `main`
  // so it stays directly after the system prompt; replace mode already replaces the
  // SYSTEM_HUMANIZER_RULES content upstream, so no separate channel block exists then.
  main: [ContextItemTag.SYSTEM_HUMANIZER_RULES, ContextItemTag.SYSTEM_CHANNEL_PROMPT],
  charDescription: [ContextItemTag.SYSTEM_PERSONA_PROMPT], // Persona prompt tag
  charPersonality: [ContextItemTag.SYSTEM_PERSONALITY],

  dialogueExamples: [ContextItemTag.DIALOGUE_SAMPLE],
  chatHistory: [ContextItemTag.DIALOGUE_HISTORY],

  worldInfoBefore: [ContextItemTag.KNOWLEDGE_SERVER_DOCUMENTS],
  worldInfoAfter: [ContextItemTag.KNOWLEDGE_SERVER_DOCUMENTS],
};

/**
 * TomoriBot-only blocks that have no ST marker equivalent.
 * These are always included and flushed at anchor points.
 */
const TOMORI_ONLY_KNOWLEDGE_TAGS = new Set([
  ContextItemTag.KNOWLEDGE_SERVER_INFO,
  ContextItemTag.KNOWLEDGE_SERVER_MEMORIES,
  ContextItemTag.KNOWLEDGE_SERVER_EMOJIS,
  ContextItemTag.KNOWLEDGE_SERVER_STICKERS,
  ContextItemTag.KNOWLEDGE_PERSONA_SPRITES,
]);

const TOMORI_ONLY_DIALOGUE_TAGS = new Set([
  ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION,
  ContextItemTag.KNOWLEDGE_SHORT_TERM_MEMORY,
  ContextItemTag.KNOWLEDGE_SERVER_CONDITIONING,
]);

/**
 * Markers that trigger flushing of TomoriBot-only knowledge blocks
 * (server info, memories, emojis, stickers).
 * These are flushed AFTER the anchor marker's items.
 */
const KNOWLEDGE_FLUSH_ANCHORS = new Set(["charPersonality", "charDescription", "main"]);

/**
 * Markers that trigger flushing of TomoriBot-only dialogue-adjacent blocks
 * (users in conversation, STM).
 * These are flushed BEFORE the anchor marker's items.
 */
const DIALOGUE_FLUSH_ANCHORS = new Set(["dialogueExamples", "chatHistory"]);

/**
 * Separator appended when a preset leaves sample dialogues at the very end
 * of the assembled prompt. This prevents strict chat backends from treating
 * the final example assistant turn as the active conversation turn.
 */
const TERMINAL_SAMPLE_DIALOGUE_SPACER =
  "[System: The sample dialogues above are reference material showing how {{char}} speaks. They are not the active conversation. Continue from the current scene or live conversation instead of continuing the examples.]";

/**
 * Build the MacroContext from TomoriBot state for the template engine.
 *
 */
function buildMacroContext(params: PresetMacroParams): MacroContext {
  const mesExamples: string[] = [];
  for (let i = 0; i < params.sampleDialoguesIn.length; i++) {
    const userLine = params.sampleDialoguesIn[i];
    const modelLine = params.sampleDialoguesOut[i];
    if (userLine) mesExamples.push(`<START>\n${userLine}`);
    if (modelLine) mesExamples.push(`${params.tomoriNickname}: ${modelLine}`);
  }

  return {
    userName: params.triggererName,
    charName: params.tomoriNickname,
    personality: params.tomoriAttributes.join("\n"),
    description: params.personaPrompt ?? "",
    scenario: "", // No TomoriBot equivalent
    mesExamples: mesExamples.join("\n"),
    lastChatMessage: params.lastUserMessage,
  };
}

/**
 * Group native context items by their metadataTag into consumable buckets.
 * Items without a tag go into an "untagged" bucket.
 * Each bucket is consumed (shifted) as markers pull from it, so items are only used once.
 *
 */
function groupByTag(contextItems: StructuredContextItem[]): Map<ContextItemTag | "untagged", StructuredContextItem[]> {
  const buckets = new Map<ContextItemTag | "untagged", StructuredContextItem[]>();

  for (const item of contextItems) {
    const key = item.metadataTag ?? "untagged";
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  return buckets;
}

/**
 * Pull all items from a bucket (consuming them so they aren't re-used).
 *
 * @returns Array of items (empty if bucket doesn't exist or is exhausted)
 */
function pullBucket(
  buckets: Map<ContextItemTag | "untagged", StructuredContextItem[]>,
  tag: ContextItemTag,
): StructuredContextItem[] {
  const items = buckets.get(tag) ?? [];
  buckets.delete(tag); // Consume the bucket
  return items;
}

/**
 * Pull only the first item from a bucket, leaving the rest for later consumption.
 * Used when multiple markers share the same tag (e.g., main and charDescription
 * both use SYSTEM_HUMANIZER_RULES). The first marker takes the first item,
 * the second marker takes remaining items.
 *
 * @returns The first item, or null if the bucket is empty
 */
function pullFirstFromBucket(
  buckets: Map<ContextItemTag | "untagged", StructuredContextItem[]>,
  tag: ContextItemTag,
): StructuredContextItem | null {
  const items = buckets.get(tag);
  if (!items || items.length === 0) return null;

  // biome-ignore lint/style/noNonNullAssertion: items.length > 0 is checked above, shift() always returns a value
  const first = items.shift()!;
  if (items.length === 0) {
    buckets.delete(tag);
  }
  return first;
}

/**
 * Append a user-side separator if sample dialogues are the terminal prompt block.
 * Some strict chat APIs reject requests whose final message is an assistant/example turn.
 *
 */
async function appendTerminalSampleDialogueSpacerIfNeeded(
  contextItems: StructuredContextItem[],
  mentionParams: MentionParams,
): Promise<void> {
  const lastItem = contextItems.at(-1);
  if (!lastItem || lastItem.metadataTag !== ContextItemTag.DIALOGUE_SAMPLE) {
    return;
  }

  const resolvedSpacerText = await convertMentions(
    TERMINAL_SAMPLE_DIALOGUE_SPACER,
    mentionParams.client,
    mentionParams.guildId,
    mentionParams.triggererName,
    mentionParams.botName,
    mentionParams.personalMemoriesEnabled,
    undefined,
    "resolve",
    {
      userFormatted: mentionParams.triggererFormattedName,
      userTerm: mentionParams.triggererAddressTerm,
    },
  );

  contextItems.push({
    role: "user",
    parts: [{ type: "text", text: resolvedSpacerText }],
  });

  log.info("[Preset Builder] Appended terminal sample-dialogue spacer after dialogueExamples ended the prompt");
}

/**
 * Batch-merge depth-injected content into dialogue history items.
 *
 * Instead of appending one `[System: ...]` text part per injection node,
 * this groups all injections targeting the same depth into a single
 * `[System: ...]` block. This reduces token waste from repeated prefixes
 * and produces cleaner output that more closely matches SillyTavern's
 * contiguous injection behavior.
 *
 * @param injections - Array of { depth, content } pairs, already sorted by depth ascending then injection_order ascending
 */
function batchMergeDepthInjections(
  contextItems: StructuredContextItem[],
  injections: Array<{ depth: number; content: string; name: string }>,
): void {
  const historyIndices: number[] = [];
  for (let i = 0; i < contextItems.length; i++) {
    if (contextItems[i].metadataTag === ContextItemTag.DIALOGUE_HISTORY) {
      historyIndices.push(i);
    }
  }

  if (historyIndices.length === 0) {
    log.warn(`[Preset Builder] Cannot merge ${injections.length} depth injection(s) — no dialogue history items found`);
    return;
  }

  const groupedByTarget = new Map<number, string[]>();

  for (const injection of injections) {
    const targetHistoryIndex = historyIndices.length - 1 - injection.depth;
    const clampedIndex = Math.max(0, Math.min(targetHistoryIndex, historyIndices.length - 1));
    const actualIndex = historyIndices[clampedIndex];

    const group = groupedByTarget.get(actualIndex);
    if (group) {
      group.push(injection.content);
    } else {
      groupedByTarget.set(actualIndex, [injection.content]);
    }
  }

  for (const [actualIndex, contents] of groupedByTarget) {
    const combinedText = contents.join("\n");
    contextItems[actualIndex].parts.push({
      type: "text",
      text: `\n[System: ${combinedText}]`,
    });
  }
}

/**
 * Reassemble native context output according to a SillyTavern preset's node order.
 *
 * Algorithm:
 *   1. Resolve all preset macros (two-pass variable resolution)
 *   2. Group native context items by metadataTag into consumable buckets
 *   3. Separate preset nodes into system-position (injection_position=0) and depth-injection (injection_position=1)
 *   4. Walk system-position nodes in node_order:
 *      - Marker nodes → pull items from the corresponding bucket
 *      - Custom nodes → create new StructuredContextItem with resolved content
 *      - At anchor markers → flush TomoriBot-only blocks
 *   5. Flush any remaining TomoriBot-only blocks
 *   6. Process depth-injection nodes (merge into dialogue history)
 *   7. Return in the same format as buildContext()
 *
 * @returns Reassembled context in the same format as buildContext()
 */
export async function reassembleWithPreset(
  nativeOutput: {
    contextItems: StructuredContextItem[];
    tailDirectives: string[];
    lowerPriorityTailDirectives: string[];
    uncensorDirective?: string;
    nudgeItem?: StructuredContextItem;
    nudgeInjectionDepth?: number;
    memoryInjectionItems?: StructuredContextItem[];
    memoryInjectionDepth?: number;
  },
  presetData: CachedPresetData,
  macroParams: PresetMacroParams,
  mentionParams: MentionParams,
): Promise<{
  contextItems: StructuredContextItem[];
  tailDirectives: string[];
  lowerPriorityTailDirectives: string[];
  uncensorDirective?: string;
  nudgeItem?: StructuredContextItem;
  nudgeInjectionDepth?: number;
  memoryInjectionItems?: StructuredContextItem[];
  memoryInjectionDepth?: number;
}> {
  const { nodes } = presetData;

  const macroContext = buildMacroContext(macroParams);
  const { resolved, expandedContentMacros } = resolvePresetMacros(nodes, macroContext);

  const buckets = groupByTag(nativeOutput.contextItems);

  const systemNodes: ResolvedNode[] = [];
  const depthNodes: ResolvedNode[] = [];

  for (const node of resolved) {
    // Skip disabled nodes and comment-only nodes (is_comment never injects regardless of enabled state)
    if (!node.is_enabled || node.is_comment) continue;

    if (node.injection_position === 1) {
      depthNodes.push(node);
    } else {
      systemNodes.push(node);
    }
  }

  // Sort depth nodes: by depth ascending (matching ST's bottom-to-top processing),
  // then injection_order ascending for same-depth nodes
  depthNodes.sort((a, b) => {
    if (a.injection_depth !== b.injection_depth) {
      return a.injection_depth - b.injection_depth; // Lower depth first (closer to end of history)
    }
    return a.injection_order - b.injection_order;
  });

  const contextItems: StructuredContextItem[] = [];
  let knowledgeFlushed = false;
  let dialogueFlushed = false;

  /**
   * Flush TomoriBot-only knowledge blocks (server info, memories, emojis, stickers).
   * Called once at the first knowledge anchor marker.
   */
  const flushKnowledgeBlocks = () => {
    if (knowledgeFlushed) return;
    knowledgeFlushed = true;

    for (const tag of TOMORI_ONLY_KNOWLEDGE_TAGS) {
      contextItems.push(...pullBucket(buckets, tag));
    }
  };

  /**
   * Flush TomoriBot-only dialogue-adjacent blocks (users in conversation, STM).
   * Called once before the first dialogue anchor marker.
   */
  const flushDialogueBlocks = () => {
    if (dialogueFlushed) return;
    dialogueFlushed = true;

    for (const tag of TOMORI_ONLY_DIALOGUE_TAGS) {
      contextItems.push(...pullBucket(buckets, tag));
    }

    const ragItems = pullBucket(buckets, ContextItemTag.KNOWLEDGE_SERVER_DOCUMENTS);
    if (ragItems.length > 0) {
      contextItems.push(...ragItems);
    }
  };

  for (const node of systemNodes) {
    if (node.is_marker) {
      const markerTags = MARKER_TO_TAGS[node.identifier];

      if (!markerTags) {
        log.warn(
          `[Preset Builder] Unrecognized marker "${node.identifier}" (node_order ${node.node_order}) — skipping`,
        );
      }

      // The native builder puts system prompt + persona prompt under this single tag.
      // `main` takes only the first item (system prompt), `charDescription` takes the rest (persona).
      if (node.identifier === "main") {
        if (markerTags) {
          for (const tag of markerTags) {
            const firstItem = pullFirstFromBucket(buckets, tag);
            if (firstItem) contextItems.push(firstItem);
          }
        }
        if (KNOWLEDGE_FLUSH_ANCHORS.has(node.identifier)) {
          flushKnowledgeBlocks();
        }
        continue;
      }

      if (node.identifier === "charDescription") {
        if (expandedContentMacros.has("description")) {
          if (KNOWLEDGE_FLUSH_ANCHORS.has(node.identifier)) {
            flushKnowledgeBlocks();
          }
          continue;
        }
        if (markerTags) {
          for (const tag of markerTags) {
            contextItems.push(...pullBucket(buckets, tag));
          }
        }
        if (KNOWLEDGE_FLUSH_ANCHORS.has(node.identifier)) {
          flushKnowledgeBlocks();
        }
        continue;
      }

      if (node.identifier === "charPersonality") {
        if (expandedContentMacros.has("personality")) {
          if (KNOWLEDGE_FLUSH_ANCHORS.has(node.identifier)) {
            flushKnowledgeBlocks();
          }
          continue;
        }
      }

      if (DIALOGUE_FLUSH_ANCHORS.has(node.identifier)) {
        flushDialogueBlocks();
      }

      if (markerTags) {
        for (const tag of markerTags) {
          contextItems.push(...pullBucket(buckets, tag));
        }
      }

      if (KNOWLEDGE_FLUSH_ANCHORS.has(node.identifier)) {
        flushKnowledgeBlocks();
      }
    } else if (node.content.length > 0) {
      const toolMacroExpandedContent = await (mentionParams.toolPromptMacroResolver?.expand(node.content) ??
        Promise.resolve(node.content));
      if (!toolMacroExpandedContent.trim()) continue;
      const resolvedContent = await convertMentions(
        toolMacroExpandedContent,
        mentionParams.client,
        mentionParams.guildId,
        mentionParams.triggererName, // Preset custom nodes should resolve {{user}} to the actual triggerer
        mentionParams.botName,
        mentionParams.personalMemoriesEnabled,
        undefined,
        "resolve",
        {
          userFormatted: mentionParams.triggererFormattedName,
          userTerm: mentionParams.triggererAddressTerm,
        },
      );

      contextItems.push({
        role: node.role,
        parts: [{ type: "text", text: resolvedContent }],
      });
    }
  }

  // ── Step 5: Flush any remaining TomoriBot-only blocks ──
  // If the preset's node order didn't include the anchor markers,
  // append remaining blocks before dialogue history.
  flushKnowledgeBlocks();
  flushDialogueBlocks();

  for (const [_tag, items] of buckets) {
    if (items.length > 0) {
      contextItems.push(...items);
    }
  }

  // ── Step 6: Process depth-injection nodes ──
  // These merge INTO existing dialogue history items rather than creating new messages.
  // Same-depth injections are batched into a single [System: ...] block to reduce
  // token waste and match SillyTavern's contiguous injection behavior.
  const resolvedInjections: Array<{
    depth: number;
    content: string;
    name: string;
  }> = [];

  for (const depthNode of depthNodes) {
    if (depthNode.content.length === 0) continue;

    const toolMacroExpandedContent = await (mentionParams.toolPromptMacroResolver?.expand(depthNode.content) ??
      Promise.resolve(depthNode.content));
    if (!toolMacroExpandedContent.trim()) continue;
    const resolvedContent = await convertMentions(
      toolMacroExpandedContent,
      mentionParams.client,
      mentionParams.guildId,
      mentionParams.triggererName,
      mentionParams.botName,
      mentionParams.personalMemoriesEnabled,
      undefined,
      "resolve",
      {
        userFormatted: mentionParams.triggererFormattedName,
        userTerm: mentionParams.triggererAddressTerm,
      },
    );

    resolvedInjections.push({
      depth: depthNode.injection_depth,
      content: resolvedContent,
      name: depthNode.name,
    });
  }

  if (resolvedInjections.length > 0) {
    batchMergeDepthInjections(contextItems, resolvedInjections);
  }

  await appendTerminalSampleDialogueSpacerIfNeeded(contextItems, mentionParams);

  log.info(
    `[Preset Builder] Reassembled ${contextItems.length} context items using preset "${presetData.preset.preset_name}" ` +
      `(${systemNodes.length} system nodes, ${depthNodes.length} depth injections)`,
  );

  // Tail directives, uncensor directive, and the out-of-band STM nudge + deferred STM
  // content block pass through unchanged because they are injected positionally
  // downstream of assembly, so preset reassembly must never re-anchor them.
  return {
    contextItems,
    tailDirectives: nativeOutput.tailDirectives,
    lowerPriorityTailDirectives: nativeOutput.lowerPriorityTailDirectives,
    uncensorDirective: nativeOutput.uncensorDirective,
    nudgeItem: nativeOutput.nudgeItem,
    nudgeInjectionDepth: nativeOutput.nudgeInjectionDepth,
    memoryInjectionItems: nativeOutput.memoryInjectionItems,
    memoryInjectionDepth: nativeOutput.memoryInjectionDepth,
  };
}
