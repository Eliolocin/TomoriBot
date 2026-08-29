import { version as packageVersion } from "../../../package.json";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { DOCS_PATHS, type DocsPath } from "@/utils/discord/docsLinks";
import { legalNoticeSuffix } from "@/utils/misc/legalNotice";
import { localizer } from "@/utils/text/localizer";

export const HELP_CATEGORY_IDS = ["setup", "features", "memory", "behavior", "integrations"] as const;
export type HelpCategoryId = (typeof HELP_CATEGORY_IDS)[number];

export const HELP_PAGE_IDS = [
  "setup-step-1",
  "setup-step-2",
  "setup-step-3",
  "setup-step-4",
  "features",
  "personal-providers",
  "custom-endpoints",
  "speech",
  "transcription",
  "persistent-memory",
  "short-term-memory",
  "memory-tagging",
  "customization",
  "personal-spotlight",
  "deliberate-trigger-mode",
  "deliberate-tool-mode",
  "age-restricted-commands",
  "matrix",
  "mcp",
  "sillytavern-presets",
] as const;
export type HelpPageId = (typeof HELP_PAGE_IDS)[number];

type HelpVariables = Record<string, string | number | boolean>;

export interface HelpSectionDefinition {
  titleKey: string;
  bodyKey: string;
  variables?: (locale: string) => HelpVariables;
}

interface HelpContentDefinition {
  titleKey: string;
  descriptionKey: string;
  docsPath: DocsPath;
  sections: readonly HelpSectionDefinition[];
  footerKey?: string;
  introTitleKey?: string;
  introDescriptionKey?: string;
  titleHeadingLevel?: 2 | 3;
  showProviderPicker?: boolean;
  providerPickerFooterKey?: string;
  variables?: (locale: string) => HelpVariables;
}

export interface HelpVariantDefinition extends HelpContentDefinition {
  id: string;
  labelKey: string;
}

export interface HelpPageDefinition extends HelpContentDefinition {
  id: HelpPageId;
  labelKey: string;
  variants?: readonly HelpVariantDefinition[];
}

export interface HelpCategoryDefinition {
  id: HelpCategoryId;
  labelKey: string;
  pages: readonly HelpPageDefinition[];
}

export function buildHelpPageReference(locale: string, labelKey: string): string {
  return localizer(locale, "commands.help.dashboard.page_reference", {
    page: localizer(locale, labelKey),
  });
}

function mention(command: string, subcommandOrGroup?: string, subcommand?: string): string {
  return commandRegistry.getCommandMention(command, subcommandOrGroup, subcommand);
}

const setupPages: readonly HelpPageDefinition[] = [
  {
    id: "setup-step-1",
    labelKey: "commands.help.dashboard.pages.setup_step_1",
    titleKey: "commands.help.setup.step1_title",
    descriptionKey: "commands.help.setup.step1_description",
    docsPath: DOCS_PATHS.API_KEYS,
    sections: [],
    introTitleKey: "commands.help.dashboard.header_title",
    introDescriptionKey: "commands.help.dashboard.header_description",
    titleHeadingLevel: 3,
    showProviderPicker: true,
    providerPickerFooterKey: "commands.help.setup.provider_picker_footer",
  },
  {
    id: "setup-step-2",
    labelKey: "commands.help.dashboard.pages.setup_step_2",
    titleKey: "commands.help.setup.step2_title",
    descriptionKey: "commands.help.setup.step2_description",
    docsPath: DOCS_PATHS.QUICKSTART,
    sections: [],
    titleHeadingLevel: 3,
    variables: () => ({
      configSetup: mention("setup"),
      expressionsInitialize: mention("expressions", "initialize"),
    }),
  },
  {
    id: "setup-step-3",
    labelKey: "commands.help.dashboard.pages.setup_step_3",
    titleKey: "commands.help.setup.step3_title",
    descriptionKey: "commands.help.setup.step3_description",
    docsPath: DOCS_PATHS.QUICKSTART,
    sections: [],
    titleHeadingLevel: 3,
    variables: () => ({
      personaTrigger: mention("persona", "trigger"),
      configPermissions: mention("capabilities", "manage"),
      serverAutotrigger: mention("server", "auto-trigger", "channels"),
    }),
  },
  {
    id: "setup-step-4",
    labelKey: "commands.help.dashboard.pages.setup_step_4",
    titleKey: "commands.help.setup.step4_title",
    descriptionKey: "commands.help.setup.step4_description",
    docsPath: DOCS_PATHS.QUICKSTART,
    sections: [
      { titleKey: "commands.help.setup.need_help_title", bodyKey: "commands.help.setup.need_help_description" },
    ],
    titleHeadingLevel: 3,
    variables: (locale) => ({
      persona: mention("persona"),
      server: mention("server"),
      personal: mention("personal"),
      memory: mention("memory"),
      config: mention("config"),
      helpFeatures: buildHelpPageReference(locale, "commands.help.dashboard.pages.features"),
      helpMemory: buildHelpPageReference(locale, "commands.help.dashboard.pages.persistent_memory"),
      helpCustomization: buildHelpPageReference(locale, "commands.help.dashboard.pages.customization"),
      supportServer: mention("support", "discord"),
      legalNotice: legalNoticeSuffix(locale, "general.legal.setup_agreement"),
    }),
  },
] as const;

