import type { Client } from "discord.js";
import { ContextItemTag, type ContextPart, type StructuredContextItem } from "@/types/misc/context";
import { HumanizerDegree, type ConditioningType } from "@/types/db/schema";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import {
  CONDITIONING_CONTEXT_MAX_GROUPS_PER_TYPE,
  getConditioningContextPastParticiple,
} from "@/utils/conditioning/conditioning";
import { UNPAIRED_SAMPLE_DIALOGUE_SENTINEL } from "@/types/preset/presetExport";
import { humanizeString } from "@/utils/text/processors/formatters";
import { applyUncensorInputTransforms } from "@/utils/text/uncensor";
import { escapeRegExp } from "@/utils/text/processors/regexUtils";
import type { TomoriState, AssembledServerConfig } from "@/types/db/schema";

// Resolved at read time, never copied into server_chat_configs.system_prompt: a
// stored copy freezes each server on whatever this said the day it ran setup, and
// migration 061 exists only to undo the era when setup did materialize it.
export const DEFAULT_SYSTEM_PROMPT =
  "\nYou are {bot}. {bot} makes sure to respond short and concisely by default. {bot} only makes lengthy responses if the situation warrants it.\n\n{{if tool:create_long_term_memory}}{bot} proactively uses the available {memory_tool} whenever someone shares a detail or {bot} notices one in the conversation that is actually worth remembering, such as a preference, an interest, or an important fact, preferring to remember things even if it is minor as long as it's not a duplicate of what {bot} already knows. {{/if}}{{if tool:update_long_term_memory}}{bot} uses {memory_update_tool} instead when new information changes or adds onto something {bot} already remembers, rather than saving a duplicate.{{/if}}\n\n{{if tool:update_user_info}}{bot} uses {user_info_tool} for changing a nickname, pronouns, addressing style, or timezone. When wording clearly separates a title from a name, {bot} submits the title as a prefix or suffix rather than embedding it in the nickname.{{/if}}\n\n{{if tool:review_capabilities}}When someone asks what {bot} can do or why something is unavailable, {bot} checks {capabilities_tool} before answering. {{/if}}{{if tool_family:url_fetch}}When more detail is needed, {bot} uses {url_fetch_tool} on `https://docs.tomoribot.app/llms.txt` for information.{{/if}}";

const RANDOM_CHOICE_MACRO_REGEX =
  /\{\{\s*random(?:::\s*([^{}]+)|:\s*([^{}]+))\s*\}\}|\{\s*random(?:::\s*([^{}]+)|:\s*([^{}]+))\s*\}/gi;

export type MentionConverter = (
  text: string,
  client: Client,
  serverId: string,
  triggererName?: string,
  tomoriNickname?: string,
  personalMemoriesEnabled?: boolean,
  snapshot?: import("@/types/misc/context").RequestSnapshot,
  identityMacroMode?: import("./mentionNormalizer").IdentityMacroMode,
  identityValues?: { userFormatted?: string; userTerm?: string },
) => Promise<string>;

/**
 * Resolves ST-style random choice macros that can appear in imported presets
 * or prompt fields. Each macro occurrence is rolled independently.
 */
function resolveRandomChoiceMacros(text: string): string {
  return text.replace(
    RANDOM_CHOICE_MACRO_REGEX,
    (
      _match,
      doubleBraceColonOptions: string | undefined,
      doubleBraceCommaOptions: string | undefined,
      singleBraceColonOptions: string | undefined,
      singleBraceCommaOptions: string | undefined,
    ) => {
      const isColonSyntax = doubleBraceColonOptions !== undefined || singleBraceColonOptions !== undefined;
      const rawOptions =
        doubleBraceColonOptions ?? doubleBraceCommaOptions ?? singleBraceColonOptions ?? singleBraceCommaOptions ?? "";
      const separator = isColonSyntax ? "::" : ",";
      const items = rawOptions
        .split(separator)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (items.length === 0) return "";
      return items[Math.floor(Math.random() * items.length)];
    },
  );
}

