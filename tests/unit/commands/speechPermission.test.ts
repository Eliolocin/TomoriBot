import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { personaRepository, serverRepository } from "@/utils/db/repositories";
import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import { initializeLocalizer } from "@/utils/text/localizer";

import { execute as executeVoiceAssign } from "@/commands/speech/voice-assign";
import { execute as executeVoiceDesignSet } from "@/commands/speech/voice-design/set";
import { execute as executeVoiceDesignRemove } from "@/commands/speech/voice-design/remove";
import { execute as executeVoiceAdd } from "@/commands/speech/voice-add";
import { execute as executeVoiceRemove } from "@/commands/speech/voice-remove";
import { execute as executeChatterboxParameters } from "@/commands/speech/chatterbox/parameters";

beforeAll(async () => {
  await initializeLocalizer();
});

type ReplyRecord = {
  options: {
    flags?: number;
    embeds?: Array<{ data: { title?: string; description?: string } }>;
  };
};

function createGuildNonManagerInteraction(): {
  interaction: ChatInputCommandInteraction;
  replies: ReplyRecord[];
} {
  const replies: ReplyRecord[] = [];
  const interaction = {
    id: "int-speech-guild-nonmanager",
    guildId: "guild-test-1",
    guild: { id: "guild-test-1" },
    channel: { id: "channel-test-1" },
    user: { id: "user-guild-1" },
    memberPermissions: {
      has: (_permission: string) => false,
    },
    deferred: false,
    replied: false,
    deferReply: async () => {},
    reply: async (options: ReplyRecord["options"]) => {
      replies.push({ options });
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

describe("/speech permission hardening", () => {
  const dummyClient = {} as Client;
  const dummyUserData = { id: 1, user_id: "user-test-1" } as UserRow;

  let personaRepoSpy: ReturnType<typeof spyOn>;
  let serverRepoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    personaRepoSpy = spyOn(personaRepository, "loadAllForServer");
    serverRepoSpy = spyOn(serverRepository, "loadServerIdByDiscId");
  });

  afterEach(() => {
    personaRepoSpy.mockRestore();
    serverRepoSpy.mockRestore();
  });

  const HANDLERS = [
    { name: "/speech voice-assign", execute: executeVoiceAssign },
    { name: "/speech voice-design set", execute: executeVoiceDesignSet },
    { name: "/speech voice-design remove", execute: executeVoiceDesignRemove },
    { name: "/speech voice-add", execute: executeVoiceAdd },
    { name: "/speech voice-remove", execute: executeVoiceRemove },
    { name: "/speech chatterbox parameters", execute: executeChatterboxParameters },
  ];

  for (const { name, execute } of HANDLERS) {
    it(`denies ${name} for guild non-manager without calling repositories`, async () => {
      const { interaction, replies } = createGuildNonManagerInteraction();

      await execute(dummyClient, interaction, dummyUserData, "en-US");

      expect(replies).toHaveLength(1);
      const payload = replies[0].options;
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(payload.embeds?.[0]?.data?.title).toBe("Permission Denied");
      expect(payload.embeds?.[0]?.data?.description).toContain("Manage Server");

      expect(personaRepoSpy).toHaveBeenCalledTimes(0);
      expect(serverRepoSpy).toHaveBeenCalledTimes(0);
    });
  }

  it("allows DM interactions without denying or dispatching an error reply", async () => {
    const replies: ReplyRecord[] = [];
    const dmInteraction = {
      id: "int-speech-dm",
      guildId: null,
      memberPermissions: null,
      deferred: false,
      replied: false,
      reply: async (options: ReplyRecord["options"]) => {
        replies.push({ options });
      },
    } as unknown as ChatInputCommandInteraction;

    const allowed = await ensureSpeechCommandAccess(dmInteraction, "en-US");
    expect(allowed).toBe(true);
    expect(replies).toHaveLength(0);
    expect(personaRepoSpy).toHaveBeenCalledTimes(0);
    expect(serverRepoSpy).toHaveBeenCalledTimes(0);
  });
});