const featureOverviewPage: HelpPageDefinition = {
  id: "features",
  labelKey: "commands.help.dashboard.pages.features",
  titleKey: "commands.help.features.title",
  descriptionKey: "commands.help.features.embed_description",
  docsPath: DOCS_PATHS.FEATURES,
  sections: [
    {
      titleKey: "commands.help.features.summary_chat_title",
      bodyKey: "commands.help.features.summary_chat_description",
    },
    {
      titleKey: "commands.help.features.summary_knowledge_title",
      bodyKey: "commands.help.features.summary_knowledge_description",
    },
    {
      titleKey: "commands.help.features.summary_capabilities_title",
      bodyKey: "commands.help.features.summary_capabilities_description",
    },
    {
      titleKey: "commands.help.features.summary_reference_title",
      bodyKey: "commands.help.features.summary_reference_description",
    },
  ],
  footerKey: "commands.help.features.footer",
  variables: () => ({ version: packageVersion }),
};

function customEndpointVariables(): HelpVariables {
  return {
    add_command: mention("providers"),
    remove_command: mention("providers"),
    server_add_command: mention("providers"),
    personal_add_command: mention("personal", "providers"),
    text_command: mention("model", "text"),
    image_command: mention("model", "image"),
    video_command: mention("model", "video"),
  };
}

function speechVariables(locale: string): HelpVariables {
  return {
    custom_endpoint_add: mention("providers"),
    model_speech: mention("model", "speech"),
    voice_add: mention("speech", "voice-add"),
    voice_assign: mention("speech", "voice-assign"),
    voice_design_set: mention("speech", "voice-design", "set"),
    elevenlabs: mention("providers"),
    help_transcription: buildHelpPageReference(locale, "commands.help.dashboard.pages.transcription"),
  };
}

function speechVariant(id: string, labelKey: string): HelpVariantDefinition {
  return {
    id,
    labelKey,
    titleKey: `commands.help.speech.${id}.title`,
    descriptionKey: `commands.help.speech.${id}.description`,
    docsPath: DOCS_PATHS.TTS,
    sections: [{ titleKey: "commands.help.speech.summary_title", bodyKey: "commands.help.speech.summary_description" }],
    variables: speechVariables,
  };
}

function transcriptionVariables(locale: string): HelpVariables {
  return {
    custom_endpoint_add: mention("providers"),
    model_transcription: mention("model", "transcription"),
    elevenlabs: mention("providers"),
    speech_transcripts: mention("speech", "transcripts"),
    help_speech: buildHelpPageReference(locale, "commands.help.dashboard.pages.speech"),
  };
}

