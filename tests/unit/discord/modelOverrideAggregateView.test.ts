/**
 * `/model override remove` is retained past the `/config` cutover precisely because it is the only
 * surface that browses channel and persona Text overrides together. The panel's Channel Overrides
 * and Persona Advanced pages each edit one scope, so a regression that narrowed this command to a
 * single scope would leave no way to see both at once and no gate would notice.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Client } from "discord.js";
import { execute as executeOverrideRemove } from "@/commands/model/override/remove";
import type { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import { llmOverrideRepo } from "@/utils/db/repositories";
import * as modalModule from "@/utils/discord/ui/modals";
import type { LlmRow, TomoriState, UserRow } from "@/types/db/schema";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

const LLM: LlmRow = {
  llm_id: 7,
  llm_provider: "google",
  llm_codename: "gemini-2.5-flash",
} as unknown as LlmRow;

function makePersona(overrides: Partial<TomoriState>): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    persona_lineage_id: 101,
    config: {},
    ...overrides,
  } as unknown as TomoriState;
}

type ModalGroup = { customId: string; options: Array<{ value: string; label: string }> };

function makeInteraction() {
  return {
    id: "interaction-1",
    guildId: "guild-1",
    guild: {
      id: "guild-1",
      channels: {
        cache: {
          get: (id: string) => (id === "channel-1" ? { name: "general", isTextBased: () => true } : undefined),
        },
      },
    },
    user: { id: "user-1" },
    memberPermissions: { has: () => true },
  } as unknown as Parameters<typeof executeOverrideRemove>[1];
}

describe("/model override remove aggregate view", () => {
  it("presents channel and persona overrides together in one modal", async () => {
    const stateSpy = spyOn(tomoriStateCache, "getCachedTomoriState").mockResolvedValue(
      makePersona({}) as Awaited<ReturnType<typeof getCachedTomoriState>>,
    );
    const personasSpy = spyOn(tomoriStateCache, "getCachedAllPersonas").mockResolvedValue([
      makePersona({ persona_id: 55, persona_nickname: "Sparrow", persona_llm: LLM }),
      // No override, so it must not reach the modal.
      makePersona({ persona_id: 56, persona_nickname: "Lighthouse", persona_llm: null }),
    ] as unknown as Awaited<ReturnType<typeof getCachedAllPersonas>>);
    const channelSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue([
      { channelDiscId: "channel-1", llm: LLM },
    ]);

    let groups: ModalGroup[] | undefined;
    const modalSpy = spyOn(modalModule, "promptWithRawModal").mockImplementation(
      async (_interaction, _locale, options) => {
        groups = (options as unknown as { components: ModalGroup[] }).components;
        return { outcome: "cancel" };
      },
    );

    await executeOverrideRemove(CLIENT, makeInteraction(), {} as UserRow, "en-US");

    expect(channelSpy).toHaveBeenCalledWith(9);
    // Two groups, one per scope: collapsing to one scope is the regression this guards.
    expect(groups?.length).toBe(2);
    expect(groups?.[0]?.options.map((option) => option.value)).toEqual(["channel-1"]);
    expect(groups?.[0]?.options.map((option) => option.label)).toEqual(["#general"]);
    expect(groups?.[1]?.options.map((option) => option.value)).toEqual(["55"]);
    expect(groups?.[1]?.options.map((option) => option.label)).toEqual([
      expect.stringContaining("Sparrow") as unknown as string,
    ]);

    modalSpy.mockRestore();
    channelSpy.mockRestore();
    personasSpy.mockRestore();
    stateSpy.mockRestore();
  });

  it("removes a persona override the modal left unchecked without touching the checked channel", async () => {
    const stateSpy = spyOn(tomoriStateCache, "getCachedTomoriState").mockResolvedValue(
      makePersona({}) as Awaited<ReturnType<typeof getCachedTomoriState>>,
    );
    const personasSpy = spyOn(tomoriStateCache, "getCachedAllPersonas").mockResolvedValue([
      makePersona({ persona_id: 55, persona_nickname: "Sparrow", persona_llm: LLM }),
    ] as unknown as Awaited<ReturnType<typeof getCachedAllPersonas>>);
    const channelSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue([
      { channelDiscId: "channel-1", llm: LLM },
    ]);
    const deleteChannelSpy = spyOn(llmOverrideRepo, "deleteChannelLlmOverride").mockResolvedValue(true);
    const clearPersonaSpy = spyOn(llmOverrideRepo, "setPersonaLlmOverride").mockResolvedValue(true);

    const modalSpy = spyOn(modalModule, "promptWithRawModal").mockImplementation(async () => ({
      outcome: "submit",
      interaction: {
        replied: true,
        deferred: true,
        editReply: async () => undefined,
        followUp: async () => undefined,
      },
      // Checked means keep: the channel stays, the persona is absent and therefore removed.
      multiValues: { channel_override_checkbox_group_0: ["channel-1"], persona_override_checkbox_group_0: [] },
    }));

    await executeOverrideRemove(CLIENT, makeInteraction(), {} as UserRow, "en-US");

    expect(deleteChannelSpy).not.toHaveBeenCalled();
    expect(clearPersonaSpy).toHaveBeenCalledWith(55, null, { serverDiscId: "guild-1" });

    modalSpy.mockRestore();
    clearPersonaSpy.mockRestore();
    deleteChannelSpy.mockRestore();
    channelSpy.mockRestore();
    personasSpy.mockRestore();
    stateSpy.mockRestore();
  });
});