function resolveRandomChoiceMacrosInContextItem(item: StructuredContextItem): StructuredContextItem {
  let changed = false;
  const parts = item.parts.map((part): ContextPart => {
    if (part.type !== "text") return part;

    const resolvedText = resolveRandomChoiceMacros(part.text);
    if (resolvedText === part.text) return part;

    changed = true;
    return { ...part, text: resolvedText };
  });

  return changed ? { ...item, parts } : item;
}

export function resolveRandomChoiceMacrosInBuildOutput(output: {
  contextItems: StructuredContextItem[];
  tailDirectives: string[];
  lowerPriorityTailDirectives: string[];
  uncensorDirective?: string;
  nudgeItem?: StructuredContextItem;
  nudgeInjectionDepth?: number;
  memoryInjectionItems?: StructuredContextItem[];
  memoryInjectionDepth?: number;
}): {
  contextItems: StructuredContextItem[];
  tailDirectives: string[];
  lowerPriorityTailDirectives: string[];
  uncensorDirective?: string;
  nudgeItem?: StructuredContextItem;
  nudgeInjectionDepth?: number;
  memoryInjectionItems?: StructuredContextItem[];
  memoryInjectionDepth?: number;
} {
  return {
    contextItems: output.contextItems.map(resolveRandomChoiceMacrosInContextItem),
    tailDirectives: output.tailDirectives.map(resolveRandomChoiceMacros),
    lowerPriorityTailDirectives: output.lowerPriorityTailDirectives.map(resolveRandomChoiceMacros),
    uncensorDirective:
      output.uncensorDirective !== undefined ? resolveRandomChoiceMacros(output.uncensorDirective) : undefined,
    nudgeItem: output.nudgeItem ? resolveRandomChoiceMacrosInContextItem(output.nudgeItem) : undefined,
    nudgeInjectionDepth: output.nudgeInjectionDepth,
    // Deferred STM block items get the same random-choice macro resolution the inline
    // path applies via `contextItems.map(...)`, so out-of-band placement is identical.
    memoryInjectionItems: output.memoryInjectionItems?.map(resolveRandomChoiceMacrosInContextItem),
    memoryInjectionDepth: output.memoryInjectionDepth,
  };
}

