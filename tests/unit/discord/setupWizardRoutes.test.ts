import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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
  isSetupDraftComplete,
  isSetupDraftProviderAccessComplete,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import { setupCustomEndpointCapabilitySchema } from "@/types/db/schema";
import {
  readSetupDraft,
  resetSetupDrafts,
  storeSetupDraft,
  updateSetupDraft,
} from "@/utils/discord/interactions/setupDraftStore";
import * as setupDraftStoreModule from "@/utils/discord/interactions/setupDraftStore";
import {
  buildSetupCancelRouteId,
  buildSetupDashboardRouteId,
  buildSetupEndpointConnectionRouteId,
  buildSetupEndpointConnectionSubmitRouteId,
  buildSetupEndpointModelRouteId,
  buildSetupEndpointModelSubmitRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupPoliciesSubmitRouteId,
  buildSetupProviderByokSubmitRouteId,
  buildSetupProviderCatalogSubmitRouteId,
  buildSetupProviderModeRouteId,
  buildSetupSettingsRouteId,
  buildSetupSettingsSubmitRouteId,
  parseSetupPoliciesSubmitRoute,
  parseSetupProviderByokSubmitRoute,
  parseSetupSettingsSubmitRoute,
  startSetupWizard,
} from "@/utils/discord/interactions/setupRoutes";
import {
  SETUP_POLICY_CHOICE_VALUES,
  SETUP_SYSTEM_PROMPT_BUILT_IN,
  buildSetupByokModal,
  buildSetupByokModalFieldId,
  buildSetupCatalogModal,
  buildSetupCatalogModalFieldId,
  buildSetupEndpointConnectionModal,
  buildSetupEndpointConnectionModalFieldId,
  buildSetupEndpointModelModal,
  buildSetupEndpointModelModalFieldId,
  buildSetupPoliciesModal,
  buildSetupPoliciesModalFieldId,
  buildSetupSettingsModalFieldId,
  buildSetupWizardPayload,
  getSetupCatalogProviderChoices,
} from "@/utils/discord/ui/setupPanel";
import { buildLegalDocUrl } from "@/utils/misc/docsUrl";
import { configRepository, llmModelRepo, personaRepository, serverRepository } from "@/utils/db/repositories";
import type { SystemPromptPresetRow, TomoriPresetRow } from "@/types/db/schema";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { ProviderFactory } from "@/utils/provider/providerFactory";
import * as cryptoModule from "@/utils/security/crypto";
import * as customEndpointService from "@/utils/provider/customEndpointService";
import * as modalModule from "@/utils/discord/ui/modals";
import * as cacheStore from "@/utils/cache/tomoriStateCache";
import * as avatarHelper from "@/utils/image/avatarHelper";
import * as emojiLazySync from "@/utils/cache/emojiLazySync";
import * as stickerLazySync from "@/utils/cache/stickerLazySync";
import * as panelActionMetrics from "@/utils/stats/panelActionMetrics";

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
  /**
   * A guild object for the flows that reach the post-commit effects. The wizard's own arms never
   * read it, which is why the default stays absent.
   */
  guild?: unknown;
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
  guild,
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
    guild,
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
      getTextInputValue: (fieldId: string) => {
        // Discord omits an empty optional text input from a modal submission, and discord.js then
        // throws on the lookup, which is why every optional read in the route is guarded. A mock
        // that returned "" instead would make those guards look unnecessary and hide a real crash.
        if (!(fieldId in fields)) {
          throw new Error(`Modal submit field not found: ${fieldId}`);
        }
        return fields[fieldId] ?? "";
      },
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

/**
 * The policy step exists only in the hosted environment, so the tests that drive it pin `RUN_ENV`.
 * A hook owns the restore rather than a per-test block, because the process-wide mutation would
 * otherwise leak into every other file batched alongside this one.
 */
let previousRunEnv: string | undefined;

const PERSONA_PRESET_ROWS = [
  {
    persona_preset_id: 1770,
    persona_preset_name: "Lighthouse",
    persona_preset_desc: "A steady, watchful companion.",
    preset_language: "en-US",
  },
  {
    persona_preset_id: 3585,
    persona_preset_name: "Sparrow",
    persona_preset_desc: "Quick, curious, and a little bratty.",
    preset_language: "en-US",
  },
] as unknown as TomoriPresetRow[];

const SYSTEM_PROMPT_ROWS = [
  {
    system_prompt_preset_id: 1,
    system_prompt_preset_name: "Tomori Default",
    system_prompt_preset_desc: "The standard reply style.",
    ja_description: "標準の返信スタイル。",
    preset_prompt_text: "You are Tomori.",
  },
  {
    system_prompt_preset_id: 2,
    system_prompt_preset_name: "Concise",
    system_prompt_preset_desc: "Shorter replies.",
    ja_description: null,
    preset_prompt_text: "Reply briefly.",
  },
] as unknown as SystemPromptPresetRow[];

/** Replaces both catalog reads for one test, and returns its own teardown. */
function stubSettingsCatalogs(
  personaPresets: readonly TomoriPresetRow[] | null = PERSONA_PRESET_ROWS,
  promptPresets: readonly SystemPromptPresetRow[] | null = SYSTEM_PROMPT_ROWS,
) {
  const personaSpy = spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue(
    personaPresets === null ? null : ([...personaPresets] as never),
  );
  const promptSpy = spyOn(configRepository, "loadSystemPromptPresets").mockResolvedValue(
    promptPresets === null ? null : ([...promptPresets] as never),
  );
  return {
    restore: () => {
      personaSpy.mockRestore();
      promptSpy.mockRestore();
    },
  };
}

function makeSettingsDraft(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
  return makeDraft({
    providerAccess: {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("secret"),
      keyVersion: 1,
    },
    ...overrides,
  });
}

