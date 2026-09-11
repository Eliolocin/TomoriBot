import { beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  ComponentType,
  PermissionsBitField,
  type ActionRowData,
  type ButtonComponentData,
  type ChatInputCommandInteraction,
  type Client,
  type ContainerComponentData,
} from "discord.js";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  isSetupDraftProviderAccessComplete,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import { setupCustomEndpointCapabilitySchema } from "@/types/db/schema";
import { readSetupDraft, resetSetupDrafts, storeSetupDraft } from "@/utils/discord/interactions/setupDraftStore";
import {
  buildSetupCancelRouteId,
  buildSetupDashboardRouteId,
  buildSetupEndpointConnectionRouteId,
  buildSetupEndpointConnectionSubmitRouteId,
  buildSetupEndpointModelRouteId,
  buildSetupEndpointModelSubmitRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupProviderByokSubmitRouteId,
  buildSetupProviderCatalogSubmitRouteId,
  buildSetupProviderModeRouteId,
  buildSetupProviderRouteId,
  buildSetupSettingsRouteId,
  parseSetupProviderByokSubmitRoute,
  startSetupWizard,
} from "@/utils/discord/interactions/setupRoutes";
import {
  buildSetupByokModal,
  buildSetupByokModalFieldId,
  buildSetupCatalogModal,
  buildSetupCatalogModalFieldId,
  buildSetupEndpointConnectionModal,
  buildSetupEndpointConnectionModalFieldId,
  buildSetupEndpointModelModal,
  buildSetupEndpointModelModalFieldId,
  buildSetupWizardPayload,
  getSetupCatalogProviderChoices,
} from "@/utils/discord/ui/setupPanel";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { ProviderFactory } from "@/utils/provider/providerFactory";
import * as cryptoModule from "@/utils/security/crypto";
import * as customEndpointService from "@/utils/provider/customEndpointService";
import * as modalModule from "@/utils/discord/ui/modals";

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
  kind?: "button" | "string" | "modal";
  actorDiscId?: string;
  guildId?: string | null;
  canManageGuild?: boolean;
  values?: string[];
  fields?: Record<string, string>;
  interactionId?: string;
}

