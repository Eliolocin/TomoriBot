import { ChannelType, type Client, type GuildMember, type Message, type TextChannel } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";
import type { StructuredContextItem } from "@/types/misc/context";
import type { EnhancedImageContent } from "@/types/tool/enhancedContextTypes";
import type { TomoriState } from "@/types/db/schema";
import { ContextItemTag } from "@/types/misc/context";
import { tomoriChat, suppressNextSelfReply } from "@/events/messageCreate/tomoriChat";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { userRepository } from "@/utils/db/repositories";
import { buildForcedMentionsForUser, ensureDiscordUserMention } from "@/utils/discord/mentionHelper";
import { getOrCreateWebhook } from "@/utils/discord/webhook/lifecycle";
import { resolvePersonaWebhookIdentity } from "@/utils/discord/webhook/identity";
import { sendWebhookMessageWithIdentity } from "@/utils/discord/webhook/personaDispatch";
import { resolvePreferredDiscordDisplayName } from "@/utils/discord/displayName";
import { downloadImage } from "@/utils/image/avatarHelper";
import { log } from "@/utils/misc/logger";
import { decryptApiKey } from "@/utils/security/crypto";
import { fetchUserRemoteUrl } from "@/utils/security/userRemoteFetch";
import {
  toZaiApiModelName,
  ZAI_CODING_CHAT_COMPLETIONS_URL,
  ZAI_GENERAL_CHAT_COMPLETIONS_URL,
} from "@/providers/zai/zaiShared";
import { resolveWelcomeDelayMs, waitForWelcomeDelay } from "@/events/guildMemberAdd/helpers/welcomeDelay";
import { fetchCurrentWelcomeMember } from "@/events/guildMemberAdd/helpers/welcomeMembership";

/**
 * Provider-to-chat-completions-URL mapping for vision model routing.
 * Google uses its own SDK and is handled separately.
 */
const VISION_PROVIDER_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  zai: ZAI_GENERAL_CHAT_COMPLETIONS_URL,
  zaicoding: ZAI_CODING_CHAT_COMPLETIONS_URL,
  deepseek: "https://api.deepseek.com/chat/completions",
};

/** Prompt sent to the vision model when analyzing a new member's avatar for the welcome message */
const WELCOME_AVATAR_VISION_PROMPT =
  "Describe this user's profile picture in detail for a welcome greeting context. Include their appearance, style, and any notable elements visible in the avatar.";

/**
 * Call the Google GenAI vision API with a single base64-encoded avatar image.
 * @param model - Model codename (e.g., "gemini-2.0-flash")
 * @param base64Image - Base64-encoded PNG image data
 */
async function callGoogleVisionForAvatar(
  apiKey: string,
  model: string,
  base64Image: string,
  prompt: string,
): Promise<string> {
  const genAI = new GoogleGenAI({ apiKey });
  const parts: Part[] = [{ text: prompt }, { inlineData: { data: base64Image, mimeType: "image/png" } }];
  const result = await genAI.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
  });
  const text = result.text;
  if (!text) throw new Error("Google Vision API returned an empty response.");
  return text;
}

/**
 * Call an OpenAI-compatible vision API with a single base64-encoded avatar image.
 * @param endpointUrl - Chat completions endpoint URL
 * @param base64Image - Base64-encoded PNG image data
 */