describe("setupWizardRoutes", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  beforeEach(() => {
    resetSetupDrafts();
    previousRunEnv = process.env.RUN_ENV;
  });

  afterEach(() => {
    if (previousRunEnv === undefined) delete process.env.RUN_ENV;
    else process.env.RUN_ENV = previousRunEnv;
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
      checkExistingSetup: async () => "ready",
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
      checkExistingSetup: async () => "ready",
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    expect(interaction.deferred).toBe(true);
    expect(editedContent).toBe(localizer("en-US", "commands.setup.wizard.permission_denied"));
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("acknowledges before refusing an already-configured workspace in startSetupWizard", async () => {
    const mockStore = mock(() => {});
    let editedPayload: { embeds?: unknown[]; content?: string } | null = null;
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
      editReply: async (payload: { embeds?: unknown[]; content?: string }) => {
        editedPayload = payload;
      },
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => "already-setup",
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    // A healthy workspace is answered with its current provider state and the commands that change
    // it, which is a summary embed rather than the wizard's one-line notice.
    expect(interaction.deferred).toBe(true);
    expect(editedPayload?.embeds?.length).toBe(1);
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("refuses a broken workspace with repair guidance instead of starting a second setup", async () => {
    const mockStore = mock(() => {});
    let editedPayload: { embeds?: Array<{ data?: { title?: string } }> } | null = null;
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
      editReply: async (payload: { embeds?: Array<{ data?: { title?: string } }> }) => {
        editedPayload = payload;
      },
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => "broken",
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    // A main persona with no loadable state is recoverable in place, so setup must not clear it.
    expect(interaction.deferred).toBe(true);
    expect(editedPayload?.embeds?.[0]?.data?.title).toBe(localizer("en-US", "commands.setup.broken_state_title"));
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("still reads a bare boolean health result as the pre-wizard already-setup answer", async () => {
    const mockStore = mock(() => {});
    let editedPayload: { embeds?: unknown[] } | null = null;
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
      editReply: async (payload: { embeds?: unknown[] }) => {
        editedPayload = payload;
      },
    } as unknown as ChatInputCommandInteraction;

    await startSetupWizard(interaction, {
      checkExistingSetup: async () => "already-setup",
      storeSetupDraft: mockStore as typeof storeSetupDraft,
    });

    expect(interaction.deferred).toBe(true);
    expect(editedPayload?.embeds?.length).toBe(1);
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("returns terminal session-ended response for stale or forged nonce without repainting panel", async () => {
    const forgedCustomId = buildSetupDashboardRouteId({ locale: "en-US", nonce: "forged-nonce-1" });
    const interaction = makeMockInteraction({ customId: forgedCustomId });

    const handled = await dispatchGlobalInteraction({} as Client, interaction);
    expect(handled).toBe(true);
    expect(interaction.updateCalls.length).toBe(1);

    const updatePayload = interaction.updateCalls[0] as { components: unknown[] };
    const payloadStr = JSON.stringify(updatePayload);
    expect(payloadStr).toContain(localizer("en-US", "commands.setup.wizard.session_ended_title"));
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

    // A consumed session cannot be used again.
    const secondInteraction = makeMockInteraction({ customId });
    await dispatchGlobalInteraction({} as Client, secondInteraction);
    expect(secondInteraction.updateCalls.length).toBe(1);
    const secondStr = JSON.stringify(secondInteraction.updateCalls[0]);
    expect(secondStr).toContain(localizer("en-US", "commands.setup.wizard.session_ended_title"));
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

  it("nests the byok radio group in a label wrapper inside the text display modal", () => {
    const nonce = "nonce-byok-modal-layout";
    const modal = buildSetupByokModal("en-US", nonce);

    expect(modal.custom_id).toBe(buildSetupProviderByokSubmitRouteId({ locale: "en-US", nonce }));
    expect(modal.components.length).toBe(2);

    const notice = modal.components[0];
    const wrapper = modal.components[1];

    expect(notice.type).toBe(10);
    expect(typeof notice.content).toBe("string");
    expect(notice.content).toContain("/personal providers");

    // 18 is Label, and the group has to sit inside one: the type-18 walk in interactionCore is the
    // only path that records a modal value, so a root-level group renders, submits, and reads back as
    // no selection at all, which is exactly how this path was unreachable before.
    expect(wrapper.type).toBe(18);
    expect(typeof wrapper.label).toBe("string");

    const group = wrapper.component;
    expect(group).toBeDefined();
    expect(group?.type).toBe(21);
    expect(group?.custom_id).toBe(buildSetupByokModalFieldId("confirm", nonce));
    expect(group?.required).toBe(true);
    expect(group?.min_values).toBe(1);
    expect(group?.max_values).toBe(1);
    expect(group?.options?.length).toBe(2);
    expect(group?.options?.[0].value).toBe("yes");
    expect(group?.options?.[1].value).toBe("no");
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

  it("opens raw modal and clears a custom endpoint draft when selecting catalog mode", async () => {
    const nonce = "nonce-cat-modal-1";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
      }),
    );

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
    expect(modal.components.length).toBe(3);

    const help = modal.components[0] as { type: number; content?: string };
    expect(help.type).toBe(10);
    expect(help.content).toContain(commandRegistry.getCommandMention("help"));

    const row1 = modal.components[1] as {
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

    const row2 = modal.components[2] as {
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
      const payload = interaction.editReplyCalls[0] as {
        components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
      };
      const payloadString = JSON.stringify(payload);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.provider_validation_failed"));
      expect(payloadString).not.toContain(fakeKey);
      expect(payload.components).toHaveLength(2);
      expect(payload.components[1]?.accentColor).toBe(0xed4245);
      expect(payload.components[1]?.components?.[0]?.content).toContain(
        localizer("en-US", "commands.setup.wizard.provider_validation_failed_title"),
      );
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

  it("renders a red receipt for an unreachable endpoint without exposing an internal address", async () => {
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
      const payload = interaction.editReplyCalls[0] as {
        components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
      };
      const payloadString = JSON.stringify(payload);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.custom_endpoint_unreachable"));
      expect(payloadString).not.toContain(secretReason);
      expect(payloadString).not.toContain("192.168.1.100");
      expect(payload.components).toHaveLength(2);
      expect(payload.components[1]?.accentColor).toBe(0xed4245);
      expect(payload.components[1]?.components?.[0]?.content).toContain(
        localizer("en-US", "commands.setup.wizard.custom_endpoint_failed_title"),
      );

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

  it("renders a safe endpoint failure reason in the custom endpoint receipt", async () => {
    const nonce = "nonce-probe-safe-reason";
    storeSetupDraft(
      nonce,
      makeDraft({
        providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
      }),
    );

    const reason = "Production requires HTTPS. The target host must be reachable over TLS.";
    const reachabilitySpy = spyOn(customEndpointService, "validateCustomEndpointReachability").mockResolvedValue({
      ok: false,
      reason,
    });
    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockReturnValue("openai-compatible");

    try {
      const customId = buildSetupEndpointConnectionSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: {
          [buildSetupEndpointConnectionModalFieldId("label", nonce)]: "Secure Endpoint",
          [buildSetupEndpointConnectionModalFieldId("url", nonce)]: "https://api.example.com/v1",
          [buildSetupEndpointConnectionModalFieldId("auth-token", nonce)]: "",
        },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      const payload = interaction.editReplyCalls[0] as {
        components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
      };
      expect(payload.components[1]?.accentColor).toBe(0xed4245);
      expect(payload.components[1]?.components?.[0]?.content).toContain("Production requires HTTPS");
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
      const payload = interaction.editReplyCalls[0] as {
        components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
      };
      const payloadString = JSON.stringify(payload);
      expect(payloadString).toContain(localizer("en-US", "commands.setup.wizard.custom_endpoint_model_invalid"));
      expect(payload.components).toHaveLength(2);
      expect(payload.components[1]?.accentColor).toBe(0xed4245);
      expect(payload.components[1]?.components?.[0]?.content).toContain(
        localizer("en-US", "commands.setup.wizard.custom_endpoint_failed_title"),
      );

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

  it("opens the policies acceptance modal from the dashboard button without touching the draft", async () => {
    const nonce = "nonce-policies-open";
    storeSetupDraft(nonce, makeDraft({ requiresPolicies: true }));

    process.env.RUN_ENV = "production";
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupPoliciesRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
      const openedModal = modalSpy.mock.calls[0]?.[1] as { custom_id: string } | undefined;
      const parsed = parseSetupPoliciesSubmitRoute(openedModal?.custom_id ?? "");
      expect(parsed?.action).toBe("policies-submit");
      expect(parsed?.nonce).toBe(nonce);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.policiesAccepted).toBe(false);
      }
    } finally {
      modalSpy.mockRestore();
    }
  });

  it("builds the policies modal from a text display and a nested required checkbox group", () => {
    const nonce = "nonce-policies-modal";
    const modal = buildSetupPoliciesModal("en-US", nonce);

    const rootTypes = modal.components.map((component) => component.type);
    expect(rootTypes[0]).toBe(10);
    expect(rootTypes).toContain(18);

    // 18 is the Label wrapper. The walk in interactionCore only records a checkbox submission for
    // a group nested inside one, so a root-level group would render and read back as no selection.
    const wrapper = modal.components.find((component) => component.type === 18);
    const checkboxGroup = wrapper?.component;
    expect(checkboxGroup?.type).toBe(22);
    expect(checkboxGroup?.min_values).toBe(SETUP_POLICY_CHOICE_VALUES.length);
    expect(checkboxGroup?.max_values).toBe(SETUP_POLICY_CHOICE_VALUES.length);
    expect(checkboxGroup?.required).toBe(true);
    expect(checkboxGroup?.custom_id).toBe(buildSetupPoliciesModalFieldId("acceptance", nonce));
    expect(checkboxGroup?.options?.map((option) => option.value)).toEqual([...SETUP_POLICY_CHOICE_VALUES]);

    const textDisplay = modal.components[0] as { content?: string };
    expect(textDisplay.content).toContain(buildLegalDocUrl("en-US", "terms-of-service"));
    expect(textDisplay.content).toContain(buildLegalDocUrl("en-US", "privacy-policy"));
  });

  it("records policy acceptance and completes the draft only when every confirmation is checked", async () => {
    const nonce = "nonce-policies-both";
    storeSetupDraft(
      nonce,
      makeDraft({
        requiresPolicies: true,
        providerAccess: {
          mode: "catalog",
          provider: "openai",
          encryptedApiKey: Buffer.from("secret"),
          keyVersion: 1,
        },
        startingSettings: {
          presetId: 1770,
          humanizer: 1,
          timezoneOffset: 9,
          systemPrompt: { kind: "built-in" },
        },
      }),
    );

    // The repaint resolves the stored settings against the catalogs, so this case needs a fixture
    // rather than whatever the developer's database happens to hold.
    const catalogs = stubSettingsCatalogs();
    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue([
      "tos",
      "privacy",
      "members",
    ]);

    process.env.RUN_ENV = "production";

    try {
      const customId = buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "modal" });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.policiesAccepted).toBe(true);
        expect(isSetupDraftComplete(check.draft)).toBe(true);
      }

      expect(interaction.editReplyCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      // The step has to come back complete in the panel the actor actually sees, not only in the
      // store: a repaint built from the pre-write record still writes correctly and still posts once.
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.policies_completed"));
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.policies_button_edit"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.policies_pending"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.policies_button_start"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.policies_required"));
      // The settings row has to resolve too, or the repaint would show it re-pended.
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_edit"));
    } finally {
      checkboxSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("answers with the session-ended state when the draft is gone before the write lands", async () => {
    const nonce = "settings-gone";
    process.env.RUN_ENV = "production";
    storeSetupDraft(nonce, makeDraft({ requiresPolicies: true }));

    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue([
      "tos",
      "privacy",
      "members",
    ]);
    const updateSpy = spyOn(setupDraftStoreModule, "updateSetupDraft").mockReturnValue({ status: "missing" });

    try {
      const customId = buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "modal" });

      await dispatchGlobalInteraction({} as Client, interaction);

      // A verdict of "accepted" for a draft that no longer exists is the one outcome this path must
      // not invent. The modal has already closed by then, so a silent return would leave the actor
      // unable to tell whether their acceptance registered.
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(interaction.editReplyCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.session_ended_title"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.policies_completed"));
      expect(interaction.updateCalls.length).toBe(0);
    } finally {
      updateSpy.mockRestore();
      checkboxSpy.mockRestore();
    }
  });

  // Pinned with both documents accepted so that dropping the member-notice confirmation from
  // SETUP_POLICY_CHOICE_VALUES fails here rather than silently relaxing the gate.
  it("leaves policies pending and repaints with a notice when the member notice is unchecked", async () => {
    const nonce = "nonce-policies-one";
    storeSetupDraft(nonce, makeDraft({ requiresPolicies: true }));

    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue(["tos", "privacy"]);

    process.env.RUN_ENV = "production";

    try {
      const customId = buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "modal" });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.policiesAccepted).toBe(false);
      }

      expect(interaction.editReplyCalls.length).toBe(1);
      expect(JSON.stringify(interaction.editReplyCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.policies_required"),
      );
    } finally {
      checkboxSpy.mockRestore();
    }
  });

  it("leaves policies pending when nothing is selected or the values are unrecognized", async () => {
    process.env.RUN_ENV = "production";

    for (const submitted of [[], ["forged_policy_value"]]) {
      const nonce = `nonce-policies-${submitted.length === 0 ? "empty" : "forged"}`;
      resetSetupDrafts();
      storeSetupDraft(nonce, makeDraft({ requiresPolicies: true }));

      const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue(submitted);

      try {
        const customId = buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce });
        const interaction = makeMockInteraction({ customId, kind: "modal" });

        await dispatchGlobalInteraction({} as Client, interaction);

        const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
        expect(check.status).toBe("ok");
        if (check.status === "ok") {
          expect(check.draft.policiesAccepted).toBe(false);
        }

        expect(interaction.editReplyCalls.length).toBe(1);
        expect(JSON.stringify(interaction.editReplyCalls[0])).toContain(
          localizer("en-US", "commands.setup.wizard.policies_required"),
        );
      } finally {
        checkboxSpy.mockRestore();
      }
    }
  });

  it("refuses a policies route on a draft whose captured step set disagrees with the environment", async () => {
    const nonce = "nonce-policies-forged";
    process.env.RUN_ENV = "production";

    // Nothing can flip a live draft's captured requirement: startSetupWizard stores it from the same
    // predicate the route re-reads, so the reachable form of drift is the environment moving under a
    // draft, which is what this pins. The submit must not acknowledge, repaint, or write.
    const draft = makeDraft({ requiresPolicies: false });
    storeSetupDraft(nonce, draft);

    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue([
      "tos",
      "privacy",
      "members",
    ]);

    try {
      const customId = buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "modal" });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.policiesAccepted).toBe(false);
      }

      expect(checkboxSpy).not.toHaveBeenCalled();
      expect(interaction.editReplyCalls.length).toBe(0);
      expect(interaction.updateCalls.length).toBe(0);
      expect(interaction.replyCalls.length).toBe(1);
      expect((interaction.replyCalls[0] as { content: string }).content).toBe(
        localizer("en-US", "commands.setup.wizard.env_mismatch"),
      );
    } finally {
      checkboxSpy.mockRestore();
    }
  });

  it("refuses every policy route on a non-hosted draft instead of leaving it unanswered", async () => {
    const nonce = "nonce-policies-not-hosted";
    storeSetupDraft(nonce, makeDraft({ requiresPolicies: false }));

    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();
    const checkboxSpy = spyOn(modalModule, "takeRawModalCheckboxGroupValues").mockReturnValue([
      "tos",
      "privacy",
      "members",
    ]);

    try {
      const opens = [
        {
          customId: buildSetupPoliciesRouteId({ locale: "en-US", nonce }),
          kind: "button" as const,
          channel: "reply" as const,
        },
        {
          customId: buildSetupPoliciesSubmitRouteId({ locale: "en-US", nonce }),
          kind: "modal" as const,
          channel: "editReply" as const,
        },
      ];

      for (const open of opens) {
        const interaction = makeMockInteraction({ customId: open.customId, kind: open.kind });

        await dispatchGlobalInteraction({} as Client, interaction);

        // An unacknowledged component interaction renders as a failed interaction, so both routes
        // have to answer. A button answers with its own ephemeral reply; a modal submit has already
        // deferred by then and answers through the repaint channel.
        const answered = open.channel === "reply" ? interaction.replyCalls[0] : interaction.editReplyCalls[0];
        expect(answered).toBeDefined();
        expect(JSON.stringify(answered)).toContain(localizer("en-US", "commands.setup.wizard.policies_denied"));
        expect(interaction.replyCalls.length + interaction.editReplyCalls.length).toBe(1);
      }

      expect(modalSpy).not.toHaveBeenCalled();
      expect(checkboxSpy).not.toHaveBeenCalled();

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.policiesAccepted).toBe(false);
      }
    } finally {
      checkboxSpy.mockRestore();
      modalSpy.mockRestore();
    }
  });

  it("opens one four-row settings modal with literals 18, 3 and 4 for its nested fields", async () => {
    const nonce = "settings-open";
    storeSetupDraft(nonce, makeSettingsDraft());
    const catalogs = stubSettingsCatalogs();

    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupSettingsRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).toHaveBeenCalledTimes(1);
      const openedModal = modalSpy.mock.calls[0]?.[1] as
        | {
            custom_id: string;
            components: Array<{
              type: number;
              description?: string;
              component?: { type: number; custom_id?: string; options?: Array<{ description?: string }> };
            }>;
          }
        | undefined;

      const parsed = parseSetupSettingsSubmitRoute(openedModal?.custom_id ?? "");
      expect(parsed?.action).toBe("settings-submit");
      expect(parsed?.nonce).toBe(nonce);

      const rows = openedModal?.components ?? [];
      expect(rows.length).toBe(4);
      for (const row of rows) {
        // 18 is the Label wrapper, which is what the type-18 walk in interactionCore reads. A row
        // left at the modal root renders and then submits as no value at all.
        expect(row.type).toBe(18);
        expect(row.component).toBeDefined();
      }
      expect(rows.map((row) => row.description)).toEqual([
        localizer("en-US", "commands.setup.wizard.settings_persona_description"),
        localizer("en-US", "commands.setup.wizard.settings_humanizer_description"),
        localizer("en-US", "commands.setup.wizard.settings_timezone_description"),
        localizer("en-US", "commands.setup.wizard.settings_system_prompt_description"),
      ]);
      expect(rows.map((row) => row.component?.type)).toEqual([3, 3, 4, 3]);
      expect(rows.map((row) => row.component?.custom_id)).toEqual([
        buildSetupSettingsModalFieldId("persona", nonce),
        buildSetupSettingsModalFieldId("humanizer", nonce),
        buildSetupSettingsModalFieldId("timezone", nonce),
        buildSetupSettingsModalFieldId("system-prompt", nonce),
      ]);
      expect(rows[3]?.component?.options?.[0]?.description).toBe(
        localizer("en-US", "commands.setup.wizard.settings_built_in_prompt_description"),
      );
    } finally {
      modalSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("stores all four settings identities and repaints the completed step", async () => {
    const nonce = "settings-save";
    storeSetupDraft(nonce, makeSettingsDraft());
    const catalogs = stubSettingsCatalogs();

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockImplementation((_id, fieldId) => {
      if (fieldId.includes("persona")) return "1770";
      if (fieldId.includes("humanizer")) return "2";
      if (fieldId.includes("system-prompt")) return "Tomori Default";
      return undefined;
    });

    try {
      const customId = buildSetupSettingsSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: { [buildSetupSettingsModalFieldId("timezone", nonce)]: " +8 " },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.startingSettings).toEqual({
          presetId: 1770,
          humanizer: 2,
          timezoneOffset: 8,
          systemPrompt: { kind: "preset", presetName: "Tomori Default" },
        });
      }

      expect(interaction.editReplyCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_edit"));
      expect(repainted).toContain("Lighthouse");
      expect(repainted).toContain("Tomori Default");
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.settings_pending"));
    } finally {
      selectSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("saves a settings submission that omits the optional timezone field entirely", async () => {
    const nonce = "omit-timezone";
    resetSetupDrafts();
    storeSetupDraft(nonce, makeSettingsDraft());
    const catalogs = stubSettingsCatalogs();

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockImplementation((_id, fieldId) => {
      if (fieldId.includes("persona")) return "1770";
      if (fieldId.includes("humanizer")) return "1";
      if (fieldId.includes("system-prompt")) return SETUP_SYSTEM_PROMPT_BUILT_IN;
      return undefined;
    });

    try {
      // Discord omits an empty optional text input from the submission, so a real submit of a blank
      // timezone arrives with no field at all. This is the only case that reaches the guarded read.
      const customId = buildSetupSettingsSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "modal", fields: {} });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.startingSettings).toEqual({
          presetId: 1770,
          humanizer: 1,
          timezoneOffset: 0,
          systemPrompt: { kind: "built-in" },
        });
      }

      expect(interaction.editReplyCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_edit"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.settings_timezone_invalid"));
    } finally {
      selectSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("defaults a blank timezone to UTC and stores the built-in prompt sentinel, not catalog text", async () => {
    const nonce = "settings-utc";
    storeSetupDraft(nonce, makeSettingsDraft());
    const catalogs = stubSettingsCatalogs();

    const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockImplementation((_id, fieldId) => {
      if (fieldId.includes("persona")) return "3585";
      if (fieldId.includes("humanizer")) return "0";
      if (fieldId.includes("system-prompt")) return SETUP_SYSTEM_PROMPT_BUILT_IN;
      return undefined;
    });

    try {
      const customId = buildSetupSettingsSubmitRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({
        customId,
        kind: "modal",
        fields: { [buildSetupSettingsModalFieldId("timezone", nonce)]: "" },
      });

      await dispatchGlobalInteraction({} as Client, interaction);

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.startingSettings).toEqual({
          presetId: 3585,
          humanizer: 0,
          timezoneOffset: 0,
          systemPrompt: { kind: "built-in" },
        });
        // The draft carries the identity, never a copy of the preset text, so the read-time default
        // keeps evolving until the commit re-resolves it.
        expect(JSON.stringify(check.draft.startingSettings)).not.toContain("You are Tomori");
      }

      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_built_in_prompt_summary"));
      expect(repainted).toContain("UTC+0");
    } finally {
      selectSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("rejects an unusable timezone, humanizer, persona or prompt without writing settings", async () => {
    const rejected = [
      {
        persona: "1770",
        humanizer: "1",
        prompt: "Tomori Default",
        timezone: "99",
        key: "out-of-range",
        notice: "settings_timezone_out_of_range",
      },
      {
        persona: "1770",
        humanizer: "1",
        prompt: "Tomori Default",
        timezone: "abc",
        key: "not-a-number",
        notice: "settings_timezone_invalid",
      },
      {
        persona: "9999",
        humanizer: "1",
        prompt: "Tomori Default",
        timezone: "0",
        key: "forged-persona",
        notice: "settings_persona_stale",
      },
      {
        persona: "1770",
        humanizer: "7",
        prompt: "Tomori Default",
        timezone: "0",
        key: "off-enum-humanizer",
        notice: "settings_persona_stale",
      },
      {
        persona: "1770",
        humanizer: "1",
        prompt: "Removed Prompt",
        timezone: "0",
        key: "removed-prompt",
        notice: "settings_persona_stale",
      },
    ];

    for (const submitted of rejected) {
      const nonce = `reject-${submitted.key}`;
      resetSetupDrafts();
      storeSetupDraft(nonce, makeSettingsDraft());
      const catalogs = stubSettingsCatalogs();

      const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockImplementation((_id, fieldId) => {
        if (fieldId.includes("persona")) return submitted.persona;
        if (fieldId.includes("humanizer")) return submitted.humanizer;
        if (fieldId.includes("system-prompt")) return submitted.prompt;
        return undefined;
      });

      try {
        const customId = buildSetupSettingsSubmitRouteId({ locale: "en-US", nonce });
        const interaction = makeMockInteraction({
          customId,
          kind: "modal",
          fields: { [buildSetupSettingsModalFieldId("timezone", nonce)]: submitted.timezone },
        });

        await dispatchGlobalInteraction({} as Client, interaction);

        const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
        expect(check.status).toBe("ok");
        if (check.status === "ok") {
          expect(check.draft.startingSettings).toBeNull();
        }

        expect(interaction.editReplyCalls.length).toBe(1);
        const payload = interaction.editReplyCalls[0] as {
          components: Array<{ accentColor?: number; components?: Array<{ content?: string }> }>;
        };
        const repainted = JSON.stringify(payload);
        expect(repainted).toContain(localizer("en-US", `commands.setup.wizard.${submitted.notice}`));
        expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_pending"));
        expect(payload.components).toHaveLength(2);
        expect(payload.components[1]?.accentColor).toBe(0xed4245);
        expect(payload.components[1]?.components?.[0]?.content).toContain(
          localizer("en-US", "commands.setup.wizard.change_failed_title"),
        );
      } finally {
        selectSpy.mockRestore();
        catalogs.restore();
      }
    }
  });

  it("keeps the timezone editable by re-parsing the exact value the editor pre-fills", async () => {
    for (const saved of [0, 8, -5, 14]) {
      const nonce = `roundtrip-${saved < 0 ? "neg" : ""}${Math.abs(saved)}`;
      resetSetupDrafts();
      storeSetupDraft(nonce, makeSettingsDraft());

      const catalogs = stubSettingsCatalogs();
      const selectSpy = spyOn(modalModule, "takeRawModalSelectValue").mockImplementation((_id, fieldId) => {
        if (fieldId.includes("persona")) return "1770";
        if (fieldId.includes("humanizer")) return "1";
        if (fieldId.includes("system-prompt")) return SETUP_SYSTEM_PROMPT_BUILT_IN;
        return undefined;
      });
      const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

      try {
        const openId = buildSetupSettingsRouteId({ locale: "en-US", nonce });
        await dispatchGlobalInteraction({} as Client, makeMockInteraction({ customId: openId, kind: "button" }));

        // The value the editor itself would pre-fill on the second open, taken from the modal it
        // built at the first save rather than from the formatter directly.
        const firstModal = modalSpy.mock.calls[0]?.[1] as
          | { components: Array<{ component?: { type: number; value?: string } }> }
          | undefined;
        const firstTimezoneRow = firstModal?.components.find((row) => row.component?.type === 4);

        const submitId = buildSetupSettingsSubmitRouteId({ locale: "en-US", nonce });
        await dispatchGlobalInteraction(
          {} as Client,
          makeMockInteraction({
            customId: submitId,
            kind: "modal",
            fields: { [buildSetupSettingsModalFieldId("timezone", nonce)]: String(saved) },
          }),
        );

        const saved1 = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
        expect(saved1.status).toBe("ok");
        if (saved1.status === "ok") {
          expect(saved1.draft.startingSettings?.timezoneOffset).toBe(saved);
        }

        // Reopen: the text input must come back pre-filled with a value that parses to the same
        // offset, which a "UTC+8" style display form would not.
        modalSpy.mockClear();
        await dispatchGlobalInteraction({} as Client, makeMockInteraction({ customId: openId, kind: "button" }));
        const secondModal = modalSpy.mock.calls[0]?.[1] as
          | { components: Array<{ component?: { type: number; value?: string } }> }
          | undefined;
        const prefilled = secondModal?.components.find((row) => row.component?.type === 4)?.component?.value;

        expect(prefilled).toBe(String(saved));
        expect(firstTimezoneRow?.component?.value).toBeUndefined();

        // And resubmitting that pre-filled value unchanged must save rather than reject.
        await dispatchGlobalInteraction(
          {} as Client,
          makeMockInteraction({
            customId: submitId,
            kind: "modal",
            fields: { [buildSetupSettingsModalFieldId("timezone", nonce)]: prefilled ?? "" },
          }),
        );

        const saved2 = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
        expect(saved2.status).toBe("ok");
        if (saved2.status === "ok") {
          expect(saved2.draft.startingSettings?.timezoneOffset).toBe(saved);
        }
      } finally {
        modalSpy.mockRestore();
        selectSpy.mockRestore();
        catalogs.restore();
      }
    }
  });

  it("re-pends the step when the stored persona has left the live catalog", async () => {
    const nonce = "drift-persona-gone";
    const removedField = "persona";
    const summaryKey = "commands.setup.wizard.settings_summary_persona";
    const summaryVariable = "persona";
    const stored = {
      presetId: 1770,
      humanizer: 1,
      timezoneOffset: 9,
      systemPrompt: { kind: "preset" as const, presetName: "Tomori Default" },
    };
    resetSetupDrafts();
    storeSetupDraft(nonce, makeDraft({ startingSettings: { ...stored } }));

    const personaSpy = spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue([
      PERSONA_PRESET_ROWS[1],
    ] as never);
    const promptSpy = spyOn(configRepository, "loadSystemPromptPresets").mockResolvedValue([
      ...SYSTEM_PROMPT_ROWS,
    ] as never);

    try {
      // Read back through the spied method first: if some earlier case left its own spy installed,
      // the fixture below would be silently ignored and this test would pass against the real
      // catalog instead of the one it declared.
      const personaRows = await configRepository.loadPresetRowsByLocale("en-US");
      expect(personaRows?.map((row) => row.persona_preset_id)).toEqual([3585]);

      const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(personaSpy).toHaveBeenCalledTimes(2);
      expect(interaction.updateCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.updateCalls[0]);
      // The step re-pends while the removed row reads as unavailable and every other stored value
      // keeps resolving, so which catalog drifted is visible in the panel itself.
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_start"));
      expect(repainted).toContain(
        `> ${localizer("en-US", summaryKey, {
          [summaryVariable]: localizer("en-US", `commands.setup.wizard.settings_${removedField}_unknown`),
        })}`,
      );

      // A removed row re-pends the step without discarding the actor's other stored values.
      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.startingSettings).toEqual(stored);
      }
    } finally {
      personaSpy.mockRestore();
      promptSpy.mockRestore();
    }
  });

  it("re-pends the step when the stored system prompt has left the live catalog", async () => {
    const nonce = "drift-prompt-gone";
    const removedField = "prompt";
    const summaryKey = "commands.setup.wizard.settings_summary_system_prompt";
    const summaryVariable = "prompt";
    const stored = {
      presetId: 1770,
      humanizer: 1,
      timezoneOffset: 9,
      systemPrompt: { kind: "preset" as const, presetName: "Tomori Default" },
    };
    resetSetupDrafts();
    storeSetupDraft(nonce, makeDraft({ startingSettings: { ...stored } }));

    const personaSpy = spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue([
      ...PERSONA_PRESET_ROWS,
    ] as never);
    const promptSpy = spyOn(configRepository, "loadSystemPromptPresets").mockResolvedValue([
      SYSTEM_PROMPT_ROWS[1],
    ] as never);

    try {
      const promptRows = await configRepository.loadSystemPromptPresets();
      expect(promptRows?.map((row) => row.system_prompt_preset_name)).toEqual(["Concise"]);

      const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(promptSpy).toHaveBeenCalledTimes(2);
      expect(interaction.updateCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.updateCalls[0]);
      // The step re-pends while the removed row reads as unavailable and every other stored value
      // keeps resolving, so which catalog drifted is visible in the panel itself.
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_start"));
      expect(repainted).toContain(
        `> ${localizer("en-US", summaryKey, {
          [summaryVariable]: localizer("en-US", `commands.setup.wizard.settings_${removedField}_unknown`),
        })}`,
      );

      const check = readSetupDraft(nonce, "actor-1", "guild-1", "guild");
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.draft.startingSettings).toEqual(stored);
      }
    } finally {
      personaSpy.mockRestore();
      promptSpy.mockRestore();
    }
  });

  it("refuses to open the settings editor when a catalog read fails", async () => {
    const nonce = "no-catalog-read";
    storeSetupDraft(nonce, makeDraft());
    const catalogs = stubSettingsCatalogs(null, null);

    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupSettingsRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).not.toHaveBeenCalled();
      expect(interaction.updateCalls.length).toBe(1);
      expect(JSON.stringify(interaction.updateCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.settings_unavailable"),
      );
    } finally {
      modalSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("refuses to open the settings editor when a catalog overflows the modal select cap", async () => {
    const nonce = "over-cap-catalog";
    storeSetupDraft(nonce, makeDraft());

    // 25 prompts plus the synthetic built-in default is one option past Discord's cap for a single
    // string select, and these selects are not the paginated selector.
    const tooManyPrompts = Array.from({ length: 25 }, (_, index) => ({
      system_prompt_preset_id: index + 1,
      system_prompt_preset_name: `Preset ${index + 1}`,
      system_prompt_preset_desc: "A reply style.",
      ja_description: null,
      preset_prompt_text: "Prompt text.",
    })) as unknown as SystemPromptPresetRow[];

    const catalogs = stubSettingsCatalogs(PERSONA_PRESET_ROWS, tooManyPrompts);
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockResolvedValue();

    try {
      const customId = buildSetupSettingsRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(modalSpy).not.toHaveBeenCalled();
      expect(interaction.updateCalls.length).toBe(1);
      expect(JSON.stringify(interaction.updateCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.settings_unavailable"),
      );
    } finally {
      modalSpy.mockRestore();
      catalogs.restore();
    }
  });

  it("says a value could not be checked, not that it is gone, when the catalog read fails", async () => {
    const nonce = "catalog-unreadable";
    resetSetupDrafts();
    storeSetupDraft(
      nonce,
      makeDraft({
        startingSettings: {
          presetId: 1770,
          humanizer: 1,
          timezoneOffset: 9,
          systemPrompt: { kind: "preset", presetName: "Tomori Default" },
        },
      }),
    );

    const catalogs = stubSettingsCatalogs(null, null);

    try {
      const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "button" });

      await dispatchGlobalInteraction({} as Client, interaction);

      const repainted = JSON.stringify(interaction.updateCalls[0]);
      // A read that failed did not establish that the row is absent, so it must not say so.
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_catalog_unavailable"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.settings_persona_unknown"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.settings_prompt_unknown"));
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_start"));
    } finally {
      catalogs.restore();
    }
  });

  it("keeps the finish action disabled when a settings row re-pends, and enabled when it resolves", async () => {
    const build = (presetId: number) =>
      makeDraft({
        providerAccess: {
          mode: "catalog",
          provider: "openai",
          encryptedApiKey: Buffer.from("secret"),
          keyVersion: 1,
        },
        startingSettings: {
          presetId,
          humanizer: 1,
          timezoneOffset: 9,
          systemPrompt: { kind: "built-in" },
        },
      });

    // 1770 resolves in the fixture, 9999 does not, so the two renders differ only in whether the
    // stored persona still exists. The whole ready state has to follow that, not just the step row.
    for (const [label, presetId, settingsResolve] of [
      ["resolved", 1770, true],
      ["drifted", 9999, false],
    ] as const) {
      const nonce = `finish-${label}`;
      resetSetupDrafts();
      storeSetupDraft(nonce, build(presetId));
      const catalogs = stubSettingsCatalogs();

      try {
        const customId = buildSetupDashboardRouteId({ locale: "en-US", nonce });
        const interaction = makeMockInteraction({ customId, kind: "button" });

        await dispatchGlobalInteraction({} as Client, interaction);

        const repainted = JSON.stringify(interaction.updateCalls[0]);
        expect(repainted).toContain(
          localizer("en-US", `commands.setup.wizard.settings_button_${settingsResolve ? "edit" : "start"}`),
        );
        // A panel that reads "1 of 2" while offering an enabled Finish contradicts itself.
        expect(repainted).toContain(
          `"label":"${localizer("en-US", "commands.setup.wizard.finish_label")}","disabled":${settingsResolve ? "false" : "true"}`,
        );
      } finally {
        catalogs.restore();
      }
    }
  });

  it("re-pends the settings step on an unrelated repaint, not only on the dashboard", async () => {
    const nonce = "drift-on-provider";
    resetSetupDrafts();
    storeSetupDraft(
      nonce,
      makeDraft({
        startingSettings: {
          presetId: 1770,
          humanizer: 1,
          timezoneOffset: 9,
          systemPrompt: { kind: "preset", presetName: "Tomori Default" },
        },
      }),
    );

    const personaSpy = spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue([
      PERSONA_PRESET_ROWS[1],
    ] as never);
    const promptSpy = spyOn(configRepository, "loadSystemPromptPresets").mockResolvedValue([
      ...SYSTEM_PROMPT_ROWS,
    ] as never);

    try {
      // Every repaint resolves the catalogs, so a step that has drifted reads as pending even on a
      // repaint that has nothing to do with settings.
      const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce });
      const interaction = makeMockInteraction({ customId, kind: "string", values: ["custom-endpoint"] });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(interaction.updateCalls.length).toBe(1);
      const repainted = JSON.stringify(interaction.updateCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_start"));
      expect(repainted).not.toContain(localizer("en-US", "commands.setup.wizard.settings_button_edit"));
    } finally {
      personaSpy.mockRestore();
      promptSpy.mockRestore();
    }
  });
});

