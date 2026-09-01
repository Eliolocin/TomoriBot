import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionsBitField,
  type ActionRowData,
  type ButtonComponentData,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ComponentInContainerData,
  type ContainerComponentData,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { PersonaSpriteRow, TomoriState, UserRow, ErrorContext } from "@/types/db/schema";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository, personaSpriteRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { isCollectorTimeoutError } from "@/utils/discord/ui/interactionCore";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS as WORKFLOW_COMPONENT_TIMEOUT_MS,
  runPersonaPickerWorkflow,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowMessageController,
  type PersonaWorkflowModalPhase,
  type PersonaWorkflowSelectionPhase,
} from "@/utils/discord/ui/personaWorkflow";
import { personaIdIsEligible } from "@/utils/discord/ui/personaEligibility";
import { ColorCode, log } from "@/utils/misc/logger";
import { PERSONA_SPRITE_LIMITS } from "@/utils/persona/sprites";
import { deletePersonaSpriteFromStorage } from "@/utils/storage/avatarStorage";
import { localizer } from "@/utils/text/localizer";
import { forkPointerForAvatarChange } from "../avatar";

const MODAL_CUSTOM_ID = "persona_sprites_remove_modal";
const CHECKBOX_ID_PREFIX = "persona_sprites_remove_checkbox_group";
const PAGE_BUTTONS_PER_SELECTOR = 20;
const PAGE_SELECT_ID_PREFIX = "persona_sprites_remove_page";
const PAGE_PREV_ID_PREFIX = "persona_sprites_remove_prev";
const PAGE_NEXT_ID_PREFIX = "persona_sprites_remove_next";
const PAGE_CANCEL_ID_PREFIX = "persona_sprites_remove_cancel";
type SpriteWithId = PersonaSpriteRow & { sprite_id: number };

