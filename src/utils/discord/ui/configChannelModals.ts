import { ChannelType, TextInputStyle } from "discord.js";
import type { ChannelPromptMode, TomoriState } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import {
  CHECKLIST_CHANNELS_PER_PAGE,
  formatGuildBlocklistChannelOptionLabel,
  type BlocklistChannelTarget,
  type ChecklistChannelTarget,
} from "@/utils/discord/channelChecklistManager";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import { buildConfigRouteId } from "@/utils/discord/configPanelCatalog";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { localizer } from "@/utils/text/localizer";

const LABEL = 18 as const;
const CHANNEL_SELECT = 8 as const;
const STRING_SELECT = 3 as const;
const TEXT_INPUT = 4 as const;

/**
 * Discord rejects a String Select carrying fewer than 1 or more than 25 options, and a modal has
 * no pagination row to spend the overflow on, so a workspace with many personas has to be trimmed
 * before the payload is built.
 */
const SELECT_OPTION_LIMIT = 25;

/**
 * Personas one Welcome modal page carries. Its Random entry is repeated on every page, so it
 * spends one of the 25 slots and the roster gets the rest.
 */
export const WELCOME_PERSONA_PAGE_SIZE = SELECT_OPTION_LIMIT - 1;

/** Personas one Auto-Trigger configure page carries; it reserves no fixed entry. */
export const AUTO_TRIGGER_PERSONA_PAGE_SIZE = SELECT_OPTION_LIMIT;

/** Personas that can back a select option at all, in the order every page slices them. */
export function selectablePersonas(personas: readonly TomoriState[]): readonly TomoriState[] {
  return personas.filter((persona) => persona.persona_id !== undefined);
}

/**
 * Maps one page of personas onto select options.
 *
 * Callers page the roster rather than trimming it, because a persona left out of every page could
 * never be assigned. Only the page holding the stored persona marks a `default`: the panel prints
 * the stored value beside the control, so an unmarked page reads as "not on this page" rather than
 * as "nothing is set".
 */
function buildPersonaSelectOptions(
  personas: readonly TomoriState[],
  selectedPersonaId: number | null,
  start: number,
  pageSize: number,
): Array<{ label: string; value: string; default: boolean }> {
  return selectablePersonas(personas)
    .slice(start, start + pageSize)
    .map((persona) => ({
      label: safeSelectOptionText(persona.persona_nickname, 100),
      value: String(persona.persona_id),
      default: persona.persona_id === selectedPersonaId,
    }));
}

export const CONFIG_CHANNEL_LOG_FIELD = "channels_log_channel";
export const CONFIG_CHANNEL_WELCOME_FIELD = "channels_welcome_channel";
export const CONFIG_CHANNEL_WELCOME_PERSONA_FIELD = "channels_welcome_persona";
export const CONFIG_CHANNEL_WELCOME_PROMPT_FIELD = "channels_welcome_prompt";
export const CONFIG_CHANNEL_WELCOME_PROMPT_MAX_LENGTH = 2000;
export const CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX = "channels_autoch_group";
export const CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD = "channels_autoch_channel";
export const CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD = "channels_autoch_enabled";
export const CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD = "channels_autoch_persona";
export const CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD = "channels_autoch_threshold";
export const CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD = "channels_autoch_max_threshold";
export const CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX = "channels_private_group";
export const CONFIG_CHANNEL_RP_CHECKBOX_PREFIX = "channels_rp_group";
export const CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX = "channels_blocklist_group";
export const CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE = 10;
export const CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS = [
  "channels_override_prompt_part1",
  "channels_override_prompt_part2",
  "channels_override_prompt_part3",
  "channels_override_prompt_part4",
] as const;
export const CONFIG_CHANNEL_OVERRIDE_MODE_FIELD = "channels_override_prompt_mode";
export const CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD = "channels_override_context_note_text";
export const CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD = "channels_override_context_note_depth";

function modalTitle(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 45);
}

function modalLabel(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 45);
}

function modalDescription(locale: string, key: string): string {
  return safeSelectOptionText(localizer(locale, key), 100);
}

function channelField(locale: string, nonce: string, field: string, labelKey: string, descriptionKey: string) {
  return {
    type: LABEL,
    label: modalLabel(locale, labelKey),
    description: modalDescription(locale, descriptionKey),
    component: {
      type: CHANNEL_SELECT,
      custom_id: buildConfigModalFieldId(field, nonce),
      channel_types: [ChannelType.GuildText],
      min_values: 1,
      max_values: 1,
      required: true,
    },
  } satisfies RawDiscordComponent;
}

export function buildConfigLogChannelModal(locale: string, nonce: string): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "channels-log-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.channels_log_modal_title"),
    components: [
      channelField(
        locale,
        nonce,
        CONFIG_CHANNEL_LOG_FIELD,
        "commands.config.panel.channels_log_select_label",
        "commands.config.panel.channels_log_select_description",
      ),
    ],
  };
}

