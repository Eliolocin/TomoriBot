/** Unit tests for the portrait Server Leaderboard infographic. */
import { beforeAll, describe, expect, it } from "bun:test";
import { renderCardToPng } from "@/utils/stats/cardRenderer";
import type { ServerCardData } from "@/utils/stats/statsInfographic";
import {
  CARD_W,
  DEFAULT_PERSONAL_CARD_PALETTE,
  getServerBarLayout,
  getServerCardHeight,
  renderServerCard,
} from "@/utils/stats/statsInfographic";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

const SAMPLE_EN: ServerCardData = {
  locale: "en-US",
  timeframe: "all_time",
  serverName: "Tomori Dev Server",
  serverIconDataUri: null,
  tomoriconDataUri: null,
  palette: DEFAULT_PERSONAL_CARD_PALETTE,
  topPersonas: [
    { name: "Tomori", avatarDataUri: null, rank: 1, totalTokens: 36_206, estimatedCost: 0.0213, accent: "#e7322a" },
    { name: "Lilya", avatarDataUri: null, rank: 2, totalTokens: 13_606, estimatedCost: 0.0089, accent: "#db1458" },
  ],
  topMembers: [
    { name: "alice", avatarDataUri: null, rank: 1, triggers: 3_421, accent: "#315c87" },
    { name: "bob", avatarDataUri: null, rank: 2, triggers: 2_108, accent: "#2f6259" },
  ],
  topModels: [
    { name: "Gemini 1.5 Pro", totalTokens: 64_210, estimatedCost: 2.84 },
    { name: "GPT-4o", totalTokens: 21_408, estimatedCost: 1.12 },
  ],
  totalTokens: 96_618,
  estimatedCost: 4.27,
  totalTriggers: 8_230,
};

const SAMPLE_JA: ServerCardData = {
  ...SAMPLE_EN,
  locale: "ja",
  serverName: "友里のサーバー",
  topPersonas: [
    { name: "友里", avatarDataUri: null, rank: 1, totalTokens: 36_206, estimatedCost: 0.0213, accent: "#e7322a" },
  ],
  topMembers: [{ name: "さくら", avatarDataUri: null, rank: 1, triggers: 3_421, accent: "#315c87" }],
  topModels: [{ name: "Gemini 1.5 Pro", totalTokens: 64_210, estimatedCost: 2.84 }],
};

describe("renderServerCard", () => {
  it("returns a VNode for English and Japanese data", () => {
    expect(renderServerCard(SAMPLE_EN)).toBeObject();
    expect(renderServerCard(SAMPLE_JA).type).toBe("div");
  });

  it("renders the no-data state when the server has no triggers", () => {
    expect(
      renderServerCard({ ...SAMPLE_EN, totalTriggers: 0, topPersonas: [], topMembers: [], topModels: [] }),
    ).toBeObject();
  });
});

describe("getServerBarLayout", () => {
  it("uses the leader-relative width until the compact label requires a floor", () => {
    expect(getServerBarLayout(1, 600, "1 | $1", "1")).toEqual({ width: 600, insideText: "1 | $1" });
    expect(getServerBarLayout(0.5, 600, "1 | $1", "1")).toEqual({ width: 300, insideText: "1 | $1" });

    const compact = getServerBarLayout(24_160 / 77_900, 600, "24,160 tokens | $0.0147", "24,160 | $0.0147");
    expect(compact.insideText).toBe("24,160 | $0.0147");
    expect(compact.width).toBeGreaterThan(Math.round(600 * (24_160 / 77_900)));
    expect(compact.width).toBeLessThan(600);
  });
});

describe("renderServerCard PNG", () => {
  it("produces non-empty English and Japanese PNGs", async () => {
    const english = await renderCardToPng(renderServerCard(SAMPLE_EN), CARD_W, getServerCardHeight(SAMPLE_EN));
    const japanese = await renderCardToPng(renderServerCard(SAMPLE_JA), CARD_W, getServerCardHeight(SAMPLE_JA));
    expect(english.byteLength).toBeGreaterThan(1000);
    expect(japanese.byteLength).toBeGreaterThan(1000);
  });

  it("grows with ranked rows and uses a shorter no-data card", () => {
    expect(getServerCardHeight(SAMPLE_EN)).toBeGreaterThan(getServerCardHeight(SAMPLE_JA));
    expect(getServerCardHeight({ ...SAMPLE_EN, totalTriggers: 0 })).toBeLessThan(getServerCardHeight(SAMPLE_EN));
  });
});