type SpriteModalSelectionResult =
  | {
      outcome: "submitted";
      phase: PersonaWorkflowModalPhase;
      displayedSprites: SpriteWithId[];
      checkboxGroupCount: number;
    }
  | { outcome: "cancelled" | "timeout" | "error" | "fatal" };

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.persona.sprites.remove.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.persona.sprites.remove.no_permission_title",
      descriptionKey: "commands.persona.sprites.remove.no_permission_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const guildId = interaction.guild.id;

  let selectedPersonaId: number | undefined;
  const workflowState: { message: PersonaWorkflowMessageController | null } = { message: null };

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const allPersonas = await personaRepository.loadAllForServer(guildId);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Class B eligibility, pointer-aware: `personaIdsWithSprites` resolves preset
    // pointers in bulk (a pointer persona has zero own rows but still has sprites)
    // and reproduces the numeric `sprite_id` narrowing used by the guard below.
    // Single-selection flow, so no in-place set refresh is needed.
    const eligibleSpritePersonaIds = await personaSpriteRepository.personaIdsWithSprites(
      allPersonas.map((persona) => persona.persona_id).filter((id): id is number => typeof id === "number"),
    );
    const isEligible = personaIdIsEligible(eligibleSpritePersonaIds);
    const eligiblePersonas = allPersonas.filter(isEligible);
    if (eligiblePersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.sprites.remove.no_sprites_title",
        descriptionKey: "commands.persona.sprites.remove.no_eligible_sprites_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const workflowResult = await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      titleKey: "commands.persona.sprites.remove.persona_select_title",
      eligibility: {
        isEligible,
        emptyTitleKey: "commands.persona.sprites.remove.no_sprites_title",
        emptyDescriptionKey: "commands.persona.sprites.remove.no_eligible_sprites_description",
        itemsLabelKey: "general.persona_workflow.items.sprites",
      },
      async onSelected(selection) {
        workflowState.message = selection.message;
        const selectedPersona = selection.persona;
        const personaId = selectedPersona.persona_id;
        selectedPersonaId = personaId;
        const work = await selection.beginInPlaceWork();
        if (!personaId) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        const sprites = (await personaSpriteRepository.listForPersona(personaId)).filter(
          (sprite): sprite is SpriteWithId => typeof sprite.sprite_id === "number",
        );
        if (sprites.length === 0) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.remove.no_sprites_title",
              descriptionKey: "commands.persona.sprites.remove.no_sprites_description",
              descriptionVars: { persona_name: selectedPersona.persona_nickname },
              color: ColorCode.WARN,
            }),
          );
          return completePersonaWorkflow();
        }

        const modalResult = await promptForSpritePage(selection, sprites, locale, interaction.user.id);
        if (modalResult.outcome !== "submitted") {
          log.info(`Persona sprite remove modal ${modalResult.outcome} for user ${interaction.user.id}`);
          return completePersonaWorkflow();
        }

        const modalWork = await modalResult.phase.beginInPlaceWork();
        const checkedKeys = collectCheckedSpriteKeys(modalResult.phase.multiValues, modalResult.checkboxGroupCount);
        const spriteKeysToRemove = modalResult.displayedSprites
          .filter((sprite) => !checkedKeys.has(sprite.sprite_key))
          .map((sprite) => sprite.sprite_key);
        if (spriteKeysToRemove.length === 0) {
          await modalWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.persona.sprites.remove.no_changes_title",
              descriptionKey: "commands.persona.sprites.remove.no_changes_description",
              color: ColorCode.INFO,
            }),
          );
          return completePersonaWorkflow();
        }

        const wasPointer = selectedPersona.is_pointer === true;
        const pointerForked = await forkPointerForAvatarChange(selectedPersona);
        if (!pointerForked) {
          await modalWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }
        if (wasPointer) invalidateTomoriStateCache(guildId);

        const removedSprites = await personaSpriteRepository.deleteSpritesByKeys(personaId, spriteKeysToRemove);
        if (removedSprites.length === 0) {
          await modalWork.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        invalidateTomoriStateCache(guildId);
        await Promise.all(removedSprites.map((sprite) => deletePersonaSpriteFromStorage(sprite.avatar_url)));
        await modalWork.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.persona.sprites.remove.success_title",
            descriptionKey: "commands.persona.sprites.remove.success_description",
            descriptionVars: {
              persona_name: selectedPersona.persona_nickname,
              removed_count: removedSprites.length.toString(),
              removed_sprites: formatRemovedSprites(removedSprites),
            },
            color: ColorCode.SUCCESS,
          }),
        );
        return completePersonaWorkflow();
      },
    });

    if (workflowResult.outcome === "error" && workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
    }
  } catch (error) {
    const context: ErrorContext = {
      personaId: selectedPersonaId,
      errorType: "CommandExecutionError",
      metadata: {
        command: "persona sprites remove",
        guildId,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error in /persona sprites remove command", error as Error, context);

    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
    } else {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

async function promptForSpritePage(
  selection: PersonaWorkflowSelectionPhase<TomoriState>,
  sprites: SpriteWithId[],
  locale: string,
  userId: string,
): Promise<SpriteModalSelectionResult> {
  const pageSize = PERSONA_SPRITE_LIMITS.MAX_REMOVAL_ENTRIES_PER_PAGE;
  const totalPages = Math.ceil(sprites.length / pageSize);
  const nonce = selection.phaseId;
  let selectorPage = 0;
  await selection.message.replace(buildPageSelectorPayload(nonce, selectorPage, sprites.length, locale));

  while (true) {
    let buttonInteraction: ButtonInteraction;
    try {
      const message = await selection.message.fetchMessage();
      buttonInteraction = await message.awaitMessageComponent({
        filter: (componentInteraction) =>
          componentInteraction.user.id === userId && componentInteraction.customId.includes(nonce),
        componentType: ComponentType.Button,
        time: WORKFLOW_COMPONENT_TIMEOUT_MS,
      });
    } catch (error) {
      const isTimeout = isCollectorTimeoutError(error);
      await selection.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.persona.sprites.remove.page_timeout_title",
          descriptionKey: isTimeout
            ? "commands.persona.sprites.remove.page_timeout_description"
            : "general.errors.unknown_error_description",
          color: isTimeout ? ColorCode.WARN : ColorCode.ERROR,
        }),
      );
      return { outcome: isTimeout ? "timeout" : "error" };
    }

    const nested = selection.useButton(buttonInteraction);
    if (buttonInteraction.customId === `${PAGE_PREV_ID_PREFIX}_${nonce}`) {
      selectorPage = Math.max(0, selectorPage - 1);
      await nested.replace(buildPageSelectorPayload(nonce, selectorPage, sprites.length, locale));
      continue;
    }
    if (buttonInteraction.customId === `${PAGE_NEXT_ID_PREFIX}_${nonce}`) {
      selectorPage = Math.min(Math.ceil(totalPages / PAGE_BUTTONS_PER_SELECTOR) - 1, selectorPage + 1);
      await nested.replace(buildPageSelectorPayload(nonce, selectorPage, sprites.length, locale));
      continue;
    }
    if (buttonInteraction.customId === `${PAGE_CANCEL_ID_PREFIX}_${nonce}`) {
      await nested.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.interaction.cancel_title",
          descriptionKey: "general.interaction.cancel_description",
          color: ColorCode.WARN,
        }),
      );
      return { outcome: "cancelled" };
    }

    const pagePrefix = `${PAGE_SELECT_ID_PREFIX}_${nonce}_`;
    const pageIndex = Number.parseInt(buttonInteraction.customId.slice(pagePrefix.length), 10);
    if (
      !buttonInteraction.customId.startsWith(pagePrefix) ||
      Number.isNaN(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= totalPages
    ) {
      await nested.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.invalid_option_title",
          descriptionKey: "general.errors.invalid_option_description",
          color: ColorCode.ERROR,
        }),
      );
      return { outcome: "error" };
    }

    const displayedSprites = sprites.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const checkboxGroups = buildSpriteCheckboxGroups(displayedSprites, locale);
    const modalResult = await nested.openModal({
      modalCustomId: `${MODAL_CUSTOM_ID}_${pageIndex}`,
      modalTitleKey: "commands.persona.sprites.remove.modal_title",
      components: checkboxGroups,
    });
    if (modalResult.outcome !== "submitted") return { outcome: modalResult.outcome };
    return {
      outcome: "submitted",
      phase: modalResult.phase,
      displayedSprites,
      checkboxGroupCount: checkboxGroups.length,
    };
  }
}

