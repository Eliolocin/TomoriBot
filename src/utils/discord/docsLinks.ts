import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageActionRowComponentBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";

const DOCS_BASE_URL = "https://docs.tomoribot.app";

export const SUPPORT_SERVER_URL = "https://discord.gg/bjCfHm9QsB";

export const DOCS_PATHS = {
  QUICKSTART: "/introduction/quickstart/",
  FEATURES: "/features/",
  COMMAND_REFERENCE: "/features/command-reference/",
  CHATTING_TRIGGERS: "/features/chatting-personality/chatting-and-triggers/",
  ROLEPLAY_CHANNELS: "/features/chatting-personality/chatting-and-triggers/#roleplay-channels",
  MULTIPLE_PERSONAS: "/features/chatting-personality/multiple-personas/",
  BEHAVIOR_TWEAKING: "/features/chatting-personality/behavior-tweaking/",
  MEMORY: "/features/knowledge/memory/",
  SHORT_TERM_MEMORY: "/features/knowledge/memory/#short-term-memory-stm",
  MEMORY_TAGGING: "/features/knowledge/memory/#tagging",
  DATA_HANDLING: "/features/knowledge/data-handling/",
  PERSONALIZATION: "/features/knowledge/personalization/",
  PERSONAL_SPOTLIGHT: "/features/knowledge/personalization/#personal-spotlight",
  PERSONAL_PROVIDERS: "/features/knowledge/personalization/#your-own-providers",
  TOOLS_EXTENSIONS: "/features/capabilities/tools-and-extensions/",
  MCP: "/features/capabilities/tools-and-extensions/#mcp",
  DELIBERATE_TOOL_MODE: "/features/capabilities/tools-and-extensions/#deliberate-tool-mode",
  MEDIA_GENERATION: "/features/capabilities/media-generation/",
  TTS: "/features/capabilities/media-generation/tts-and-stt/#text-to-speech",
  STT: "/features/capabilities/media-generation/tts-and-stt/#speech-to-text",
  PROVIDERS_MODELS: "/features/setup-administration/providers-and-models/",
  API_KEYS: "/features/setup-administration/providers-and-models/#api-keys",
  CUSTOM_ENDPOINTS: "/features/setup-administration/providers-and-models/#custom-endpoints",
  AGE_RESTRICTED_COMMANDS: "/features/setup-administration/age-restricted-commands/",
  MATRIX_BRIDGE: "/features/integrations/matrix-bridge/",
  SILLYTAVERN_PROMPT_PRESETS: "/features/integrations/sillytavern-support/#prompt-presets",
  SELF_HOSTING: "/self-hosting/",
  SELF_HOSTING_SETUP_WIZARD: "/self-hosting/setup-wizard/",
  LOCAL_ENDPOINTS: "/self-hosting/local-endpoints/",
  COMFYUI_SETUP: "/self-hosting/local-endpoints/setup-comfyui/",
  LOCAL_MCP_SETUP: "/self-hosting/local-endpoints/setup-local-mcp/",
  LOCAL_TTS_SETUP: "/self-hosting/local-endpoints/text-to-speech/",
  LOCAL_STT_SETUP: "/self-hosting/local-endpoints/speech-to-text/",
  MAINTENANCE: "/self-hosting/maintenance/",
  SAFE_MIGRATION: "/self-hosting/safe-migration/",
  LOCAL_MONITORING: "/self-hosting/local-monitoring/",
  THREAT_MODELS: "/wiki/threat-models/",
} as const;

export type DocsPath = (typeof DOCS_PATHS)[keyof typeof DOCS_PATHS] | string;

export function buildDocsUrl(path: DocsPath): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${DOCS_BASE_URL}${normalizedPath}`;
}

export function buildDocsLinkRow(
  locale: string,
  path: DocsPath,
  labelKey = "general.docs.open_button_label",
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  // Link buttons render grey by API contract, so an emoji is the only way to add visual weight.
  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setEmoji("✨")
    .setLabel(localizer(locale, labelKey))
    .setURL(buildDocsUrl(path));

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
}