function transcriptionVariant(id: string, labelKey: string): HelpVariantDefinition {
  return {
    id,
    labelKey,
    titleKey: `commands.help.transcription.${id}.title`,
    descriptionKey: `commands.help.transcription.${id}.description`,
    docsPath: DOCS_PATHS.STT,
    sections: [
      {
        titleKey: "commands.help.transcription.summary_title",
        bodyKey: "commands.help.transcription.summary_description",
      },
    ],
    variables: transcriptionVariables,
  };
}

const featurePages: readonly HelpPageDefinition[] = [
  featureOverviewPage,
  {
    id: "personal-providers",
    labelKey: "commands.help.dashboard.pages.personal_providers",
    titleKey: "commands.help.personal-provider.title",
    descriptionKey: "commands.help.personal-provider.description_body",
    docsPath: DOCS_PATHS.PERSONAL_PROVIDERS,
    sections: [
      {
        titleKey: "commands.help.personal-provider.setup_field",
        bodyKey: "commands.help.personal-provider.setup_value",
      },
      {
        titleKey: "commands.help.personal-provider.behavior_field",
        bodyKey: "commands.help.personal-provider.behavior_value",
      },
      { titleKey: "commands.help.personal-provider.byok_field", bodyKey: "commands.help.personal-provider.byok_value" },
    ],
    footerKey: "commands.help.personal-provider.footer",
    variables: () => ({
      add_command: mention("personal", "providers"),
      model_command: mention("personal", "config"),
      toggle_command: mention("personal", "providers"),
      samplers_command: mention("personal", "config"),
      fallback_command: mention("personal", "config"),
      byok_command: mention("moderation"),
    }),
  },
  {
    id: "custom-endpoints",
    labelKey: "commands.help.dashboard.pages.custom_endpoints",
    titleKey: "commands.help.custom_models.title",
    descriptionKey: "commands.help.custom_models.description_body",
    docsPath: DOCS_PATHS.CUSTOM_ENDPOINTS,
    sections: [
      { titleKey: "commands.help.custom_models.server_field", bodyKey: "commands.help.custom_models.server_value" },
      {
        titleKey: "commands.help.custom_models.personal_field",
        bodyKey: "commands.help.custom_models.personal_value",
        variables: () => ({
          add_command: mention("personal", "providers"),
          remove_command: mention("personal", "providers"),
        }),
      },
      {
        titleKey: "commands.help.custom_models.selection_field",
        bodyKey: "commands.help.custom_models.selection_summary_value",
      },
    ],
    variables: customEndpointVariables,
    variants: [
      {
        id: "overview",
        labelKey: "commands.help.custom_models.choice_overview",
        titleKey: "commands.help.custom_models.title",
        descriptionKey: "commands.help.custom_models.description_body",
        docsPath: DOCS_PATHS.CUSTOM_ENDPOINTS,
        sections: [
          { titleKey: "commands.help.custom_models.server_field", bodyKey: "commands.help.custom_models.server_value" },
          {
            titleKey: "commands.help.custom_models.personal_field",
            bodyKey: "commands.help.custom_models.personal_value",
            variables: () => ({
              add_command: mention("personal", "providers"),
              remove_command: mention("personal", "providers"),
            }),
          },
          {
            titleKey: "commands.help.custom_models.selection_field",
            bodyKey: "commands.help.custom_models.selection_summary_value",
          },
        ],
        variables: customEndpointVariables,
      },
      {
        id: "comfyui",
        labelKey: "commands.help.custom_models.choice_comfyui",
        titleKey: "commands.help.custom_models.comfyui_page1_title",
        descriptionKey: "commands.help.custom_models.comfyui_summary_description",
        docsPath: DOCS_PATHS.COMFYUI_SETUP,
        sections: [
          {
            titleKey: "commands.help.custom_models.comfyui_summary_register_field",
            bodyKey: "commands.help.custom_models.comfyui_summary_register_value",
          },
        ],
        variables: customEndpointVariables,
      },
    ],
  },
  {
    id: "speech",
    labelKey: "commands.help.dashboard.pages.speech",
    titleKey: "commands.help.speech.overview.title",
    descriptionKey: "commands.help.speech.overview.description",
    docsPath: DOCS_PATHS.TTS,
    sections: [{ titleKey: "commands.help.speech.summary_title", bodyKey: "commands.help.speech.summary_description" }],
    variables: speechVariables,
    variants: [
      speechVariant("overview", "commands.help.dashboard.variants.overview"),
      speechVariant("chatterbox", "commands.help.dashboard.variants.chatterbox"),
      speechVariant("qwen3tts", "commands.help.dashboard.variants.qwen3tts"),
      speechVariant("irodoritts", "commands.help.dashboard.variants.irodoritts"),
      speechVariant("elevenlabs", "commands.help.dashboard.variants.elevenlabs"),
    ],
  },
  {
    id: "transcription",
    labelKey: "commands.help.dashboard.pages.transcription",
    titleKey: "commands.help.transcription.overview.title",
    descriptionKey: "commands.help.transcription.overview.description",
    docsPath: DOCS_PATHS.STT,
    sections: [
      {
        titleKey: "commands.help.transcription.summary_title",
        bodyKey: "commands.help.transcription.summary_description",
      },
    ],
    variables: transcriptionVariables,
    variants: [
      transcriptionVariant("overview", "commands.help.dashboard.variants.overview"),
      transcriptionVariant("whisperx", "commands.help.dashboard.variants.whisperx"),
      transcriptionVariant("koboldcpp", "commands.help.dashboard.variants.koboldcpp"),
      transcriptionVariant("elevenlabs", "commands.help.dashboard.variants.elevenlabs"),
    ],
  },
] as const;

