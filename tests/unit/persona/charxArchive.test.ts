import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import { readCharxCard, type CharxReadLimits } from "@/utils/persona/charxArchive";

const LIMITS: CharxReadLimits = {
  maxCardBytes: 1024 * 1024,
  maxAssets: 10,
  maxTotalAssetBytes: 4 * 1024 * 1024,
};

/** Minimal but complete Character Card V3 object, using only invented identities. */
function v3Card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Sparrow",
      nickname: "Sparrow",
      description: "A wandering archivist who catalogues forgotten songs.",
      personality: "Curious, dry-humored.",
      scenario: "A rain-soaked library at the edge of a drowned city.",
      first_mes: "Sparrow looks up from a water-stained ledger.",
      alternate_greetings: ["Sparrow hums a tune you almost recognize."],
      mes_example: "<START>\n{{user}}: Who are you?\n{{char}}: A cataloguer. Nothing more.",
      system_prompt: "Stay in character at all times.",
      post_history_instructions: "Never break the fourth wall.",
      creator_notes: "Placeholder card.",
      creator_notes_multilingual: { en: "Placeholder card.", ja: "プレースホルダー。" },
      tags: ["archivist"],
      creator: "Juno",
      character_version: "1.0",
      group_only_greetings: [],
      source: ["https://example.invalid/card"],
      creation_date: 0,
      modification_date: 0,
      extensions: { depth_prompt: { prompt: "Keep replies short.", depth: 4, role: "system" } },
      assets: [
        { type: "icon", uri: "embeded://assets/icon/images/main.png", name: "main", ext: "png" },
        { type: "emotion", uri: "embeded://assets/emotion/images/happy.png", name: "happy", ext: "png" },
      ],
      character_book: {
        name: "Lore",
        extensions: {},
        entries: [
          {
            keys: ["library"],
            content: "The library flooded twice.",
            extensions: {},
            enabled: true,
            insertion_order: 100,
            use_regex: false,
          },
        ],
      },
      ...overrides,
    },
  };
}

/** Builds a `.charx`-shaped zip: a card manifest plus an asset tree. */
async function buildCharx(options: {
  card?: unknown;
  /** Hand-written card payload, for bodies a fixture object cannot express. */
  rawCardJson?: string;
  cardName?: string;
  assets?: Array<{ path: string; bytes: Buffer }>;
  extraRootFiles?: Record<string, string | Buffer>;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(options.cardName ?? "card.json", options.rawCardJson ?? JSON.stringify(options.card ?? v3Card()));
  for (const asset of options.assets ?? []) {
    zip.file(asset.path, asset.bytes);
  }
  for (const [name, content] of Object.entries(options.extraRootFiles ?? {})) {
    zip.file(name, content);
  }
  return (await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })) as Buffer;
}

