/** Unit tests for the portrait Persona Affinity infographic. */
import { beforeAll, describe, expect, it } from "bun:test";
import { renderCardToPng } from "@/utils/stats/cardRenderer";
import type { PersonaCardData } from "@/utils/stats/statsInfographic";
import {
  buildDonutSvg,
  CARD_W,
  DEFAULT_PERSONAL_CARD_PALETTE,
  getPersonaCardHeight,
  renderPersonaCard,
} from "@/utils/stats/statsInfographic";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

const SAMPLE_EN: PersonaCardData = {
  locale: "en-US",
  timeframe: "all_time",
  username: "alice",
  userAvatarDataUri: null,
  personaName: "Tomori",
  personaAvatarDataUri: null,
  tomoriconDataUri: null,
  palette: DEFAULT_PERSONAL_CARD_PALETTE,
  userPalette: DEFAULT_PERSONAL_CARD_PALETTE,
  inputTokens: 31_386,
  outputTokens: 4_820,
  totalTriggers: 867,
  estimatedCost: 0.0317,
  memoryCount: 112,
  conditioning: { rewards: 15, punishments: 3 },
  favoriteEmojis: [{ name: "happy", imageDataUri: null }],
  favoriteEmotions: [
    { label: "happy", count: 30 },
    { label: "smug", count: 12 },
  ],
  favoriteTools: [{ label: "web_search", count: 8 }],
};

const SAMPLE_JA: PersonaCardData = {
  ...SAMPLE_EN,
  locale: "ja",
  username: "さくら",
  personaName: "友里",
  favoriteEmotions: [{ label: "うれしい", count: 30 }],
};

describe("renderPersonaCard", () => {
  it("returns a VNode for English and Japanese data", () => {
    expect(renderPersonaCard(SAMPLE_EN)).toBeObject();
    expect(renderPersonaCard(SAMPLE_JA).type).toBe("div");
  });

  it("handles non-all-time cards without a memory count", () => {
    expect(renderPersonaCard({ ...SAMPLE_EN, timeframe: "week", memoryCount: null })).toBeObject();
  });

  it("renders the no-data state when the selected affinity has no triggers", () => {
    expect(renderPersonaCard({ ...SAMPLE_EN, totalTriggers: 0 })).toBeObject();
  });
});

describe("renderPersonaCard PNG", () => {
  it("produces non-empty English and Japanese PNGs", async () => {
    const english = await renderCardToPng(renderPersonaCard(SAMPLE_EN), CARD_W, getPersonaCardHeight(SAMPLE_EN));
    const japanese = await renderCardToPng(renderPersonaCard(SAMPLE_JA), CARD_W, getPersonaCardHeight(SAMPLE_JA));
    expect(english.byteLength).toBeGreaterThan(1000);
    expect(japanese.byteLength).toBeGreaterThan(1000);
  });

  it("produces a shorter PNG when the all-time memory row is absent", async () => {
    const timeWindow = { ...SAMPLE_EN, timeframe: "week" as const, memoryCount: null };
    const png = await renderCardToPng(renderPersonaCard(timeWindow), CARD_W, getPersonaCardHeight(timeWindow));
    expect(png.byteLength).toBeGreaterThan(1000);
  });

  it("shortens time-window cards when the all-time memory tile is absent", () => {
    expect(getPersonaCardHeight({ ...SAMPLE_EN, memoryCount: null })).toBeLessThan(getPersonaCardHeight(SAMPLE_EN));
  });
});

describe("buildDonutSvg", () => {
  it("renders segments and a zero-value track", () => {
    expect(buildDonutSvg([{ value: 60, color: "#e7322a" }])).toContain("<path");
    expect(buildDonutSvg([])).toContain("<circle");
  });
});