const memoryPages: readonly HelpPageDefinition[] = [
  {
    id: "persistent-memory",
    labelKey: "commands.help.dashboard.pages.persistent_memory",
    titleKey: "commands.help.memory.title",
    descriptionKey: "commands.help.memory.embed_description",
    docsPath: DOCS_PATHS.MEMORY,
    sections: [
      { titleKey: "commands.help.memory.teaching_title", bodyKey: "commands.help.memory.teaching_description" },
      { titleKey: "commands.help.memory.forgetting_title", bodyKey: "commands.help.memory.forgetting_description" },
      { titleKey: "commands.help.memory.how_it_works_title", bodyKey: "commands.help.memory.how_it_works_description" },
      { titleKey: "commands.help.memory.tips_title", bodyKey: "commands.help.memory.tips_description" },
      { titleKey: "commands.help.memory.documents_title", bodyKey: "commands.help.memory.documents_description" },
      { titleKey: "commands.help.memory.shortterm_title", bodyKey: "commands.help.memory.shortterm_description" },
    ],
    variables: (locale) => ({
      memoryPersonalAdd: mention("personal", "memories"),
      memoryPersonalRemove: mention("personal", "memories"),
      memoryPersonalExport: mention("memory", "personal", "export"),
      memoryServerAdd: mention("memory", "server", "add"),
      memoryServerRemove: mention("memory", "server", "remove"),
      memoryServerExport: mention("memory", "server", "export"),
      status: mention("tool", "status"),
      helpCustomization: buildHelpPageReference(locale, "commands.help.dashboard.pages.customization"),
      personalStm: mention("personal", "config"),
      personalStmClear: mention("personal", "memories"),
      legalNotice: legalNoticeSuffix(locale, "general.legal.data_handling_reference"),
    }),
  },
  {
    id: "short-term-memory",
    labelKey: "commands.help.dashboard.pages.short_term_memory",
    titleKey: "commands.help.stm.title",
    descriptionKey: "commands.help.stm.embed_description",
    docsPath: DOCS_PATHS.SHORT_TERM_MEMORY,
    sections: [
      { titleKey: "commands.help.stm.parameters_title", bodyKey: "commands.help.stm.parameters_description" },
      { titleKey: "commands.help.stm.nudge_title", bodyKey: "commands.help.stm.nudge_description" },
      { titleKey: "commands.help.stm.categories_title", bodyKey: "commands.help.stm.categories_description" },
      { titleKey: "commands.help.stm.prompts_title", bodyKey: "commands.help.stm.prompts_description" },
      { titleKey: "commands.help.stm.manage_title", bodyKey: "commands.help.stm.manage_description" },
    ],
    variables: (locale) => ({
      helpMemory: buildHelpPageReference(locale, "commands.help.dashboard.pages.persistent_memory"),
      stmParameters: mention("server", "stm", "parameters"),
      stmPromptEdit: mention("server", "stm", "prompt-edit"),
      stmCategoriesEdit: mention("server", "stm", "categories-edit"),
      stmManage: mention("server", "stm", "manage"),
      stmPrivacyBypass: mention("server", "stm", "privacy-bypass"),
      personaStmEdit: mention("persona", "stm", "edit"),
    }),
  },
  {
    id: "memory-tagging",
    labelKey: "commands.help.dashboard.pages.memory_tagging",
    titleKey: "commands.help.memory-tagging.title",
    descriptionKey: "commands.help.memory-tagging.embed_description",
    docsPath: DOCS_PATHS.MEMORY_TAGGING,
    sections: [
      {
        titleKey: "commands.help.memory-tagging.keywords_title",
        bodyKey: "commands.help.memory-tagging.keywords_description",
      },
      {
        titleKey: "commands.help.memory-tagging.channels_title",
        bodyKey: "commands.help.memory-tagging.channels_description",
      },
    ],
    variables: () => ({
      memoryTaggingSet: mention("memory", "tagging", "set"),
      toolPromptSnapshot: mention("tool", "prompt", "snapshot"),
    }),
  },
] as const;

