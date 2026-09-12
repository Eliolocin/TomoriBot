/**
 * Modal construction for `/generate voice-message`.
 *
 * Split out of the command module so the component budget is testable without a Discord
 * interaction. Discord caps a modal at five components, and the worst case here (an `auto`
 * Chatterbox endpoint, an uploaded clip, a typed design prompt, and a persona holding both a
 * sample and a design prompt) lands on exactly five. That leaves no headroom, so this module
 * asserts the cap and documents the drop order instead of letting Discord reject the modal at
 * runtime.
 */

import { TextInputStyle } from "discord.js";
import type { ModalComponent } from "@/types/discord/modal";
import { localizer } from "@/utils/text/localizer";
import {
  formatVoiceSourceOptionDescription,
  selectDefaultVoiceSource,
  type VoiceSourceCandidate,
  type VoiceSourceShape,
} from "@/utils/speech/voiceSourceResolution";

/** Modal custom id, matched by the command's `execute` on the nonced id. */
export const VOICE_MESSAGE_MODAL_CUSTOM_ID = "generate_voice_message_modal";

export const VOICE_MESSAGE_SCRIPT_INPUT_ID = "voice_message_script";
export const VOICE_MESSAGE_SOURCE_INPUT_ID = "voice_message_source";
export const VOICE_MESSAGE_DIRECTION_INPUT_ID = "voice_message_direction";
export const VOICE_MESSAGE_TRANSCRIPT_INPUT_ID = "voice_message_transcript";
export const VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID = "voice_message_expressiveness";

/** Discord's hard cap on components per modal. */
export const VOICE_MESSAGE_MODAL_COMPONENT_LIMIT = 5;

/** Longest spoken script the TextInput accepts. */
const VOICE_MESSAGE_SCRIPT_MAX_LENGTH = 2000;

/** Delivery direction and reference transcript are short prose, not scripts. */
const VOICE_MESSAGE_SHORT_FIELD_MAX_LENGTH = 300;

/**
 * Order in which optional components are dropped if the budget is ever exceeded.
 * Highest number goes first, so the least-essential control disappears first.
 */
const DROP_ORDER = [
  VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
  VOICE_MESSAGE_TRANSCRIPT_INPUT_ID,
  VOICE_MESSAGE_DIRECTION_INPUT_ID,
] as const;

/** Which delivery-knob backend the expressiveness radio drives, if any. */
export type ExpressivenessBackend = "chatterbox" | "elevenlabs";

export interface ChatterboxDefaults {
  cfgWeight: number;
  exaggeration: number;
}

export interface VoiceMessageModalInput {
  locale: string;
  candidates: readonly VoiceSourceCandidate[];
  /** Active endpoint's `script_markup`, which picks the script placeholder. */
  scriptMarkup: string | undefined;
  /** Render the Delivery Direction field: some design-shaped source is available. */
  designShapeAvailable: boolean;
  /** Render Delivery Direction for clone endpoints that accept one-off instructions. */
  cloneInstructionsAvailable: boolean;
  /** Render the Reference Transcript field: an uploaded clip will be cloned. */
  uploadShapeSelected: boolean;
  /** Render the delivery-knob radio, or null when the backend has no such knob. */
  expressiveness: ExpressivenessBackend | null;
  /** Stored server values behind the clone radio's pre-selected `Server default` option. */
  chatterboxDefaults: ChatterboxDefaults;
}

/** One `Expressiveness` / `Voice Stability` preset and the values it sends. */
export interface ExpressivenessPreset {
  value: string;
  default?: boolean;
  /** Chatterbox overrides; absent on the ElevenLabs mapping. */
  chatterbox?: ChatterboxDefaults;
  /** ElevenLabs `voice_settings.stability`; absent on the Chatterbox mapping. */
  stability?: number;
}

const CHATTERBOX_PRESETS: ExpressivenessPreset[] = [
  { value: "subtle", chatterbox: { cfgWeight: 0.7, exaggeration: 0.25 } },
  { value: "server-default", default: true },
  { value: "expressive", chatterbox: { cfgWeight: 0.4, exaggeration: 0.7 } },
  { value: "very-expressive", chatterbox: { cfgWeight: 0.3, exaggeration: 1 } },
];

const ELEVENLABS_PRESETS: ExpressivenessPreset[] = [
  { value: "stable", stability: 0.75 },
  { value: "natural", default: true, stability: 0.5 },
  { value: "creative", stability: 0.3 },
];

/** Preset table for a backend, ordered as it renders in the radio. */
export function getExpressivenessPresets(backend: ExpressivenessBackend): ExpressivenessPreset[] {
  return backend === "chatterbox" ? CHATTERBOX_PRESETS : ELEVENLABS_PRESETS;
}

/** Locale key for a preset value, with hyphens folded into underscores. */
function getExpressivenessPresetKey(preset: ExpressivenessPreset): string {
  return preset.value.replace(/-/g, "_");
}

function modePrefixKey(shape: VoiceSourceShape): string {
  return shape === "clone"
    ? "commands.generate.voice-message.modal.mode_clone"
    : "commands.generate.voice-message.modal.mode_design";
}

