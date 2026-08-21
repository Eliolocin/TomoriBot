import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import type { CompactSummaryMode } from "@/types/misc/compact";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
import type { ModalComponent } from "@/types/discord/modal";

const MODAL_CUSTOM_ID = "tool_compact_modal";
const MANUAL_MODAL_CUSTOM_ID = "tool_compact_manual_modal";
const REFRESH_FIELD_ID = "refresh_context";
const ANALYZE_IMAGES_FIELD_ID = "analyze_images";
const SYSTEM_PROMPT_FIELD_ID = "system_prompt";
const MANUAL_CONTENT_FIELD_ID = "manual_content";

const DEFAULT_MANUAL_CONTENT =
  "Manually enter a summary, scene change, or other event. There will be NO AI summarization or compaction of preceding messages.";

const DEFAULT_CONVERSATION_SYSTEM_PROMPT =
  "You are a skilled conversation analyst who creates clear, readable summaries of Discord conversations. " +
  "Your goal is to distill the conversation into a well-written, human-readable narrative that captures the essential elements: " +
  "key facts, relationships between participants, important decisions, ongoing tasks, and the overall flow of discussion. " +
  "Write in natural prose that's easy to understand, avoiding unnecessary jargon or robotic phrasing. " +
  "Be concise but thorough: every sentence should add value. Output plain text only.";

const DEFAULT_ROLEPLAY_SYSTEM_PROMPT =
  "You are producing a summary of this AI-enabled roleplay session in order to shorten the context submitted to the AI in future messages. " +
  "Analyze the roleplay narrative and produce a structured summary which captures necessary elements to provide narrative and character coherency going forward. " +
  "Write with clarity, and structure the summary as appropriate for the material presented. " +
  "Your description should be complete while remaining quite concise. " +
  "If something is unclear, note this rather than attempting to resolve it. " +
  "Your target audience is the AI player, not the human player - consider this when deciding what to summarize and how. " +
  "Your maximum budget is 3500 characters.";

export type CompactModalSelection = {
  submitInteraction: ModalSubmitInteraction;
  summaryType: CompactSummaryMode;
  refresh: boolean;
  analyzeImages: boolean;
  systemPrompt: string;
};

export async function promptForCompactOptions(
  interaction: ChatInputCommandInteraction,
  locale: string,
  summaryType: CompactSummaryMode,
): Promise<CompactModalSelection | null> {
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.compact.modal.title",
      components: buildCompactModalComponents(locale, summaryType),
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit") {
    return null;
  }

  const submitInteraction = modalResult.interaction;
  if (!submitInteraction || !modalResult.values) {
    return null;
  }

  const defaultSystemPrompt =
    summaryType === "roleplay" ? DEFAULT_ROLEPLAY_SYSTEM_PROMPT : DEFAULT_CONVERSATION_SYSTEM_PROMPT;

  return {
    submitInteraction,
    summaryType,
    refresh: (modalResult.multiValues?.[REFRESH_FIELD_ID] ?? []).includes("yes"),
    analyzeImages: (modalResult.multiValues?.[ANALYZE_IMAGES_FIELD_ID] ?? []).includes("yes"),
    systemPrompt: modalResult.values[SYSTEM_PROMPT_FIELD_ID]?.trim() || defaultSystemPrompt,
  };
}

export type ManualModalSelection = {
  submitInteraction: ModalSubmitInteraction;
  refresh: boolean;
  summaryContent: string;
};

export async function promptForManualOptions(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<ManualModalSelection | null> {
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MANUAL_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.compact.modal.title",
      components: [
        {
          kind: "checkboxGroup",
          customId: REFRESH_FIELD_ID,
          labelKey: "commands.compact.modal.refresh_label",
          descriptionKey: "commands.compact.modal.refresh_description",
          minValues: 0,
          required: false,
          options: [{ label: localizer(locale, "general.yes"), value: "yes" }],
        },
        {
          customId: MANUAL_CONTENT_FIELD_ID,
          labelKey: "commands.compact.modal.manual_content_label",
          required: false,
          style: TextInputStyle.Paragraph,
          maxLength: 4000,
          value: DEFAULT_MANUAL_CONTENT,
        },
      ],
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit") return null;
  const submitInteraction = modalResult.interaction;
  if (!submitInteraction || !modalResult.values) return null;

  return {
    submitInteraction,
    refresh: (modalResult.multiValues?.[REFRESH_FIELD_ID] ?? []).includes("yes"),
    summaryContent: modalResult.values[MANUAL_CONTENT_FIELD_ID]?.trim() || DEFAULT_MANUAL_CONTENT,
  };
}

function buildCompactModalComponents(locale: string, summaryType: CompactSummaryMode): ModalComponent[] {
  const defaultSystemPrompt =
    summaryType === "roleplay" ? DEFAULT_ROLEPLAY_SYSTEM_PROMPT : DEFAULT_CONVERSATION_SYSTEM_PROMPT;

  return [
    {
      kind: "checkboxGroup",
      customId: REFRESH_FIELD_ID,
      labelKey: "commands.compact.modal.refresh_label",
      descriptionKey: "commands.compact.modal.refresh_description",
      minValues: 0,
      required: false,
      options: [{ label: localizer(locale, "general.yes"), value: "yes" }],
    },
    {
      kind: "checkboxGroup",
      customId: ANALYZE_IMAGES_FIELD_ID,
      labelKey: "commands.compact.modal.analyze_images_label",
      descriptionKey: "commands.compact.modal.analyze_images_description",
      minValues: 0,
      required: false,
      options: [{ label: localizer(locale, "general.yes"), value: "yes" }],
    },
    {
      customId: SYSTEM_PROMPT_FIELD_ID,
      labelKey: "commands.compact.modal.system_prompt_label",
      placeholder: "commands.compact.modal.system_prompt_placeholder",
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 2000,
      value: defaultSystemPrompt,
    },
  ];
}
