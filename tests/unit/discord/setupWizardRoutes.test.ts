import { beforeEach, describe, expect, it, mock } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction, type Client } from "discord.js";
import { SETUP_DRAFT_SCHEMA_VERSION, type SetupDraftRecord } from "@/types/discord/setupWizard";
import { readSetupDraft, resetSetupDrafts, storeSetupDraft } from "@/utils/discord/interactions/setupDraftStore";
import {
  buildSetupCancelRouteId,
  buildSetupDashboardRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupProviderModeRouteId,
  buildSetupProviderRouteId,
  buildSetupSettingsRouteId,
  startSetupWizard,
} from "@/utils/discord/interactions/setupRoutes";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { localizer } from "@/utils/text/localizer";

function makeDraft(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
  return {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: "actor-1",
    workspaceKey: "guild-1",
    context: "guild",
    providerAccess: null,
    startingSettings: null,
    policiesAccepted: false,
    requiresPolicies: false,
    ...overrides,
  };
}

interface MockInteractionOptions {
  customId: string;
  kind?: "button" | "string";
  actorDiscId?: string;
  guildId?: string | null;
  canManageGuild?: boolean;
  values?: string[];
}

function makeMockInteraction({
  customId,
  kind = "button",
  actorDiscId = "actor-1",
  guildId = "guild-1",
  canManageGuild = true,
  values = [],
}: MockInteractionOptions): GlobalRoutableInteraction & {
  replyCalls: unknown[];
  updateCalls: unknown[];
} {
  const replyCalls: unknown[] = [];
  const updateCalls: unknown[] = [];

  const interaction = {
    id: `interaction-${customId}`,
    customId,
    locale: "en-US",
    guildLocale: "en-US",
    user: { id: actorDiscId },
    guildId,
    memberPermissions: {
      has: (perm: unknown) =>
        (perm === "ManageGuild" || perm === PermissionsBitField.Flags.ManageGuild) && canManageGuild,
    },
    replied: false,
    deferred: false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    values,
    reply: async (payload: unknown) => {
      interaction.replied = true;
      replyCalls.push(payload);
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    update: async (payload: unknown) => {
      interaction.replied = true;
      updateCalls.push(payload);
    },
    editReply: async () => {},
    followUp: async (payload: unknown) => {
      replyCalls.push(payload);
    },
    replyCalls,
    updateCalls,
  };

  return interaction as unknown as GlobalRoutableInteraction & {
    replyCalls: unknown[];
    updateCalls: unknown[];
  };
}

describe("setupWizardRoutes", () => {
  beforeEach(() => {
    resetSetupDrafts();
  });

  it("dispatches through real InteractionRouteRegistry to registered setup route", async () => {
    const nonce = "nonce-live-1";
    storeSetupDraft(nonce, makeDraft());

    const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({ customId });

    const handled = await dispatchGlobalInteraction({} as Client, interaction);
    expect(handled).toBe(true);
    expect(interaction.updateCalls.length).toBe(1);
  });

  it("reaches each step-open seam under its exact dispatcher key", async () => {
    const nonce = "nonce-seams-1";
    storeSetupDraft(nonce, makeDraft());

    const seams = [
      { key: "policies", build: buildSetupPoliciesRouteId },
      { key: "provider", build: buildSetupProviderRouteId },
      { key: "settings", build: buildSetupSettingsRouteId },
    ];

    for (const seam of seams) {
      const customId = seam.build({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId });

      const handled = await dispatchGlobalInteraction({} as Client, interaction);
      expect(handled).toBe(true);
      expect(interaction.replyCalls.length).toBe(1);
      const call = interaction.replyCalls[0] as { content: string; flags?: number };
      expect(call.content).toBe(localizer("en-US", "commands.setup.wizard.step_unavailable"));
    }
  });

  it("acknowledges ephemerally before any slow work in startSetupWizard", async () => {
    let acknowledgedAtStoreTime: boolean | null = null;

    const mockStore = mock((nonce: string, record: SetupDraftRecord) => {
      acknowledgedAtStoreTime = interaction.deferred || interaction.replied;
      storeSetupDraft(nonce, record);
    });

    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      guildId: "guild-1",
      user: { id: "actor-1" },
      memberPermissions: {
        has: () => true,
      },
      replied: false,
      deferred: false,
      deferReply: async () => {
        interaction.deferred = true;
      },
      reply: async () => {
        interaction.replied = true;
      },
      editReply: async () => {},
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => false,
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    expect(acknowledgedAtStoreTime).toBe(true);
    expect(mockStore).toHaveBeenCalledTimes(1);
  });

  it("acknowledges before refusing an unauthorized actor in startSetupWizard", async () => {
    const mockStore = mock(() => {});
    let editedContent = "";
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      guildId: "guild-1",
      user: { id: "actor-1" },
      memberPermissions: {
        has: () => false,
      },
      replied: false,
      deferred: false,
      deferReply: async () => {
        interaction.deferred = true;
      },
      reply: async () => {
        interaction.replied = true;
      },
      editReply: async (payload: { content?: string }) => {
        editedContent = payload.content ?? "";
      },
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => false,
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    expect(interaction.deferred).toBe(true);
    expect(editedContent).toBe(localizer("en-US", "commands.setup.wizard.permission_denied"));
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("acknowledges before refusing an already-configured workspace in startSetupWizard", async () => {
    const mockStore = mock(() => {});
    let editedContent = "";
    const interaction = {
      locale: "en-US",
      guildLocale: "en-US",
      guildId: "guild-1",
      user: { id: "actor-1" },
      memberPermissions: {
        has: () => true,
      },
      replied: false,
      deferred: false,
      deferReply: async () => {
        interaction.deferred = true;
      },
      reply: async () => {
        interaction.replied = true;
      },
      editReply: async (payload: { content?: string }) => {
        editedContent = payload.content ?? "";
      },
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => true,
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    expect(interaction.deferred).toBe(true);
    expect(editedContent).toBe(localizer("en-US", "commands.setup.already_setup_description"));
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("returns terminal expired response for stale or forged nonce without repainting panel", async () => {
    const forgedCustomId = buildSetupDashboardRouteId({ locale: "en-US", nonce: "forged-nonce-1" });
    const interaction = makeMockInteraction({ customId: forgedCustomId });

    const handled = await dispatchGlobalInteraction({} as Client, interaction);
    expect(handled).toBe(true);
    expect(interaction.updateCalls.length).toBe(1);

    const updatePayload = interaction.updateCalls[0] as { components: unknown[] };
    const payloadStr = JSON.stringify(updatePayload);
    expect(payloadStr).toContain(localizer("en-US", "commands.setup.wizard.expired_title"));
    expect(payloadStr).not.toContain(localizer("en-US", "commands.setup.wizard.title"));
  });

  it("refuses wrong actor without mutating or consuming draft", async () => {
    const nonce = "nonce-protect-1";
    storeSetupDraft(nonce, makeDraft({ actorDiscId: "actor-legit" }));

    const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
    const attackerInteraction = makeMockInteraction({
      customId,
      actorDiscId: "attacker-user-id",
    });

    const handled = await dispatchGlobalInteraction({} as Client, attackerInteraction);
    expect(handled).toBe(true);
    expect(attackerInteraction.replyCalls.length).toBe(1);

    const check = readSetupDraft(nonce, "actor-legit", "guild-1", "guild");
    expect(check.status).toBe("ok");
  });

  it("refuses wrong workspace without mutating or consuming draft", async () => {
    const nonce = "nonce-workspace-1";
    storeSetupDraft(nonce, makeDraft({ workspaceKey: "guild-legit" }));

    const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
    const wrongWorkspaceInteraction = makeMockInteraction({
      customId,
      actorDiscId: "actor-1",
      guildId: "guild-wrong",
    });

    await dispatchGlobalInteraction({} as Client, wrongWorkspaceInteraction);

    const check = readSetupDraft(nonce, "actor-1", "guild-legit", "guild");
    expect(check.status).toBe("ok");
  });

  it("refuses wrong context without mutating or consuming draft", async () => {
    const nonce = "nonce-context-1";
    storeSetupDraft(nonce, makeDraft({ context: "guild", workspaceKey: "guild-1" }));

    const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
    const dmInteraction = makeMockInteraction({
      customId,
      actorDiscId: "actor-1",
      guildId: null, // context dm
    });

    await dispatchGlobalInteraction({} as Client, dmInteraction);

    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("ok");
  });

  it("refuses when ManageGuild is lost without mutating or consuming draft", async () => {
    const nonce = "nonce-lost-auth-1";
    storeSetupDraft(nonce, makeDraft({ actorDiscId: "actor-1", workspaceKey: "guild-1" }));

    const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
    const lostAuthInteraction = makeMockInteraction({
      customId,
      actorDiscId: "actor-1",
      guildId: "guild-1",
      canManageGuild: false,
    });

    await dispatchGlobalInteraction({} as Client, lostAuthInteraction);

    expect(lostAuthInteraction.replyCalls.length).toBe(1);
    const call = lostAuthInteraction.replyCalls[0] as { content: string };
    expect(call.content).toBe(localizer("en-US", "commands.setup.wizard.permission_denied"));

    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("ok");
  });

  it("refuses Finish Setup while any requirement is pending", async () => {
    const nonce = "nonce-finish-pending-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null, startingSettings: null }));

    const customId = buildSetupFinishRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({ customId });

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(interaction.replyCalls.length).toBe(1);
    const call = interaction.replyCalls[0] as { content: string };
    expect(call.content).toBe(localizer("en-US", "commands.setup.wizard.finish_incomplete"));
  });

  it("consumes draft exactly once on Cancel and repaints terminal cancelled state", async () => {
    const nonce = "nonce-cancel-1";
    storeSetupDraft(nonce, makeDraft());

    const customId = buildSetupCancelRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({ customId });

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(interaction.updateCalls.length).toBe(1);
    const payloadStr = JSON.stringify(interaction.updateCalls[0]);
    expect(payloadStr).toContain(localizer("en-US", "commands.setup.wizard.cancelled_title"));

    // Verify draft was consumed
    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("missing");

    // Second click returns expired session
    const secondInteraction = makeMockInteraction({ customId });
    await dispatchGlobalInteraction({} as Client, secondInteraction);
    expect(secondInteraction.updateCalls.length).toBe(1);
    const secondStr = JSON.stringify(secondInteraction.updateCalls[0]);
    expect(secondStr).toContain(localizer("en-US", "commands.setup.wizard.expired_title"));
  });

  it("switches to User BYOK and repaints dashboard on provider-mode select", async () => {
    const nonce = "nonce-byok-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({
      customId,
      kind: "string",
      values: ["user-byok"],
    });

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(interaction.updateCalls.length).toBe(1);

    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("ok");
    if (check.status === "ok") {
      expect(check.draft.providerAccess?.mode).toBe("user-byok");
    }
  });
});