export function buildConfigWelcomeModal(
  locale: string,
  nonce: string,
  personas: readonly TomoriState[],
  currentPrompt: string | null,
  currentPersonaId: number | null,
  start = 0,
): RawModalPayload {
  const personaOptions = [
    {
      label: safeSelectOptionText(localizer(locale, "commands.config.panel.channels_welcome_random_label"), 100),
      value: "random",
      default: currentPersonaId === null,
    },
    ...buildPersonaSelectOptions(personas, currentPersonaId, start, WELCOME_PERSONA_PAGE_SIZE),
  ];

  return {
    custom_id: buildConfigRouteId({ action: "channels-welcome-submit", locale, nonce }),
    title: modalTitle(locale, "commands.config.panel.channels_welcome_modal_title"),
    components: [
      channelField(
        locale,
        nonce,
        CONFIG_CHANNEL_WELCOME_FIELD,
        "commands.config.panel.channels_welcome_channel_label",
        "commands.config.panel.channels_welcome_channel_description",
      ),
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_welcome_persona_label"),
        description: modalDescription(locale, "commands.config.panel.channels_welcome_persona_description"),
        component: {
          type: STRING_SELECT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PERSONA_FIELD, nonce),
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.panel.channels_welcome_persona_placeholder"),
            100,
          ),
          required: true,
          options: personaOptions,
        },
      },
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_welcome_prompt_label"),
        description: modalDescription(locale, "commands.config.panel.channels_welcome_prompt_description"),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_WELCOME_PROMPT_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          required: true,
          max_length: CONFIG_CHANNEL_WELCOME_PROMPT_MAX_LENGTH,
          value: currentPrompt ?? undefined,
        },
      },
    ],
  };
}

export function buildConfigAutoTriggerChannelsModal(
  locale: string,
  nonce: string,
  start: number,
  fp: string,
  channels: readonly { id: string; name: string }[],
  selectedIds: ReadonlySet<string>,
): RawModalPayload {
  const presented = channels.slice(0, CHECKLIST_CHANNELS_PER_PAGE);
  const groups: RawDiscordComponent[] = [];
  for (let offset = 0; offset < presented.length; offset += 10) {
    const groupIndex = offset / 10;
    const options = presented.slice(offset, offset + 10).map((channel) => ({
      label: safeSelectOptionText(`#${channel.name}`, 100),
      value: channel.id,
      default: selectedIds.has(channel.id),
    }));
    groups.push({
      type: LABEL,
      label: modalLabel(
        locale,
        groupIndex === 0
          ? "commands.config.panel.channels_auto_trigger_group_label"
          : "commands.config.panel.channels_auto_trigger_group_label_continued",
      ),
      description:
        groupIndex === 0
          ? modalDescription(locale, "commands.config.panel.channels_auto_trigger_group_description")
          : undefined,
      component: {
        // Five groups of ten fit in one modal, and a missing group payload is stale rather than empty.
        type: 22,
        custom_id: buildConfigModalFieldId(`${CONFIG_CHANNEL_AUTO_TRIGGER_CHECKBOX_PREFIX}_${groupIndex}`, nonce),
        min_values: 0,
        max_values: options.length,
        required: false,
        options,
      },
    });
  }

  return {
    custom_id: buildConfigRouteId({ action: "channels-autoch-submit", locale, start, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.channels_auto_trigger_modal_title"),
    components: groups,
  };
}

export function buildConfigAutoTriggerConfigureModal(
  locale: string,
  nonce: string,
  fp: string,
  personas: readonly TomoriState[],
  currentChannelId: string | null = null,
  currentEnabled = false,
  currentPersonaId: number | null = null,
  start = 0,
): RawModalPayload {
  const mainPersona = personas.find((persona) => !persona.is_alter) ?? personas[0];
  const selectedPersonaId = currentPersonaId ?? mainPersona?.persona_id ?? null;
  const personaOptions = buildPersonaSelectOptions(personas, selectedPersonaId, start, AUTO_TRIGGER_PERSONA_PAGE_SIZE);

  return {
    custom_id: buildConfigRouteId({ action: "channels-autoch-configure-submit", locale, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.channels_auto_trigger_configure_modal_title"),
    components: [
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_auto_trigger_channel_label"),
        description: modalDescription(locale, "commands.config.panel.channels_auto_trigger_channel_description"),
        component: {
          type: CHANNEL_SELECT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_CHANNEL_FIELD, nonce),
          channel_types: [ChannelType.GuildText],
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_auto_trigger_enabled_label"),
        description: modalDescription(locale, "commands.config.panel.channels_auto_trigger_enabled_toggle_description"),
        component: {
          type: 23,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_ENABLED_FIELD, nonce),
          default: currentChannelId ? currentEnabled : false,
        },
      },
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_auto_trigger_persona_label"),
        description: modalDescription(locale, "commands.config.panel.channels_auto_trigger_persona_description"),
        component: {
          type: STRING_SELECT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_PERSONA_FIELD, nonce),
          required: true,
          options: personaOptions,
        },
      },
    ],
  };
}

