import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
  type TextDisplayComponentData,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type { ConfigPersonaVoiceView } from "@/utils/discord/interactions/configPersonaVoiceLoader";
import { buildConfigRouteId } from "@/utils/discord/configPanelCatalog";
import { buildOptionalThumbnailSection } from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
import {
  buildTextPreview,
  CV2_TEXT_PREVIEW_BUDGET,
  textPreviewFooterKey,
  textPreviewFooterVars,
} from "@/utils/text/textPreview";

const CONFIG_PERSONA_VOICE_PAGE_SIZE = 25;
const CONFIG_PERSONA_VOICE_PAGE_SIZE_WITH_MORE = CONFIG_PERSONA_VOICE_PAGE_SIZE - 1;

/**
 * The route layer owns remote catalog fetching. The renderer receives only bounded labels and
 * fingerprints, so an external provider ID can never become a component value by accident.
 */
interface ConfigPersonaVoiceRemoteOptionView {
  label: string;
  fingerprint?: string;
}

export interface ConfigPersonaVoiceRemoteView {
  /** `voices` is the normal name; `options` keeps fixture views easy to adapt from catalog APIs. */
  voices?: readonly ConfigPersonaVoiceRemoteOptionView[];
  options?: readonly ConfigPersonaVoiceRemoteOptionView[];
  catalogFingerprint?: string;
  pageStart?: number;
}

export type ConfigPersonaVoiceRenderView = ConfigPersonaVoiceView & {
  remoteChooser?: ConfigPersonaVoiceRemoteView;
};

export interface ConfigVoicePanelInput {
  locale: string;
  actor: ConfigActor;
  readStatus: PanelReadStatus;
  selectedPersona: TomoriState | null;
  selectedPersonaAvatarUrl?: string | null;
  view?: ConfigPersonaVoiceRenderView;
  remoteView?: ConfigPersonaVoiceRemoteView;
  samplePageStart?: number;
  remotePageStart?: number;
}

function selectedPersonaId(input: ConfigVoicePanelInput): number | null {
  const personaId = input.selectedPersona?.persona_id;
  return typeof personaId === "number" && Number.isSafeInteger(personaId) && personaId > 0 ? personaId : null;
}

function buildVoiceRoute(
  input: ConfigVoicePanelInput,
  route:
    | { action: "voice-select"; personaId: number }
    | { action: "voice-page"; personaId: number; start: number }
    | { action: "voice-clear"; personaId: number }
    | { action: "voice-design-open"; personaId: number }
    | { action: "voice-design-remove"; personaId: number },
): string {
  return buildConfigRouteId({ locale: input.locale, ...route });
}

function currentVoiceLabel(input: ConfigVoicePanelInput, view: ConfigPersonaVoiceView): string {
  const persona = input.selectedPersona;
  if (!persona) return localizer(input.locale, "commands.config.panel.voice_page_unassigned");

  if (
    view.capability.apiStyle === "tts-clone" &&
    persona.speech_voice_sample_id !== null &&
    persona.speech_voice_sample_id !== undefined
  ) {
    const sample = view.samples.find((candidate) => candidate.sample_id === persona.speech_voice_sample_id);
    return localizer(input.locale, "commands.config.panel.voice_page_sample_value", {
      name:
        sample?.name ??
        persona.speech_voice_name ??
        localizer(input.locale, "commands.config.panel.voice_page_unknown_sample"),
    });
  }

  if (view.capability.apiStyle === "elevenlabs" && persona.speech_voice_id) {
    return localizer(input.locale, "commands.config.panel.voice_page_provider_value", {
      name: persona.speech_voice_name ?? localizer(input.locale, "commands.config.panel.voice_page_named_voice"),
    });
  }

  if (
    view.capability.apiStyle === "tts-clone" &&
    view.capability.supportsVoiceDesign &&
    persona.speech_voice_design_prompt?.trim()
  ) {
    return localizer(input.locale, "commands.config.panel.voice_page_design_value");
  }

  if (persona.speech_voice_name?.trim()) {
    return localizer(input.locale, "commands.config.panel.voice_page_provider_value", {
      name: persona.speech_voice_name,
    });
  }

  return localizer(input.locale, "commands.config.panel.voice_page_unassigned");
}