function makeMockInteraction({
  customId,
  kind = "button",
  actorDiscId = "actor-1",
  guildId = "guild-1",
  canManageGuild = true,
  values = [],
  fields = {},
  interactionId,
}: MockInteractionOptions): GlobalRoutableInteraction & {
  replyCalls: unknown[];
  updateCalls: unknown[];
  editReplyCalls: unknown[];
} {
  const replyCalls: unknown[] = [];
  const updateCalls: unknown[] = [];
  const editReplyCalls: unknown[] = [];

  const id = interactionId ?? `interaction-${customId}`;
  const interaction = {
    id,
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
    isMessageComponent: () => kind === "button" || kind === "string",
    isModalSubmit: () => kind === "modal",
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    values,
    fields: {
      getTextInputValue: (fieldId: string) => fields[fieldId] ?? "",
    },
    reply: async (payload: unknown) => {
      interaction.replied = true;
      replyCalls.push(payload);
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    update: async (payload: unknown) => {
      interaction.replied = true;
      updateCalls.push(payload);
    },
    editReply: async (payload: unknown) => {
      editReplyCalls.push(payload);
    },
    followUp: async (payload: unknown) => {
      replyCalls.push(payload);
    },
    replyCalls,
    updateCalls,
    editReplyCalls,
  };

  return interaction as unknown as GlobalRoutableInteraction & {
    replyCalls: unknown[];
    updateCalls: unknown[];
    editReplyCalls: unknown[];
  };
}

describe("setupWizardRoutes", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

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

  it("opens raw modal and writes nothing to draft when selecting user-byok in a guild", async () => {
    const nonce = "nonce-byok-modal-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    let openedModal: { custom_id: string; title: string; components: unknown[] } | null = null;
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async (_interaction, modal) => {
      openedModal = modal as typeof openedModal;
    });

    try {
      const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "string",
        values: ["user-byok"],
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
      expect(openedModal).not.toBeNull();
      const modalCustomId = openedModal?.custom_id ?? "";
      const parsed = parseSetupProviderByokSubmitRoute(modalCustomId);
      expect(parsed).not.toBeNull();
      expect(parsed?.action).toBe("provider-byok-submit");
      expect(parsed?.nonce).toBe(nonce);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("builds byok modal with literal types 10 and 21 and yes/no options", () => {
    const nonce = "nonce-byok-modal-layout";
    const modal = buildSetupByokModal("en-US", nonce);

    expect(modal.custom_id).toBe(buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce }));
    expect(modal.components.length).toBe(2);

    const first = modal.components[0];
    const second = modal.components[1];

    expect(first.type).toBe(10);
    expect(typeof first.content).toBe("string");
    expect(first.content).toContain("/personal providers");

    expect(second.type).toBe(21);
    expect(second.custom_id).toBe(buildSetupByokModalFieldId("confirm", nonce));
    expect(second.required).toBe(true);
    expect(second.min_values).toBe(1);
    expect(second.max_values).toBe(1);
    expect(second.options?.length).toBe(2);
    expect(second.options?.[0].value).toBe("yes");
    expect(second.options?.[1].value).toBe("no");
  });

  it("stores user-byok mode and marks provider access complete on yes submission", async () => {
    const nonce = "nonce-byok-yes-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("yes");

    try {
      const customId = buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toEqual({ mode: "user-byok" });
        expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(true);
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("leaves prior completed catalog access byte-for-byte intact on no submission", async () => {
    const nonce = "nonce-byok-no-catalog";
    const originalBuffer = Buffer.from("super-secret-catalog-api-key-bytes-12345");
    const priorCatalogAccess = {
      mode: "catalog" as const,
      provider: "google",
      encryptedApiKey: originalBuffer,
      keyVersion: 2,
    };
    storeSetupDraft(nonce, makeDraft({ providerAccess: priorCatalogAccess }));

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("no");

    try {
      const customId = buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).not.toBeNull();
        expect(check.draft.providerAccess?.mode).toBe("catalog");
        if (check.draft.providerAccess?.mode === "catalog") {
          expect(check.draft.providerAccess.provider).toBe("google");
          expect(check.draft.providerAccess.keyVersion).toBe(2);
          expect(check.draft.providerAccess.encryptedApiKey).toBe(originalBuffer);
          expect(check.draft.providerAccess.encryptedApiKey.equals(originalBuffer)).toBe(true);
          expect(check.draft.providerAccess.encryptedApiKey.toString("utf8")).toBe(
            "super-secret-catalog-api-key-bytes-12345",
          );
        }
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("leaves providerAccess null and pending on no submission when no prior choice existed", async () => {
    const nonce = "nonce-byok-no-null";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("no");

    try {
      const customId = buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
        expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(false);
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("writes nothing and repaints with notice on forged radio submission", async () => {
    const nonce = "nonce-byok-forged-choice";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("maybe-exploit");

    try {
      const customId = buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.byok_choice_invalid"));

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("rejects selecting user-byok in a dm context without modal or write", async () => {
    const nonce = "nonce-byok-dm-select";
    storeSetupDraft(
      nonce,
      makeDraft({
        context: "dm",
        workspaceKey: "actor-1",
        actorDiscId: "actor-1",
        providerAccess: null,
      }),
    );

    let modalOpened = false;
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async () => {
      modalOpened = true;
    });

    try {
      const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "string",
        guildId: null,
        values: ["user-byok"],
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalOpened).toBe(false);
      expect(interaction.replyCalls.length).toBe(1);
      const replyJson = JSON.stringify(interaction.replyCalls[0]);
      expect(replyJson).toContain(localizer("en-US", "commands.setup.wizard.provider_byok_guild_only"));

      const check = readSetupDraft(nonce, "actor-1", "actor-1", "dm");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("rejects forged provider-byok-submit route in a dm context without write", async () => {
    const nonce = "nonce-byok-dm-submit";
    storeSetupDraft(
      nonce,
      makeDraft({
        context: "dm",
        workspaceKey: "actor-1",
        actorDiscId: "actor-1",
        providerAccess: null,
      }),
    );

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("yes");

    try {
      const customId = buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        guildId: null,
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.provider_byok_guild_only"));

      const check = readSetupDraft(nonce, "actor-1", "actor-1", "dm");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("opens raw modal and writes nothing to draft when selecting catalog mode", async () => {
    const nonce = "nonce-cat-modal-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    let openedModal: { custom_id: string; title: string; components: unknown[] } | null = null;
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async (_interaction, modal) => {
      openedModal = modal as typeof openedModal;
    });

    try {
      const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "string",
        values: ["catalog"],
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
      expect(openedModal).not.toBeNull();
      expect(openedModal?.custom_id).toBe(buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce }));

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("builds catalog modal containing curated providers while excluding non-curated services", () => {
    const nonce = "nonce-cat-options-1";
    const modal = buildSetupCatalogModal("en-US", nonce);

    expect(modal.custom_id).toBe(buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce }));
    expect(modal.title).toBe(localizer("en-US", "commands.setup.wizard.catalog_modal_title"));
    expect(modal.components.length).toBe(2);

    const row1 = modal.components[0] as {
      type: number;
      component?: { type: number; custom_id?: string; options?: Array<{ value: string }> };
    };
    expect(row1.type).toBe(18);
    expect(row1.component?.custom_id).toBe(buildSetupCatalogModalFieldId("provider", nonce));

    const options = row1.component?.options ?? [];
    const optionValues = options.map((opt) => opt.value);

    const curatedChoices = getSetupCatalogProviderChoices();
    expect(optionValues).toEqual(curatedChoices.map((choice) => choice.value));

    expect(optionValues).toContain("google");
    expect(optionValues).not.toContain("elevenlabs");
    expect(optionValues).not.toContain("brave");
    expect(optionValues).not.toContain("custom");

    const row2 = modal.components[1] as {
      type: number;
      component?: { type: number; custom_id?: string; style: number };
    };
    expect(row2.type).toBe(18);
    expect(row2.component?.custom_id).toBe(buildSetupCatalogModalFieldId("api-key", nonce));
  });

  it("stores encrypted catalog access on successful submit without leaking plaintext key", async () => {
    const nonce = "nonce-cat-submit-ok";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const fakeKey = "test-secret-api-key-12345";
    const mockProvider = {
      validateApiKey: mock(async () => ({ valid: true })),
    };
    const providerSpy = spyOn(ProviderFactory, "getProviderByName").mockResolvedValue(mockProvider as never);
    const encryptSpy = spyOn(cryptoModule, "encryptApiKey").mockResolvedValue({
      encrypted: Buffer.from("encrypted-bytes"),
      version: 2,
    });
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("google");

    try {
      const customId = buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupCatalogModalFieldId("api-key", nonce)]: fakeKey,
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);

      // Confirm plaintext key appears in no reply or edit payloads
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).not.toContain(fakeKey);
      expect(payloadString).not.toContain(localizer("en-US", "commands.setup.wizard.provider_validation_failed"));
      expect(payloadString).not.toContain(localizer("en-US", "commands.setup.wizard.provider_invalid"));

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode).toBe("catalog");
        if (check.draft.providerAccess?.mode === "catalog") {
          expect(check.draft.providerAccess.provider).toBe("google");
          expect(check.draft.providerAccess.encryptedApiKey).toEqual(Buffer.from("encrypted-bytes"));
          expect(check.draft.providerAccess.keyVersion).toBe(2);
        }
      }
    } finally {
      providerSpy.mockRestore();
      encryptSpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("leaves draft unchanged when catalog API key validation fails", async () => {
    const nonce = "nonce-cat-submit-fail";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const fakeKey = "invalid-key-attempt";
    const mockProvider = {
      validateApiKey: mock(async () => ({ valid: false, reason: "invalid key" })),
    };
    const providerSpy = spyOn(ProviderFactory, "getProviderByName").mockResolvedValue(mockProvider as never);
    const encryptSpy = spyOn(cryptoModule, "encryptApiKey");
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("google");

    try {
      const customId = buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupCatalogModalFieldId("api-key", nonce)]: fakeKey,
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.provider_validation_failed"));
      expect(encryptSpy).not.toHaveBeenCalled();

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      providerSpy.mockRestore();
      encryptSpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("renders validation failed notice when provider resolution throws", async () => {
    const nonce = "nonce-cat-factory-throw";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const providerSpy = spyOn(ProviderFactory, "getProviderByName").mockRejectedValue(
      new Error("Provider lookup failed"),
    );
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("google");

    try {
      const customId = buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupCatalogModalFieldId("api-key", nonce)]: "some-api-key",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.provider_validation_failed"));

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      providerSpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("stores incomplete custom-endpoint access on provider-mode select", async () => {
    const nonce = "nonce-custom-1";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({
      customId,
      kind: "string",
      values: ["custom-endpoint"],
    });

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(interaction.updateCalls.length).toBe(1);

    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("ok");
    if (check.status === "ok") {
      expect(check.draft.providerAccess).toEqual({
        mode: "custom-endpoint",
        connection: null,
        textModel: null,
      });
      expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(false);
    }
  });

  it("rejects forged provider value not in curated catalog and writes nothing", async () => {
    const nonce = "nonce-forged-cat";
    storeSetupDraft(nonce, makeDraft({ providerAccess: null }));

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("malicious-provider");
    const encryptSpy = spyOn(cryptoModule, "encryptApiKey");

    try {
      const customId = buildSetupProviderCatalogSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupCatalogModalFieldId("api-key", nonce)]: "some-api-key-value",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.provider_invalid"));
      expect(encryptSpy).not.toHaveBeenCalled();

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toBeNull();
      }
    } finally {
      selectSpy.mockRestore();
      encryptSpy.mockRestore();
    }
  });

  it("replaces existing completed catalog draft when switching to custom-endpoint", async () => {
    const nonce = "nonce-switch-cat-to-custom";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "catalog",
          provider: "google",
          encryptedApiKey: Buffer.from("encrypted"),
          keyVersion: 1,
        },
      }),
    );

    const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
    const interaction = makeMockInteraction({
      customId,
      kind: "string",
      values: ["custom-endpoint"],
    });

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(interaction.updateCalls.length).toBe(1);

    const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
    expect(check.status).toBe("ok");
    if (check.status === "ok") {
      expect(check.draft.providerAccess).toEqual({
        mode: "custom-endpoint",
        connection: null,
        textModel: null,
      });
      expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(false);
    }
  });

  it("renders custom endpoint sub-area only in custom-endpoint mode", () => {
    const hintText = localizer("en-US", "commands.setup.wizard.custom_endpoint_hint");

    const customPayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: null,
          textModel: null,
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-subarea-custom",
    });
    const customJson = JSON.stringify(customPayload);
    expect(customJson).toContain(hintText);
    expect(customJson).toContain(
      buildSetupEndpointConnectionRouteId({ locale: "en-US", nonce: "nonce-subarea-custom" }),
    );
    expect(customJson).toContain(buildSetupEndpointModelRouteId({ locale: "en-US", nonce: "nonce-subarea-custom" }));

    const catalogPayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: {
          mode: "catalog",
          provider: "openai",
          encryptedApiKey: Buffer.from("secret"),
          keyVersion: 1,
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-subarea-cat",
    });
    const catalogJson = JSON.stringify(catalogPayload);
    expect(catalogJson).not.toContain(hintText);
    expect(catalogJson).not.toContain("endpoint-connection");

    const byokPayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: { mode: "user-byok" },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-subarea-byok",
    });
    const byokJson = JSON.stringify(byokPayload);
    expect(byokJson).not.toContain(hintText);
    expect(byokJson).not.toContain("endpoint-connection");
  });

  it("keeps Configure Text Model disabled when connection is null and enables it once set", () => {
    const pendingPayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: null,
          textModel: null,
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-disable-model",
    });

    const pendingContainer = pendingPayload.components[0] as ContainerComponentData<ActionRowData<ButtonComponentData>>;
    const pendingSubRow = pendingContainer.components.find(
      (c): c is ActionRowData<ButtonComponentData> =>
        c.type === ComponentType.ActionRow &&
        c.components?.some(
          (b) => b.customId === buildSetupEndpointModelRouteId({ locale: "en-US", nonce: "nonce-disable-model" }),
        ),
    );
    expect(pendingSubRow).toBeDefined();
    const pendingConnBtn = pendingSubRow?.components[0];
    const pendingModelBtn = pendingSubRow?.components[1];
    expect(pendingConnBtn?.label).toBe(
      localizer("en-US", "commands.setup.wizard.custom_endpoint_button_connection_start"),
    );
    expect(pendingModelBtn?.label).toBe(localizer("en-US", "commands.setup.wizard.custom_endpoint_button_model_start"));
    expect(pendingModelBtn?.disabled).toBe(true);

    const configuredPayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Local Ollama",
            apiStyle: "ollama-native",
            endpointUrl: "http://localhost:11434",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: null,
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-enable-model",
    });

    const configuredContainer = configuredPayload.components[0] as ContainerComponentData<
      ActionRowData<ButtonComponentData>
    >;
    const configuredSubRow = configuredContainer.components.find(
      (c): c is ActionRowData<ButtonComponentData> =>
        c.type === ComponentType.ActionRow &&
        c.components?.some(
          (b) => b.customId === buildSetupEndpointModelRouteId({ locale: "en-US", nonce: "nonce-enable-model" }),
        ),
    );
    expect(configuredSubRow).toBeDefined();
    const configuredConnBtn = configuredSubRow?.components[0];
    const configuredModelBtn = configuredSubRow?.components[1];
    expect(configuredConnBtn?.label).toBe(
      localizer("en-US", "commands.setup.wizard.custom_endpoint_button_connection_edit"),
    );
    expect(configuredModelBtn?.label).toBe(
      localizer("en-US", "commands.setup.wizard.custom_endpoint_button_model_start"),
    );
    expect(configuredModelBtn?.disabled).toBe(false);

    const completePayload = buildSetupWizardPayload({
      draft: makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Local Ollama",
            apiStyle: "ollama-native",
            endpointUrl: "http://localhost:11434",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: {
            modelCode: "llama3",
            numCtx: 4096,
            capabilities: ["tools"],
          },
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: "nonce-edit-model",
    });

    const completeContainer = completePayload.components[0] as ContainerComponentData<
      ActionRowData<ButtonComponentData>
    >;
    const completeSubRow = completeContainer.components.find(
      (c): c is ActionRowData<ButtonComponentData> =>
        c.type === ComponentType.ActionRow &&
        c.components?.some(
          (b) => b.customId === buildSetupEndpointModelRouteId({ locale: "en-US", nonce: "nonce-edit-model" }),
        ),
    );
    expect(completeSubRow?.components[1].label).toBe(
      localizer("en-US", "commands.setup.wizard.custom_endpoint_button_model_edit"),
    );
    expect(completeSubRow?.components[1].disabled).toBe(false);
  });

  it("offers exactly text-capable API styles in the connection modal", () => {
    const modal = buildSetupEndpointConnectionModal("en-US", "nonce-style-check");
    expect(modal.components.length).toBe(4);

    const apiStyleWrapper = modal.components[0];
    expect(apiStyleWrapper.type).toBe(18);
    const select = apiStyleWrapper.component as { type: number; options: Array<{ value: string }> };
    expect(select.type).toBe(3);

    const optionValues = select.options.map((o) => o.value);
    expect(optionValues).toEqual(["openai-compatible", "ollama-native"]);
    expect(optionValues).not.toContain("comfyui");
    expect(optionValues).not.toContain("tts-clone");
    expect(optionValues).not.toContain("elevenlabs");
    expect(optionValues).not.toContain("elevenlabs-transcription");
    expect(optionValues).not.toContain("openai-compatible-transcription");
  });

  it("builds capability component with type 22 and option values matching schema enum", () => {
    const modal = buildSetupEndpointModelModal("en-US", "nonce-cap-check");
    expect(modal.components.length).toBe(3);

    const capWrapper = modal.components[2];
    expect(capWrapper.type).toBe(18);
    const checkboxGroup = capWrapper.component as { type: number; options: Array<{ value: string }> };
    expect(checkboxGroup.type).toBe(22);

    const schemaOptions = new Set<string>(setupCustomEndpointCapabilitySchema.options);
    expect(checkboxGroup.options.length).toBeGreaterThan(0);
    for (const opt of checkboxGroup.options) {
      expect(schemaOptions.has(opt.value)).toBe(true);
      expect(setupCustomEndpointCapabilitySchema.safeParse(opt.value).success).toBe(true);
    }
    expect(checkboxGroup.options.some((o) => o.value === "video")).toBe(false);
  });

  it("stores normalized connection and encrypted token on successful connection submit", async () => {
    const nonce = "nonce-conn-success";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
      }),
    );

    const reachabilitySpy = spyOn(customEndpointService, "validateCustomEndpointReachability").mockResolvedValue({
      ok: true,
    });
    const encryptSpy = spyOn(cryptoModule, "encryptApiKey").mockResolvedValue({
      encrypted: Buffer.from("encrypted-secret"),
      version: 2,
    });
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("openai-compatible");

    try {
      const customId = buildSetupEndpointConnectionSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointConnectionModalFieldId("label", nonce)]: "My OpenAI Server",
          [buildSetupEndpointConnectionModalFieldId("url", nonce)]: "http://localhost:8080",
          [buildSetupEndpointConnectionModalFieldId("auth-token", nonce)]: "bearer-token-123",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      expect(reachabilitySpy).toHaveBeenCalledWith({
        apiStyle: "openai-compatible",
        endpointUrl: "http://localhost:8080/v1",
        apiKey: "bearer-token-123",
      });
      expect(encryptSpy).toHaveBeenCalledWith("bearer-token-123");

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode).toBe("custom-endpoint");
        if (check.draft.providerAccess?.mode === "custom-endpoint") {
          expect(check.draft.providerAccess.connection).toEqual({
            label: "My OpenAI Server",
            apiStyle: "openai-compatible",
            endpointUrl: "http://localhost:8080/v1",
            encryptedAuthToken: Buffer.from("encrypted-secret"),
            keyVersion: 2,
          });
          expect(check.draft.providerAccess.textModel).toBeNull();
        }
      }
    } finally {
      reachabilitySpy.mockRestore();
      encryptSpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("stores null encryptedAuthToken when auth token is blank", async () => {
    const nonce = "nonce-conn-blank-token";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
      }),
    );

    const reachabilitySpy = spyOn(customEndpointService, "validateCustomEndpointReachability").mockResolvedValue({
      ok: true,
    });
    const encryptSpy = spyOn(cryptoModule, "encryptApiKey");
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("ollama-native");

    try {
      const customId = buildSetupEndpointConnectionSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointConnectionModalFieldId("label", nonce)]: "Local Ollama",
          [buildSetupEndpointConnectionModalFieldId("url", nonce)]: "http://localhost:11434",
          [buildSetupEndpointConnectionModalFieldId("auth-token", nonce)]: "   ",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      expect(encryptSpy).not.toHaveBeenCalled();

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode).toBe("custom-endpoint");
        if (check.draft.providerAccess?.mode === "custom-endpoint") {
          expect(check.draft.providerAccess.connection?.encryptedAuthToken).toBeNull();
          expect(check.draft.providerAccess.connection?.keyVersion).toBe(1);
        }
      }
    } finally {
      reachabilitySpy.mockRestore();
      encryptSpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("re-saving connection voids previously stored textModel", async () => {
    const nonce = "nonce-void-model";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Old Connection",
            apiStyle: "openai-compatible",
            endpointUrl: "http://localhost:8000/v1",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: {
            modelCode: "gpt-4o",
            numCtx: 8192,
            capabilities: ["tools", "vision"],
          },
        },
      }),
    );

    const reachabilitySpy = spyOn(customEndpointService, "validateCustomEndpointReachability").mockResolvedValue({
      ok: true,
    });
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("ollama-native");

    try {
      const customId = buildSetupEndpointConnectionSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointConnectionModalFieldId("label", nonce)]: "New Ollama",
          [buildSetupEndpointConnectionModalFieldId("url", nonce)]: "http://localhost:11434",
          [buildSetupEndpointConnectionModalFieldId("auth-token", nonce)]: "",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode).toBe("custom-endpoint");
        if (check.draft.providerAccess?.mode === "custom-endpoint") {
          expect(check.draft.providerAccess.connection?.label).toBe("New Ollama");
          expect(check.draft.providerAccess.textModel).toBeNull();
          expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(false);
        }
      }
    } finally {
      reachabilitySpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("failed reachability probe writes nothing and omits raw reason from notice", async () => {
    const nonce = "nonce-probe-fail";
    const initialDraft = makeDraft({
      providerAccess: {
        mode: "custom-endpoint",
        connection: null,
        textModel: null,
      },
    });
    storeSetupDraft(nonce, initialDraft);

    const secretReason = "Internal ECONNREFUSED 192.168.1.100:5000 server down";
    const reachabilitySpy = spyOn(customEndpointService, "validateCustomEndpointReachability").mockResolvedValue({
      ok: false,
      reason: secretReason,
    });
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("openai-compatible");

    try {
      const customId = buildSetupEndpointConnectionSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointConnectionModalFieldId("label", nonce)]: "Failing Endpoint",
          [buildSetupEndpointConnectionModalFieldId("url", nonce)]: "http://192.168.1.100:5000",
          [buildSetupEndpointConnectionModalFieldId("auth-token", nonce)]: "",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.custom_endpoint_unreachable"));
      expect(payloadString).not.toContain(secretReason);
      expect(payloadString).not.toContain("192.168.1.100");

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toEqual({
          mode: "custom-endpoint",
          connection: null,
          textModel: null,
        });
      }
    } finally {
      reachabilitySpy.mockRestore();
      selectSpy.mockRestore();
    }
  });

  it("stores text model with numCtx null when context size is blank or below 512", async () => {
    const nonce = "nonce-model-blank-ctx";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Configured Endpoint",
            apiStyle: "openai-compatible",
            endpointUrl: "http://localhost:8000/v1",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: null,
        },
      }),
    );

    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue(["tools", "vision"]);

    try {
      const customId = buildSetupEndpointModelSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointModelModalFieldId("model-code", nonce)]: "qwen-2.5",
          [buildSetupEndpointModelModalFieldId("num-ctx", nonce)]: "   ",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode).toBe("custom-endpoint");
        if (check.draft.providerAccess?.mode === "custom-endpoint") {
          expect(check.draft.providerAccess.textModel).toEqual({
            modelCode: "qwen-2.5",
            numCtx: null,
            capabilities: ["tools", "vision"],
          });
          expect(isSetupDraftProviderAccessComplete(check.draft.providerAccess)).toBe(true);
        }
      }
    } finally {
      checkboxSpy.mockRestore();
    }
  });

  it("rejects forged capability token outside canonical enum and writes nothing", async () => {
    const nonce = "nonce-forged-cap";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Valid Endpoint",
            apiStyle: "openai-compatible",
            endpointUrl: "http://localhost:8000/v1",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: null,
        },
      }),
    );

    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue([
      "tools",
      "forged_unknown_capability",
    ]);

    try {
      const customId = buildSetupEndpointModelSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointModelModalFieldId("model-code", nonce)]: "llama3",
          [buildSetupEndpointModelModalFieldId("num-ctx", nonce)]: "4096",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.editReplyCalls.length).toBe(1);
      const payloadString = JSON.stringify(interaction.editReplyCalls[0]);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.custom_endpoint_model_invalid"));

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess?.mode === "custom-endpoint");
        if (check.draft.providerAccess?.mode === "custom-endpoint") {
          expect(check.draft.providerAccess.textModel).toBeNull();
        }
      }
    } finally {
      checkboxSpy.mockRestore();
    }
  });

  it("rejects forged endpoint-model route against user-byok draft without modal or write", async () => {
    const nonce = "nonce-forged-model-byok";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: { mode: "user-byok" },
      }),
    );

    const modalSpy = spyOn(modalModule, "showRoutedRawModal");

    try {
      const customId = buildSetupEndpointModelRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "button",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).not.toHaveBeenCalled();

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.providerAccess).toEqual({ mode: "user-byok" });
      }
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("opens connection modal when endpoint-connection button is clicked", async () => {
    const nonce = "nonce-open-conn-modal";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: null,
          textModel: null,
        },
      }),
    );

    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupEndpointConnectionRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "button",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("opens text model modal when endpoint-model button is clicked with connection set", async () => {
    const nonce = "nonce-open-model-modal";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: "Local",
            apiStyle: "ollama-native",
            endpointUrl: "http://localhost:11434",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: null,
        },
      }),
    );

    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupEndpointModelRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "button",
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
    } finally {
      modalSpy.mockRestore();
    }
  });
});
