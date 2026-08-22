import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Message,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { personaRepository } from "@/utils/db/repositories";
import { cooldownRepository } from "@/utils/db/repositories/CooldownRepository";
import { sendCooldownDM } from "@/utils/discord/cooldownDM";
import { normalizeMessageFetchLimit } from "@/utils/discord/messageFetchLimit";
import { safeSelectOptionText } from "@/utils/discord/interactionHelper";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { tomoriChat } from "@/events/messageCreate/tomoriChat";
import { CooldownType, type TomoriState, type UserRow } from "@/types/db/schema";
import { ColorCode, log } from "@/utils/misc/logger";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { localizer } from "@/utils/text/localizer";
import { buildSceneTextQuotaTriggerKey, buildSceneTurnDirective } from "@/utils/chat/sceneTurn";
import type { SceneTurnMetadata, SceneTurnSpeaker } from "@/utils/chat/types";

const MODAL_CUSTOM_ID = "generate_scene_modal";
const CHARACTER_1_INPUT_ID = "generate_scene_character_1";
const CHARACTER_2_INPUT_ID = "generate_scene_character_2";
const CHARACTER_3_INPUT_ID = "generate_scene_character_3";
const CYCLES_INPUT_ID = "generate_scene_cycles";
const INSTRUCTIONS_INPUT_ID = "generate_scene_instructions";
const MAX_PERSONA_SELECT_OPTIONS = 25;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("scene").setDescription(localizer("en-US", "commands.generate.scene.description"));

function parsePositiveIntegerEnv(value: string | undefined, defaultValue: number, minimum: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(minimum, parsed);
}

function getMaxCycles(): number {
  // BOT_GENERATE_SCENE_MAX_CYCLES is the name operators already have set from when this
  // command lived at /bot generate scene, so it stays readable: dropping it would silently
  // return a tuned deployment to the default of 10.
  return parsePositiveIntegerEnv(
    process.env.GENERATE_SCENE_MAX_CYCLES ?? process.env.BOT_GENERATE_SCENE_MAX_CYCLES,
    10,
    1,
  );
}

function getPersonaOptions(personas: TomoriState[], locale: string) {
  return personas
    .filter((persona) => typeof persona.persona_id === "number")
    .map((persona) => ({
      label: safeSelectOptionText(persona.persona_nickname),
      value: String(persona.persona_id),
      description: localizer(
        locale,
        persona.is_alter
          ? "commands.generate.scene.modal.alter_persona_description"
          : "commands.generate.scene.modal.main_persona_description",
      ),
    }));
}

function parseCycleCount(rawValue: string | undefined): number | null {
  if (!rawValue?.trim()) return null;
  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isNaN(parsed) || String(parsed) !== rawValue.trim() ? null : parsed;
}

function buildSceneSequence(speakers: SceneTurnSpeaker[], cycles: number): SceneTurnSpeaker[] {
  const sequence: SceneTurnSpeaker[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    sequence.push(...speakers);
  }
  return sequence;
}

