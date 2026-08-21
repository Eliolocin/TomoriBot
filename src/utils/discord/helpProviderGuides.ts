import { buildHelpPageReference } from "@/utils/discord/helpCatalog";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { DOCS_PATHS, type DocsPath } from "@/utils/discord/docsLinks";

export const HELP_PROVIDER_IDS = [
  "google",
  "openrouter",
  "deepseek",
  "novelai",
  "nvidia",
  "zai",
  "vertexexpress",
  "vertex",
  "custom",
  "brave",
  "elevenlabs",
] as const;
export type HelpProviderId = (typeof HELP_PROVIDER_IDS)[number];

type HelpVariables = Record<string, string | number | boolean>;

export interface ProviderGuideDefinition {
  id: HelpProviderId;
  labelKey: string;
  pickerDescriptionKey: string;
  titleKey: string;
  descriptionKey: string;
  sections: ReadonlyArray<{ titleKey: string; bodyKey: string }>;
  footerKey?: string;
  docsPath: DocsPath;
}

function providerGuide(
  id: Exclude<HelpProviderId, "elevenlabs">,
  sectionStems: readonly string[],
  footer = true,
): ProviderGuideDefinition {
  const prefix = `commands.help.api-key.${id}`;
  return {
    id,
    labelKey: `commands.help.api-key.provider_choice_${id}`,
    pickerDescriptionKey: `commands.help.api-key.provider_description_${id}`,
    titleKey: `${prefix}_title`,
    descriptionKey: `${prefix}_description`,
    sections: sectionStems.map((stem) => ({
      titleKey: `${prefix}_${stem}_title`,
      bodyKey: `${prefix}_${stem}_description`,
    })),
    ...(footer ? { footerKey: `${prefix}_footer` } : {}),
    docsPath: id === "custom" ? DOCS_PATHS.CUSTOM_ENDPOINTS : DOCS_PATHS.API_KEYS,
  };
}

export const PROVIDER_GUIDES: readonly ProviderGuideDefinition[] = [
  providerGuide("google", ["getting_key"]),
  providerGuide("openrouter", ["getting_key", "important"]),
  providerGuide("deepseek", ["getting_key"]),
  providerGuide("novelai", ["getting_key"]),
  providerGuide("nvidia", ["getting_key", "important"]),
  providerGuide("zai", ["getting_key", "important"]),
  providerGuide("vertexexpress", ["getting_key", "important"]),
  providerGuide("vertex", ["getting_key", "important"]),
  providerGuide("custom", [], false),
  providerGuide("brave", ["getting_key", "important"]),
  {
    id: "elevenlabs",
    labelKey: "commands.help.api-key.provider_choice_elevenlabs",
    pickerDescriptionKey: "commands.help.api-key.provider_description_elevenlabs",
    titleKey: "commands.help.elevenlabs.title",
    descriptionKey: "commands.help.elevenlabs.description",
    sections: [
      {
        titleKey: "commands.help.elevenlabs.getting_key_title",
        bodyKey: "commands.help.elevenlabs.getting_key_description",
      },
      {
        titleKey: "commands.help.elevenlabs.free_voices_title",
        bodyKey: "commands.help.elevenlabs.free_voices_description",
      },
      {
        titleKey: "commands.help.elevenlabs.choosing_voice_title",
        bodyKey: "commands.help.elevenlabs.choosing_voice_description",
      },
      {
        titleKey: "commands.help.elevenlabs.important_notes_title",
        bodyKey: "commands.help.elevenlabs.important_notes_description",
      },
    ],
    footerKey: "commands.help.elevenlabs.footer",
    docsPath: DOCS_PATHS.TTS,
  },
] as const;

export function isHelpProviderId(value: string): value is HelpProviderId {
  return (HELP_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderGuide(providerId: HelpProviderId): ProviderGuideDefinition {
  const guide = PROVIDER_GUIDES.find((candidate) => candidate.id === providerId);
  if (!guide) {
    throw new Error(`Missing help provider guide: ${providerId}`);
  }
  return guide;
}

export function getProviderGuideVariables(locale: string): HelpVariables {
  return {
    configBraveapiSet: commandRegistry.getCommandMention("optional-key", "brave", "set"),
    configSetup: commandRegistry.getCommandMention("setup"),
    configApikeySet: commandRegistry.getCommandMention("provider", "add"),
    configModel: commandRegistry.getCommandMention("model", "text"),
    configModelEmbedding: commandRegistry.getCommandMention("model", "embedding"),
    configModelImage: commandRegistry.getCommandMention("model", "image"),
    configCustomModelsAdd: commandRegistry.getCommandMention("provider", "custom-endpoint", "add"),
    personalCustomModelsAdd: commandRegistry.getCommandMention("personal", "custom-endpoint", "add"),
    helpCustomModels: buildHelpPageReference(locale, "commands.help.dashboard.pages.custom_endpoints"),
    supportServer: commandRegistry.getCommandMention("support", "discord"),
    configSpeechElevenlabs: commandRegistry.getCommandMention("speech", "elevenlabs"),
    configSpeechVoiceAssign: commandRegistry.getCommandMention("speech", "voice-assign"),
    configSpeechTranscripts: commandRegistry.getCommandMention("speech", "transcripts"),
  };
}
