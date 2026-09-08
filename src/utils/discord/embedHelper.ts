import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ButtonInteraction,
  type TextChannel,
  type NewsChannel,
  type DMChannel,
  type Message,
  type APIEmbedField,
  type BaseGuildTextChannel,
  type BaseGuildVoiceChannel,
  type AnyThreadChannel,
  type Webhook,
} from "discord.js";
import { ColorCode, log } from "../misc/logger";
import { localizer } from "../text/localizer";
import { sendWebhookMessageWithIdentity } from "./webhookManager";
import { attachTextDisplayModalCollector, buildTextDisplayModalButton } from "./textDisplayModal";
import type { StandardEmbedOptions, SummaryEmbedOptions, TranslationEmbedOptions } from "../../types/discord/embed";
import { TRANSLATOR_COLORS, TranslationProvider } from "../../types/discord/embed";

type Provider = keyof typeof TRANSLATOR_COLORS;

/**
 * Discord's maximum field value length for embeds
 */
const MAX_FIELD_VALUE_LENGTH = 1024;

/**
 * Discord's maximum embed description length.
 */
export const MAX_EMBED_DESCRIPTION_LENGTH = 4096;

/**
 * Tip-item locale key for the Official Support Server link, appended to every rendered tip modal.
 */
export const SUPPORT_SERVER_TIP_KEY = "genai.tips.support_server";
export const TIP_DETAILS_BUTTON_ID = "error_tip_details";
const DEFAULT_TIP_BUTTON_TIMEOUT_MS = 86_400_000;
export const TIP_BUTTON_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.TIP_BUTTON_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIP_BUTTON_TIMEOUT_MS;
})();

/**
 * Truncates text so it fits within Discord's embed description limit, optionally reserving
 * space for other content that shares the same description (e.g. a headline above the detail).
 * @returns The value, truncated with a trailing ellipsis when it would otherwise overflow.
 */
export function truncateForEmbedDescription(value: string, reservedChars = 0): string {
  const available = Math.max(0, MAX_EMBED_DESCRIPTION_LENGTH - reservedChars);
  if (value.length <= available) {
    return value;
  }
  // Reserve 3 characters for the ellipsis; if there is not even room for that, hard-cut.
  return available <= 3 ? value.substring(0, available) : `${value.substring(0, available - 3)}...`;
}

export type WebhookEmbedContext = {
  webhook?: Webhook;
  personaUsername?: string;
  personaAvatarUrl?: string;
};

function canUseWebhookForChannel(
  channel: TextChannel | NewsChannel | DMChannel | BaseGuildTextChannel | AnyThreadChannel | BaseGuildVoiceChannel,
  webhook: Webhook,
): boolean {
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    return channel.parentId === webhook.channelId;
  }

  return webhook.channelId === channel.id;
}

/**
 * Truncates a field value to Discord's maximum allowed length.
 * Adds ellipsis if truncation occurs.
 * @returns Truncated value that fits within Discord's limits
 */
function truncateFieldValue(value: string): string {
  if (value.length <= MAX_FIELD_VALUE_LENGTH) {
    return value;
  }
  // Reserve 3 characters for ellipsis
  return `${value.substring(0, MAX_FIELD_VALUE_LENGTH - 3)}...`;
}

/**
 * Creates a standard info embed for non-interaction contexts.
 * This is a low-level utility - prefer using sendStandardEmbed for consistency.
 * @param locale - The locale to use for strings
 */
export function createStandardEmbed(locale: string, options: StandardEmbedOptions): EmbedBuilder {
  const {
    titleKey,
    titleVars = {},
    descriptionKey,
    description,
    descriptionVars = {},
    color = ColorCode.INFO,
    footerKey,
    footerVars = {},
    thumbnailUrl,
  } = options;

  // Use raw description if provided, otherwise use descriptionKey with localization
  const descriptionText = description
    ? description
    : descriptionKey
      ? localizer(locale, descriptionKey, descriptionVars)
      : null;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(localizer(locale, titleKey, titleVars))
    .setDescription(descriptionText);

  if (footerKey) {
    embed.setFooter({
      text: localizer(locale, footerKey, footerVars),
    });
  }

  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }

  return embed;
}