function hasStoredVoice(persona: TomoriState | null): boolean {
  if (!persona) return false;
  return (
    (persona.speech_voice_sample_id !== null && persona.speech_voice_sample_id !== undefined) ||
    Boolean(
      persona.speech_voice_id?.trim() ||
        persona.speech_voice_name?.trim() ||
        persona.speech_voice_design_prompt?.trim(),
    )
  );
}

function renderPromptPreview(locale: string, prompt: string): string {
  const preview = buildTextPreview(prompt, Math.min(CV2_TEXT_PREVIEW_BUDGET, 2200));
  const footerKey = textPreviewFooterKey(preview);
  const footer = footerKey ? `\n-# ${localizer(locale, footerKey, textPreviewFooterVars(preview))}` : "";
  return ["```markdown", `${preview.text}${footer}`, "```"].join("\n");
}

function resolveSamplePage(samplesLength: number, requestedStart: number | undefined): number {
  const pageSize =
    samplesLength > CONFIG_PERSONA_VOICE_PAGE_SIZE
      ? CONFIG_PERSONA_VOICE_PAGE_SIZE_WITH_MORE
      : CONFIG_PERSONA_VOICE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(samplesLength / pageSize));
  const requestedPage = Number.isFinite(requestedStart) ? Math.floor((requestedStart ?? 0) / pageSize) : 0;
  return Math.min(Math.max(requestedPage, 0), pageCount - 1) * pageSize;
}

function buildSampleSelector(input: ConfigVoicePanelInput, view: ConfigPersonaVoiceView): ComponentInContainerData {
  const personaId = selectedPersonaId(input) ?? 0;
  const samples = view.samples;
  const start = resolveSamplePage(samples.length, input.samplePageStart);
  const pageSize =
    samples.length > CONFIG_PERSONA_VOICE_PAGE_SIZE
      ? CONFIG_PERSONA_VOICE_PAGE_SIZE_WITH_MORE
      : CONFIG_PERSONA_VOICE_PAGE_SIZE;
  const visibleSamples = samples.slice(start, start + pageSize);
  const options = visibleSamples.map((sample, offset) => ({
    label: safeSelectOptionText(sample.name, 100),
    value: String(start + offset),
    description: sample.ref_text?.trim()
      ? safeSelectOptionText(sample.ref_text.trim(), 100)
      : sample.duration_ms > 0
        ? `${(sample.duration_ms / 1000).toFixed(1)}s`
        : undefined,
    default: sample.sample_id === input.selectedPersona?.speech_voice_sample_id,
  }));

  if (start + visibleSamples.length < samples.length) {
    const nextStart = start + pageSize;
    options.push({
      label: safeSelectOptionText(localizer(input.locale, "commands.config.panel.voice_page_more_option"), 100),
      value: `page:${nextStart}`,
      description: safeSelectOptionText(
        localizer(input.locale, "commands.config.panel.voice_page_more_description", {
          start: String(nextStart + 1),
          end: String(Math.min(nextStart + pageSize, samples.length)),
        }),
        100,
      ),
      default: false,
    });
  }

  if (options.length === 0) {
    options.push({
      label: safeSelectOptionText(localizer(input.locale, "commands.config.panel.voice_page_no_samples_option"), 100),
      value: "none",
      description: undefined,
      default: false,
    });
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildVoiceRoute(input, { action: "voice-select", personaId }),
        placeholder: safeSelectOptionText(
          localizer(input.locale, "commands.config.panel.voice_page_sample_placeholder"),
          150,
        ),
        options,
        disabled: input.readStatus !== "fresh" || !view.capability.assignable || samples.length === 0,
      },
    ],
  } satisfies ActionRowData<StringSelectMenuComponentData>;
}