export async function buildPromptContextItems(params: {
  client: Client;
  guildId: string;
  botName: string;
  tomoriAttributes: string[];
  tomoriConfig: AssembledServerConfig;
  channelPromptOverride?: { prompt: string; mode: import("@/types/db/schema").ChannelPromptMode } | null;
  personaPrompt?: string | null;
  isUserImpersonation: boolean;
  impersonatedIdentityName: string | null;
  impersonatedUserPrompt?: string | null;
  suppressDefaultSystemPrompt: boolean;
  snapshot?: import("@/types/misc/context").RequestSnapshot;
  toolPromptMacroResolver: { expand(text: string): Promise<string> };
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem[]> {
  const contextItems: StructuredContextItem[] = [];

  if (!params.isUserImpersonation) {
    const channelOverride = params.channelPromptOverride;

    // Resolve the server-level system prompt (or default fallback).
    const baseSystemPrompt =
      params.tomoriConfig.system_prompt?.trim() || (params.suppressDefaultSystemPrompt ? null : DEFAULT_SYSTEM_PROMPT);

    // Replace mode: the channel prompt fully takes over the system-prompt slot's
    //    content (persona prompt + attributes below are untouched). Otherwise keep
    //    the server/default system prompt in that slot.
    const systemPrompt = channelOverride?.mode === "replace" ? channelOverride.prompt : baseSystemPrompt;

    if (systemPrompt) {
      const expandedSystemPrompt = await params.toolPromptMacroResolver.expand(systemPrompt);
      if (expandedSystemPrompt.trim()) {
        const humanizerText = await params.convertMentions(
          expandedSystemPrompt,
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.tomoriConfig.personal_memories_enabled,
          params.snapshot,
        );
        contextItems.push({
          role: "system",
          parts: [{ type: "text", text: humanizerText }],
          metadataTag: ContextItemTag.SYSTEM_HUMANIZER_RULES,
        });
      }
    }

    // Append mode: emit the channel prompt as its own distinct block placed
    //    immediately after the system prompt (and before the persona prompt).
    if (channelOverride?.mode === "append" && channelOverride.prompt.trim()) {
      const expandedChannelPrompt = await params.toolPromptMacroResolver.expand(channelOverride.prompt);
      if (expandedChannelPrompt.trim()) {
        const channelPromptText = await params.convertMentions(
          expandedChannelPrompt,
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.tomoriConfig.personal_memories_enabled,
          params.snapshot,
        );
        contextItems.push({
          role: "system",
          parts: [{ type: "text", text: channelPromptText }],
          metadataTag: ContextItemTag.SYSTEM_CHANNEL_PROMPT,
        });
      }
    }
  }

  if (!params.isUserImpersonation && params.personaPrompt?.trim()) {
    const expandedPersonaPrompt = await params.toolPromptMacroResolver.expand(params.personaPrompt.trim());
    if (expandedPersonaPrompt.trim()) {
      contextItems.push({
        role: "system",
        parts: [
          {
            type: "text",
            text: await params.convertMentions(
              expandedPersonaPrompt,
              params.client,
              params.guildId,
              "User",
              params.botName,
              params.tomoriConfig.personal_memories_enabled,
              params.snapshot,
            ),
          },
        ],
        metadataTag: ContextItemTag.SYSTEM_PERSONA_PROMPT,
      });
    }
  }

  if (params.isUserImpersonation && params.impersonatedUserPrompt?.trim()) {
    const expandedImpersonatedPrompt = await params.toolPromptMacroResolver.expand(
      params.impersonatedUserPrompt.trim(),
    );
    if (expandedImpersonatedPrompt.trim()) {
      contextItems.push({
        role: "system",
        parts: [
          {
            type: "text",
            text: await params.convertMentions(
              expandedImpersonatedPrompt,
              params.client,
              params.guildId,
              params.impersonatedIdentityName || "User",
              params.botName,
              params.tomoriConfig.personal_memories_enabled,
              params.snapshot,
            ),
          },
        ],
        metadataTag: ContextItemTag.SYSTEM_HUMANIZER_RULES,
      });
    }
  }

  if (!params.isUserImpersonation) {
    const expandedAttributes = await params.toolPromptMacroResolver.expand(params.tomoriAttributes.join("\n"));
    if (expandedAttributes.trim()) {
      contextItems.push({
        role: "system",
        parts: [
          {
            type: "text",
            text: await params.convertMentions(
              expandedAttributes,
              params.client,
              params.guildId,
              "User",
              params.botName,
              params.tomoriConfig.personal_memories_enabled,
              params.snapshot,
            ),
          },
        ],
        metadataTag: ContextItemTag.SYSTEM_PERSONALITY,
      });
    }
  }

  return contextItems;
}

export async function buildSampleDialogueContextItems(params: {
  client: Client;
  guildId: string;
  triggererName: string;
  botName: string;
  tomoriState: TomoriState | null;
  tomoriConfig: AssembledServerConfig;
  isUserImpersonation: boolean;
  uncensorInputOptions: { unicodeSpacesEnabled: boolean; sanitizeEnabled: boolean };
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem[]> {
  const tomoriState = params.tomoriState;
  if (
    params.isUserImpersonation ||
    !tomoriState ||
    tomoriState.sample_dialogues_in.length === 0 ||
    tomoriState.sample_dialogues_out.length === 0 ||
    tomoriState.sample_dialogues_in.length !== tomoriState.sample_dialogues_out.length
  ) {
    return [];
  }

  const contextItems: StructuredContextItem[] = [];
  for (let i = 0; i < tomoriState.sample_dialogues_in.length; i++) {
    let userSampleText = tomoriState.sample_dialogues_in[i];
    const isUnpairedSample = userSampleText === UNPAIRED_SAMPLE_DIALOGUE_SENTINEL;
    if (!isUnpairedSample) {
      if (params.tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY) {
        userSampleText = humanizeString(userSampleText);
      }
      contextItems.push({
        role: "user",
        parts: [
          {
            type: "text",
            text: applyUncensorInputTransforms(
              await params.convertMentions(
                userSampleText,
                params.client,
                params.guildId,
                params.triggererName,
                params.botName,
                params.tomoriConfig.personal_memories_enabled,
              ),
              params.uncensorInputOptions,
            ),
          },
        ],
        metadataTag: ContextItemTag.DIALOGUE_SAMPLE,
      });
    }

    const rawOut = tomoriState.sample_dialogues_out[i];
    const escapedBotName = escapeRegExp(params.botName);
    const namePattern = `(?:${escapedBotName}|\\{\\{?char\\}\\}?|\\{\\{?bot\\}\\}?)`;
    const speakerPattern = new RegExp(`^\\s*${namePattern}(?:\\s*\\([^)]+\\))?\\s*[:：]`, "iu");

    let modelSampleText = speakerPattern.test(rawOut) ? rawOut : `${params.botName}: ${rawOut}`;
    if (params.tomoriConfig.humanizer_degree >= HumanizerDegree.HEAVY) {
      modelSampleText = humanizeString(modelSampleText);
    }
    contextItems.push({
      role: "model",
      parts: [
        {
          type: "text",
          text: applyUncensorInputTransforms(
            await params.convertMentions(
              modelSampleText,
              params.client,
              params.guildId,
              params.triggererName,
              params.botName,
              params.tomoriConfig.personal_memories_enabled,
            ),
            params.uncensorInputOptions,
          ),
        },
      ],
      metadataTag: ContextItemTag.DIALOGUE_SAMPLE,
    });
  }

  return contextItems;
}

export async function buildConditioningContextItem(params: {
  client: Client;
  guildId: string;
  serverId: number;
  personaLineageId: number;
  botName: string;
  personalMemoriesEnabled: boolean;
  rewardEnabled: boolean;
  punishEnabled: boolean;
  convertMentions: MentionConverter;
}): Promise<StructuredContextItem | null> {
  const sections: string[] = [];

  const appendSection = async (conditioningType: ConditioningType, enabled: boolean): Promise<void> => {
    if (!enabled) {
      return;
    }

    const visibleGroups = (
      await conditioningMemoryRepository.loadGroupsForPersona(
        params.serverId,
        params.personaLineageId,
        conditioningType,
      )
    )
      .filter((group) => group.reasonText.trim().length > 0)
      .slice(0, CONDITIONING_CONTEXT_MAX_GROUPS_PER_TYPE);

    if (visibleGroups.length === 0) {
      return;
    }

    const heading =
      conditioningType === "reward"
        ? `## Rewarded Behaviors\nHere are past things ${params.botName} did that got rewarded for. Strive to do them again:`
        : `## Punished Behaviors\nHere are past things ${params.botName} did that got punished for. Avoid doing them again:`;

    const lines = visibleGroups.map((group) => {
      const users = group.userDiscIds.map((userDiscId) => `<@${userDiscId}>`).join(", ");
      const action = getConditioningContextPastParticiple(conditioningType, group.actionKey);
      const countSuffix = group.totalCount > 1 ? ` (${group.totalCount} times)` : "";
      const actionTextSuffix = group.actionText ? ` with \`${group.actionText}\`` : "";
      return `- [${params.botName} was ${action} by ${users}. Reason: \`${group.reasonText}\`${actionTextSuffix}]${countSuffix}`;
    });

    sections.push(`${heading}\n${lines.join("\n")}`);
  };

  await appendSection("reward", params.rewardEnabled);
  await appendSection("punish", params.punishEnabled);

  if (sections.length === 0) {
    return null;
  }

  return {
    role: "system",
    parts: [
      {
        type: "text",
        text: await params.convertMentions(
          sections.join("\n\n"),
          params.client,
          params.guildId,
          "User",
          params.botName,
          params.personalMemoriesEnabled,
        ),
      },
    ],
    metadataTag: ContextItemTag.KNOWLEDGE_SERVER_CONDITIONING,
  };
}
