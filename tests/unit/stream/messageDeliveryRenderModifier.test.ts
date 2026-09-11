import { describe, expect, it } from "bun:test";
import { HumanizerDegree } from "@/types/db/schema";
import type { StreamContext } from "@/types/stream/interfaces";
import {
  createDefaultStreamState,
  type TextProcessingConfig,
  type TypingSimulationConfig,
  VisibleDeliveryMode,
} from "@/types/stream/types";
import { StreamMessageDelivery } from "@/utils/discord/stream/messageDelivery";
import type { StreamSendPayload, StreamUiUpdater } from "@/utils/discord/stream/uiUpdater";

function textConfig(visibleDeliveryMode = VisibleDeliveryMode.STREAMING): TextProcessingConfig {
  return {
    humanizerDegree: HumanizerDegree.NONE,
    visibleDeliveryMode,
    emojiUsageEnabled: true,
    emojiStrings: [],
    botName: "Ren",
    botNameAliases: [],
    registeredSpeakerNamesLower: new Set(),
    maxMessageLength: 2000,
  };
}

const typingConfig: TypingSimulationConfig = {
  enabled: false,
  baseSpeedMsPerChar: 0,
  maxTypingTimeMs: 0,
  minVisibleDurationMs: 0,
  randomPauseEnabled: false,
  thinkingPauseChance: 0,
};

const context = {
  channel: { id: "channel_1" },
  tomoriState: {
    config: {},
  },
} as StreamContext;

describe("StreamMessageDelivery copied-render options", () => {
  it("passes identity overrides and accumulated text prefixes to the UI updater", async () => {
    const sentPayloads: Array<{ payload: StreamSendPayload; textForState: string }> = [];
    const delivery = new StreamMessageDelivery({
      hasStopRequest: () => false,
      uiUpdater: {
        sendSinglePayload: async (payload, textForState) => {
          sentPayloads.push({ payload, textForState });
          return null;
        },
      } as StreamUiUpdater,
    });

    // Copied identities flip the Discord display name ("Obonya (Ren)") while
    // the accumulated-text prefix stays source-persona-first for the model.
    await delivery.sendSegment("hi", "period", textConfig(), typingConfig, context, createDefaultStreamState(), {
      identityOverride: {
        username: "Obonya (Ren)",
        avatarUrl: "https://example.com/avatar.png",
      },
      accumulatedTextPrefix: "Ren (Obonya): ",
    });

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].payload.identityOverride?.username).toBe("Obonya (Ren)");
    expect(sentPayloads[0].payload.identityOverride?.avatarUrl).toBe("https://example.com/avatar.png");
    expect(sentPayloads[0].payload.accumulatedTextPrefix).toBe("Ren (Obonya): ");
    expect(sentPayloads[0].textForState).toBe("hi");
  });

  it("passes sprite records with a clean username and decorated accumulated prefix", async () => {
    const sentPayloads: Array<{ payload: StreamSendPayload; textForState: string }> = [];
    const delivery = new StreamMessageDelivery({
      hasStopRequest: () => false,
      uiUpdater: {
        sendSinglePayload: async (payload, textForState) => {
          sentPayloads.push({ payload, textForState });
          return null;
        },
      } as StreamUiUpdater,
    });

    // Sprite renders keep the webhook username clean ("Ren"); the decorated
    // label only appears in the accumulated-text prefix, and the sprite record
    // rides along for post-send persistence.
    await delivery.sendSegment("grr", "period", textConfig(), typingConfig, context, createDefaultStreamState(), {
      identityOverride: {
        username: "Ren",
        avatarUrl: "https://example.com/sprites/mad.png",
      },
      accumulatedTextPrefix: "Ren (mad): ",
      spriteRecord: { personaId: 42, spriteName: "mad", isIdentity: false },
    });

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].payload.identityOverride?.username).toBe("Ren");
    expect(sentPayloads[0].payload.accumulatedTextPrefix).toBe("Ren (mad): ");
    expect(sentPayloads[0].payload.spriteRecord).toEqual({ personaId: 42, spriteName: "mad", isIdentity: false });
  });

  it("flushes aggregate-mode bot text before sending a copied-render override", async () => {
    const sentPayloads: StreamSendPayload[] = [];
    const delivery = new StreamMessageDelivery({
      hasStopRequest: () => false,
      uiUpdater: {
        sendSinglePayload: async (payload) => {
          sentPayloads.push(payload);
          return null;
        },
      } as StreamUiUpdater,
    });
    const state = createDefaultStreamState();
    state.pendingAggregatedText = "plain bot text";

    await delivery.sendSegment(
      "copied text",
      "period",
      textConfig(VisibleDeliveryMode.AGGREGATED_PHASE),
      typingConfig,
      context,
      state,
      {
        identityOverride: {
          username: "Obonya (Ren)",
        },
        accumulatedTextPrefix: "Ren (Obonya): ",
      },
    );

    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0]).toMatchObject({ content: "plain bot text" });
    expect(sentPayloads[0].identityOverride).toBeUndefined();
    expect(sentPayloads[1]).toMatchObject({
      content: "copied text",
      accumulatedTextPrefix: "Ren (Obonya): ",
    });
    expect(sentPayloads[1].identityOverride?.username).toBe("Obonya (Ren)");
  });
});