function buildVoiceActionRow(
  input: ConfigVoicePanelInput,
  personaId: number,
  options: {
    chooseProvider?: boolean;
    cancelChooser?: boolean;
    includeDesign?: boolean;
    chooseProviderDisabled?: boolean;
  } = {},
): ComponentInContainerData {
  const prompt = input.selectedPersona?.speech_voice_design_prompt?.trim();
  const disabled = input.readStatus !== "fresh" || !input.actor.isManager;
  const buttons: ButtonComponentData[] = [];

  if (options.chooseProvider || options.cancelChooser) {
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: options.cancelChooser
        ? buildConfigRouteId({ locale: input.locale, action: "voice-chooser-cancel", personaId })
        : buildVoiceRoute(input, { action: "voice-select", personaId }),
      label: localizer(
        input.locale,
        options.cancelChooser
          ? "commands.config.panel.voice_page_cancel_button"
          : "commands.config.panel.voice_page_choose_provider_button",
      ),
      disabled: disabled || options.chooseProviderDisabled === true,
    });
  }

  if (options.includeDesign) {
    buttons.push(
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildVoiceRoute(input, { action: "voice-design-open", personaId }),
        label: localizer(
          input.locale,
          prompt
            ? "commands.config.panel.voice_page_edit_design_button"
            : "commands.config.panel.voice_page_design_button",
        ),
        disabled,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildVoiceRoute(input, { action: "voice-design-remove", personaId }),
        label: localizer(input.locale, "commands.config.panel.voice_page_clear_design_button"),
        disabled: disabled || !prompt,
      },
    );
  }

  buttons.push({
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    customId: buildVoiceRoute(input, { action: "voice-clear", personaId }),
    label: localizer(input.locale, "commands.config.panel.voice_page_clear_button"),
    disabled: disabled || !hasStoredVoice(input.selectedPersona),
  });

  return {
    type: ComponentType.ActionRow,
    components: buttons,
  } satisfies ActionRowData<ButtonComponentData>;
}

function remoteCatalogOptions(view: ConfigPersonaVoiceRemoteView): readonly ConfigPersonaVoiceRemoteOptionView[] {
  return view.voices ?? view.options ?? [];
}

function boundedFingerprint(value: string | undefined): string {
  const normalized = value?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return normalized || "catalog";
}

function buildRemoteVoiceValue(position: number, fingerprint: string | undefined): string {
  return `voice:${Math.max(0, Math.floor(position))}:${boundedFingerprint(fingerprint)}`;
}

function buildRemotePageValue(start: number, fingerprint: string | undefined): string {
  return `page:${Math.max(0, Math.floor(start))}:${boundedFingerprint(fingerprint)}`;
}

function applyRemotePageStart(
  view: ConfigPersonaVoiceRemoteView,
  pageStart: number | undefined,
): ConfigPersonaVoiceRemoteView {
  return pageStart === undefined ? view : { ...view, pageStart };
}