function buildPageSelectorPayload(
  nonce: string,
  selectorPage: number,
  totalSprites: number,
  locale: string,
): PersonaWorkflowComponentsV2Payload {
  const pageSize = PERSONA_SPRITE_LIMITS.MAX_REMOVAL_ENTRIES_PER_PAGE;
  const totalPages = Math.ceil(totalSprites / pageSize);

  // Every sprite fits in one modal (<= 10 options x 5 checkbox groups), so a
  //    range selector would offer a single meaningless choice. The persona button
  //    was already update-deferred before the sprite query, so the modal must be
  //    opened from a fresh launcher button rather than from that interaction.
  if (totalPages <= 1) {
    return buildSinglePageLauncherPayload(nonce, locale);
  }

  const selectorPageCount = Math.ceil(totalPages / PAGE_BUTTONS_PER_SELECTOR);
  const startPage = selectorPage * PAGE_BUTTONS_PER_SELECTOR;
  const endPage = Math.min(totalPages, startPage + PAGE_BUTTONS_PER_SELECTOR);
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.persona.sprites.remove.page_select_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.persona.sprites.remove.page_select_description", {
        total_sprites: totalSprites.toString(),
        total_pages: totalPages.toString(),
        current_page: (selectorPage + 1).toString(),
        page_count: selectorPageCount.toString(),
      }),
    },
  ];
  const pageButtons: ButtonComponentData[] = [];

  for (let pageIndex = startPage; pageIndex < endPage; pageIndex++) {
    const rangeStart = pageIndex * pageSize + 1;
    const rangeEnd = Math.min((pageIndex + 1) * pageSize, totalSprites);
    pageButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: `${PAGE_SELECT_ID_PREFIX}_${nonce}_${pageIndex}`,
      label: `${rangeStart}-${rangeEnd}`,
    });
  }

  for (let index = 0; index < pageButtons.length; index += 5) {
    components.push({
      type: ComponentType.ActionRow,
      components: pageButtons.slice(index, index + 5),
    } satisfies ActionRowData<ButtonComponentData>);
  }

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: `${PAGE_PREV_ID_PREFIX}_${nonce}`,
        label: localizer(locale, "commands.persona.sprites.remove.previous_page_button"),
        disabled: selectorPage === 0,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: `${PAGE_CANCEL_ID_PREFIX}_${nonce}`,
        label: localizer(locale, "general.pagination.cancel"),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: `${PAGE_NEXT_ID_PREFIX}_${nonce}`,
        label: localizer(locale, "commands.persona.sprites.remove.next_page_button"),
        disabled: selectorPage >= selectorPageCount - 1,
      },
    ],
  } satisfies ActionRowData<ButtonComponentData>);

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Builds the single-page launcher state shown when every sprite fits in one modal.
 *
 * The "open" button intentionally reuses the page-selector custom ID for page 0 so
 * the shared collector loop in {@link promptForSpritePage} resolves it as a normal
 * page selection with no extra branching.
 *
 * @param nonce - Phase-scoped nonce shared by every button in this workflow step.
 * @param locale - Locale used for all button labels and container text.
 * @returns A Components V2 payload replacing the picker with an open/cancel pair.
 */