export function buildConfigAutoTriggerThresholdModal(
  locale: string,
  nonce: string,
  threshold: number,
  maxThreshold: number,
  fp: string,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({ action: "channels-autoch-threshold-submit", locale, fp, nonce }),
    title: modalTitle(locale, "commands.config.panel.channels_auto_trigger_threshold_modal_title"),
    components: [
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_auto_trigger_threshold_label"),
        description: modalDescription(
          locale,
          "commands.config.panel.channels_auto_trigger_threshold_input_description",
        ),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_THRESHOLD_FIELD, nonce),
          style: TextInputStyle.Short,
          min_length: 1,
          max_length: 3,
          required: true,
          value: String(threshold),
        },
      },
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_auto_trigger_max_threshold_label"),
        description: modalDescription(locale, "commands.config.panel.channels_auto_trigger_max_threshold_description"),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_AUTO_TRIGGER_MAX_THRESHOLD_FIELD, nonce),
          style: TextInputStyle.Short,
          min_length: 1,
          max_length: 3,
          required: false,
          value: String(maxThreshold),
        },
      },
    ],
  };
}

type ChannelRulesTarget = ChecklistChannelTarget | BlocklistChannelTarget;

function buildConfigChannelRulesModal(
  customId: string,
  nonce: string,
  title: string,
  groupLabel: string,
  groupLabelContinued: string,
  groupDescription: string,
  checkboxIdPrefix: string,
  channels: readonly ChannelRulesTarget[],
  buildOption: (channel: ChannelRulesTarget) => {
    label: string;
    value: string;
    description?: string;
    default: boolean;
  },
): RawModalPayload {
  const groups: RawDiscordComponent[] = [];
  for (let offset = 0; offset < channels.length; offset += CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE) {
    const groupIndex = offset / CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE;
    const options = channels
      .slice(offset, offset + CONFIG_CHANNEL_RULES_CHECKBOX_GROUP_SIZE)
      .map((channel) => buildOption(channel));
    groups.push({
      type: LABEL,
      label: groupIndex === 0 ? groupLabel : groupLabelContinued,
      description: groupIndex === 0 ? groupDescription : undefined,
      component: {
        type: 22,
        custom_id: buildConfigModalFieldId(`${checkboxIdPrefix}_${groupIndex}`, nonce),
        min_values: 0,
        max_values: options.length,
        required: false,
        options,
      },
    });
  }

  return { custom_id: customId, title, components: groups };
}

function buildTextChannelRuleOption(channel: ChannelRulesTarget, selectedIds: ReadonlySet<string>) {
  return {
    label: safeSelectOptionText(`#${channel.name}`, 100),
    value: channel.id,
    default: selectedIds.has(channel.id),
  };
}

function buildBlocklistRuleOption(locale: string, selectedIds: ReadonlySet<string>, channel: BlocklistChannelTarget) {
  return {
    label: safeSelectOptionText(formatGuildBlocklistChannelOptionLabel(channel, locale), 100),
    value: channel.id,
    description: channel.parentName
      ? safeSelectOptionText(
          localizer(locale, "commands.config.panel.channels_rules_blocklist_option_description_category", {
            category_name: channel.parentName,
          }),
          100,
        )
      : undefined,
    default: selectedIds.has(channel.id),
  };
}

export function buildConfigPrivateChannelsModal(
  locale: string,
  nonce: string,
  start: number,
  fp: string,
  channels: readonly ChecklistChannelTarget[],
  selectedIds: ReadonlySet<string>,
): RawModalPayload {
  return buildConfigChannelRulesModal(
    buildConfigRouteId({ action: "channels-private-submit", locale, start, fp, nonce }),
    nonce,
    modalTitle(locale, "commands.config.panel.channels_rules_private_modal_title"),
    modalLabel(locale, "commands.config.panel.channels_rules_private_group_label"),
    modalLabel(locale, "commands.config.panel.channels_rules_private_group_label_continued"),
    modalDescription(locale, "commands.config.panel.channels_rules_private_group_description"),
    CONFIG_CHANNEL_PRIVATE_CHECKBOX_PREFIX,
    channels,
    (channel) => buildTextChannelRuleOption(channel, selectedIds),
  );
}

