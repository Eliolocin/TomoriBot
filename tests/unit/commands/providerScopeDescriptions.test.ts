import { beforeAll, describe, expect, it } from "bun:test";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

const LOCALES = ["en-US", "ja"] as const;

/** Discord rejects a registered command or subcommand description longer than this. */
const DISCORD_DESCRIPTION_LIMIT = 100;

const SERVER_SCOPED_KEYS = [
  "commands.provider.description",
  "commands.provider.add.description",
  "commands.provider.remove.description",
  "commands.model.description",
  "commands.model.text.description",
  "commands.model.embedding.description",
  "commands.model.image.description",
  "commands.model.video.description",
  "commands.model.vision.description",
  "commands.model.fallback.description",
  "commands.model.parameters.description",
];

const PERSONAL_SCOPED_KEYS = [
  "commands.personal.description",
  "commands.personal.config.description",
  "commands.personal.memories.description",
  "commands.personal.providers.description",
];

/** Scope markers that must appear in a description for it to read as server- or user-scoped. */
const SERVER_MARKERS: Record<string, string[]> = {
  "en-US": ["this server", "server's"],
  ja: ["このサーバー"],
};

const PERSONAL_MARKERS: Record<string, string[]> = {
  "en-US": ["your", "personal", "every server"],
  ja: ["個人", "自分", "全サーバー"],
};

function matchesAny(text: string, markers: string[]): boolean {
  const haystack = text.toLowerCase();
  return markers.some((marker) => haystack.includes(marker.toLowerCase()));
}

describe("server and personal command descriptions state their scope", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  for (const locale of LOCALES) {
    it(`resolves every scoped description in ${locale}`, () => {
      for (const key of SERVER_SCOPED_KEYS) {
        // The localizer echoes the key back when it is missing, which is exactly the failure
        // that let `/model` fall through to the command loader's generic fallback description.
        expect(localizer(locale, key)).not.toBe(key);
      }
    });

    it(`keeps every scoped description within Discord's limit in ${locale}`, () => {
      for (const key of SERVER_SCOPED_KEYS) {
        expect(localizer(locale, key).length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
      }
    });

    it(`names the server scope on /provider and /model in ${locale}`, () => {
      for (const key of SERVER_SCOPED_KEYS) {
        expect(matchesAny(localizer(locale, key), SERVER_MARKERS[locale])).toBe(true);
      }
    });
  }

  it("keeps every live personal destination scoped and within Discord's limit", () => {
    for (const key of PERSONAL_SCOPED_KEYS) {
      const description = localizer("en-US", key);
      expect(description).not.toBe(key);
      expect(description.length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
      expect(matchesAny(description, PERSONAL_MARKERS["en-US"])).toBe(true);
    }
  });

  it("keeps the localized personal root explicitly personal", () => {
    expect(matchesAny(localizer("ja", "commands.personal.description"), PERSONAL_MARKERS.ja)).toBe(true);
  });
});