function resolveSelectedSpeakers(params: {
  values: Record<string, string> | undefined;
  availablePersonas: TomoriState[];
}): SceneTurnSpeaker[] | null {
  const selectedIds = [
    params.values?.[CHARACTER_1_INPUT_ID],
    params.values?.[CHARACTER_2_INPUT_ID],
    params.values?.[CHARACTER_3_INPUT_ID],
  ].filter((value): value is string => Boolean(value?.trim()));

  if (selectedIds.length < 2 || new Set(selectedIds).size !== selectedIds.length) {
    return null;
  }

  const personasById = new Map(
    params.availablePersonas
      .filter((persona) => typeof persona.persona_id === "number")
      .map((persona) => [String(persona.persona_id), persona]),
  );
  const speakers: SceneTurnSpeaker[] = [];

  for (const selectedId of selectedIds) {
    const persona = personasById.get(selectedId);
    if (!persona?.persona_id) {
      return null;
    }

    speakers.push({
      personaId: persona.persona_id,
      personaName: persona.persona_nickname,
    });
  }

  return speakers;
}

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel || !("messages" in interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isDMChannel = !interaction.guildId;
  const serverDiscId = interaction.guildId ?? interaction.user.id;

  if (!isDMChannel) {
    const botMember = interaction.guild?.members.me;
    if (!botMember) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildChannel = interaction.guild?.channels.cache.get(interaction.channel.id) ?? interaction.channel;
    if (!("permissionsFor" in guildChannel)) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const permissions = guildChannel.permissionsFor(botMember);
    const isThread =
      "isThread" in guildChannel && typeof guildChannel.isThread === "function" && guildChannel.isThread();
    const canSendMessages = isThread
      ? permissions?.has(PermissionFlagsBits.SendMessagesInThreads)
      : permissions?.has(PermissionFlagsBits.SendMessages);

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory) ||
      !canSendMessages
    ) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.generate.scene.missing_permissions_title",
        descriptionKey: "commands.generate.scene.missing_permissions_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const tomoriState = await personaRepository.loadState(serverDiscId);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const invokingMember = interaction.member as GuildMember | null;
  const cooldownType = tomoriState.config.cooldown_type ?? CooldownType.OFF;
  const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
    serverDiscId,
    interaction.user.id,
    interaction.channel.id,
    cooldownType,
    invokingMember,
  );

  if (cooldownResult.isOnCooldown) {
    if (cooldownResult.blockedByWhitelist) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.generate.scene.channel_not_whitelisted",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await sendCooldownDM(
      interaction.user,
      locale,
      "general.message_cooldown_title",
      "commands.generate.scene.cooldown_active",
      {
        seconds: cooldownResult.remainingSeconds.toString(),
        botName: tomoriState.persona_nickname,
      },
      cooldownRepository.getCooldownTypeFooterKey(cooldownResult.cooldownType),
      interaction,
      MessageFlags.Ephemeral,
    );
    return;
  }

  const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
  const parentChannelId = interaction.channel.isThread() ? interaction.channel.parent?.id : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    serverDiscId,
    interaction.channel.id,
    invokingMember?.roles.cache.map((role) => role.id),
    parentChannelId,
  );
  const personalSpotlightStatus = userData.user_id
    ? await getCachedPersonalSpotlightStatus(
        tomoriState.server_id,
        userData.user_id,
        parentChannelId ?? interaction.channel.id,
      )
    : null;
  const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus).filter(
    (persona) => typeof persona.persona_id === "number",
  );

  if (availablePersonas.length < 2) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.scene.not_enough_personas_title",
      descriptionKey: "commands.generate.scene.not_enough_personas_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (availablePersonas.length > MAX_PERSONA_SELECT_OPTIONS) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.scene.too_many_personas_title",
      descriptionKey: "commands.generate.scene.too_many_personas_description",
      descriptionVars: {
        count: String(availablePersonas.length),
        max: String(MAX_PERSONA_SELECT_OPTIONS),
      },
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fetchedMessages = await interaction.channel.messages.fetch({
    limit: normalizeMessageFetchLimit(tomoriState.config.message_fetch_limit),
  });
  const latestMessage = fetchedMessages.first();
  if (!latestMessage) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.scene.no_messages_title",
      descriptionKey: "commands.generate.scene.no_messages_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const personaOptions = getPersonaOptions(availablePersonas, locale);
  const maxCycles = getMaxCycles();
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.generate.scene.modal.title",
      components: [
        {
          customId: CHARACTER_1_INPUT_ID,
          labelKey: "commands.generate.scene.modal.character_1_label",
          descriptionKey: "commands.generate.scene.modal.character_description",
          placeholder: localizer(locale, "commands.generate.scene.modal.character_placeholder"),
          required: true,
          options: personaOptions,
        },
        {
          customId: CHARACTER_2_INPUT_ID,
          labelKey: "commands.generate.scene.modal.character_2_label",
          descriptionKey: "commands.generate.scene.modal.character_description",
          placeholder: localizer(locale, "commands.generate.scene.modal.character_placeholder"),
          required: true,
          options: personaOptions,
        },
        {
          customId: CHARACTER_3_INPUT_ID,
          labelKey: "commands.generate.scene.modal.character_3_label",
          descriptionKey: "commands.generate.scene.modal.character_3_description",
          placeholder: localizer(locale, "commands.generate.scene.modal.character_3_placeholder"),
          required: false,
          options: personaOptions,
        },
        {
          customId: CYCLES_INPUT_ID,
          labelKey: "commands.generate.scene.modal.cycles_label",
          descriptionKey: "commands.generate.scene.modal.cycles_description",
          placeholder: localizer(locale, "commands.generate.scene.modal.cycles_placeholder", {
            max: String(maxCycles),
          }),
          required: true,
          minLength: 1,
          maxLength: Math.max(1, String(maxCycles).length),
          style: TextInputStyle.Short,
        },
        {
          customId: INSTRUCTIONS_INPUT_ID,
          labelKey: "commands.generate.scene.modal.instructions_label",
          descriptionKey: "commands.generate.scene.modal.instructions_description",
          placeholder: localizer(locale, "commands.generate.scene.modal.instructions_placeholder"),
          required: false,
          maxLength: 1000,
          style: TextInputStyle.Paragraph,
        },
      ],
    },
    // Do not auto-defer the modal submission: the success path replies with a
    // *non-ephemeral* embed so it becomes a real channel message the context
    // builder can re-read as a [System: ...] scene directive. All post-submit
    // work below is synchronous, so we still acknowledge within the 3s window.
  );

  if (modalResult.outcome !== "submit" || !modalResult.interaction) {
    return;
  }

  const modalInteraction = modalResult.interaction;
  const speakers = resolveSelectedSpeakers({
    values: modalResult.values,
    availablePersonas,
  });

  if (!speakers) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.scene.invalid_personas_title",
      descriptionKey: "commands.generate.scene.invalid_personas_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cycles = parseCycleCount(modalResult.values?.[CYCLES_INPUT_ID]);
  if (!cycles || cycles < 1 || cycles > maxCycles) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.scene.invalid_cycles_title",
      descriptionKey: "commands.generate.scene.invalid_cycles_description",
      descriptionVars: { max: String(maxCycles) },
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  for (const speaker of speakers) {
    if (!isPersonaAllowedForTrigger(whitelistStatus, personalSpotlightStatus, speaker.personaId)) {
      await replyInfoEmbed(modalInteraction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.generate.scene.persona_access_blocked",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const sequence = buildSceneSequence(speakers, cycles);
  const additionalInstructions = modalResult.values?.[INSTRUCTIONS_INPUT_ID]?.trim() || undefined;
  const firstSceneTurn: SceneTurnMetadata = {
    commandId: interaction.id,
    sequence,
    turnIndex: 0,
    totalTurns: sequence.length,
    additionalInstructions,
  };

  const speakingOrder = speakers.map((speaker) => speaker.personaName).join(" → ");
  const descriptionLines = [
    localizer(locale, "commands.generate.scene.success_order_line", { order: speakingOrder }),
    localizer(locale, "commands.generate.scene.success_rounds_line", {
      rounds: String(cycles),
      turns: String(sequence.length),
    }),
  ];
  if (additionalInstructions) {
    descriptionLines.push(
      localizer(locale, "commands.generate.scene.success_instructions_line", {
        instructions: additionalInstructions,
      }),
    );
  }

  // Footer shows who triggered the scene, mirroring the executor identity pattern
  //    in /impersonate user (guild member avatar, falling back to the global user avatar).
  const executorAvatarUrl = invokingMember
    ? invokingMember.displayAvatarURL({ size: 64, extension: "png", forceStatic: true })
    : interaction.user.displayAvatarURL({ size: 64, extension: "png", forceStatic: true });

  await modalInteraction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(localizer(locale, "commands.generate.scene.success_title"))
        .setDescription(descriptionLines.join("\n"))
        .setColor(ColorCode.SUCCESS)
        .setFooter({
          text: localizer(locale, "commands.generate.scene.success_footer", {
            user: interaction.user.username,
          }),
          iconURL: executorAvatarUrl,
        }),
    ],
  });

  log.info(
    `[/generate scene] Starting scene in channel ${interaction.channel.id}: ${sequence
      .map((speaker) => speaker.personaName)
      .join(" -> ")}`,
  );

  await tomoriChat({
    client,
    message: latestMessage as Message,
    isFromQueue: false,
    isManuallyTriggered: true,
    selectedPersonaId: sequence[0].personaId,
    triggeredPersonaIds: speakers.map((speaker) => speaker.personaId),
    textQuotaSource: "user",
    textQuotaTriggerKey: buildSceneTextQuotaTriggerKey(firstSceneTurn),
    textQuotaUserDiscId: interaction.user.id,
    manualSystemPrompt: buildSceneTurnDirective(firstSceneTurn),
    shouldSurfaceUserErrors: true,
    manualTriggerInvoker: {
      userDiscId: interaction.user.id,
      username: interaction.user.username,
      locale,
      member: invokingMember,
    },
    sceneTurn: firstSceneTurn,
  });
}