/**
 * The final commit path.
 *
 * These drive the real registry dispatch rather than the exported commit helper, so the assertions
 * cover the seam a button press actually travels: route parse, draft read, the routed guards, the
 * commit, and the receipt the actor ends up looking at.
 */
describe("setupWizardFinish", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  beforeEach(() => {
    resetSetupDrafts();
    previousRunEnv = process.env.RUN_ENV;
  });

  afterEach(() => {
    if (previousRunEnv === undefined) delete process.env.RUN_ENV;
    else process.env.RUN_ENV = previousRunEnv;
  });

  const COMMIT_NONCE = "nonce-finish-commit-1";
  const COMMIT_CATALOGS = {
    persona: PERSONA_PRESET_ROWS[0],
    prompt: SYSTEM_PROMPT_ROWS[0],
  };

  /** A guild object reached only by the post-commit expression sync, which is stubbed out. */
  const COMMIT_GUILD = {
    id: "guild-1",
    name: "Wizard Guild",
    emojis: { cache: new Map() },
    stickers: { cache: new Map() },
  };

  function makeCompleteDraft(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
    return makeDraft({
      providerAccess: {
        mode: "catalog",
        // A real member of the curated catalog, which the commit re-reads before writing.
        provider: "anthropic",
        encryptedApiKey: Buffer.from("encrypted-key"),
        keyVersion: 1,
      },
      startingSettings: {
        presetId: COMMIT_CATALOGS.persona.persona_preset_id,
        humanizer: 2,
        timezoneOffset: 9,
        systemPrompt: { kind: "preset", presetName: COMMIT_CATALOGS.prompt.system_prompt_preset_name },
      },
      ...overrides,
    });
  }

  /**
   * Every read the commit path makes outside the transaction, so a test only states the one it is
   * varying. Returns the spies for assertions and a restore for the caller's finally block.
   */
  function stubCommitDependencies() {
    const spies = [
      spyOn(serverRepository, "loadServerIdByDiscId").mockResolvedValue(null),
      spyOn(personaRepository, "hasMainPersona").mockResolvedValue(false as never),
      spyOn(personaRepository, "loadState").mockResolvedValue({
        server_id: 42,
        is_alter: false,
        config: { llm_id: 7, user_byok_mode: false, tool_use_enabled: true },
        llm: { has_tools: true },
      } as never),
      spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue([COMMIT_CATALOGS.persona] as never),
      spyOn(configRepository, "loadSystemPromptPresets").mockResolvedValue([COMMIT_CATALOGS.prompt] as never),
      spyOn(llmModelRepo, "loadDefaultModel").mockResolvedValue({ llm_codename: "gpt-4o" } as never),
      spyOn(serverRepository, "setup").mockResolvedValue({
        server: { server_id: 42 },
        tomori: {},
        emojis: [],
        stickers: [],
      } as never),
      spyOn(cacheStore, "invalidateTomoriStateCache").mockImplementation(() => {}),
      spyOn(avatarHelper, "getCachedPresetAvatar").mockReturnValue(null),
      spyOn(personaRepository, "markServerMainAvatarSynced").mockResolvedValue(undefined as never),
      spyOn(emojiLazySync, "lazySyncGuildEmojis").mockResolvedValue(undefined as never),
      spyOn(stickerLazySync, "lazySyncGuildStickers").mockResolvedValue(undefined as never),
      spyOn(panelActionMetrics, "recordPanelActionStat").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 })),
    ];

    return {
      setupSpy: spies[6],
      invalidateSpy: spies[7],
      loadStateSpy: spies[2],
      panelActionSpy: spies[12],
      fetchSpy: spies[13],
      restore: () => {
        for (const spy of spies) spy.mockRestore();
      },
    };
  }

  it("commits once, renders the receipt in place, and records exactly one panel action", async () => {
    const stubs = stubCommitDependencies();

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(stubs.setupSpy).toHaveBeenCalledTimes(1);
      const [, writtenConfig] = stubs.setupSpy.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
      expect(writtenConfig.serverId).toBe("guild-1");
      expect(writtenConfig.presetId).toBe(COMMIT_CATALOGS.persona.persona_preset_id);
      expect(writtenConfig.humanizer).toBe(2);
      expect(writtenConfig.timezoneOffset).toBe(9);
      // The prompt is re-read from the live catalog at commit rather than copied into the draft.
      expect(writtenConfig.systemPrompt).toBe(COMMIT_CATALOGS.prompt.preset_prompt_text);
      expect(writtenConfig.providerAccess).toMatchObject({ mode: "catalog", provider: "anthropic" });

      // The receipt replaces the wizard's own message: an editReply, never a second message.
      expect(interaction.editReplyCalls.length).toBe(1);
      expect(interaction.replyCalls.length).toBe(0);
      const receipt = JSON.stringify(interaction.editReplyCalls[0]);
      expect(receipt).toContain(localizer("en-US", "commands.setup.wizard.receipt_title"));
      expect(receipt).toContain("gpt-4o");
      expect(receipt).toContain(COMMIT_CATALOGS.persona.persona_preset_name);
      // The terminal panel carries no controls at all: a stale Finish button must not survive it.
      expect(receipt).not.toContain(buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE }));
      expect(receipt).not.toContain(buildSetupCancelRouteId({ locale: "en-US", nonce: COMMIT_NONCE }));
      // No credential reaches the receipt, in plaintext or as a re-encoded buffer.
      expect(receipt).not.toContain("encrypted-key");
      expect(receipt).not.toContain(COMMIT_NONCE);

      expect(stubs.invalidateSpy).toHaveBeenCalledWith("guild-1");
      expect(stubs.panelActionSpy).toHaveBeenCalledTimes(1);
      expect(stubs.panelActionSpy.mock.calls[0]?.[0]).toMatchObject({
        action: "setup.workspace.setup.complete",
        serverId: 42,
        userDiscId: "actor-1",
      });

      // Consumed, so nothing can replay the transaction through this nonce.
      expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("missing");
    } finally {
      stubs.restore();
    }
  });

  it("acknowledges the button before the first write of the commit", async () => {
    const stubs = stubCommitDependencies();
    let acknowledgedAtWrite: boolean | null = null;
    stubs.setupSpy.mockImplementation((async () => {
      acknowledgedAtWrite = interactionAcknowledged;
      return { server: { server_id: 42 }, tomori: {}, emojis: [], stickers: [] };
    }) as never);

    let interactionAcknowledged = false;

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });
      interaction.deferUpdate = async () => {
        interactionAcknowledged = true;
        interaction.deferred = true;
      };

      await dispatchGlobalInteraction({} as Client, interaction);

      // Discord drops an unacknowledged component interaction at three seconds, and the commit path
      // is a claim, several catalog reads, a transaction, a cache invalidation, an expression sync,
      // and a REST avatar update before the receipt is edited in. Sampling the flag from inside the
      // write is the only way to see the ordering, because the ordering is invisible in what is
      // called: every delivery method here is editReply either way.
      expect(acknowledgedAtWrite).toBe(true);
      expect(interaction.editReplyCalls.length).toBe(1);
    } finally {
      stubs.restore();
    }
  });

  it("refuses an edit that lands while the draft is claimed, keeping the credential live", async () => {
    const stubs = stubCommitDependencies();
    const originalBuffer = Buffer.from("live-credential");

    try {
      storeSetupDraft(COMMIT_NONCE, {
        ...makeCompleteDraft({
          providerAccess: {
            mode: "catalog",
            provider: "anthropic",
            encryptedApiKey: originalBuffer,
            keyVersion: 1,
          },
        }),
        writeClaimed: true,
      });

      // The same authorized actor saves a different provider mode while the commit that claimed the
      // draft is still running. Without a freeze this mutation reaches
      // wipeDisplacedProviderAccessSecrets, which zero-fills the buffer the running commit is about
      // to write, and the setup succeeds with a key that cannot authenticate.
      const customId = buildSetupProviderModeRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, kind: "string", values: ["custom-endpoint"] });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(JSON.stringify(interaction.updateCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.commit_in_progress_title"),
      );
      expect(originalBuffer.equals(Buffer.from("live-credential"))).toBe(true);
      // Refused at the read, so the mode never changed and no arm ran against the frozen draft.
      const stored = readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild");
      expect(stored.status).toBe("in-flight");
    } finally {
      stubs.restore();
    }
  });

  it("freezes the draft at the store, so a save cannot zero the credential being committed", async () => {
    // The route-level refusal above is the outer half of this guard. This is the inner half: the
    // store itself refuses a mutation on a claimed draft, because a caller reaching it by any other
    // path would otherwise wipe the displaced buffer and hand the commit a zeroed key.
    const liveBuffer = Buffer.from("live-credential");
    storeSetupDraft(COMMIT_NONCE, {
      ...makeCompleteDraft({
        providerAccess: { mode: "catalog", provider: "anthropic", encryptedApiKey: liveBuffer, keyVersion: 1 },
      }),
      writeClaimed: true,
    });

    const result = updateSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild", {
      providerAccess: { mode: "user-byok" },
    });

    expect(result.status).toBe("in-flight");
    // The refused mutation did not reach the wipe, so the buffer the commit holds is intact.
    expect(liveBuffer.equals(Buffer.from("live-credential"))).toBe(true);

    // The freeze covers reads, which is what makes the dispatcher's refusal reachable at all.
    expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("in-flight");
  });

  it("drains the claim when receipt delivery fails after the transaction commits", async () => {
    const stubs = stubCommitDependencies();

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());

      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });
      // The row is already committed when this runs, which is exactly the window that used to skip
      // the draft cleanup and leave a claimed draft holding a live encrypted credential.
      interaction.editReply = async (payload: unknown) => {
        interaction.editReplyCalls.push(payload);
        throw new Error("receipt delivery failed after the commit");
      };

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(stubs.setupSpy).toHaveBeenCalledTimes(1);
      // Drained rather than left frozen, so a later press reads the terminal state instead of
      // "already being saved" while a credential remains in memory.
      expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("missing");
    } finally {
      stubs.restore();
    }
  });

  it("drains the claim when an unexpected error escapes between the commit and the receipt", async () => {
    const stubs = stubCommitDependencies();

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());

      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });
      // The transaction has landed by the time the commit path re-reads the workspace to report on
      // it, so throwing on that read is the window that used to leave the draft claimed with its
      // credential still in memory. The first read is the pre-commit health check.
      let loadStateCalls = 0;
      stubs.loadStateSpy.mockImplementation((async () => {
        loadStateCalls += 1;
        if (loadStateCalls > 1) throw new Error("workspace read exploded after the commit");
        return {
          server_id: 42,
          is_alter: false,
          config: { llm_id: 7, user_byok_mode: false, tool_use_enabled: true },
          llm: { has_tools: true },
        };
      }) as never);

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(stubs.setupSpy).toHaveBeenCalledTimes(1);
      // Drained rather than left frozen: a later press reads the terminal state instead of
      // "already being saved" after the commit exits.
      expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("missing");
    } finally {
      stubs.restore();
    }
  });

  it("answers a repeated final submit with the session-ended state and commits nothing", async () => {
    const stubs = stubCommitDependencies();

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });

      await dispatchGlobalInteraction({} as Client, makeMockInteraction({ customId, guild: COMMIT_GUILD }));
      expect(stubs.setupSpy).toHaveBeenCalledTimes(1);

      const second = makeMockInteraction({ customId, guild: COMMIT_GUILD });
      await dispatchGlobalInteraction({} as Client, second);

      expect(stubs.setupSpy).toHaveBeenCalledTimes(1);
      // A consumed nonce is a missing draft, which the route answers by editing the anchor in place.
      expect(JSON.stringify(second.updateCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.session_ended_title"),
      );
      expect(stubs.panelActionSpy).toHaveBeenCalledTimes(1);
    } finally {
      stubs.restore();
    }
  });

  it("re-pends only the settings step and commits nothing when the stored persona left the catalog", async () => {
    const stubs = stubCommitDependencies();
    const personaSpy = spyOn(configRepository, "loadPresetRowsByLocale").mockResolvedValue([
      PERSONA_PRESET_ROWS[1],
    ] as never);

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(stubs.setupSpy).not.toHaveBeenCalled();
      const repainted = JSON.stringify(interaction.editReplyCalls[0]);
      expect(repainted).toContain(localizer("en-US", "commands.setup.wizard.settings_button_start"));
      // A disabled Finish is the visible form of the refusal.
      expect(repainted).toContain(
        `"label":"${localizer("en-US", "commands.setup.wizard.finish_label")}","disabled":true`,
      );

      // The provider half of the draft survives: only the drifted step is cleared.
      const stored = readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild");
      expect(stored.status).toBe("ok");
      if (stored.status === "ok") {
        expect(stored.draft.providerAccess).not.toBeNull();
        expect(stored.draft.startingSettings).toBeNull();
      }
    } finally {
      personaSpy.mockRestore();
      stubs.restore();
    }
  });

  it("consumes the draft and shows a retry notice when the transaction throws", async () => {
    const stubs = stubCommitDependencies();
    stubs.setupSpy.mockRejectedValue(new Error("transaction exploded"));

    try {
      storeSetupDraft(COMMIT_NONCE, makeCompleteDraft());
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });

      await dispatchGlobalInteraction({} as Client, interaction);

      const notice = JSON.stringify(interaction.editReplyCalls[0]);
      expect(notice).toContain(localizer("en-US", "commands.setup.wizard.commit_failed_title"));
      // Never a receipt for a setup that did not land.
      expect(notice).not.toContain(localizer("en-US", "commands.setup.wizard.receipt_title"));
      expect(stubs.panelActionSpy).not.toHaveBeenCalled();
      expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("missing");
    } finally {
      stubs.restore();
    }
  });

  it("refuses a second press while the first commit is still in flight", async () => {
    const stubs = stubCommitDependencies();

    try {
      // writeClaimed is what the atomic claim sets for the duration of the transaction, so this is
      // the state a duplicate confirmation arriving mid-commit actually reads.
      storeSetupDraft(COMMIT_NONCE, { ...makeCompleteDraft(), writeClaimed: true });
      const customId = buildSetupFinishRouteId({ locale: "en-US", nonce: COMMIT_NONCE });
      const interaction = makeMockInteraction({ customId, guild: COMMIT_GUILD });

      await dispatchGlobalInteraction({} as Client, interaction);

      expect(stubs.setupSpy).not.toHaveBeenCalled();
      // The dispatcher refuses every action on a claimed draft, so this press never reaches the finish
      // arm at all: it is answered in place with the in-flight notice.
      expect(JSON.stringify(interaction.updateCalls[0])).toContain(
        localizer("en-US", "commands.setup.wizard.commit_in_progress_title"),
      );
      // The claim is not stolen: the in-flight commit still owns its draft.
      expect(readSetupDraft(COMMIT_NONCE, "actor-1", "guild-1", "guild").status).toBe("in-flight");
    } finally {
      stubs.restore();
    }
  });
});