describe("charx archive reader", () => {
  it("reads card.json from the archive root and reports the ignored asset count", async () => {
    const buffer = await buildCharx({
      assets: [
        { path: "assets/icon/images/main.png", bytes: Buffer.from("icon-bytes") },
        { path: "assets/emotion/images/happy.png", bytes: Buffer.from("happy-bytes") },
      ],
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.ignoredAssetCount).toBe(2);
    const card = result.card as { spec: string; data: { name: string } };
    expect(card.spec).toBe("chara_card_v3");
    expect(card.data.name).toBe("Sparrow");
  });

  it("finds the card through a wrapping folder and a differently cased filename", async () => {
    const buffer = await buildCharx({ cardName: "Sparrow/Card.JSON" });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.card as { spec: string }).spec).toBe("chara_card_v3");
  });

  it("accepts a card that declares no assets", async () => {
    const buffer = await buildCharx({ card: v3Card({ assets: undefined }) });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ignoredAssetCount).toBe(0);
  });

  it("ignores application-specific root files alongside the card", async () => {
    const buffer = await buildCharx({
      extraRootFiles: { "user_data.json": JSON.stringify({ theme: "dark" }) },
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
  });

  it("rejects a buffer that is not a valid zip", async () => {
    const result = await readCharxCard(Buffer.from("this is definitely not a zip file"), LIMITS);
    expect(result).toEqual({ ok: false, reason: "invalid_zip" });
  });

  it("rejects an archive with no card.json", async () => {
    const zip = new JSZip();
    zip.file("assets/icon/images/main.png", Buffer.from("icon"));
    const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

    const result = await readCharxCard(buffer, LIMITS);
    expect(result).toEqual({ ok: false, reason: "missing_card" });
  });

  it("rejects a card.json that is not JSON", async () => {
    const zip = new JSZip();
    zip.file("card.json", "{ this is not json");
    const malformed = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

    const result = await readCharxCard(malformed, LIMITS);
    expect(result).toEqual({ ok: false, reason: "invalid_card" });
  });

  it("rejects an archive whose payload is a zip rather than a character card", async () => {
    const buffer = await buildCharx({ card: { spec: "lorebook_v3", data: { entries: [] } } });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result).toEqual({ ok: false, reason: "not_character_card" });
  });

  it("accepts any JSON object and lets the converter judge its contents", async () => {
    // The reader no longer owns recognition: an envelope without a `spec` is a
    // root-level V2 card's normal shape, so rejecting it here would refuse cards
    // the converter imports. What it still rejects is a body that is not an object.
    const envelopeWithoutSpec = await buildCharx({ card: { spec_version: "3.0" } });
    expect((await readCharxCard(envelopeWithoutSpec, LIMITS)).ok).toBe(true);

    const notAnObject = await buildCharx({ rawCardJson: "[1,2,3]" });
    expect(await readCharxCard(notAnObject, LIMITS)).toEqual({ ok: false, reason: "invalid_card" });
  });

  it("does not count a remote URI or the spec default as bundled media", async () => {
    const buffer = await buildCharx({
      card: v3Card({
        assets: [
          { type: "icon", uri: "https://example.invalid/icon.png", name: "main", ext: "png" },
          { type: "icon", uri: "ccdefault:", name: "main", ext: "png" },
        ],
      }),
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Nothing is bundled, so telling the user their media was dropped would be
    // false. The spec's own default for a missing `assets` is exactly this icon.
    expect(result.ignoredAssetCount).toBe(0);
  });

  it("does not count an embedded URI whose entry is missing or escapes the root", async () => {
    const buffer = await buildCharx({
      card: v3Card({
        assets: [
          { type: "icon", uri: "embeded://../../../etc/passwd", name: "main", ext: "png" },
          { type: "icon", uri: "embeded://assets/icon/images/absent.png", name: "main", ext: "png" },
        ],
      }),
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ignoredAssetCount).toBe(0);
  });

  it("prefers the root card over a decoy buried in the asset tree", async () => {
    const buffer = await buildCharx({
      card: v3Card({ name: "REAL" }),
      extraRootFiles: { "assets/card.json": JSON.stringify(v3Card({ name: "DECOY" })) },
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The spec puts the card at the archive root, so a same-named file in the
    // asset tree must never shadow it.
    expect((result.card as { data: { name: string } }).data.name).toBe("REAL");
  });

  it("refuses a huge asset list without scanning it", async () => {
    // Each entry is one byte of JSON and fails shape validation, so a counter that
    // only advanced on valid entries would never reach the cap and the loop would
    // run to completion on the main thread.
    // Sized to land between the two bounds: well over the 500-asset cap, and well
    // under the 4 MB card cap, so only the asset bound can refuse this. A counter
    // that advanced only on valid entries would never reach the cap, because every
    // `null` fails shape validation, and the loop would run to completion on the
    // main thread.
    const junkCount = 400_000;
    const assets = `[${"null,".repeat(junkCount - 1)}null]`;
    const rawCardJson = `{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Sparrow","assets":${assets}}}`;
    const buffer = await buildCharx({ rawCardJson });

    const started = Date.now();
    // A card cap raised above the payload, so the asset bound is the only thing
    // that can refuse this archive.
    const result = await readCharxCard(buffer, { ...LIMITS, maxCardBytes: 8 * 1024 * 1024 });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ ok: false, reason: "assets_too_large" });
    // The upload is a few KB; the bound is what keeps this from being a second of
    // blocked event loop rather than the loop itself.
    expect(elapsed).toBeLessThan(1000);
  });

  it("accepts a card whose spec is absent, leaving recognition to the converter", async () => {
    // A root-level V2 card has no `spec` at all, and the converter accepts one.
    const noSpec = { name: "Sparrow", description: "An archivist.", first_mes: "Hello.", personality: "Curious." };
    const buffer = await buildCharx({ card: noSpec });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const conversion = presetRepository.convertSillyTavernJsonToPresetData(result.card);
    expect(conversion.success).toBe(true);
  });

  it("is not fooled by a directory whose name matches the card", async () => {
    const zip = new JSZip();
    zip.folder("card.json");
    zip.file("data/card.json", JSON.stringify(v3Card({ name: "NESTED" })));
    const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.card as { data: { name: string } }).data.name).toBe("NESTED");
  });

  it("rejects a card whose decompressed payload exceeds the card byte budget", async () => {
    const buffer = await buildCharx({ card: v3Card({ description: "x".repeat(4096) }) });

    const result = await readCharxCard(buffer, { ...LIMITS, maxCardBytes: 512 });
    expect(result).toEqual({ ok: false, reason: "card_too_large" });
  });

  it("rejects a card declaring more assets than the asset-count budget", async () => {
    const buffer = await buildCharx({
      card: v3Card({
        assets: [
          { type: "emotion", uri: "embeded://assets/emotion/images/a.png", name: "a", ext: "png" },
          { type: "emotion", uri: "embeded://assets/emotion/images/b.png", name: "b", ext: "png" },
        ],
      }),
    });

    const result = await readCharxCard(buffer, { ...LIMITS, maxAssets: 1 });
    expect(result).toEqual({ ok: false, reason: "assets_too_large" });
  });

  it("rejects an asset tree whose declared total size exceeds the budget", async () => {
    const buffer = await buildCharx({
      card: v3Card({
        assets: [
          { type: "icon", uri: "embeded://assets/icon/images/main.png", name: "main", ext: "png" },
          { type: "background", uri: "embeded://assets/background/images/bg.png", name: "main", ext: "png" },
        ],
      }),
      assets: [
        { path: "assets/icon/images/main.png", bytes: Buffer.alloc(2048, 1) },
        { path: "assets/background/images/bg.png", bytes: Buffer.alloc(2048, 2) },
      ],
    });

    // Each entry fits the per-file budget, so only the running total can reject this.
    const result = await readCharxCard(buffer, { ...LIMITS, maxTotalAssetBytes: 3000 });
    expect(result).toEqual({ ok: false, reason: "assets_too_large" });
  });

  it("does not size assets that point outside the archive or to a remote URI", async () => {
    const buffer = await buildCharx({
      card: v3Card({
        assets: [
          { type: "icon", uri: "https://example.invalid/icon.png", name: "main", ext: "png" },
          { type: "icon", uri: "ccdefault:", name: "main", ext: "png" },
          { type: "icon", uri: "embeded://../../../etc/passwd", name: "main", ext: "png" },
          { type: "icon", uri: "embeded://assets/icon/images/absent.png", name: "main", ext: "png" },
        ],
      }),
    });

    const result = await readCharxCard(buffer, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // None of the four is present in the archive, so the byte budget stays
    // untouched, the import is not refused, and nothing is reported as dropped.
    expect(result.ignoredAssetCount).toBe(0);
  });
});

describe("charx card conversion", () => {
  it("maps a V3 card through the existing SillyTavern converter without mapping work", async () => {
    const buffer = await buildCharx({});
    const archive = await readCharxCard(buffer, LIMITS);
    expect(archive.ok).toBe(true);
    if (!archive.ok) {
      return;
    }

    expect(presetRepository.looksLikeSillyTavernCardJson(archive.card)).toBe(true);

    const conversion = presetRepository.convertSillyTavernJsonToPresetData(archive.card);
    expect(conversion.success).toBe(true);
    if (!conversion.success) {
      return;
    }

    expect(conversion.data.tomori_nickname).toBe("Sparrow");
    // description, personality, scenario, system prompt, post-history, depth
    // prompt, and the character book entry.
    expect(conversion.data.attribute_list).toHaveLength(7);
    expect(conversion.data.attribute_list[0]).toContain("wandering archivist");
    expect(conversion.data.sample_dialogues_in).toHaveLength(3);
    expect(conversion.data.sample_dialogues_out).toHaveLength(3);
    expect(conversion.data.trigger_words).toEqual(["sparrow"]);
  });

  it("accepts a bare V3 card.json handed over as a .json import", () => {
    // The `.json` path needs no `.charx` support: the spec check already matches
    // any `chara_card*` value, so a V3 card converts as-is.
    const conversion = presetRepository.convertSillyTavernJsonToPresetData(v3Card());
    expect(conversion.success).toBe(true);
    if (!conversion.success) {
      return;
    }
    expect(conversion.data.tomori_nickname).toBe("Sparrow");
  });
});
