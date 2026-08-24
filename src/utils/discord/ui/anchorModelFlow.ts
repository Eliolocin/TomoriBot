import type {
  ActionRowData,
  ButtonComponentData,
  ButtonInteraction,
  ComponentInContainerData,
  ContainerComponentData,
} from "discord.js";
import { ButtonStyle, ComponentType, escapeMarkdown, MessageFlags } from "discord.js";
import type { ModalOptions } from "@/types/discord/modal";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { buildRangeSelectorPayload, parseModalRangeIndex, RANGES_PER_SELECTOR_PAGE } from "./interactionCore";
import {
  buildPersonaWorkflowNotice,
  isCollectorTimeoutError,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
  type AnchorPrivateWorkflowPhase,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowModalPhase,
} from "./personaWorkflow";

/**
 * Shared delivery mechanics for the anchor one-message model-config commands
 * (`/model text|vision|video|image|embedding` and their personal-scope siblings).
 *
 * Each command owns its business logic: which model table, which config field, which
 * terminal copy, so and calls these helpers only for the lifecycle: render the provider
 * step on the anchor message, collect the opening button, and open the model modal
 * (routing `>25` options through the anchor range selector automatically). This is
 * what keeps "adding a picker→modal command touches one file": the lifecycle lives here,
 * the intent lives in the command.
 */

/** Minimal shape a saved-provider row needs for the anchor picker. */
export interface AnchorProviderChoice {
  provider: string;
}

/** One active model/provider pair rendered as muted subtext beneath the picker guidance. */
export interface AnchorCurrentSelection {
  model: string;
  provider: string;
}

/**
 * Which config surface a anchor model command writes to. Server-scope commands
 * (`/model *`) and personal-scope commands (`/personal provider model-*`) share every
 * lifecycle mechanic but differ in a few terminal copy strings and command mentions.
 */
export type AnchorModelScopeKind = "server" | "personal";

/**
 * Builds the Components V2 provider picker: one Secondary button per provider (4 per row)
 * plus a Danger cancel button. Button ids are `${customIdPrefix}_${index}`; cancel is
 * `${customIdPrefix}_cancel`.
 *
 * `currentSelections` is a list because a capability can have more than one active model
 * (e.g. `image` tracks a diffusion model *and* a NovelAI diffusion model), and personal
 * scope may have none at all. Duplicates are collapsed; an empty list renders no subtext.
 */
export function buildProviderPickerPayload(
  locale: string,
  customIdPrefix: string,
  providers: readonly string[],
  currentSelections: readonly AnchorCurrentSelection[],
  options?: { note?: string },
): PersonaWorkflowComponentsV2Payload {
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.model.providerPicker.title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.model.providerPicker.description"),
    },
  ];

  // Muted subtext showing the current selection(s): matches the footer convention in
  // buildNoticeContainer. Kept as its own TextDisplay (not "\n\n" appended) so the
  // Container's built-in gap doesn't stack into an oversized break. De-duplicated on the
  // provider+model pair, mirroring the legacy picker's behaviour.
  const uniqueSelections = Array.from(
    new Map(
      currentSelections.map((selection) => [JSON.stringify([selection.provider, selection.model]), selection]),
    ).values(),
  );
  if (uniqueSelections.length > 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: uniqueSelections
        .map(
          (selection) =>
            `-# ${localizer(locale, "commands.model.providerPicker.current_selection", {
              model: escapeMarkdown(selection.model),
              provider: escapeMarkdown(selection.provider),
            })}`,
        )
        .join("\n"),
    });
  }

  if (options?.note) {
    components.push({ type: ComponentType.TextDisplay, content: options.note });
  }

  const buttons = providers.map(
    (provider, index): ButtonComponentData => ({
      type: ComponentType.Button,
      customId: `${customIdPrefix}_${index}`,
      label: getProviderDisplayName(provider),
      style: ButtonStyle.Secondary,
    }),
  );
  const buttonRows: ButtonComponentData[][] = [];
  for (let offset = 0; offset < buttons.length; offset += 4) {
    buttonRows.push(buttons.slice(offset, offset + 4));
  }

  const cancelButton: ButtonComponentData = {
    type: ComponentType.Button,
    customId: `${customIdPrefix}_cancel`,
    label: localizer(locale, "general.pagination.cancel"),
    style: ButtonStyle.Danger,
  };
  const lastRow = buttonRows.at(-1);
  if (lastRow && lastRow.length < 5) {
    lastRow.push(cancelButton);
  } else {
    buttonRows.push([cancelButton]);
  }
  for (const row of buttonRows) {
    components.push({
      type: ComponentType.ActionRow,
      components: row,
    } satisfies ActionRowData<ButtonComponentData>);
  }

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Single "open model selector" button for the single-provider case: no provider picker
 * is shown, but the flow still opens its modal from a button click on the one anchor
 * message. The button's custom id is `openId`.
 */