const behaviorPages: readonly HelpPageDefinition[] = [
  {
    id: "customization",
    labelKey: "commands.help.dashboard.pages.customization",
    titleKey: "commands.help.customization.embed1_title",
    descriptionKey: "commands.help.customization.embed1_description",
    docsPath: DOCS_PATHS.MULTIPLE_PERSONAS,
    sections: [
      {
        titleKey: "commands.help.customization.summary_personas_title",
        bodyKey: "commands.help.customization.summary_personas_description",
      },
      {
        titleKey: "commands.help.customization.summary_behavior_title",
        bodyKey: "commands.help.customization.summary_behavior_description",
      },
      {
        titleKey: "commands.help.customization.summary_server_title",
        bodyKey: "commands.help.customization.summary_server_description",
      },
    ],
    variables: (locale) => ({
      helpMemory: buildHelpPageReference(locale, "commands.help.dashboard.pages.persistent_memory"),
      personaCreate: mention("persona", "create"),
      personaGenerate: mention("persona", "generate"),
      personaAttributeAdd: mention("persona", "attribute", "add"),
      personaSampleDialogueAdd: mention("persona", "sample-dialogue", "add"),
      configModel: mention("model", "text"),
      configHumanizer: mention("config", "humanizer"),
      configSystemPromptSet: mention("config", "system-prompt", "set"),
      capabilitiesManage: mention("capabilities", "manage"),
      serverWhitelistChannel: mention("moderation"),
    }),
  },
  {
    id: "personal-spotlight",
    labelKey: "commands.help.dashboard.pages.personal_spotlight",
    titleKey: "commands.help.spotlight.title",
    descriptionKey: "commands.help.spotlight.embed_description",
    docsPath: DOCS_PATHS.PERSONAL_SPOTLIGHT,
    sections: [
      { titleKey: "commands.help.spotlight.what_title", bodyKey: "commands.help.spotlight.what_description" },
      { titleKey: "commands.help.spotlight.set_title", bodyKey: "commands.help.spotlight.set_description" },
      {
        titleKey: "commands.help.spotlight.auto_trigger_title",
        bodyKey: "commands.help.spotlight.auto_trigger_description",
      },
      { titleKey: "commands.help.spotlight.rules_title", bodyKey: "commands.help.spotlight.rules_description" },
      { titleKey: "commands.help.spotlight.manage_title", bodyKey: "commands.help.spotlight.manage_description" },
    ],
    footerKey: "commands.help.spotlight.footer",
    variables: () => ({
      personalSpotlightSet: mention("personal", "config"),
      personalSpotlightManage: mention("personal", "config"),
      serverWhitelistPersona: mention("moderation"),
    }),
  },
  {
    id: "deliberate-trigger-mode",
    labelKey: "commands.help.dashboard.pages.deliberate_trigger_mode",
    titleKey: "commands.help.deliberate-trigger-mode.title",
    descriptionKey: "commands.help.deliberate-trigger-mode.embed_description",
    docsPath: `${DOCS_PATHS.CHATTING_TRIGGERS}#deliberate-trigger-mode`,
    sections: [
      {
        titleKey: "commands.help.deliberate-trigger-mode.normal_title",
        bodyKey: "commands.help.deliberate-trigger-mode.normal_description",
      },
      {
        titleKey: "commands.help.deliberate-trigger-mode.enabled_title",
        bodyKey: "commands.help.deliberate-trigger-mode.enabled_description",
      },
      {
        titleKey: "commands.help.deliberate-trigger-mode.personal_title",
        bodyKey: "commands.help.deliberate-trigger-mode.personal_description",
      },
    ],
    footerKey: "commands.help.deliberate-trigger-mode.footer",
    variables: () => ({
      serverDtm: mention("server", "deliberate-trigger-mode"),
      personalDtm: mention("personal", "config"),
      respondCommand: mention("respond"),
    }),
  },
  {
    id: "deliberate-tool-mode",
    labelKey: "commands.help.dashboard.pages.deliberate_tool_mode",
    titleKey: "commands.help.deliberate-tool-mode.title",
    descriptionKey: "commands.help.deliberate-tool-mode.embed_description",
    docsPath: DOCS_PATHS.DELIBERATE_TOOL_MODE,
    sections: [
      {
        titleKey: "commands.help.deliberate-tool-mode.what_title",
        bodyKey: "commands.help.deliberate-tool-mode.what_description",
      },
      {
        titleKey: "commands.help.deliberate-tool-mode.intent_title",
        bodyKey: "commands.help.deliberate-tool-mode.intent_description",
      },
      {
        titleKey: "commands.help.deliberate-tool-mode.custom_title",
        bodyKey: "commands.help.deliberate-tool-mode.custom_description",
      },
      {
        titleKey: "commands.help.deliberate-tool-mode.control_title",
        bodyKey: "commands.help.deliberate-tool-mode.control_description",
      },
    ],
    footerKey: "commands.help.deliberate-tool-mode.footer",
    variables: () => ({
      serverDtm: mention("server", "deliberate-tool-mode"),
      personalDtm: mention("personal", "config"),
      triggerCommand: mention("server", "deliberate-tool-trigger"),
      thoughtLogs: mention("server", "thought-logs-channel"),
    }),
  },
  {
    id: "age-restricted-commands",
    labelKey: "commands.help.dashboard.pages.age_restricted_commands",
    titleKey: "commands.help.nsfw.title",
    descriptionKey: "commands.help.nsfw.embed_description",
    docsPath: DOCS_PATHS.AGE_RESTRICTED_COMMANDS,
    sections: [
      { titleKey: "commands.help.nsfw.enable_title", bodyKey: "commands.help.nsfw.enable_description" },
      { titleKey: "commands.help.nsfw.channel_title", bodyKey: "commands.help.nsfw.channel_description" },
      { titleKey: "commands.help.nsfw.warning_title", bodyKey: "commands.help.nsfw.warning_description" },
    ],
    footerKey: "commands.help.nsfw.footer",
  },
] as const;