function formatSourceDescription(locale: string, candidate: VoiceSourceCandidate): string {
  const modePrefix = localizer(locale, modePrefixKey(candidate.shape));
  const body =
    candidate.shape === "design"
      ? (candidate.designPrompt ?? "")
      : (candidate.displayText ?? localizer(locale, "commands.generate.voice-message.modal.source_sample_fallback"));
  return formatVoiceSourceOptionDescription(modePrefix, body);
}

/** Script placeholder for the endpoint's `script_markup`, teaching the in-band emotion syntax. */
function resolveScriptPlaceholderKey(scriptMarkup: string | undefined): string {
  if (scriptMarkup === "bracket-tags") return "commands.generate.voice-message.modal.script_placeholder_bracket_tags";
  if (scriptMarkup === "emoji") return "commands.generate.voice-message.modal.script_placeholder_emoji";
  return "commands.generate.voice-message.modal.script_placeholder_plain";
}

function buildVoiceSourceField(locale: string, candidates: readonly VoiceSourceCandidate[]): ModalComponent | null {
  // A radio group needs at least two options, so the single-source case renders no control at all.
  if (candidates.length < 2) return null;

  const defaultSource = selectDefaultVoiceSource(candidates);
  return {
    kind: "radioGroup",
    customId: VOICE_MESSAGE_SOURCE_INPUT_ID,
    labelKey: "commands.generate.voice-message.modal.voice_source_label",
    descriptionKey: "commands.generate.voice-message.modal.voice_source_description",
    required: true,
    options: candidates.map((candidate) => ({
      value: candidate.id,
      label: localizer(locale, `commands.generate.voice-message.modal.source_${candidate.id.replace(/-/g, "_")}_label`),
      description: formatSourceDescription(locale, candidate),
      default: candidate.id === defaultSource?.id,
    })),
  };
}

function buildExpressivenessField(locale: string, backend: ExpressivenessBackend): ModalComponent {
  const presets = getExpressivenessPresets(backend);
  return {
    kind: "radioGroup",
    customId: VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
    labelKey:
      backend === "chatterbox"
        ? "commands.generate.voice-message.modal.expressiveness_label"
        : "commands.generate.voice-message.modal.stability_label",
    descriptionKey:
      backend === "chatterbox"
        ? "commands.generate.voice-message.modal.expressiveness_description"
        : "commands.generate.voice-message.modal.stability_description",
    required: true,
    options: presets.map((preset) => {
      const key = getExpressivenessPresetKey(preset);
      return {
        value: preset.value,
        label: localizer(locale, `commands.generate.voice-message.modal.preset_${key}_label`),
        description: localizer(locale, `commands.generate.voice-message.modal.preset_${key}_description`),
        default: preset.default,
      };
    }),
  };
}

/**
 * Builds the modal's component list.
 *
 * Exported for the budget tests: the assertion below is the contract that keeps a future field
 * from reaching Discord as a rejected interaction response.
 */
export function buildVoiceMessageModalComponents(input: VoiceMessageModalInput): ModalComponent[] {
  const { locale } = input;
  const components: ModalComponent[] = [];

  components.push({
    customId: VOICE_MESSAGE_SCRIPT_INPUT_ID,
    labelKey: "commands.generate.voice-message.modal.script_label",
    descriptionKey: "commands.generate.voice-message.modal.script_description",
    placeholder: localizer(locale, resolveScriptPlaceholderKey(input.scriptMarkup)),
    required: true,
    style: TextInputStyle.Paragraph,
    maxLength: VOICE_MESSAGE_SCRIPT_MAX_LENGTH,
  });

  const sourceField = buildVoiceSourceField(locale, input.candidates);
  if (sourceField) components.push(sourceField);

  if (input.designShapeAvailable || input.cloneInstructionsAvailable) {
    components.push({
      customId: VOICE_MESSAGE_DIRECTION_INPUT_ID,
      labelKey: "commands.generate.voice-message.modal.direction_label",
      descriptionKey: "commands.generate.voice-message.modal.direction_description",
      placeholder: localizer(locale, "commands.generate.voice-message.modal.direction_placeholder"),
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: VOICE_MESSAGE_SHORT_FIELD_MAX_LENGTH,
    });
  }

  if (input.uploadShapeSelected) {
    components.push({
      customId: VOICE_MESSAGE_TRANSCRIPT_INPUT_ID,
      labelKey: "commands.generate.voice-message.modal.transcript_label",
      descriptionKey: "commands.generate.voice-message.modal.transcript_description",
      placeholder: localizer(locale, "commands.generate.voice-message.modal.transcript_placeholder"),
      required: false,
      style: TextInputStyle.Short,
      maxLength: VOICE_MESSAGE_SHORT_FIELD_MAX_LENGTH,
    });
  }

  if (input.expressiveness) {
    components.push(buildExpressivenessField(locale, input.expressiveness));
  }

  // Documented drop order: the delivery knobs go before the delivery prose.
  for (const customId of DROP_ORDER) {
    if (components.length <= VOICE_MESSAGE_MODAL_COMPONENT_LIMIT) break;
    const index = components.findIndex((component) => component.customId === customId);
    if (index >= 0) components.splice(index, 1);
  }

  if (components.length > VOICE_MESSAGE_MODAL_COMPONENT_LIMIT) {
    throw new Error(
      `Voice message modal would exceed Discord's ${VOICE_MESSAGE_MODAL_COMPONENT_LIMIT}-component limit (${components.length} built)`,
    );
  }

  return components;
}