async function callOpenAICompatibleVisionForAvatar(
  apiKey: string,
  model: string,
  endpointUrl: string,
  base64Image: string,
  prompt: string,
): Promise<string> {
  const requestBody = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64Image}` },
          },
        ],
      },
    ],
    max_tokens: 1024,
  };
  const response = await fetchUserRemoteUrl(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Vision API returned ${response.status}: ${errorText}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision API returned an empty response.");
  return content;
}

/**
 * Delegates avatar analysis to the persona's configured vision model.
 * Called when the greeting persona's primary LLM cannot see images but a vision_llm is set.
 * Downloads the avatar, calls the vision model API, and returns a plain-text description.
 * @param member - The guild member whose avatar will be analyzed
 * @returns Text description from the vision model, or null if analysis fails
 */
async function getAvatarVisionDescription(member: GuildMember, persona: TomoriState): Promise<string | null> {
  const visionLlm = persona.vision_llm;
  if (!visionLlm || !persona.config.api_key) return null;

  const avatarUrl = member.displayAvatarURL({
    extension: "png",
    forceStatic: true,
    size: 1024,
  });
  const avatarBuffer = await downloadImage(avatarUrl);
  const base64Image = avatarBuffer.toString("base64");

  const keyVersion = persona.config.key_version || 1;
  const apiKey = await decryptApiKey(persona.config.api_key, keyVersion);
  if (!apiKey) return null;

  const provider = visionLlm.llm_provider.toLowerCase();
  const apiModelName =
    provider === "zai" || provider === "zaicoding" ? toZaiApiModelName(visionLlm.llm_codename) : visionLlm.llm_codename;

  log.info(`newUser: Delegating avatar analysis to vision model ${provider}/${apiModelName} for member ${member.id}`);

  if (provider === "google") {
    return await callGoogleVisionForAvatar(apiKey, apiModelName, base64Image, WELCOME_AVATAR_VISION_PROMPT);
  }

  const knownUrl = VISION_PROVIDER_URLS[provider];
  const customUrl = persona.config.custom_endpoint_url;
  const endpointUrl =
    knownUrl ??
    (customUrl
      ? customUrl.endsWith("/chat/completions")
        ? customUrl
        : `${customUrl}/chat/completions`
      : "https://api.openai.com/v1/chat/completions");

  return await callOpenAICompatibleVisionForAvatar(
    apiKey,
    apiModelName,
    endpointUrl,
    base64Image,
    WELCOME_AVATAR_VISION_PROMPT,
  );
}

async function buildWelcomeContextItem(params: {
  member: GuildMember;
  additionalPrompt: string;
  includeAvatarContext: boolean;
  /** Text description from vision model, so used when the primary model cannot see images */
  avatarDescription?: string;
}): Promise<StructuredContextItem> {
  const { member, additionalPrompt, includeAvatarContext, avatarDescription } = params;
  const displayName = resolvePreferredDiscordDisplayName({
    memberDisplayName: member.displayName,
    user: member.user,
  });
  const sentences = [
    `${displayName} just joined the server ${member.guild.name}, greet them by mentioning them with @{${displayName}}!`,
  ];
  const parts: StructuredContextItem["parts"] = [];

  if (includeAvatarContext) {
    const avatarUrl = member.displayAvatarURL({
      extension: "png",
      forceStatic: true,
      size: 1024,
    });

    try {
      const avatarBuffer = await downloadImage(avatarUrl);
      const base64Avatar = avatarBuffer.toString("base64");
      sentences.push("What their avatar looks like has been attached as an image for your information.");
      parts.push({
        type: "image",
        uri: `data:image/png;base64,${base64Avatar}`,
        mimeType: "image/png",
        inlineData: {
          mimeType: "image/png",
          data: base64Avatar,
        },
      } as EnhancedImageContent);
    } catch (error) {
      log.warn(`Failed to load avatar context for welcome message (${member.id}):`, error);
    }
  } else if (avatarDescription) {
    sentences.push(`Their profile picture has been analyzed by a vision model: ${avatarDescription}`);
  }

  sentences.push(additionalPrompt);
  parts.unshift({
    type: "text",
    text: `[System: ${sentences.join(" ")}]`,
  });

  return {
    role: "user",
    metadataTag: ContextItemTag.DIALOGUE_HISTORY,
    parts,
  };
}

async function triggerWelcomeMessage(client: Client, member: GuildMember): Promise<void> {
  const initialTomoriState = await getCachedTomoriState(member.guild.id);
  if (!initialTomoriState) return;

  const welcomeChannelId = initialTomoriState.config.welcome_channel_disc_id;
  const additionalPrompt = initialTomoriState.config.welcome_prompt?.trim();
  if (!welcomeChannelId || !additionalPrompt) return;

  const welcomeDelayMs = resolveWelcomeDelayMs();
  if (welcomeDelayMs > 0) {
    log.info(`Waiting ${welcomeDelayMs}ms before welcoming ${member.user.tag}`);
    await waitForWelcomeDelay(welcomeDelayMs);

    if (!(await fetchCurrentWelcomeMember(member))) {
      log.info(`Skipping welcome for ${member.user.tag}: original membership ended during the onboarding grace period`);
      return;
    }
  }

  const tomoriState = welcomeDelayMs > 0 ? await getCachedTomoriState(member.guild.id) : initialTomoriState;
  if (!tomoriState) return;

  const currentWelcomeChannelId = tomoriState.config.welcome_channel_disc_id;
  const currentAdditionalPrompt = tomoriState.config.welcome_prompt?.trim();
  if (!currentWelcomeChannelId || !currentAdditionalPrompt) return;

  const rawChannel = await member.guild.channels.fetch(currentWelcomeChannelId).catch(() => null);
  if (!rawChannel || rawChannel.type !== ChannelType.GuildText) {
    log.warn(
      `Skipping welcome for ${member.user.tag}: configured welcome channel ${currentWelcomeChannelId} is unavailable`,
    );
    return;
  }

  const welcomeChannel = rawChannel as TextChannel;
  const allPersonas = await getCachedAllPersonas(member.guild.id);
  const availablePersonas = allPersonas.length > 0 ? allPersonas : [tomoriState];
  const selectedWelcomePersonaId = tomoriState.config.welcome_persona_id;
  const chosenPersona =
    selectedWelcomePersonaId === null
      ? availablePersonas[Math.floor(Math.random() * availablePersonas.length)]
      : (availablePersonas.find((persona) => persona.persona_id === selectedWelcomePersonaId) ??
        availablePersonas.find((persona) => !persona.is_alter) ??
        availablePersonas[0]);

  if (!chosenPersona?.persona_id) {
    log.warn(`Skipping welcome for ${member.user.tag}: no persona could be resolved`);
    return;
  }

  let lastMessage: Message | undefined;
  try {
    const messages = await welcomeChannel.messages.fetch({ limit: 1 });
    lastMessage = messages.first();
  } catch (error) {
    log.warn(`Failed to fetch welcome anchor message from channel ${welcomeChannel.id}:`, error);
  }

  if (!lastMessage) {
    try {
      lastMessage = await welcomeChannel.send({ content: "\u2800" });
      log.info(`Seeded placeholder message in welcome channel ${welcomeChannel.id}`);
    } catch (error) {
      log.warn(`Failed to seed placeholder message in welcome channel ${welcomeChannel.id}:`, error);
    }
  }

  if (!lastMessage) return;

  const includeAvatarContext = chosenPersona.llm.sees_images;
  let avatarDescription: string | undefined;

  if (!includeAvatarContext && chosenPersona.vision_llm) {
    try {
      avatarDescription = (await getAvatarVisionDescription(member, chosenPersona)) ?? undefined;
      log.success(`Obtained vision description for welcome avatar of member ${member.id}`);
    } catch (error) {
      log.warn(`Failed to get vision description for welcome (${member.id}):`, error);
    }
  }

  const welcomeContextItem = await buildWelcomeContextItem({
    member,
    additionalPrompt: currentAdditionalPrompt,
    includeAvatarContext,
    avatarDescription,
  });
  const forcedMentions = await buildForcedMentionsForUser(member.id, client, member.guild);

  if (!(await fetchCurrentWelcomeMember(member))) {
    log.info(`Skipping welcome for ${member.user.tag}: original membership ended before welcome generation`);
    return;
  }

  const welcomeStartTime = Date.now();

  suppressNextSelfReply(welcomeChannel.id);
  log.info(
    `Triggering welcome message for ${member.user.tag} in channel ${welcomeChannel.id} using persona ${chosenPersona.persona_nickname}`,
  );

  await tomoriChat({
    client,
    message: lastMessage,
    isFromQueue: false,
    isManuallyTriggered: true,
    forceReason: false,
    isStopResponse: false,
    selectedPersonaId: chosenPersona.persona_id,
    isPersonaJob: false,
    isUserImpersonation: false,
    textQuotaSource: "system",
    textQuotaTriggerKey: `welcome:${member.guild.id}:${member.id}:${lastMessage.id}`,
    injectedContextItems: [welcomeContextItem],
    forcedMentions: forcedMentions.length > 0 ? forcedMentions : undefined,
  });

  await ensureDiscordUserMention({
    client,
    channel: welcomeChannel,
    targetUserId: member.id,
    afterMessageId: lastMessage.id,
    triggerStartTime: welcomeStartTime,
    contextLabel: `welcome for member ${member.id} in server ${member.guild.id}`,
    fallbackSender: async (content) => {
      if (!chosenPersona.is_alter) return false;

      const supportsWebhooks =
        welcomeChannel.type === ChannelType.GuildText ||
        welcomeChannel.type === ChannelType.PublicThread ||
        welcomeChannel.type === ChannelType.PrivateThread ||
        welcomeChannel.type === ChannelType.AnnouncementThread;
      if (!supportsWebhooks) return false;

      try {
        const webhookResult = await getOrCreateWebhook(welcomeChannel);
        const webhook = webhookResult.webhook;
        if (!webhook) return false;

        const identity = await resolvePersonaWebhookIdentity(chosenPersona, member.guild);
        await sendWebhookMessageWithIdentity(
          webhook,
          {
            content,
            allowedMentions: { users: [member.id], roles: [], parse: [] },
          },
          identity,
        );
        return true;
      } catch (error) {
        log.warn(`Failed to send Alter persona fallback welcome mention for member ${member.id}:`, error);
        return false;
      }
    },
  });
}

/**
 * Handles registration of new users when they join a guild.
 * Creates user record if new, and logs the action.
 * @param member - The guild member who joined
 */
const handler = async (_client: Client, member: GuildMember): Promise<void> => {
  try {
    const userLanguage = member.guild.preferredLocale;
    log.info(`New user ${member.user.tag} joined server, registering with language: ${userLanguage}`);

    const userData = await userRepository.register(
      member.id,
      resolvePreferredDiscordDisplayName({
        memberDisplayName: member.displayName,
        user: member.user,
      }),
      userLanguage,
    );

    if (userData) {
      log.success(`User ${member.user.tag} registered successfully`);
    } else {
      log.error(`Failed to register user ${member.user.tag}`);
    }
  } catch (error) {
    log.error(`Error registering joined member ${member.user.tag}:`, error);
  }

  if (member.user.bot) return;

  try {
    await triggerWelcomeMessage(_client, member);
  } catch (error) {
    log.error(`Error sending welcome message for ${member.user.tag}:`, error);
  }
};

export default handler;