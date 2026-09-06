import { beforeAll, describe, expect, it } from "bun:test";
import { AttachmentBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import {
  repaint,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { resolvePersonaPanelCharacterReference } from "@/utils/discord/personaPanelCharacterReference";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function makePersona(): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Aphel",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    physical_appearance_tags: [],
    nai_char_ref_url: "data/charreferences/personas/55/reference.png",
  } as unknown as TomoriState;
}

function makeScope(persona: TomoriState): ConfigScope {
  return {
    serverDiscId: "guild-1",
    guildId: "guild-1",
    internalServerId: 9,
    userId: 1,
    actor: { workspaceKind: "guild", isManager: true },
    personas: [persona],
    readStatus: "fresh",
  };
}

describe("config character-reference repaint seam", () => {
  it("delivers the selected appearance reference beside a local avatar and clears old attachments", async () => {
    const edits: unknown[] = [];
    let referenceLoads = 0;
    const avatarFile = new AttachmentBuilder(Buffer.from("avatar"), { name: "persona_avatar_55.png" });
    const dependencies = {
      getPersonaAvatarData: async () => ({
        url: "attachment://persona_avatar_55.png",
        files: [avatarFile],
      }),
      getPersonaCharacterReferenceData: async (reference: string, personaId: number, attachmentName: string) =>
        resolvePersonaPanelCharacterReference(reference, personaId, attachmentName, {
          resolveDisplayAsset: async () => {
            referenceLoads += 1;
            return { type: "buffer" as const, buffer: Buffer.from("reference") };
          },
        }),
    } as unknown as ConfigRouteDependencies;
    const interaction = {
      editReply: async (payload: unknown) => {
        edits.push(payload);
        return payload;
      },
    } as unknown as ChatInputCommandInteraction;

    await repaint(interaction, {
      locale: "en-US",
      scope: makeScope(makePersona()),
      category: "persona",
      page: "appearance",
      selectedPersonaId: 55,
      dependencies,
    });

    const delivered = edits.at(-1) as {
      attachments?: unknown;
      files?: AttachmentBuilder[];
      components?: unknown;
    };
    expect(referenceLoads).toBe(1);
    expect(delivered.attachments).toEqual([]);
    expect(delivered.files?.map((file) => file.name)).toEqual(["persona_avatar_55.png", "persona_char_ref_55.png"]);
    expect(JSON.stringify(delivered.components)).toContain("attachment://persona_char_ref_55.png");

    await repaint(interaction, {
      locale: "en-US",
      scope: makeScope(makePersona()),
      category: "persona",
      page: "general",
      selectedPersonaId: 55,
      dependencies,
    });

    expect(referenceLoads).toBe(1);
    expect((edits.at(-1) as { attachments?: unknown }).attachments).toEqual([]);

    await repaint(interaction, {
      locale: "en-US",
      scope: makeScope(makePersona()),
      category: "persona",
      page: "appearance",
      selectedPersonaId: 55,
      receipt: { tone: "success", heading: "Saved", detail: "Configuration was saved." },
      dependencies,
    });

    const receiptDelivered = edits.at(-1) as {
      attachments?: unknown;
      files?: AttachmentBuilder[];
      components?: unknown;
    };
    expect(referenceLoads).toBe(2);
    expect(receiptDelivered.attachments).toEqual([]);
    expect(receiptDelivered.files?.map((file) => file.name)).toEqual([
      "persona_avatar_55.png",
      "persona_char_ref_55.png",
    ]);
    expect(JSON.stringify(receiptDelivered.components)).toContain("attachment://persona_char_ref_55.png");

    await repaint(interaction, {
      locale: "en-US",
      scope: {
        ...makeScope(makePersona()),
        actor: { workspaceKind: "dm", isManager: true },
        guildId: null,
      },
      category: "persona",
      page: "appearance",
      selectedPersonaId: 55,
      dependencies,
    });

    expect(referenceLoads).toBe(2);
  });
});