const integrationPages: readonly HelpPageDefinition[] = [
  {
    id: "matrix",
    labelKey: "commands.help.dashboard.pages.matrix",
    titleKey: "commands.help.matrix.title",
    descriptionKey: "commands.help.matrix.embed_description",
    docsPath: DOCS_PATHS.MATRIX_BRIDGE,
    sections: [
      { titleKey: "commands.help.matrix.setup_title", bodyKey: "commands.help.matrix.setup_description" },
      { titleKey: "commands.help.matrix.room_id_title", bodyKey: "commands.help.matrix.room_id_description" },
      { titleKey: "commands.help.matrix.usage_title", bodyKey: "commands.help.matrix.usage_description" },
      { titleKey: "commands.help.matrix.limitations_title", bodyKey: "commands.help.matrix.limitations_description" },
      {
        titleKey: "commands.help.matrix.troubleshooting_title",
        bodyKey: "commands.help.matrix.troubleshooting_description",
      },
    ],
    variables: (locale) => ({
      botUserId: process.env.MATRIX_BOT_USER_ID ?? localizer(locale, "commands.help.matrix.bot_user_fallback"),
      matrixLink: mention("matrix", "link"),
      supportServer: mention("support", "discord"),
    }),
  },
  {
    id: "mcp",
    labelKey: "commands.help.dashboard.pages.mcp",
    titleKey: "commands.help.mcp.title",
    descriptionKey: "commands.help.mcp.description_text",
    docsPath: DOCS_PATHS.MCP,
    sections: [
      { titleKey: "commands.help.mcp.online_title", bodyKey: "commands.help.mcp.online_summary_description" },
      { titleKey: "commands.help.mcp.local_title", bodyKey: "commands.help.mcp.local_summary_description" },
      { titleKey: "commands.help.mcp.security_title", bodyKey: "commands.help.mcp.security_description" },
    ],
    footerKey: "commands.help.mcp.footer",
    variables: () => ({ mcpsCommand: mention("mcps") }),
  },
  {
    id: "sillytavern-presets",
    labelKey: "commands.help.dashboard.pages.sillytavern_presets",
    titleKey: "commands.help.st-preset.embed1_title",
    descriptionKey: "commands.help.st-preset.embed1_description",
    docsPath: DOCS_PATHS.SILLYTAVERN_PROMPT_PRESETS,
    sections: [
      {
        titleKey: "commands.help.st-preset.embed1_controls_title",
        bodyKey: "commands.help.st-preset.embed1_controls_description",
      },
      {
        titleKey: "commands.help.st-preset.embed1_still_sent_title",
        bodyKey: "commands.help.st-preset.embed1_still_sent_description",
      },
    ],
    footerKey: "commands.help.st-preset.embed1_footer",
    variables: () => ({
      stPresets: mention("st-presets"),
      stPresetImport: mention("st-presets"),
      stPresetToggle: mention("st-presets"),
      stPresetRemove: mention("st-presets"),
      configSystemPromptSet: mention("config", "system-prompt", "set"),
      personaPromptSet: mention("persona", "prompt", "set"),
      personaAttributeAdd: mention("persona", "attribute", "add"),
      personaSampleDialogueAdd: mention("persona", "sample-dialogue", "add"),
    }),
  },
] as const;

export const HELP_CATEGORIES: readonly HelpCategoryDefinition[] = [
  { id: "setup", labelKey: "commands.help.dashboard.categories.setup", pages: setupPages },
  { id: "features", labelKey: "commands.help.dashboard.categories.features", pages: featurePages },
  { id: "memory", labelKey: "commands.help.dashboard.categories.memory", pages: memoryPages },
  { id: "behavior", labelKey: "commands.help.dashboard.categories.behavior", pages: behaviorPages },
  { id: "integrations", labelKey: "commands.help.dashboard.categories.integrations", pages: integrationPages },
] as const;

export function getHelpCategory(categoryId: string): HelpCategoryDefinition | undefined {
  return HELP_CATEGORIES.find((category) => category.id === categoryId);
}

export function getHelpPage(category: HelpCategoryDefinition, pageId: string): HelpPageDefinition | undefined {
  return category.pages.find((page) => page.id === pageId);
}

export function getHelpVariant(page: HelpPageDefinition, variantId?: string): HelpVariantDefinition | undefined {
  if (!variantId) {
    return undefined;
  }
  return page.variants?.find((variant) => variant.id === variantId);
}