function buildRemoteChooser(
  input: ConfigVoicePanelInput,
  view: ConfigPersonaVoiceRemoteView,
): ComponentInContainerData {
  const personaId = selectedPersonaId(input) ?? 0;
  const voices = remoteCatalogOptions(view);
  const pageSize =
    voices.length > CONFIG_PERSONA_VOICE_PAGE_SIZE
      ? CONFIG_PERSONA_VOICE_PAGE_SIZE_WITH_MORE
      : CONFIG_PERSONA_VOICE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(voices.length / pageSize));
  const requestedPageStart = view.pageStart ?? 0;
  const pageIndex = Number.isFinite(requestedPageStart)
    ? Math.min(Math.max(Math.floor(requestedPageStart / pageSize), 0), pageCount - 1)
    : 0;
  const start = pageIndex * pageSize;
  const visibleVoices = voices.slice(start, start + pageSize);
  const options: SelectMenuComponentOptionData[] = visibleVoices.map((voice, offset) => ({
    label: safeSelectOptionText(
      voice.label || localizer(input.locale, "commands.config.voice.elevenlabs.voice_available_description"),
      100,
    ),
    value: buildRemoteVoiceValue(start + offset, voice.fingerprint ?? view.catalogFingerprint),
    default: false,
  }));

  if (start + visibleVoices.length < voices.length) {
    const nextStart = start + pageSize;
    options.push({
      label: safeSelectOptionText(localizer(input.locale, "commands.config.panel.voice_page_more_option"), 100),
      value: buildRemotePageValue(nextStart, view.catalogFingerprint),
      description: safeSelectOptionText(
        localizer(input.locale, "commands.config.panel.voice_page_more_description", {
          start: String(nextStart + 1),
          end: String(Math.min(nextStart + pageSize, voices.length)),
        }),
        100,
      ),
      default: false,
    });
  }

  if (options.length === 0) {
    options.push({
      label: safeSelectOptionText(localizer(input.locale, "commands.config.panel.voice_page_no_samples_option"), 100),
      value: "none",
      default: false,
    });
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildVoiceRoute(input, { action: "voice-select", personaId }),
        placeholder: safeSelectOptionText(
          localizer(input.locale, "commands.config.panel.voice_page_choose_provider_button"),
          150,
        ),
        options,
        disabled: input.readStatus !== "fresh" || !input.actor.isManager,
      },
    ],
  } satisfies ActionRowData<StringSelectMenuComponentData>;
}

export function buildConfigVoiceBody(input: ConfigVoicePanelInput): ComponentInContainerData[] {
  const view: ConfigPersonaVoiceRenderView = input.view ?? {
    capability: { apiStyle: null, assignable: false, supportsVoiceDesign: false },
    samples: [],
  };
  const personaId = selectedPersonaId(input);
  const components: ComponentInContainerData[] = [];
  const heading: TextDisplayComponentData = {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(input.locale, "commands.config.panel.page_persona_voice")}\n${localizer(input.locale, "commands.config.panel.voice_page_description")}`,
  };
  components.push(buildOptionalThumbnailSection(heading, input.selectedPersonaAvatarUrl));

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(input.locale, "commands.config.panel.voice_page_current_title")}**\n> ${currentVoiceLabel(input, view)}`,
  });

  if (view.capability.apiStyle === "tts-clone") {
    components.push(buildSampleSelector(input, view));
  } else if (view.capability.apiStyle === "elevenlabs") {
    const remoteView = input.remoteView ?? view.remoteChooser;
    if (remoteView) {
      components.push(buildRemoteChooser(input, applyRemotePageStart(remoteView, input.remotePageStart)));
    }
  }

  const supportsDesign = view.capability.apiStyle === "tts-clone" && view.capability.supportsVoiceDesign;
  if (supportsDesign && personaId !== null) {
    const prompt = input.selectedPersona?.speech_voice_design_prompt?.trim();
    if (prompt) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `**${localizer(input.locale, "commands.config.panel.voice_page_design_preview_title")}**\n${renderPromptPreview(input.locale, prompt)}`,
      });
    }
    if (personaId !== null) components.push(buildVoiceActionRow(input, personaId, { includeDesign: true }));
  } else if (personaId !== null) {
    const remoteView = input.remoteView ?? view.remoteChooser;
    components.push(
      buildVoiceActionRow(input, personaId, {
        chooseProvider: !view.capability.assignable || (view.capability.apiStyle === "elevenlabs" && !remoteView),
        cancelChooser: view.capability.apiStyle === "elevenlabs" && Boolean(remoteView),
        chooseProviderDisabled: !view.capability.assignable,
      }),
    );
  }

  if (!view.capability.assignable) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(input.locale, "commands.config.panel.voice_page_no_endpoint_title")}**\n${localizer(input.locale, "commands.config.panel.voice_page_no_endpoint_description")}`,
    });
  } else if (!supportsDesign) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(input.locale, "commands.config.panel.voice_page_design_unavailable_description")}`,
    });
  }

  return components;
}