function buildSinglePageLauncherPayload(nonce: string, locale: string): PersonaWorkflowComponentsV2Payload {
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "general.persona_workflow.modal_ready_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "general.persona_workflow.modal_ready_description"),
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: `${PAGE_SELECT_ID_PREFIX}_${nonce}_0`,
          label: localizer(locale, "general.persona_workflow.open_modal_button"),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: `${PAGE_CANCEL_ID_PREFIX}_${nonce}`,
          label: localizer(locale, "general.pagination.cancel"),
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>,
  ];

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components,
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildSpriteCheckboxGroups(sprites: SpriteWithId[], locale: string): ModalCheckboxGroupField[] {
  const groups: ModalCheckboxGroupField[] = [];

  for (let index = 0; index < sprites.length; index += PERSONA_SPRITE_LIMITS.MAX_OPTIONS_PER_GROUP) {
    const chunk = sprites.slice(index, index + PERSONA_SPRITE_LIMITS.MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(index / PERSONA_SPRITE_LIMITS.MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((sprite) => ({
      label: safeSelectOptionText(sprite.sprite_name, 100),
      value: sprite.sprite_key,
      description: safeSelectOptionText(formatSpriteDescription(sprite, locale), 100),
      default: true,
    }));

    groups.push({
      kind: "checkboxGroup",
      customId: `${CHECKBOX_ID_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0
          ? "commands.persona.sprites.remove.checkbox_label"
          : "commands.persona.sprites.remove.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.persona.sprites.remove.checkbox_description" : undefined,
      minValues: 0,
      maxValues: options.length,
      required: false,
      options,
    });
  }

  return groups;
}

function collectCheckedSpriteKeys(multiValues: Record<string, string[]> | undefined, groupCount: number): Set<string> {
  const checkedKeys = new Set<string>();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const groupValues = multiValues?.[`${CHECKBOX_ID_PREFIX}_${groupIndex}`] ?? [];
    for (const spriteKey of groupValues) {
      checkedKeys.add(spriteKey);
    }
  }
  return checkedKeys;
}

function formatSpriteDescription(sprite: PersonaSpriteRow, locale: string): string {
  const instructions = sprite.usage_instructions.trim();
  return instructions || localizer(locale, "commands.persona.sprites.remove.default_usage_description");
}

function formatRemovedSprites(sprites: PersonaSpriteRow[]): string {
  const maxVisible = 10;
  const visibleSprites = sprites.slice(0, maxVisible);
  const suffix = sprites.length > maxVisible ? ", ..." : "";
  return `${visibleSprites.map((sprite) => `\`${sprite.sprite_name}\``).join(", ")}${suffix}`;
}
