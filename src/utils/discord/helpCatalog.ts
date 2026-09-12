import { commandRegistry } from "@/utils/discord/commandRegistry";
import { DOCS_PATHS, type DocsPath } from "@/utils/discord/docsLinks";
import { localizer } from "@/utils/text/localizer";

export const HELP_CATEGORY_IDS = ["setup", "features", "moderation", "plugins"] as const;
export type HelpCategoryId = (typeof HELP_CATEGORY_IDS)[number];

export const HELP_PAGE_IDS = [
  "personal-profile",
  "custom-endpoints",
  "multiple-personas",
  "media-generation",
  "tons-of-tweakability",
  "memory",
  "scheduled-tasks",
  "server-moderation",
  "quotas",
  "age-restricted-commands",
  "user-byok",
  "sillytavern-presets",
  "mcp-servers",
  "matrix",
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
  pickerDescriptionKey: string;
}

export interface HelpPageDefinition extends HelpContentDefinition {
  id: HelpPageId;
  labelKey: string;
  pickerDescriptionKey: string;
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

type BreadcrumbRoot = "config" | "personal" | "moderation";

function renderBreadcrumbRoot(root: BreadcrumbRoot, locale: string, breadcrumbKey: string): string {
  const rootMention =
    root === "config"
      ? commandRegistry.getCommandMention("config", undefined, undefined, true)
      : root === "personal"
        ? commandRegistry.getCommandMention("personal", "config", undefined, true)
        : commandRegistry.getCommandMention("moderation", undefined, undefined, true);
  return `${rootMention} > ${localizer(locale, breadcrumbKey)}`;
}

export function breadcrumbPage(root: BreadcrumbRoot, locale: string, breadcrumbKey: string): string {
  return renderBreadcrumbRoot(root, locale, breadcrumbKey);
}

/**
 * Every dissolved leaf now reaches its destination through the same bare `/config` mention, so a
 * sentence naming several of them would repeat an identical token with nothing to tell the pages
 * apart. The breadcrumb carries the distinction the subcommand name used to.
 */
export function configPage(locale: string, breadcrumbKey: string): string {
  return renderBreadcrumbRoot("config", locale, breadcrumbKey);
}

export function personalConfigPage(locale: string, breadcrumbKey: string): string {
  return renderBreadcrumbRoot("personal", locale, breadcrumbKey);
}

export function moderationPage(locale: string, breadcrumbKey: string): string {
  return renderBreadcrumbRoot("moderation", locale, breadcrumbKey);
}

const setupPages: readonly HelpPageDefinition[] = [
  {
    id: "personal-profile",
    labelKey: "commands.help.dashboard.sections.personal_profile",
    pickerDescriptionKey: "commands.help.dashboard.sections.personal_profile_description",
    titleKey: "commands.help.personal_profile.title",
    descriptionKey: "commands.help.personal_profile.description",
    docsPath: DOCS_PATHS.PERSONALIZATION,
    sections: [],
    variants: [
      {
        id: "nickname-pronouns",
        labelKey: "commands.help.dashboard.subsections.nickname_pronouns",
        pickerDescriptionKey: "commands.help.dashboard.subsections.nickname_pronouns_description",
        titleKey: "commands.help.personal_profile.nickname_pronouns.title",
        descriptionKey: "commands.help.personal_profile.nickname_pronouns.description",
        docsPath: DOCS_PATHS.PERSONALIZATION,
        sections: [],
        footerKey: "commands.help.personal_profile.nickname_pronouns.footer",
        variables: (locale) => ({
          personalProfile: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.general"),
        }),
      },
      {
        id: "personal-memories",
        labelKey: "commands.help.dashboard.subsections.personal_memories",
        pickerDescriptionKey: "commands.help.dashboard.subsections.personal_memories_description",
        titleKey: "commands.help.personal_profile.personal_memories.title",
        descriptionKey: "commands.help.personal_profile.personal_memories.description",
        docsPath: DOCS_PATHS.PERSONALIZATION,
        sections: [],
        footerKey: "commands.help.personal_profile.personal_memories.footer",
        variables: (locale) => ({
          personalMemories: mention("personal", "memories"),
          personalPrivacy: personalConfigPage(locale, "commands.help.breadcrumbs.personal.privacy.controls"),
        }),
      },
      {
        id: "personal-providers",
        labelKey: "commands.help.dashboard.subsections.personal_providers",
        pickerDescriptionKey: "commands.help.dashboard.subsections.personal_providers_description",
        titleKey: "commands.help.personal_profile.personal_providers.title",
        descriptionKey: "commands.help.personal_profile.personal_providers.description",
        docsPath: DOCS_PATHS.PERSONAL_PROVIDERS,
        sections: [],
        variables: (locale) => ({
          personalProviders: mention("personal", "providers"),
          personalModels: personalConfigPage(locale, "commands.help.breadcrumbs.personal.models.switch"),
        }),
      },
    ],
  },
  {
    id: "custom-endpoints",
    labelKey: "commands.help.dashboard.sections.custom_endpoints",
    pickerDescriptionKey: "commands.help.dashboard.sections.custom_endpoints_description",
    titleKey: "commands.help.custom_endpoints.title",
    descriptionKey: "commands.help.custom_endpoints.description",
    docsPath: DOCS_PATHS.CUSTOM_ENDPOINTS,
    sections: [],
    variables: () => ({
      providers: mention("providers"),
      personalProviders: mention("personal", "providers"),
    }),
    variants: [
      {
        id: "text-models",
        labelKey: "commands.help.dashboard.subsections.text_models",
        pickerDescriptionKey: "commands.help.dashboard.subsections.text_models_description",
        titleKey: "commands.help.custom_endpoints.text_models.title",
        descriptionKey: "commands.help.custom_endpoints.text_models.description",
        docsPath: DOCS_PATHS.CUSTOM_ENDPOINTS,
        sections: [],
        footerKey: "commands.help.custom_endpoints.text_models.footer",
        variables: (locale) => ({
          configSwitchModels: configPage(locale, "commands.help.breadcrumbs.models.switch"),
        }),
      },
      {
        id: "comfyui",
        labelKey: "commands.help.dashboard.subsections.comfyui",
        pickerDescriptionKey: "commands.help.dashboard.subsections.comfyui_description",
        titleKey: "commands.help.custom_endpoints.comfyui.title",
        descriptionKey: "commands.help.custom_endpoints.comfyui.description",
        docsPath: DOCS_PATHS.COMFYUI_SETUP,
        sections: [],
        footerKey: "commands.help.custom_endpoints.comfyui.footer",
      },
      {
        id: "text-to-speech",
        labelKey: "commands.help.dashboard.subsections.text_to_speech",
        pickerDescriptionKey: "commands.help.dashboard.subsections.text_to_speech_description",
        titleKey: "commands.help.custom_endpoints.text_to_speech.title",
        descriptionKey: "commands.help.custom_endpoints.text_to_speech.description",
        docsPath: DOCS_PATHS.TTS,
        sections: [],
        footerKey: "commands.help.custom_endpoints.text_to_speech.footer",
        variables: (locale) => ({
          configPersonaVoice: configPage(locale, "commands.help.breadcrumbs.persona.voice"),
          configVoices: configPage(locale, "commands.help.breadcrumbs.models.voices"),
        }),
      },
    ],
  },
];

const featurePages: readonly HelpPageDefinition[] = [
  {
    id: "multiple-personas",
    labelKey: "commands.help.dashboard.sections.multiple_personas",
    pickerDescriptionKey: "commands.help.dashboard.sections.multiple_personas_description",
    titleKey: "commands.help.multiple_personas.title",
    descriptionKey: "commands.help.multiple_personas.description",
    docsPath: DOCS_PATHS.MULTIPLE_PERSONAS,
    sections: [
      {
        titleKey: "commands.help.multiple_personas.mains_alters_title",
        bodyKey: "commands.help.multiple_personas.mains_alters_body",
      },
      {
        titleKey: "commands.help.multiple_personas.bringing_in_title",
        bodyKey: "commands.help.multiple_personas.bringing_in_body",
      },
      {
        titleKey: "commands.help.multiple_personas.where_to_find_title",
        bodyKey: "commands.help.multiple_personas.where_to_find_body",
      },
      {
        titleKey: "commands.help.multiple_personas.talking_title",
        bodyKey: "commands.help.multiple_personas.talking_body",
      },
    ],
    footerKey: "commands.help.multiple_personas.footer",
    variables: (locale) => ({
      personaImport: mention("persona", "import"),
      configPersonaAppearance: configPage(locale, "commands.help.breadcrumbs.persona.general"),
      configPersonaSprites: configPage(locale, "commands.help.breadcrumbs.persona.sprites"),
      configPersonaTriggers: configPage(locale, "commands.help.breadcrumbs.persona.triggers"),
      personaExport: mention("persona", "export"),
    }),
  },
  {
    id: "media-generation",
    labelKey: "commands.help.dashboard.sections.media_generation",
    pickerDescriptionKey: "commands.help.dashboard.sections.media_generation_description",
    titleKey: "commands.help.media_generation.title",
    descriptionKey: "commands.help.media_generation.description",
    docsPath: DOCS_PATHS.MEDIA_GENERATION,
    sections: [],
    variants: [
      {
        id: "image-generation",
        labelKey: "commands.help.dashboard.subsections.image_generation",
        pickerDescriptionKey: "commands.help.dashboard.subsections.image_generation_description",
        titleKey: "commands.help.media_generation.image_generation.title",
        descriptionKey: "commands.help.media_generation.image_generation.description",
        docsPath: DOCS_PATHS.MEDIA_GENERATION,
        sections: [],
        footerKey: "commands.help.media_generation.image_generation.footer",
        variables: (locale) => ({
          generateImage: mention("generate", "image"),
          providers: mention("providers"),
          configImageDefaults: configPage(locale, "commands.help.breadcrumbs.models.image"),
        }),
      },
      {
        id: "video-generation",
        labelKey: "commands.help.dashboard.subsections.video_generation",
        pickerDescriptionKey: "commands.help.dashboard.subsections.video_generation_description",
        titleKey: "commands.help.media_generation.video_generation.title",
        descriptionKey: "commands.help.media_generation.video_generation.description",
        docsPath: DOCS_PATHS.MEDIA_GENERATION,
        sections: [],
        variables: () => ({
          generateVideo: mention("generate", "video"),
          providers: mention("providers"),
        }),
      },
      {
        id: "speech-generation",
        labelKey: "commands.help.dashboard.subsections.speech_generation",
        pickerDescriptionKey: "commands.help.dashboard.subsections.speech_generation_description",
        titleKey: "commands.help.media_generation.speech_generation.title",
        descriptionKey: "commands.help.media_generation.speech_generation.description",
        docsPath: DOCS_PATHS.TTS,
        sections: [],
        variables: (locale) => ({
          generateVoice: mention("generate", "voice-message"),
          configPersonaVoice: configPage(locale, "commands.help.breadcrumbs.persona.voice"),
        }),
      },
    ],
  },
  {
    id: "tons-of-tweakability",
    labelKey: "commands.help.dashboard.sections.tons_of_tweakability",
    pickerDescriptionKey: "commands.help.dashboard.sections.tons_of_tweakability_description",
    titleKey: "commands.help.tons_of_tweakability.title",
    descriptionKey: "commands.help.tons_of_tweakability.description",
    docsPath: DOCS_PATHS.BEHAVIOR_TWEAKING,
    sections: [],
    variants: [
      {
        id: "behavior-tuning",
        labelKey: "commands.help.dashboard.subsections.behavior_tuning",
        pickerDescriptionKey: "commands.help.dashboard.subsections.behavior_tuning_description",
        titleKey: "commands.help.tons_of_tweakability.behavior_tuning.title",
        descriptionKey: "commands.help.tons_of_tweakability.behavior_tuning.description",
        docsPath: DOCS_PATHS.BEHAVIOR_TWEAKING,
        sections: [],
        footerKey: "commands.help.tons_of_tweakability.behavior_tuning.footer",
        variables: (locale) => ({
          configSwitchModels: configPage(locale, "commands.help.breadcrumbs.models.switch"),
          configBehaviorGeneral: configPage(locale, "commands.help.breadcrumbs.behavior.general"),
          configTools: configPage(locale, "commands.help.breadcrumbs.plugins.available-tools"),
          configParameters: configPage(locale, "commands.help.breadcrumbs.models.parameters"),
        }),
      },
      {
        id: "server-wide-settings",
        labelKey: "commands.help.dashboard.subsections.server_wide_settings",
        pickerDescriptionKey: "commands.help.dashboard.subsections.server_wide_settings_description",
        titleKey: "commands.help.tons_of_tweakability.server_wide_settings.title",
        descriptionKey: "commands.help.tons_of_tweakability.server_wide_settings.description",
        docsPath: DOCS_PATHS.CHATTING_TRIGGERS,
        sections: [],
        footerKey: "commands.help.tons_of_tweakability.server_wide_settings.footer",
        variables: (locale) => ({
          moderation: mention("moderation"),
          configAutoTrigger: configPage(locale, "commands.help.breadcrumbs.channels.auto-trigger"),
          configWelcome: configPage(locale, "commands.help.breadcrumbs.channels.destinations"),
          configChannelOverrides: configPage(locale, "commands.help.breadcrumbs.channels.overrides"),
        }),
      },
      {
        id: "personal-settings",
        labelKey: "commands.help.dashboard.subsections.personal_settings",
        pickerDescriptionKey: "commands.help.dashboard.subsections.personal_settings_description",
        titleKey: "commands.help.tons_of_tweakability.personal_settings.title",
        descriptionKey: "commands.help.tons_of_tweakability.personal_settings.description",
        docsPath: DOCS_PATHS.PERSONALIZATION,
        sections: [],
        footerKey: "commands.help.tons_of_tweakability.personal_settings.footer",
        variables: (locale) => ({
          personalProfile: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.general"),
          personalProviders: mention("personal", "providers"),
          personalConfig: mention("personal", "config"),
          personalSpotlight: personalConfigPage(locale, "commands.help.breadcrumbs.personal.advanced.spotlight"),
        }),
      },
    ],
  },
  {
    id: "memory",
    labelKey: "commands.help.dashboard.sections.memory",
    pickerDescriptionKey: "commands.help.dashboard.sections.memory_description",
    titleKey: "commands.help.memory_catalog.title",
    descriptionKey: "commands.help.memory_catalog.description",
    docsPath: DOCS_PATHS.MEMORY,
    sections: [],
    variants: [
      {
        id: "long-term-memory",
        labelKey: "commands.help.dashboard.subsections.long_term_memory",
        pickerDescriptionKey: "commands.help.dashboard.subsections.long_term_memory_description",
        titleKey: "commands.help.memory_catalog.long_term_memory.title",
        descriptionKey: "commands.help.memory_catalog.long_term_memory.description",
        docsPath: DOCS_PATHS.MEMORY,
        sections: [],
        variables: () => ({
          memories: mention("memories"),
          personalMemories: mention("personal", "memories"),
        }),
      },
      {
        id: "short-term-memory",
        labelKey: "commands.help.dashboard.subsections.short_term_memory",
        pickerDescriptionKey: "commands.help.dashboard.subsections.short_term_memory_description",
        titleKey: "commands.help.memory_catalog.short_term_memory.title",
        descriptionKey: "commands.help.memory_catalog.short_term_memory.description",
        docsPath: DOCS_PATHS.SHORT_TERM_MEMORY,
        sections: [],
        footerKey: "commands.help.memory_catalog.short_term_memory.footer",
        variables: (locale) => ({
          configAdvancedMemory: configPage(locale, "commands.help.breadcrumbs.behavior.memory"),
          memories: mention("memories"),
        }),
      },
      {
        id: "rewards-punishments",
        labelKey: "commands.help.dashboard.subsections.rewards_punishments",
        pickerDescriptionKey: "commands.help.dashboard.subsections.rewards_punishments_description",
        titleKey: "commands.help.memory_catalog.rewards_punishments.title",
        descriptionKey: "commands.help.memory_catalog.rewards_punishments.description",
        docsPath: DOCS_PATHS.MEMORY,
        sections: [],
        footerKey: "commands.help.memory_catalog.rewards_punishments.footer",
        variables: () => ({
          reward: mention("reward"),
          punish: mention("punish"),
        }),
      },
      {
        id: "memory-tagging",
        labelKey: "commands.help.dashboard.subsections.memory_tagging",
        pickerDescriptionKey: "commands.help.dashboard.subsections.memory_tagging_description",
        titleKey: "commands.help.memory_catalog.memory_tagging.title",
        descriptionKey: "commands.help.memory_catalog.memory_tagging.description",
        docsPath: DOCS_PATHS.MEMORY_TAGGING,
        sections: [],
        footerKey: "commands.help.memory_catalog.memory_tagging.footer",
        variables: (locale) => ({
          configAdvancedMemory: configPage(locale, "commands.help.breadcrumbs.behavior.memory"),
          toolPromptSnapshot: mention("tool", "prompt", "snapshot"),
        }),
      },
    ],
  },
  {
    id: "scheduled-tasks",
    labelKey: "commands.help.dashboard.sections.scheduled_tasks",
    pickerDescriptionKey: "commands.help.dashboard.sections.scheduled_tasks_description",
    titleKey: "commands.help.scheduled_tasks.title",
    descriptionKey: "commands.help.scheduled_tasks.description",
    docsPath: DOCS_PATHS.SCHEDULED_TASKS,
    sections: [
      {
        titleKey: "commands.help.scheduled_tasks.making_title",
        bodyKey: "commands.help.scheduled_tasks.making_body",
      },
      {
        titleKey: "commands.help.scheduled_tasks.changing_title",
        bodyKey: "commands.help.scheduled_tasks.changing_body",
      },
      {
        titleKey: "commands.help.scheduled_tasks.who_title",
        bodyKey: "commands.help.scheduled_tasks.who_body",
      },
    ],
    variables: () => ({
      scheduledTaskEdit: mention("scheduled-task", "edit"),
      scheduledTaskRemove: mention("scheduled-task", "remove"),
    }),
  },
];

const moderationPages: readonly HelpPageDefinition[] = [
  {
    id: "server-moderation",
    labelKey: "commands.help.dashboard.sections.server_moderation",
    pickerDescriptionKey: "commands.help.dashboard.sections.server_moderation_description",
    titleKey: "commands.help.server_moderation.title",
    descriptionKey: "commands.help.server_moderation.description",
    docsPath: DOCS_PATHS.SERVER_MODERATION,
    sections: [],
    variables: () => ({
      moderation: mention("moderation"),
    }),
    variants: [
      {
        id: "blacklisting",
        labelKey: "commands.help.dashboard.subsections.blacklisting",
        pickerDescriptionKey: "commands.help.dashboard.subsections.blacklisting_description",
        titleKey: "commands.help.server_moderation.blacklisting.title",
        descriptionKey: "commands.help.server_moderation.blacklisting.description",
        docsPath: DOCS_PATHS.SERVER_MODERATION,
        sections: [],
        footerKey: "commands.help.server_moderation.blacklisting.footer",
        variables: (locale) => ({
          moderationBlacklist: moderationPage(locale, "commands.help.breadcrumbs.moderation.user-blacklist"),
        }),
      },
    ],
  },
  {
    id: "quotas",
    labelKey: "commands.help.dashboard.sections.quotas",
    pickerDescriptionKey: "commands.help.dashboard.sections.quotas_description",
    titleKey: "commands.help.quotas.title",
    descriptionKey: "commands.help.quotas.description",
    docsPath: DOCS_PATHS.QUOTAS,
    sections: [
      {
        titleKey: "commands.help.quotas.spent_title",
        bodyKey: "commands.help.quotas.spent_body",
      },
      {
        titleKey: "commands.help.quotas.limits_title",
        bodyKey: "commands.help.quotas.limits_body",
      },
      {
        titleKey: "commands.help.quotas.starting_over_title",
        bodyKey: "commands.help.quotas.starting_over_body",
      },
    ],
    footerKey: "commands.help.quotas.footer",
    variables: (locale) => ({
      moderationQuotas: moderationPage(locale, "commands.help.breadcrumbs.moderation.quotas"),
      quotaResetUser: mention("quota", "reset", "user"),
      quotaResetGlobal: mention("quota", "reset", "global"),
    }),
  },
  {
    id: "age-restricted-commands",
    labelKey: "commands.help.dashboard.sections.age_restricted_commands",
    pickerDescriptionKey: "commands.help.dashboard.sections.age_restricted_commands_description",
    titleKey: "commands.help.age_restricted_commands.title",
    descriptionKey: "commands.help.age_restricted_commands.description",
    docsPath: DOCS_PATHS.AGE_RESTRICTED_COMMANDS,
    sections: [
      {
        titleKey: "commands.help.age_restricted_commands.filter_title",
        bodyKey: "commands.help.age_restricted_commands.filter_body",
      },
      {
        titleKey: "commands.help.age_restricted_commands.gated_title",
        bodyKey: "commands.help.age_restricted_commands.gated_body",
      },
    ],
    footerKey: "commands.help.age_restricted_commands.footer",
    variables: () => ({
      nsfw: mention("nsfw"),
      nsfwJailbreaks: mention("nsfw", "jailbreaks"),
    }),
  },
  {
    id: "user-byok",
    labelKey: "commands.help.dashboard.sections.user_byok",
    pickerDescriptionKey: "commands.help.dashboard.sections.user_byok_description",
    titleKey: "commands.help.user_byok.title",
    descriptionKey: "commands.help.user_byok.description",
    docsPath: DOCS_PATHS.USER_BYOK,
    sections: [
      {
        titleKey: "commands.help.user_byok.changes_title",
        bodyKey: "commands.help.user_byok.changes_body",
      },
      {
        titleKey: "commands.help.user_byok.suits_title",
        bodyKey: "commands.help.user_byok.suits_body",
      },
      {
        titleKey: "commands.help.user_byok.members_title",
        bodyKey: "commands.help.user_byok.members_body",
      },
    ],
    footerKey: "commands.help.user_byok.footer",
    variables: (locale) => ({
      moderationMemberAccess: moderationPage(locale, "commands.help.breadcrumbs.moderation.member-access"),
      setup: mention("setup"),
      personalProviders: mention("personal", "providers"),
    }),
  },
];

const pluginPages: readonly HelpPageDefinition[] = [
  {
    id: "sillytavern-presets",
    labelKey: "commands.help.dashboard.sections.sillytavern_presets",
    pickerDescriptionKey: "commands.help.dashboard.sections.sillytavern_presets_description",
    titleKey: "commands.help.sillytavern_presets.title",
    descriptionKey: "commands.help.sillytavern_presets.description",
    docsPath: DOCS_PATHS.SILLYTAVERN_PROMPT_PRESETS,
    sections: [
      {
        titleKey: "commands.help.sillytavern_presets.importing_title",
        bodyKey: "commands.help.sillytavern_presets.importing_body",
      },
      {
        titleKey: "commands.help.sillytavern_presets.controls_title",
        bodyKey: "commands.help.sillytavern_presets.controls_body",
      },
      {
        titleKey: "commands.help.sillytavern_presets.still_applies_title",
        bodyKey: "commands.help.sillytavern_presets.still_applies_body",
      },
    ],
    footerKey: "commands.help.sillytavern_presets.footer",
    variables: (locale) => ({
      configStPresets: configPage(locale, "commands.help.breadcrumbs.plugins.sillytavern-presets"),
      configBehaviorGeneral: configPage(locale, "commands.help.breadcrumbs.behavior.general"),
      configPersonaAdvanced: configPage(locale, "commands.help.breadcrumbs.persona.advanced"),
    }),
  },
  {
    id: "mcp-servers",
    labelKey: "commands.help.dashboard.sections.mcp_servers",
    pickerDescriptionKey: "commands.help.dashboard.sections.mcp_servers_description",
    titleKey: "commands.help.mcp_servers.title",
    descriptionKey: "commands.help.mcp_servers.description",
    docsPath: DOCS_PATHS.MCP,
    sections: [
      {
        titleKey: "commands.help.mcp_servers.hosted_title",
        bodyKey: "commands.help.mcp_servers.hosted_body",
      },
      {
        titleKey: "commands.help.mcp_servers.local_title",
        bodyKey: "commands.help.mcp_servers.local_body",
      },
      {
        titleKey: "commands.help.mcp_servers.before_title",
        bodyKey: "commands.help.mcp_servers.before_body",
      },
    ],
    footerKey: "commands.help.mcp_servers.footer",
    variables: (locale) => ({
      configMcp: configPage(locale, "commands.help.breadcrumbs.plugins.mcp-servers"),
      configTools: configPage(locale, "commands.help.breadcrumbs.plugins.available-tools"),
    }),
  },
  {
    id: "matrix",
    labelKey: "commands.help.dashboard.sections.matrix",
    pickerDescriptionKey: "commands.help.dashboard.sections.matrix_description",
    titleKey: "commands.help.matrix_bridge.title",
    descriptionKey: "commands.help.matrix_bridge.description",
    docsPath: DOCS_PATHS.MATRIX_BRIDGE,
    sections: [
      {
        titleKey: "commands.help.matrix_bridge.linking_title",
        bodyKey: "commands.help.matrix_bridge.linking_body",
      },
      {
        titleKey: "commands.help.matrix_bridge.reads_title",
        bodyKey: "commands.help.matrix_bridge.reads_body",
      },
    ],
    footerKey: "commands.help.matrix_bridge.footer",
    variables: (locale) => ({
      matrixLink: mention("matrix", "link"),
      matrixBotUser: process.env.MATRIX_BOT_USER_ID ?? localizer(locale, "commands.help.matrix.bot_user_fallback"),
    }),
  },
];

export const HELP_CATEGORIES: readonly HelpCategoryDefinition[] = [
  { id: "setup", labelKey: "commands.help.dashboard.categories.setup", pages: setupPages },
  { id: "features", labelKey: "commands.help.dashboard.categories.features", pages: featurePages },
  { id: "moderation", labelKey: "commands.help.dashboard.categories.moderation", pages: moderationPages },
  { id: "plugins", labelKey: "commands.help.dashboard.categories.plugins", pages: pluginPages },
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
