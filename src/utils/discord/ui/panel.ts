import { ComponentType, type ComponentInContainerData, type ContainerComponentData } from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";

const PANEL_ACCENT_BY_TONE = {
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
  info: 0x65c6c5,
} as const;

export function buildPanelContainer(
  components: ComponentInContainerData[],
): ContainerComponentData<ComponentInContainerData> {
  return {
    type: ComponentType.Container,
    accentColor: PANEL_ACCENT_BY_TONE.info,
    components,
  };
}

export function buildPanelReceiptContainer(receipt: PanelReceipt): ContainerComponentData<ComponentInContainerData> {
  return {
    type: ComponentType.Container,
    accentColor: PANEL_ACCENT_BY_TONE[receipt.tone],
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### ${receipt.heading}\n> ${receipt.detail}${receipt.metadata ? `\n-# ${receipt.metadata}` : ""}`,
      },
    ],
  };
}
