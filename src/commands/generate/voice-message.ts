/**
 * `/generate voice-message`
 *
 * Manual driver for the server's configured speech endpoint, so testing a voice clone or a voice
 * design prompt does not cost a full chat turn and a coin flip on whether the model decides to
 * call `generate_voice_message`.
 *
 * Two per-invocation overrides are accepted and deliberately never persisted: an uploaded voice
 * sample and a typed voice design prompt. The uploaded buffer lives only in this invocation, and
 * neither value reaches `persona_voice_configs` or `voice_samples`.
 */

import {
  EmbedBuilder,
  MessageFlags,
  type Attachment,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { parseBuffer } from "music-metadata";
import { personaRepository, statRepository } from "@/utils/db/repositories";
import { loadVoiceSamples } from "@/utils/db/repositories/SpeechRepository";
import { cooldownRepository } from "@/utils/db/repositories/CooldownRepository";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { sendCooldownDM } from "@/utils/discord/cooldownDM";
import {
  isGuildMessageCommandChannel,
  resolveGuildWebhookTargetChannel,
  resolveGuildWebhookThreadId,
} from "@/utils/discord/guildMessageChannel";
import { handlePersonaAutocomplete } from "@/utils/discord/autocomplete/personaAutocomplete";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import type { ModalComponent } from "@/types/discord/modal";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { resolvePersonaWebhookIdentity } from "@/utils/discord/webhook/identity";
import {
  deliverVoiceMessage,
  postVoiceTranscriptCaption,
  type VoiceDeliveryTarget,
} from "@/utils/discord/webhook/voiceMessageDelivery";
import { setCachedVoiceTranscript } from "@/utils/audio/voiceTranscriptCache";
import { generateVoiceMessageMetadata } from "@/utils/audio/voiceMessageMetadata";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import { isChatterboxEndpoint } from "@/providers/custom/styles/ttsCloningAdapter";
import type { CustomEndpointRow } from "@/types/db/schema";
import { resolveActiveSpeechEndpoint } from "@/utils/provider/speechEndpointResolver";
import { getOptApiKey } from "@/utils/security/crypto";
import { safeDownload } from "@/utils/security/safeDownload";
import {
  normalizeVoiceSampleToWav,
  SPEECH_SAMPLE_MAX_DURATION_SECS,
  SPEECH_SAMPLE_MAX_MB,
  validateVoiceSampleUpload,
} from "@/utils/speech/voiceSampleAddOperation";
import {
  resolveVoiceSourceCandidates,
  selectDefaultVoiceSource,
  type VoiceSourceCandidate,
} from "@/utils/speech/voiceSourceResolution";
import {
  buildVoiceMessageModalComponents,
  getExpressivenessPresets,
  VOICE_MESSAGE_DIRECTION_INPUT_ID,
  VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
  VOICE_MESSAGE_MODAL_COMPONENT_LIMIT,
  VOICE_MESSAGE_MODAL_CUSTOM_ID,
  VOICE_MESSAGE_SCRIPT_INPUT_ID,
  VOICE_MESSAGE_SOURCE_INPUT_ID,
  VOICE_MESSAGE_TRANSCRIPT_INPUT_ID,
  type ExpressivenessBackend,
} from "@/utils/speech/voiceMessageModal";
import {
  synthesizeVoiceMessage,
  type ResolvedVoiceSource,
  type VoiceBackendKey,
} from "@/utils/speech/voiceMessageSynthesis";
import { filterPersonasForTrigger, isPersonaAllowedForTrigger } from "@/utils/persona/personaAccess";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { CooldownType, type TomoriState, type UserRow } from "@/types/db/schema";
import type { WhitelistCheckResult } from "@/types/misc/channelWhitelist";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("voice-message")
    .setDescription(localizer("en-US", "commands.generate.voice-message.description"))
    .addStringOption((option) =>
      option
        .setName("persona")
        .setDescription(localizer("en-US", "commands.generate.voice-message.persona_description"))
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("voice_sample")
        .setDescription(localizer("en-US", "commands.generate.voice-message.voice_sample_description"))
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("voice_design")
        .setDescription(localizer("en-US", "commands.generate.voice-message.voice_design_description"))
        .setRequired(false)
        .setMaxLength(1000),
    );

/**
 * Autocomplete is the same persona list `/impersonate persona` uses: already filtered through
 * `filterPersonasForTrigger`, so a suggestion never reveals a persona the actor cannot use here.
 */
export const autocomplete = handlePersonaAutocomplete;

type PreModalFailure = {
  titleKey: string;
  descriptionKey: string;
  descriptionVars?: Record<string, string>;
};

type PersonaResolution = { ok: true; persona: TomoriState } | { ok: false; failure: PreModalFailure };

function resolvePersonaForInvocation(input: {
  allPersonas: readonly TomoriState[];
  availablePersonas: readonly TomoriState[];
  whitelistStatus: WhitelistCheckResult | null;
  personalSpotlightStatus: PersonalSpotlightStatus | null;
  requestedPersonaId: string | null;
}): PersonaResolution {
  const unavailable: PreModalFailure = {
    titleKey: "general.message_cooldown_title",
    descriptionKey: "commands.generate.voice-message.persona_access_blocked",
  };

  if (input.requestedPersonaId) {
    const parsedId = Number.parseInt(input.requestedPersonaId, 10);
    const selected = Number.isInteger(parsedId)
      ? input.availablePersonas.find((persona) => persona.persona_id === parsedId)
      : undefined;

    // Re-checking access after autocomplete is not redundant: autocomplete output is a
    // client-side suggestion and a user can submit any string.
    if (
      !selected?.persona_id ||
      !isPersonaAllowedForTrigger(input.whitelistStatus, input.personalSpotlightStatus, selected.persona_id)
    ) {
      return { ok: false, failure: unavailable };
    }

    return { ok: true, persona: selected };
  }

  const mainPersona = input.allPersonas.find((persona) => !persona.is_alter);
  if (!mainPersona?.persona_id) {
    return {
      ok: false,
      failure: {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
      },
    };
  }

  if (!isPersonaAllowedForTrigger(input.whitelistStatus, input.personalSpotlightStatus, mainPersona.persona_id)) {
    return { ok: false, failure: unavailable };
  }

  return { ok: true, persona: mainPersona };
}

function describeBackend(locale: string, backendKey: VoiceBackendKey): string {
  return localizer(locale, `commands.generate.voice-message.backend_${backendKey.replace(/-/g, "_")}`);
}

/** True when the persona holds an ElevenLabs voice id the fallback path could use. */
function usesElevenLabsVoice(persona: TomoriState): boolean {
  return Boolean(persona.speech_voice_id?.trim());
}

/**
 * Picks the delivery-knob radio for the resolved endpoint, or null when that endpoint has no knob.
 *
 * A control that renders where it does nothing teaches the user it is broken, so the Chatterbox
 * variant is gated on the label sniff rather than shown everywhere and disclaimed.
 */
function resolveExpressivenessBackend(input: {
  endpoint: CustomEndpointRow | null;
  usesElevenLabs: boolean;
  cloneShapeSelected: boolean;
}): ExpressivenessBackend | null {
  if (input.usesElevenLabs || input.endpoint?.api_style === "elevenlabs") return "elevenlabs";
  if (input.cloneShapeSelected && isChatterboxEndpoint(input.endpoint)) return "chatterbox";
  return null;
}

/** Display name of the persona's assigned reference sample, for the radio option text. */
async function resolvePersonaSampleName(persona: TomoriState): Promise<string | null> {
  const sampleId = persona.speech_voice_sample_id ?? null;
  if (!sampleId) return null;

  const samples = await loadVoiceSamples(persona.server_id);
  return samples.find((sample) => sample.sample_id === sampleId)?.name ?? null;
}

function resolveSourceDisplayText(input: {
  locale: string;
  candidate: VoiceSourceCandidate;
  personaSampleName: string | null;
  uploadFilename: string | null;
}): string {
  const { locale, candidate } = input;

  if (candidate.id === "upload") {
    return input.uploadFilename ?? localizer(locale, "commands.generate.voice-message.source_upload_fallback");
  }
  if (candidate.id === "persona-sample") {
    return input.personaSampleName ?? localizer(locale, "commands.generate.voice-message.source_sample_fallback");
  }
  if (candidate.shape === "design") {
    // Bare, without the radio's `Design | ` prefix: this field is titled "Voice Used", so the mode
    // prefix would be noise rather than the request-shape signal it carries in the modal.
    return candidate.designPrompt ?? "";
  }
  return localizer(locale, "commands.generate.voice-message.source_elevenlabs");
}

/** Downloads and normalizes the ad-hoc upload. The buffer is never written to `voice_samples`. */
async function loadUploadedReferenceAudio(
  attachment: Attachment,
): Promise<{ ok: true; refAudio: Buffer } | { ok: false; failure: PreModalFailure }> {
  const downloadResult = await safeDownload(attachment.url, {
    maxSizeMB: SPEECH_SAMPLE_MAX_MB,
    timeoutMs: 30_000,
    knownSize: attachment.size,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    return {
      ok: false,
      failure: {
        titleKey: "commands.generate.voice-message.upload_failed_title",
        descriptionKey: "commands.generate.voice-message.upload_failed_description",
        descriptionVars: { error: downloadResult.details ?? downloadResult.error ?? "unknown error" },
      },
    };
  }

  const rawBuffer = downloadResult.buffer;
  try {
    const metadata = await parseBuffer(rawBuffer, { mimeType: attachment.contentType ?? undefined });
    const durationSecs = metadata.format.duration ?? 0;
    if (durationSecs > SPEECH_SAMPLE_MAX_DURATION_SECS) {
      return {
        ok: false,
        failure: {
          titleKey: "commands.generate.voice-message.upload_too_long_title",
          descriptionKey: "commands.generate.voice-message.upload_too_long_description",
          descriptionVars: { max: String(SPEECH_SAMPLE_MAX_DURATION_SECS) },
        },
      };
    }
  } catch {
    // music-metadata cannot read every container; an unreadable duration is not a reason to refuse
    // a clip the endpoint may still handle.
    log.warn("[VoiceMessage] Could not parse uploaded sample duration; accepting without validation");
  }

  try {
    const refAudio = await normalizeVoiceSampleToWav(rawBuffer);
    return { ok: true, refAudio };
  } catch (error) {
    log.warn("[VoiceMessage] Uploaded sample normalization failed", error);
    return {
      ok: false,
      failure: {
        titleKey: "commands.generate.voice-message.upload_normalize_failed_title",
        descriptionKey: "commands.generate.voice-message.upload_normalize_failed_description",
      },
    };
  }
}

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.channel || !isGuildMessageCommandChannel(interaction.channel)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.voice-message.channel_only_title",
      descriptionKey: "commands.generate.voice-message.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const serverDiscId = interaction.guildId;
  const invokingMember = interaction.member as GuildMember | null;

  const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
  if (allPersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mainPersona = allPersonas.find((persona) => !persona.is_alter) ?? allPersonas[0];
  if (!mainPersona.config.voice_message_enabled) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.voice-message.disabled_title",
      descriptionKey: "commands.generate.voice-message.disabled_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cooldownResult = await cooldownRepository.checkMessageTriggerCooldownWithWhitelist(
    serverDiscId,
    interaction.user.id,
    channel.id,
    mainPersona.config.cooldown_type ?? CooldownType.OFF,
    invokingMember,
  );

  if (cooldownResult.isOnCooldown) {
    if (cooldownResult.blockedByWhitelist) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.message_cooldown_title",
        descriptionKey: "commands.generate.voice-message.channel_not_whitelisted",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await sendCooldownDM(
      interaction.user,
      locale,
      "general.message_cooldown_title",
      "commands.generate.voice-message.cooldown_active",
      {
        seconds: cooldownResult.remainingSeconds.toString(),
        botName: mainPersona.persona_nickname,
      },
      cooldownRepository.getCooldownTypeFooterKey(cooldownResult.cooldownType),
      interaction,
      MessageFlags.Ephemeral,
    );
    return;
  }

  const isThread = channel.isThread();
  const parentChannelId = isThread ? channel.parent?.id : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    serverDiscId,
    channel.id,
    invokingMember?.roles.cache.map((role) => role.id),
    parentChannelId,
  );
  const personalSpotlightStatus = userData.user_id
    ? await getCachedPersonalSpotlightStatus(mainPersona.server_id, userData.user_id, parentChannelId ?? channel.id)
    : null;
  const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus).filter(
    (persona) => typeof persona.persona_id === "number",
  );

  const personaResolution = resolvePersonaForInvocation({
    allPersonas,
    availablePersonas,
    whitelistStatus,
    personalSpotlightStatus,
    requestedPersonaId: interaction.options.getString("persona"),
  });
  if (!personaResolution.ok) {
    await replyInfoEmbed(interaction, locale, {
      ...personaResolution.failure,
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const persona = personaResolution.persona;

  const speechEndpoint = await resolveActiveSpeechEndpoint(mainPersona.server_id);
  const endpointIsElevenLabs = speechEndpoint?.endpoint.api_style === "elevenlabs";

  // Mirror the tool's credential precedence: an endpoint-scoped key wins over the legacy
  // opt_api_keys entry, which only survives for deployments that predate the endpoint pathway. A
  // server whose ElevenLabs key lives on its endpoint has no opt_api_keys row at all.
  //
  // The key is fetched whenever the endpoint is ElevenLabs or absent, regardless of which source
  // ends up selected: on an ElevenLabs endpoint a persona with a sample and a voice id resolves to
  // the voice id only after the sample is discarded, so the endpoint can need this key for a
  // persona whose sample looked like the obvious choice.
  const needsElevenLabsKey = usesElevenLabsVoice(persona) && (endpointIsElevenLabs || !speechEndpoint);
  const elevenLabsApiKey = needsElevenLabsKey
    ? speechEndpoint?.apiKey || ((await getOptApiKey(mainPersona.server_id, ELEVENLABS_SERVICE_NAME)) ?? "")
    : "";

  const usesElevenLabs = !speechEndpoint && Boolean(elevenLabsApiKey) && usesElevenLabsVoice(persona);
  if (!speechEndpoint && !usesElevenLabs) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.voice-message.no_endpoint_title",
      descriptionKey: "commands.generate.voice-message.no_endpoint_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const uploadAttachment = interaction.options.getAttachment("voice_sample");
  if (uploadAttachment) {
    // Metadata-only validation: MIME and byte size, no network, so the 3-second pre-modal
    // window is never at risk from a large attachment.
    const validation = validateVoiceSampleUpload({
      url: uploadAttachment.url,
      filename: uploadAttachment.name,
      contentType: uploadAttachment.contentType,
      size: uploadAttachment.size,
    });
    if (validation !== "ok") {
      await replyInfoEmbed(interaction, locale, {
        titleKey: `commands.generate.voice-message.upload_${validation === "too-large" ? "too_large" : "invalid_format"}_title`,
        descriptionKey: `commands.generate.voice-message.upload_${validation === "too-large" ? "too_large" : "invalid_format"}_description`,
        descriptionVars: { max: String(SPEECH_SAMPLE_MAX_MB) },
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // ElevenLabs accepts neither request shape, so an endpoint that is missing entirely means the
  // persona's stored ElevenLabs voice id is the only candidate.
  const effectiveEndpoint = speechEndpoint?.endpoint ?? null;
  const typedDesignPrompt = interaction.options.getString("voice_design");
  const personaSampleName = await resolvePersonaSampleName(persona);
  const candidateInput = {
    endpoint: effectiveEndpoint,
    persona,
    personaSampleName,
    uploadFilename: uploadAttachment?.name ?? null,
    typedDesignPrompt,
  };
  const candidates = resolveVoiceSourceCandidates(candidateInput);
  if (candidates.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.voice-message.no_voice_source_title",
      descriptionKey: "commands.generate.voice-message.no_voice_source_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const defaultSource = selectDefaultVoiceSource(candidates);

  // Keyed off the resolved candidate, not off the endpoint: a persona whose only voice is an
  // ElevenLabs id on a server with no speech endpoint is indistinguishable from a `tts-clone`
  // server by endpoint alone, and its voice id is precisely what the source table falls back to.
  if (defaultSource?.id === "elevenlabs" && !elevenLabsApiKey) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.generate.voice-message.no_api_key_title",
      descriptionKey: "commands.generate.voice-message.no_api_key_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const anyDesignShape = candidates.some((candidate) => candidate.shape === "design");
  const expressiveness = resolveExpressivenessBackend({
    endpoint: effectiveEndpoint,
    usesElevenLabs,
    cloneShapeSelected: defaultSource?.shape === "clone",
  });

  let modalComponents: ModalComponent[];
  try {
    modalComponents = buildVoiceMessageModalComponents({
      locale,
      candidates,
      scriptMarkup: effectiveEndpoint?.extra_config.script_markup as string | undefined,
      // A design-shaped source, not merely a design-capable endpoint: on an `auto` endpoint whose
      // only candidates are clone-shaped, a Delivery Direction field would render and then be
      // dropped by the dispatcher.
      designShapeAvailable: anyDesignShape,
      uploadShapeSelected: defaultSource?.id === "upload",
      expressiveness,
      chatterboxDefaults: {
        cfgWeight: mainPersona.config.chatterbox_cfg_weight ?? 0.5,
        exaggeration: mainPersona.config.chatterbox_exaggeration ?? 0.5,
      },
    });
  } catch (error) {
    // The builder's component-cap assertion is a programming guard, but it runs before anything
    // has been acknowledged, so an escaped throw would surface as "The application did not
    // respond" rather than anything a user or a log reader could act on.
    log.error("[/generate voice-message] Failed to build the modal components", error as Error);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  log.info(
    `[/generate voice-message] Showing modal | server=${serverDiscId} persona=${persona.persona_id} sources=${candidates.map((candidate) => candidate.id).join(",")} components=${modalComponents.length}/${VOICE_MESSAGE_MODAL_COMPONENT_LIMIT}`,
  );

  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: VOICE_MESSAGE_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.generate.voice-message.modal.title",
      components: modalComponents,
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit" || !modalResult.interaction) return;
  const modalInteraction = modalResult.interaction;

  const script = modalResult.values?.[VOICE_MESSAGE_SCRIPT_INPUT_ID]?.trim() ?? "";
  if (!script) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.empty_script_title",
      descriptionKey: "commands.generate.voice-message.empty_script_description",
      color: ColorCode.WARN,
    });
    return;
  }

  const selectedSourceId = modalResult.values?.[VOICE_MESSAGE_SOURCE_INPUT_ID] ?? defaultSource?.id;
  const selectedSource = candidates.find((candidate) => candidate.id === selectedSourceId) ?? defaultSource;
  if (!selectedSource) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.no_voice_source_title",
      descriptionKey: "commands.generate.voice-message.no_voice_source_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const voiceInstructions = modalResult.values?.[VOICE_MESSAGE_DIRECTION_INPUT_ID]?.trim() ?? "";
  const referenceTranscript = modalResult.values?.[VOICE_MESSAGE_TRANSCRIPT_INPUT_ID]?.trim() || null;
  const expressivenessValue = modalResult.values?.[VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID];
  const preset = expressiveness
    ? (getExpressivenessPresets(expressiveness).find((entry) => entry.value === expressivenessValue) ?? null)
    : null;

  const uploadAttachmentFromModal = selectedSource.id === "upload" ? uploadAttachment : null;

  let voiceSource: ResolvedVoiceSource;
  if (selectedSource.id === "upload" && uploadAttachmentFromModal) {
    const loaded = await loadUploadedReferenceAudio(uploadAttachmentFromModal);
    if (!loaded.ok) {
      await replyInfoEmbed(modalInteraction, locale, { ...loaded.failure, color: ColorCode.ERROR });
      return;
    }
    voiceSource = { kind: "clone-buffer", refAudio: loaded.refAudio, refText: referenceTranscript };
  } else if (selectedSource.shape === "design") {
    voiceSource = { kind: "design", designPrompt: selectedSource.designPrompt ?? "" };
  } else if (selectedSource.id === "persona-sample" && selectedSource.sampleId) {
    voiceSource = { kind: "clone", voiceSampleId: selectedSource.sampleId };
  } else if (selectedSource.id === "elevenlabs" && persona.speech_voice_id?.trim()) {
    voiceSource = { kind: "elevenlabs", voiceId: persona.speech_voice_id.trim() };
  } else {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.no_voice_source_title",
      descriptionKey: "commands.generate.voice-message.no_voice_source_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  // Persona identity is the point of this command, so a webhook failure is an error rather than a
  // silent fall back to posting as the bot.
  const webhookTargetChannel = resolveGuildWebhookTargetChannel(channel);
  const webhookThreadId = resolveGuildWebhookThreadId(channel);
  if (!webhookTargetChannel) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.webhook_error_title",
      descriptionKey: "commands.generate.voice-message.webhook_error_description",
      descriptionVars: { error: "channel cannot host a webhook" },
      color: ColorCode.ERROR,
    });
    return;
  }

  const { webhook, errorReason } = await getOrCreateWebhook(webhookTargetChannel);
  if (!webhook) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.webhook_error_title",
      descriptionKey: "commands.generate.voice-message.webhook_error_description",
      descriptionVars: { error: errorReason || "Failed to create webhook" },
      color: ColorCode.ERROR,
    });
    return;
  }

  const target: VoiceDeliveryTarget = {
    channel: webhookTargetChannel,
    webhook,
    threadId: webhookThreadId,
    personaUsername: persona.persona_nickname,
    personaAvatarUrl: (await resolvePersonaWebhookIdentity(persona, interaction.guild)).avatarUrl ?? null,
  };

  log.info(
    `[/generate voice-message] Synthesizing | server=${serverDiscId} persona=${persona.persona_id} source=${selectedSource.id} backend=${selectedSource.shape}`,
  );

  const startedAt = performance.now();
  const synthesisResult = await synthesizeVoiceMessage({
    endpoint: effectiveEndpoint,
    endpointApiKey: speechEndpoint?.apiKey ?? "",
    elevenLabsApiKey,
    source: voiceSource,
    script,
    voiceInstructions,
    chatterbox: {
      turboEnabled: mainPersona.config.chatterbox_turbo_enabled ?? true,
      cfgWeight: preset?.chatterbox?.cfgWeight ?? mainPersona.config.chatterbox_cfg_weight ?? 0.5,
      exaggeration: preset?.chatterbox?.exaggeration ?? mainPersona.config.chatterbox_exaggeration ?? 0.5,
    },
    ...(preset?.stability !== undefined ? { elevenLabsVoiceSettings: { stability: preset.stability } } : {}),
  });

  if (!synthesisResult.success || !synthesisResult.audioBuffer) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.synthesis_failed_title",
      descriptionKey: "commands.generate.voice-message.synthesis_failed_description",
      descriptionVars: { error: synthesisResult.details ?? "unknown error" },
      color: ColorCode.ERROR,
    });
    return;
  }

  const audioBuffer = synthesisResult.audioBuffer;
  const isElevenLabs = synthesisResult.backendKey === "elevenlabs";
  const mimeType = (synthesisResult.contentType ?? (isElevenLabs ? "audio/mpeg" : "audio/wav")).split(";")[0].trim();
  const filename = `voice-message.${synthesisResult.extension ?? (isElevenLabs ? "mp3" : "wav")}`;
  const voiceMeta = await generateVoiceMessageMetadata(audioBuffer, mimeType);
  if (!voiceMeta) {
    log.warn("[VoiceMessage] Waveform generation returned null: delivering a plain attachment");
  }

  const sentMessageId = await deliverVoiceMessage({
    target,
    audioBuffer,
    mimeType,
    filename,
    voiceMeta,
  });

  if (!sentMessageId) {
    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.generate.voice-message.delivery_failed_title",
      descriptionKey: "commands.generate.voice-message.delivery_failed_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const captionText = synthesisResult.cleanedCaptionText ?? "";
  if (captionText) {
    // Cached so replaying the clip into context still reads as speech instead of an attachment.
    setCachedVoiceTranscript(sentMessageId, captionText, "tts");
    if (mainPersona.config.voice_transcript_chat_mode) {
      await postVoiceTranscriptCaption(target, captionText);
    }
  }

  // Same three backend keys as the tool: manual invocations are already distinguishable through
  // command_used, and forking the key space would break the cost breakdown in statMetrics.ts.
  if (userData.user_id) {
    statRepository.recordStat({
      serverId: mainPersona.server_id,
      userId: userData.user_id,
      lineageId: persona.persona_lineage_id ?? 0,
      metric: "audio_generated",
      metricKey: synthesisResult.backendKey,
    });
  }

  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const sourceDisplayText = resolveSourceDisplayText({
    locale,
    candidate: selectedSource,
    personaSampleName,
    uploadFilename: uploadAttachment?.name ?? null,
  });
  const successEmbed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.generate.voice-message.success_title"))
    .setDescription(
      localizer(locale, "commands.generate.voice-message.success_description", {
        persona: persona.persona_nickname,
        backend: describeBackend(locale, synthesisResult.backendKey),
        elapsed: elapsedSeconds,
      }),
    )
    .addFields({
      name: localizer(locale, "commands.generate.voice-message.success_source_field"),
      value: safeSelectOptionText(sourceDisplayText, 1024),
    })
    .setColor(ColorCode.SUCCESS);

  await modalInteraction.editReply({ embeds: [successEmbed] });

  log.success(
    `[/generate voice-message] Delivered | server=${serverDiscId} persona=${persona.persona_id} backend=${synthesisResult.backendKey} source=${selectedSource.id} elapsed=${elapsedSeconds}s`,
  );
}