export function buildOpenSelectorPayload(locale: string, openId: string): PersonaWorkflowComponentsV2Payload {
  return buildPersonaWorkflowNotice({
    locale,
    titleKey: "general.persona_workflow.modal_ready_title",
    descriptionKey: "general.persona_workflow.modal_ready_description",
    color: ColorCode.INFO,
    button: {
      customId: openId,
      labelKey: "general.persona_workflow.open_modal_button",
      style: ButtonStyle.Primary,
    },
  });
}

/**
 * Terminal notice for the legacy OpenRouter "other-model" sentinel, which was moved to
 * the provider panel. The V2 equivalent of `replyLegacyOpenRouterOtherModelMoved`
 * points at the panel that matches the caller's scope.
 */
export function buildOpenRouterMovedNotice(
  locale: string,
  scopeKind: AnchorModelScopeKind = "server",
): PersonaWorkflowComponentsV2Payload {
  const providersMention =
    scopeKind === "server"
      ? commandRegistry.getCommandMention("providers")
      : commandRegistry.getCommandMention("personal", "providers");

  return buildPersonaWorkflowNotice({
    locale,
    titleKey: "general.openrouter_model_moved_title",
    descriptionKey: "general.openrouter_model_moved_description",
    descriptionVars: {
      add_command: providersMention,
      remove_command: providersMention,
    },
    color: ColorCode.ERROR,
  });
}

/**
 * The no-saved-providers terminal notice, used as the initial anchor payload.
 * Personal scope points the user at `/personal providers` instead of the server
 * setup flow, and treats it as a warning rather than an error.
 */
export function buildNoProvidersPayload(
  locale: string,
  scopeKind: AnchorModelScopeKind = "server",
): PersonaWorkflowComponentsV2Payload {
  if (scopeKind === "personal") {
    return buildPersonaWorkflowNotice({
      locale,
      titleKey: "commands.personal.provider.no_saved_title",
      descriptionKey: "commands.personal.provider.no_saved_description",
      color: ColorCode.WARN,
    });
  }

  return buildPersonaWorkflowNotice({
    locale,
    titleKey: "commands.model.providerPicker.no_providers_title",
    descriptionKey: "commands.model.providerPicker.no_providers_description",
    color: ColorCode.ERROR,
  });
}

/**
 * Awaits a button click on the anchor message. On timeout it renders the timeout
 * notice in place and returns null; the returned button is left unacknowledged so the
 * caller can open a modal on it via {@link AnchorPrivateWorkflowPhase.useButton}.
 */
async function awaitAnchorButton(
  phase: AnchorPrivateWorkflowPhase,
  userId: string,
  prefix: string,
  locale: string,
): Promise<ButtonInteraction | null> {
  const message = await phase.message.fetchMessage();
  try {
    return await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (candidate) => candidate.user.id === userId && candidate.customId.startsWith(prefix),
      time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCollectorTimeoutError(error)) {
      await phase.message
        .replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.interaction.timeout_title",
            descriptionKey: "general.pagination.timeout",
            color: ColorCode.WARN,
          }),
        )
        .catch(() => undefined);
      return null;
    }
    throw error;
  }
}

/**
 * Renders the provider-selection step and returns the unacknowledged button the model
 * modal will open from, plus the chosen provider.
 *
 * - 1 provider: the anchor message already shows the "open selector" button; this just
 *   collects the click and returns the lone provider.
 * - 2+ providers: collects the picker click, handling cancel and invalid selection.
 *
 * Returns null when the user cancels/times out, so the anchor message already shows the
 * terminal notice in those cases.
 */
export async function acquireModelModalOpener(
  phase: AnchorPrivateWorkflowPhase,
  userId: string,
  locale: string,
  savedProviders: readonly AnchorProviderChoice[],
  idRoot: string,
): Promise<{ button: ButtonInteraction; provider: string } | null> {
  if (savedProviders.length === 1) {
    const button = await awaitAnchorButton(phase, userId, `${idRoot}_open`, locale);
    if (!button) return null;
    return { button, provider: savedProviders[0].provider.toLowerCase() };
  }

  const button = await awaitAnchorButton(phase, userId, idRoot, locale);
  if (!button) return null;
  if (button.customId === `${idRoot}_cancel`) {
    await phase.useButton(button).replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.interaction.cancel_title",
        descriptionKey: "general.pagination.cancelled",
        color: ColorCode.WARN,
      }),
    );
    return null;
  }
  const index = Number.parseInt(button.customId.replace(`${idRoot}_`, ""), 10);
  const provider = savedProviders[index];
  if (!provider) {
    await phase.useButton(button).replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      }),
    );
    return null;
  }
  return { button, provider: provider.provider.toLowerCase() };
}

/**
 * Renders the shared `>25` range selector on the anchor message and returns the chosen
 * half-open option range, or null when the user cancelled or timed out (both rendered in
 * place). The returned button is left unacknowledged so the caller can open its modal from it.
 *
 * The anchor engine's own bridge (see {@link openAnchorModal}) already does this for
 * the common case, but it slices exactly one select component and assumes every entry is a
 * real option. This helper exists for modals that neither assumption fits: `/model fallback`
 * and its personal sibling render **five** selects over one shared option list and reserve one
 * entry per page for an explicit "None" choice. They pick a range here first, then hand
 * {@link openAnchorModal} an already-sliced `<=25` list, which opens directly.
 *
 * @param optionCount - Total selectable options, excluding any reserved entries.
 * @returns The chosen range plus the button to open the modal from, or null.
 */