export function buildConfigRoleplayChannelsModal(
  locale: string,
  nonce: string,
  start: number,
  fp: string,
  channels: readonly ChecklistChannelTarget[],
  selectedIds: ReadonlySet<string>,
): RawModalPayload {
  return buildConfigChannelRulesModal(
    buildConfigRouteId({ action: "channels-rp-submit", locale, start, fp, nonce }),
    nonce,
    modalTitle(locale, "commands.config.panel.channels_rules_roleplay_modal_title"),
    modalLabel(locale, "commands.config.panel.channels_rules_roleplay_group_label"),
    modalLabel(locale, "commands.config.panel.channels_rules_roleplay_group_label_continued"),
    modalDescription(locale, "commands.config.panel.channels_rules_roleplay_group_description"),
    CONFIG_CHANNEL_RP_CHECKBOX_PREFIX,
    channels,
    (channel) => buildTextChannelRuleOption(channel, selectedIds),
  );
}

export function buildConfigBlocklistChannelsModal(
  locale: string,
  nonce: string,
  start: number,
  fp: string,
  channels: readonly BlocklistChannelTarget[],
  selectedIds: ReadonlySet<string>,
): RawModalPayload {
  return buildConfigChannelRulesModal(
    buildConfigRouteId({ action: "channels-blocklist-submit", locale, start, fp, nonce }),
    nonce,
    modalTitle(locale, "commands.config.panel.channels_rules_blocklist_modal_title"),
    modalLabel(locale, "commands.config.panel.channels_rules_blocklist_group_label"),
    modalLabel(locale, "commands.config.panel.channels_rules_blocklist_group_label_continued"),
    modalDescription(locale, "commands.config.panel.channels_rules_blocklist_group_description"),
    CONFIG_CHANNEL_BLOCKLIST_CHECKBOX_PREFIX,
    channels,
    (channel) => buildBlocklistRuleOption(locale, selectedIds, channel as BlocklistChannelTarget),
  );
}

export function buildConfigChannelPromptModal(
  locale: string,
  channelId: string,
  fp: string,
  nonce: string,
  prompt: string | null,
  mode: ChannelPromptMode | null,
): RawModalPayload {
  const parts = splitPromptIntoModalParts(prompt, CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS.length, 4000);
  return {
    custom_id: buildConfigRouteId({
      action: "channels-overrides-prompt-submit",
      locale,
      channelId,
      fp,
      nonce,
    }),
    title: modalTitle(locale, "commands.config.panel.channels_overrides_prompt_modal_title"),
    components: [
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_overrides_prompt_mode_label"),
        description: modalDescription(locale, "commands.config.panel.channels_overrides_prompt_mode_description"),
        component: {
          type: 21,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_MODE_FIELD, nonce),
          required: true,
          options: [
            {
              value: "append",
              label: localizer(locale, "commands.config.panel.channels_overrides_prompt_mode_append"),
              default: (mode ?? "append") === "append",
            },
            {
              value: "replace",
              label: localizer(locale, "commands.config.panel.channels_overrides_prompt_mode_replace"),
              default: mode === "replace",
            },
          ],
        },
      },
      ...CONFIG_CHANNEL_OVERRIDE_PROMPT_PART_FIELDS.map((field, index) => ({
        type: LABEL as 18,
        label: modalLabel(locale, "commands.config.panel.channels_overrides_prompt_part_label"),
        description: modalDescription(locale, "commands.config.panel.channels_overrides_prompt_part_description"),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(field, nonce),
          style: TextInputStyle.Paragraph,
          max_length: 4000,
          required: false,
          value: parts[index] || undefined,
        },
      })),
    ],
  };
}

export function buildConfigChannelContextNoteModal(
  locale: string,
  channelId: string,
  fp: string,
  nonce: string,
  note: string | null,
  depth: number | null,
): RawModalPayload {
  return {
    custom_id: buildConfigRouteId({
      action: "channels-overrides-context-note-submit",
      locale,
      channelId,
      fp,
      nonce,
    }),
    title: modalTitle(locale, "commands.config.panel.channels_overrides_context_note_modal_title"),
    components: [
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_overrides_context_note_text_label"),
        description: modalDescription(locale, "commands.config.panel.channels_overrides_context_note_text_description"),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_TEXT_FIELD, nonce),
          style: TextInputStyle.Paragraph,
          max_length: 2000,
          required: false,
          value: note ?? undefined,
        },
      },
      {
        type: LABEL,
        label: modalLabel(locale, "commands.config.panel.channels_overrides_context_note_depth_label"),
        description: modalDescription(
          locale,
          "commands.config.panel.channels_overrides_context_note_depth_description",
        ),
        component: {
          type: TEXT_INPUT,
          custom_id: buildConfigModalFieldId(CONFIG_CHANNEL_OVERRIDE_CONTEXT_NOTE_DEPTH_FIELD, nonce),
          style: TextInputStyle.Short,
          max_length: 3,
          required: true,
          value: String(depth ?? 0),
        },
      },
    ],
  };
}
