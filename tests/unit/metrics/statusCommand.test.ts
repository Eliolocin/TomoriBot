import { describe, expect, it } from "bun:test";
import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { ColorCode } from "@/utils/misc/logger";
import { executeStatusCommand, type StatusCommandDependencies } from "@/utils/metrics/status/command";

type StatusScope = "personal" | "persona" | "server_model" | "server_config" | "server_channels";
type DependencyCall<Name extends keyof StatusCommandDependencies> = Parameters<StatusCommandDependencies[Name]>;
type CachedTomoriState = NonNullable<Awaited<ReturnType<StatusCommandDependencies["getCachedTomoriState"]>>>;

type MockInteraction = {
  guildId: string | null;
  user: { id: string };
  options: { getString: (name: string, required: boolean) => string };
  deferred: boolean;
  replied: boolean;
  deferReply: (options?: { flags?: MessageFlags }) => Promise<void>;
};

type DependencyCalls = {
  cache: DependencyCall<"getCachedTomoriState">[];
  info: DependencyCall<"replyInfoEmbed">[];
  personal: DependencyCall<"showPersonalStatus">[];
  persona: DependencyCall<"showPersonaStatus">[];
  serverModel: DependencyCall<"showServerModelStatus">[];
  serverConfig: DependencyCall<"showServerConfigStatus">[];
  serverChannels: DependencyCall<"showServerChannelsStatus">[];
};

const client = { user: { id: "bot-user" } } as Client;
const userData = { user_id: 42, user_disc_id: "user-42" } as UserRow;
const tomoriState = {} as CachedTomoriState;

function createInteraction(
  scope: string,
  guildId: string | null,
): {
  interaction: MockInteraction;
  deferCalls: ({ flags?: MessageFlags } | undefined)[];
} {
  const deferCalls: ({ flags?: MessageFlags } | undefined)[] = [];
  const interaction: MockInteraction = {
    guildId,
    user: { id: "dm-user" },
    options: {
      getString: (name, required) => {
        expect(name).toBe("scope");
        expect(required).toBe(true);
        return scope;
      },
    },
    deferred: false,
    replied: false,
    deferReply: async (options) => {
      deferCalls.push(options);
      interaction.deferred = true;
    },
  };

  return { interaction, deferCalls };
}

function createDependencies(
  interaction: MockInteraction,
  state: CachedTomoriState | null,
): {
  dependencies: StatusCommandDependencies;
  calls: DependencyCalls;
} {
  const calls: DependencyCalls = {
    cache: [],
    info: [],
    personal: [],
    persona: [],
    serverModel: [],
    serverConfig: [],
    serverChannels: [],
  };
  const expectAcknowledged = () => {
    expect(interaction.deferred || interaction.replied).toBe(true);
  };

  const dependencies: StatusCommandDependencies = {
    getCachedTomoriState: async (...args) => {
      calls.cache.push(args);
      expectAcknowledged();
      return state;
    },
    replyInfoEmbed: async (...args) => {
      calls.info.push(args);
      expectAcknowledged();
    },
    showPersonalStatus: async (...args) => {
      calls.personal.push(args);
      expectAcknowledged();
    },
    showPersonaStatus: async (...args) => {
      calls.persona.push(args);
      expectAcknowledged();
    },
    showServerModelStatus: async (...args) => {
      calls.serverModel.push(args);
      expectAcknowledged();
    },
    showServerConfigStatus: async (...args) => {
      calls.serverConfig.push(args);
      expectAcknowledged();
    },
    showServerChannelsStatus: async (...args) => {
      calls.serverChannels.push(args);
      expectAcknowledged();
    },
  };

  return { dependencies, calls };
}

function expectNoRendererCalls(calls: DependencyCalls): void {
  expect(calls.personal).toHaveLength(0);
  expect(calls.persona).toHaveLength(0);
  expect(calls.serverModel).toHaveLength(0);
  expect(calls.serverConfig).toHaveLength(0);
  expect(calls.serverChannels).toHaveLength(0);
}