export async function acquireModalOptionRange(
  phase: AnchorPrivateWorkflowPhase,
  button: ButtonInteraction,
  userId: string,
  locale: string,
  optionCount: number,
  pageSize: number,
): Promise<{ button: ButtonInteraction; start: number; end: number } | null> {
  // A per-invocation prefix keeps a previous run's stale selector buttons from resolving here.
  const prefix = `anchor_range_${button.id}_${Date.now().toString(36)}`;
  const totalRanges = Math.ceil(optionCount / pageSize);
  const totalRangePages = Math.ceil(totalRanges / RANGES_PER_SELECTOR_PAGE);
  let rangePage = 0;

  await phase.useButton(button).replace(buildRangeSelectorPayload(locale, prefix, optionCount, rangePage, pageSize));

  while (true) {
    const rangeButton = await awaitAnchorButton(phase, userId, prefix, locale);
    if (!rangeButton) return null;

    if (rangeButton.customId === `${prefix}_cancel`) {
      await phase.useButton(rangeButton).replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.interaction.cancel_title",
          descriptionKey: "general.pagination.cancelled",
          color: ColorCode.WARN,
        }),
      );
      return null;
    }

    if (rangeButton.customId === `${prefix}_previous` || rangeButton.customId === `${prefix}_next`) {
      rangePage =
        rangeButton.customId === `${prefix}_previous`
          ? Math.max(0, rangePage - 1)
          : Math.min(totalRangePages - 1, rangePage + 1);
      await phase
        .useButton(rangeButton)
        .replace(buildRangeSelectorPayload(locale, prefix, optionCount, rangePage, pageSize));
      continue;
    }

    const rangeIndex = parseModalRangeIndex(rangeButton.customId, prefix);
    if (rangeIndex === null) {
      await phase.useButton(rangeButton).replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "general.errors.invalid_option_description",
          color: ColorCode.ERROR,
        }),
      );
      return null;
    }

    const start = rangeIndex * pageSize;
    return { button: rangeButton, start, end: Math.min(start + pageSize, optionCount) };
  }
}

/**
 * Renders a two-button confirm step on the anchor message and returns the unacknowledged
 * Continue button, or null when the user declined or timed out (both rendered in place).
 *
 * Personal-scope model commands enable a cross-server override as a side effect of picking a
 * model, so a capability moving off the server default needs an explicit acknowledgement before
 * the write. The Continue button is deliberately left unacknowledged so the caller decides when
 * the three-second ack lands relative to its own database work.
 */
export async function confirmPersonalOverrideActivation(
  phase: AnchorPrivateWorkflowPhase,
  modalPhase: PersonaWorkflowModalPhase,
  userId: string,
  locale: string,
  details: { capability: string; provider: string; model: string },
  idRoot: string,
): Promise<ButtonInteraction | null> {
  const prefix = `${idRoot}_activate`;
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.WARN.replace("#", ""), 16),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.provider.activation_confirm_title")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.personal.provider.activation_confirm_description", details),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId: `${prefix}_yes`,
            label: localizer(locale, "commands.personal.provider.activation_confirm_continue"),
            style: ButtonStyle.Success,
          },
          {
            type: ComponentType.Button,
            customId: `${prefix}_no`,
            label: localizer(locale, "commands.personal.provider.activation_confirm_cancel"),
            style: ButtonStyle.Danger,
          },
        ],
      } satisfies ActionRowData<ButtonComponentData>,
    ],
  };

  await modalPhase.replace({ components: [container], flags: MessageFlags.IsComponentsV2 });

  const button = await awaitAnchorButton(phase, userId, prefix, locale);
  if (!button) return null;
  if (button.customId === `${prefix}_no`) {
    await phase.useButton(button).replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "commands.personal.provider.activation_cancelled_title",
        descriptionKey: "commands.personal.provider.activation_cancelled_description",
        color: ColorCode.WARN,
      }),
    );
    return null;
  }
  return button;
}

/**
 * Opens the model-selection modal on the anchor message from `button`, routing the
 * `>25` case through the anchor range selector automatically. Returns the submitted
 * modal phase, or null when the flow ended without a submit, so cancel and timeout are
 * rendered in place by the bridge; a transport error renders the generic error notice.
 */
export async function openAnchorModal(
  phase: AnchorPrivateWorkflowPhase,
  button: ButtonInteraction,
  locale: string,
  modalOptions: ModalOptions,
): Promise<PersonaWorkflowModalPhase | null> {
  const result = await phase.useButton(button).openModal(modalOptions);
  if (result.outcome === "submitted") return result.phase;
  // Cancel and timeout already rendered a terminal notice; only transport errors need one.
  if (result.outcome === "error" || result.outcome === "fatal") {
    await phase.message
      .replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      )
      .catch(() => undefined);
  }
  return null;
}
