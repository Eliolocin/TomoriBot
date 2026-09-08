import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import { log } from "@/utils/misc/logger";

const MODAL_TITLE_LIMIT = 45;
const TEXT_DISPLAY_LIMIT = 4_000;
const MODAL_COMPONENT_LIMIT = 5;

interface TextDisplayModalOptions {
  customId: string;
  title: string;
  content: string;
}

interface TextDisplayModalCollectorOptions extends TextDisplayModalOptions {
  message: Message;
  timeoutMs: number;
  onExpire?: () => Promise<void>;
  logLabel: string;
}

/** Builds a read-only modal from markdown-capable text display components. */
export function buildTextDisplayModal({ customId, title, content }: TextDisplayModalOptions): ModalBuilder {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += TEXT_DISPLAY_LIMIT) {
    chunks.push(content.slice(offset, offset + TEXT_DISPLAY_LIMIT));
  }

  if (chunks.length === 0) {
    chunks.push("\u200b");
  }
  if (chunks.length > MODAL_COMPONENT_LIMIT) {
    throw new Error("Text display modal content exceeds Discord's component limit");
  }

  const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, MODAL_TITLE_LIMIT));
  modal.addTextDisplayComponents(...chunks.map((chunk) => new TextDisplayBuilder().setContent(chunk)));
  return modal;
}

/** Builds the single-button row used to open a read-only text modal. */
export function buildTextDisplayModalButton(
  customId: string,
  label: string,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

/** Wires a message button to a read-only modal for the collector lifetime. */
export function attachTextDisplayModalCollector({
  message,
  customId,
  title,
  content,
  timeoutMs,
  onExpire,
  logLabel,
}: TextDisplayModalCollectorOptions): void {
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
    filter: (interaction) => interaction.customId === customId && !interaction.user.bot,
  });

  collector.on("collect", async (interaction: ButtonInteraction) => {
    try {
      await interaction.showModal(buildTextDisplayModal({ customId: `${customId}_modal`, title, content }));
    } catch (error) {
      log.warn(`${logLabel} modal failed`, error as Error);
    }
  });

  collector.on("end", async () => {
    if (!onExpire) return;
    await onExpire().catch((error: unknown) => log.warn(`${logLabel} expiry update failed`, error));
  });
}