describe("executeStatusCommand", () => {
  it("acknowledges before dispatching each valid scope and preserves renderer arguments", async () => {
    const scopes: StatusScope[] = ["personal", "persona", "server_model", "server_config", "server_channels"];

    for (const scope of scopes) {
      const { interaction, deferCalls } = createInteraction(scope, "guild-123");
      const { dependencies, calls } = createDependencies(interaction, tomoriState);

      await executeStatusCommand(
        client,
        interaction as unknown as ChatInputCommandInteraction,
        userData,
        "en-US",
        dependencies,
      );

      expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(interaction.deferred).toBe(true);
      expect(calls.info).toHaveLength(0);

      if (scope === "personal") {
        expect(calls.personal).toEqual([[interaction, userData, "en-US"]]);
        expect(calls.persona).toHaveLength(0);
        expect(calls.serverModel).toHaveLength(0);
        expect(calls.serverConfig).toHaveLength(0);
        expect(calls.serverChannels).toHaveLength(0);
        expect(calls.cache).toHaveLength(0);
      } else if (scope === "persona") {
        expect(calls.persona).toEqual([[interaction, userData, "guild-123", "en-US"]]);
        expect(calls.personal).toHaveLength(0);
        expect(calls.serverModel).toHaveLength(0);
        expect(calls.serverConfig).toHaveLength(0);
        expect(calls.serverChannels).toHaveLength(0);
        expect(calls.cache).toHaveLength(0);
      } else {
        expect(calls.cache).toEqual([["guild-123"]]);
        expect(calls.personal).toHaveLength(0);
        expect(calls.persona).toHaveLength(0);

        if (scope === "server_model") {
          expect(calls.serverModel).toEqual([[client, interaction, "guild-123", tomoriState, "en-US"]]);
          expect(calls.serverConfig).toHaveLength(0);
          expect(calls.serverChannels).toHaveLength(0);
        } else if (scope === "server_config") {
          expect(calls.serverConfig).toEqual([[client, interaction, tomoriState, "en-US"]]);
          expect(calls.serverModel).toHaveLength(0);
          expect(calls.serverChannels).toHaveLength(0);
        } else {
          expect(calls.serverChannels).toEqual([[client, interaction, "guild-123", tomoriState, "en-US"]]);
          expect(calls.serverModel).toHaveLength(0);
          expect(calls.serverConfig).toHaveLength(0);
        }
      }
    }
  });

  it("uses the DM user ID as the effective server ID", async () => {
    const scopes: StatusScope[] = ["personal", "persona", "server_model", "server_config", "server_channels"];

    for (const scope of scopes) {
      const { interaction } = createInteraction(scope, null);
      const { dependencies, calls } = createDependencies(interaction, tomoriState);

      await executeStatusCommand(
        client,
        interaction as unknown as ChatInputCommandInteraction,
        userData,
        "ja",
        dependencies,
      );

      expect(interaction.deferred).toBe(true);
      if (scope === "personal") {
        expect(calls.personal).toEqual([[interaction, userData, "ja"]]);
        expect(calls.cache).toHaveLength(0);
        expect(calls.persona).toHaveLength(0);
      } else if (scope === "persona") {
        expect(calls.persona).toEqual([[interaction, userData, "dm-user", "ja"]]);
        expect(calls.cache).toHaveLength(0);
      } else {
        expect(calls.cache).toEqual([["dm-user"]]);
        if (scope === "server_model") {
          expect(calls.serverModel).toEqual([[client, interaction, "dm-user", tomoriState, "ja"]]);
          expect(calls.serverConfig).toHaveLength(0);
          expect(calls.serverChannels).toHaveLength(0);
        } else if (scope === "server_config") {
          expect(calls.serverConfig).toEqual([[client, interaction, tomoriState, "ja"]]);
          expect(calls.serverModel).toHaveLength(0);
          expect(calls.serverChannels).toHaveLength(0);
        } else {
          expect(calls.serverChannels).toEqual([[client, interaction, "dm-user", tomoriState, "ja"]]);
          expect(calls.serverModel).toHaveLength(0);
          expect(calls.serverConfig).toHaveLength(0);
        }
      }
    }
  });

  it("replies for not-setup server scopes without running a renderer", async () => {
    const scopes: StatusScope[] = ["server_model", "server_config", "server_channels"];

    for (const scope of scopes) {
      const { interaction, deferCalls } = createInteraction(scope, "guild-empty");
      const { dependencies, calls } = createDependencies(interaction, null);

      await executeStatusCommand(
        client,
        interaction as unknown as ChatInputCommandInteraction,
        userData,
        "en-US",
        dependencies,
      );

      expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(calls.cache).toEqual([["guild-empty"]]);
      expect(calls.info).toEqual([
        [
          interaction,
          "en-US",
          {
            titleKey: "general.errors.tomori_not_setup_title",
            descriptionKey: "general.errors.tomori_not_setup_description",
            color: ColorCode.ERROR,
          },
        ],
      ]);
      expectNoRendererCalls(calls);
    }
  });

  it("replies for an invalid scope after acknowledgement", async () => {
    const { interaction, deferCalls } = createInteraction("unknown", "guild-123");
    const { dependencies, calls } = createDependencies(interaction, tomoriState);

    await executeStatusCommand(
      client,
      interaction as unknown as ChatInputCommandInteraction,
      userData,
      "en-US",
      dependencies,
    );

    expect(deferCalls).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(calls.cache).toHaveLength(0);
    expect(calls.info).toEqual([
      [
        interaction,
        "en-US",
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
      ],
    ]);
    expectNoRendererCalls(calls);
  });
});