/** Builds the localized markdown shown by a "What You Can Do" text modal. */
export function createTipText(
  locale: string,
  tipKeys: string[],
  tipVars: Record<string, string | number | boolean> = {},
): string | null {
  // Localize every tip item and drop any that resolve to empty text (e.g. an unset optional key).
  const items = tipKeys
    .filter((key) => key !== SUPPORT_SERVER_TIP_KEY)
    .map((key) => localizer(locale, key, tipVars).trim())
    .filter((text) => text.length > 0);
  if (items.length === 0) {
    return null;
  }

  // The support link gives every recovery modal an escape hatch without burdening each caller.
  const supportItem = localizer(locale, SUPPORT_SERVER_TIP_KEY, tipVars).trim();
  if (supportItem.length > 0) {
    items.push(supportItem);
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function createSummaryEmbed(locale: string, options: SummaryEmbedOptions): EmbedBuilder {
  const {
    titleKey,
    titleVars = {},
    descriptionKey,
    description,
    descriptionVars = {},
    color = ColorCode.INFO,
    footerKey,
    footerVars = {},
    thumbnailUrl,
    timestamp,
    fields,
  } = options;

  // Use raw description if provided, otherwise use descriptionKey with localization
  const descriptionText = description
    ? description
    : descriptionKey
      ? localizer(locale, descriptionKey, descriptionVars)
      : null;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(localizer(locale, titleKey, titleVars))
    .setDescription(descriptionText)
    .addFields(
      // Map over the fields provided in options
      fields.map(
        // Define the transformation for each field
        (field): APIEmbedField => {
          // Determine the field name: Use localized nameKey if present, otherwise use direct name, fallback to empty string
          const name = field.nameKey
            ? localizer(locale, field.nameKey, field.nameVars) // Use nameVars for name
            : (field.name ?? "");

          // Determine the field value: Use localized valueKey if present, otherwise use direct value
          const rawValue = field.valueKey
            ? localizer(locale, field.valueKey, field.valueVars) // Localize valueKey using valueVars
            : (field.value ?? ""); // Otherwise, use the value directly

          // Truncate value to Discord's maximum field value length (1024 chars)
          const value = truncateFieldValue(rawValue);

          return {
            name,
            value,
            inline: field.inline ?? false,
          };
        },
      ),
    );

  if (footerKey) {
    embed.setFooter({
      text: localizer(locale, footerKey, footerVars),
    });
  }

  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }

  if (timestamp) {
    embed.setTimestamp();
  }

  return embed;
}

/**
 * Shows a standard embed in a text channel. This follows the pattern of interactionHelpers
 * by handling the sending of the embed directly.
 * @param locale - The locale to use for strings
 */
export async function sendStandardEmbed(
  channel: TextChannel | NewsChannel | DMChannel | BaseGuildTextChannel | AnyThreadChannel | BaseGuildVoiceChannel,
  locale: string,
  options: StandardEmbedOptions,
  webhookContext?: WebhookEmbedContext,
): Promise<void> {
  const embed = createStandardEmbed(locale, options);
  const tipText = options.tipKeys?.length ? createTipText(locale, options.tipKeys, options.tipVars) : null;
  const activeTipRow = tipText
    ? buildTextDisplayModalButton(TIP_DETAILS_BUTTON_ID, localizer(locale, "genai.tips.button"))
    : undefined;
  const disabledTipRow = tipText
    ? buildTextDisplayModalButton(TIP_DETAILS_BUTTON_ID, localizer(locale, "genai.tips.button"), true)
    : undefined;
  const components = activeTipRow ? [activeTipRow] : [];
  let sentMessage: Message;
  let sentViaWebhook = false;
  let threadId: string | undefined;

  if (
    webhookContext?.webhook &&
    webhookContext.personaUsername &&
    canUseWebhookForChannel(channel, webhookContext.webhook)
  ) {
    threadId =
      "isThread" in channel && typeof channel.isThread === "function" && channel.isThread() ? channel.id : undefined;
    try {
      sentMessage = await sendWebhookMessageWithIdentity(
        webhookContext.webhook,
        {
          embeds: [embed],
          components,
          ...(threadId ? { threadId } : {}),
        },
        {
          username: webhookContext.personaUsername,
          avatarUrl: webhookContext.personaAvatarUrl,
          avatarDataUri: webhookContext.personaAvatarUrl?.startsWith("data:image/")
            ? webhookContext.personaAvatarUrl
            : undefined,
        },
      );
      sentViaWebhook = true;
    } catch (error) {
      log.warn("Failed to send embed via webhook, falling back to bot message", error as Error);
      sentMessage = await channel.send({ embeds: [embed], components });
    }
  } else {
    sentMessage = await channel.send({ embeds: [embed], components });
  }

  if (!tipText || !disabledTipRow) return;

  attachTextDisplayModalCollector({
    message: sentMessage,
    customId: TIP_DETAILS_BUTTON_ID,
    title: localizer(locale, "genai.tips.title"),
    content: tipText,
    timeoutMs: TIP_BUTTON_TIMEOUT_MS,
    logLabel: "Error tips",
    onExpire: async () => {
      if (sentViaWebhook && webhookContext?.webhook) {
        await webhookContext.webhook.editMessage(sentMessage.id, {
          embeds: [embed],
          components: [disabledTipRow],
          ...(threadId ? { threadId } : {}),
        });
        return;
      }
      await sentMessage.edit({ embeds: [embed], components: [disabledTipRow] });
    },
  });
}

const TRANSLATION_TIMEOUT = 90000;
/**
 * Creates an embed with translation buttons that cycle between different translations.
 * Returns a promise that resolves when the buttons are disabled (timeout or all providers shown).
 */
export async function sendTranslationEmbed(message: Message, options: TranslationEmbedOptions): Promise<void> {
  const { translations, initialProvider = TranslationProvider.GOOGLE, timeout = TRANSLATION_TIMEOUT } = options;

  const createButtons = (activeProvider: Provider) => {
    const buttons = Object.values(TranslationProvider).map((provider) => {
      return new ButtonBuilder()
        .setLabel(provider.charAt(0).toUpperCase() + provider.slice(1))
        .setStyle(provider === activeProvider ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setCustomId(`${provider}-trans`)
        .setDisabled(provider === activeProvider);
    });
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
  };

  const embed = new EmbedBuilder()
    .setColor(TRANSLATOR_COLORS[initialProvider])
    .setDescription(translations[initialProvider]);

  const sentMessage = await message.reply({
    embeds: [embed],
    components: [createButtons(initialProvider)],
  });

  const collector = sentMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeout,
  });

  collector.on("collect", async (interaction: ButtonInteraction) => {
    const provider = interaction.customId.split("-")[0] as Provider;

    embed.setColor(TRANSLATOR_COLORS[provider]);
    embed.setDescription(translations[provider]);

    await interaction.update({
      embeds: [embed],
      components: [createButtons(provider)],
    });
  });

  collector.on("end", async () => {
    const disabledButtons = createButtons(initialProvider);
    for (const button of disabledButtons.components) {
      button.setDisabled(true);
    }

    await sentMessage.edit({
      embeds: [embed],
      components: [disabledButtons],
    });
  });
}
