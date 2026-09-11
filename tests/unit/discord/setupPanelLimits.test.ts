import { beforeAll, describe, expect, it } from "bun:test";
import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ContainerComponentData,
  type StringSelectMenuComponentData,
} from "discord.js";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  type SetupDraftProviderAccess,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import {
  buildSetupCancelledPayload,
  buildSetupExpiredPayload,
  buildSetupSuccessPayload,
  buildSetupWizardPayload,
} from "@/utils/discord/ui/setupPanel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => {
  await initializeLocalizer();
});

const SECRET_KEY_STRING = "super-secret-api-key-do-not-leak";
const TEST_NONCE = "nonce-abc-12345";

/** The catalog rows the complete-draft fixture stores, so its settings step resolves and reads as done. */
const COMPLETE_DRAFT_CATALOGS = {
  personas: [{ id: 1, name: "Lighthouse", description: "A steady, watchful companion." }],
  prompts: [{ name: "Tomori Default", description: "The standard reply style." }],
  // Only the commit path reads this, but the editor fixtures travel with the whole shape so a
  // catalog object built here can be handed to either without a cast.
  promptTexts: new Map([["Tomori Default", "You are Tomori."]]),
};

function createDraft(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
  return {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: "actor-1234567890",
    workspaceKey: "workspace-1234567890",
    context: "guild",
    providerAccess: null,
    startingSettings: null,
    policiesAccepted: false,
    requiresPolicies: false,
    ...overrides,
  };
}

/**
 * A draft with every step done, paired with the catalogs its settings step resolves against.
 *
 * The two travel together because a completed settings step is only complete against a catalog that
 * still holds its persona and prompt: building the pair separately once already produced a fixture
 * that rendered `1 of 2` with an enabled Finish while the test asserted it was ready.
 */
function createCompleteDraftInput(isHosted = false): {
  draft: SetupDraftRecord;
  settingsCatalogs: typeof COMPLETE_DRAFT_CATALOGS;
} {
  return {
    draft: createDraft({
      requiresPolicies: isHosted,
      policiesAccepted: isHosted,
      providerAccess: {
        mode: "catalog",
        provider: "openai",
        encryptedApiKey: Buffer.from(SECRET_KEY_STRING),
        keyVersion: 1,
      },
      startingSettings: {
        presetId: COMPLETE_DRAFT_CATALOGS.personas[0].id,
        humanizer: 1,
        timezoneOffset: 9,
        systemPrompt: { kind: "preset", presetName: COMPLETE_DRAFT_CATALOGS.prompts[0].name },
      },
    }),
    settingsCatalogs: COMPLETE_DRAFT_CATALOGS,
  };
}

function extractAllText(payload: ReturnType<typeof buildSetupWizardPayload>): string[] {
  const texts: string[] = [];
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      texts.push(record.content);
    }
    for (const value of Object.values(record)) {
      visit(value);
    }
  }
  visit(payload);
  return texts;
}

function getContainerComponents(payload: ReturnType<typeof buildSetupWizardPayload>): unknown[] {
  const container = payload.components[0] as ContainerComponentData<unknown>;
  return container.components;
}

describe("setupPanel Components V2 layout and limits", () => {
  it("renders three requirements in production and exactly two in non-production", () => {
    const draft = createDraft();

    const hostedPayload = buildSetupWizardPayload({
      draft: { ...draft, requiresPolicies: true },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const nonHostedPayload = buildSetupWizardPayload({
      draft: { ...draft, requiresPolicies: false },
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });

    const hostedTexts = extractAllText(hostedPayload);
    const nonHostedTexts = extractAllText(nonHostedPayload);

    expect(hostedTexts.some((t) => t.includes(localizer("en-US", "commands.setup.wizard.policies_name")))).toBe(true);
    expect(nonHostedTexts.some((t) => t.includes(localizer("en-US", "commands.setup.wizard.policies_name")))).toBe(
      false,
    );

    const nonHostedJson = JSON.stringify(nonHostedPayload);
    expect(nonHostedJson).not.toContain("Policies");
    expect(nonHostedJson).not.toContain("policies");
    expect(nonHostedJson).not.toContain("Terms of Service");
    expect(nonHostedJson).not.toContain("Privacy Policy");
  });

  it("counts progress based only on rendered requirements", () => {
    const hostedPending = buildSetupWizardPayload({
      draft: createDraft({ requiresPolicies: true }),
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });
    const hostedTexts = extractAllText(hostedPending);
    expect(hostedTexts[0]).toContain("0 of 3");

    const nonHostedPending = buildSetupWizardPayload({
      draft: createDraft({ requiresPolicies: false }),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });
    const nonHostedTexts = extractAllText(nonHostedPending);
    expect(nonHostedTexts[0]).toContain("0 of 2");
    expect(nonHostedTexts[0]).not.toContain("0 of 3");
  });

  it("keeps Finish Setup disabled Secondary while pending and enabled Primary when complete", () => {
    const pendingPayload = buildSetupWizardPayload({
      draft: createDraft(),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });

    const pendingContainer = getContainerComponents(pendingPayload);
    const pendingFooter = pendingContainer[pendingContainer.length - 1] as ActionRowData<ButtonComponentData>;
    const finishPendingBtn = pendingFooter.components[0];

    expect(finishPendingBtn.disabled).toBe(true);
    expect(finishPendingBtn.style).toBe(ButtonStyle.Secondary);

    const completePayload = buildSetupWizardPayload({
      ...createCompleteDraftInput(false),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });

    const completeContainer = getContainerComponents(completePayload);
    const completeFooter = completeContainer[completeContainer.length - 1] as ActionRowData<ButtonComponentData>;
    const finishCompleteBtn = completeFooter.components[0];

    expect(finishCompleteBtn.disabled).toBe(false);
    expect(finishCompleteBtn.style).toBe(ButtonStyle.Primary);
  });

  it("relabels completed step controls while keeping them enabled", () => {
    const pendingHosted = buildSetupWizardPayload({
      draft: createDraft({ requiresPolicies: true }),
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const pendingComp = getContainerComponents(pendingHosted);
    const policiesPendingRow = pendingComp[2] as ActionRowData<ButtonComponentData>;
    expect(policiesPendingRow.components[0].label).toBe(
      localizer("en-US", "commands.setup.wizard.policies_button_start"),
    );
    expect(policiesPendingRow.components[0].disabled).toBe(false);

    const settingsPendingRow = pendingComp[6] as ActionRowData<ButtonComponentData>;
    expect(settingsPendingRow.components[0].label).toBe(
      localizer("en-US", "commands.setup.wizard.settings_button_start"),
    );
    expect(settingsPendingRow.components[0].disabled).toBe(false);

    const completeHosted = buildSetupWizardPayload({
      ...createCompleteDraftInput(true),
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
      // A completed settings step resolves its stored identities against the live catalogs, so a
      // "complete" fixture without them renders as pending.
      settingsCatalogs: COMPLETE_DRAFT_CATALOGS,
    });

    const completeComp = getContainerComponents(completeHosted);
    const policiesCompleteRow = completeComp[2] as ActionRowData<ButtonComponentData>;
    expect(policiesCompleteRow.components[0].label).toBe(
      localizer("en-US", "commands.setup.wizard.policies_button_edit"),
    );
    expect(policiesCompleteRow.components[0].disabled).toBe(false);

    const settingsCompleteRow = completeComp[6] as ActionRowData<ButtonComponentData>;
    expect(settingsCompleteRow.components[0].label).toBe(
      localizer("en-US", "commands.setup.wizard.settings_button_edit"),
    );
    expect(settingsCompleteRow.components[0].disabled).toBe(false);
  });

  it("omits User BYOK in DM context and includes it in guild context", () => {
    const guildPayload = buildSetupWizardPayload({
      draft: createDraft({ context: "guild" }),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });
    const guildComp = getContainerComponents(guildPayload);
    const guildSelectRow = guildComp[2] as ActionRowData<StringSelectMenuComponentData>;
    const guildSelect = guildSelectRow.components[0];
    expect(guildSelect.options.some((o) => o.value === "user-byok")).toBe(true);

    const dmPayload = buildSetupWizardPayload({
      draft: createDraft({ context: "dm" }),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });
    const dmComp = getContainerComponents(dmPayload);
    const dmSelectRow = dmComp[2] as ActionRowData<StringSelectMenuComponentData>;
    const dmSelect = dmSelectRow.components[0];
    expect(dmSelect.options.some((o) => o.value === "user-byok")).toBe(false);
  });

  it("shows neutral placeholder and no default option while provider is pending", () => {
    const pendingPayload = buildSetupWizardPayload({
      draft: createDraft({ providerAccess: null }),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });
    const comp = getContainerComponents(pendingPayload);
    const selectRow = comp[2] as ActionRowData<StringSelectMenuComponentData>;
    const select = selectRow.components[0];

    expect(select.placeholder).toBe(localizer("en-US", "commands.setup.wizard.provider_select_placeholder"));
    expect(select.options.every((o) => !o.default)).toBe(true);

    const chosenPayload = buildSetupWizardPayload({
      draft: createDraft({
        providerAccess: {
          mode: "catalog",
          provider: "anthropic",
          encryptedApiKey: Buffer.from("test-key"),
          keyVersion: 1,
        },
      }),
      locale: "en-US",
      isHosted: false,
      nonce: TEST_NONCE,
    });
    const chosenComp = getContainerComponents(chosenPayload);
    const chosenSelectRow = chosenComp[2] as ActionRowData<StringSelectMenuComponentData>;
    const chosenSelect = chosenSelectRow.components[0];

    const catalogOption = chosenSelect.options.find((o) => o.value === "catalog");
    expect(catalogOption?.default).toBe(true);
  });

  it("holds text and component budgets under maximum-length fixtures", () => {
    const maxProviderName = "p".repeat(40);
    const maxEndpointLabel = "e".repeat(40);
    const maxModelCode = "m".repeat(40);
    const maxPresetName = "r".repeat(32);

    const maxPayload = buildSetupWizardPayload({
      draft: {
        schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
        actorDiscId: "123456789012345678",
        workspaceKey: "123456789012345678",
        context: "guild",
        policiesAccepted: true,
        requiresPolicies: true,
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: maxEndpointLabel,
            apiStyle: "openai-compatible",
            endpointUrl: "https://example.invalid/v1",
            encryptedAuthToken: Buffer.from(SECRET_KEY_STRING),
            keyVersion: 1,
          },
          textModel: {
            modelCode: maxModelCode,
            numCtx: 131072,
            capabilities: ["tools", "vision"],
          },
        },
        startingSettings: {
          presetId: 99999,
          humanizer: 3,
          timezoneOffset: 14,
          systemPrompt: { kind: "preset", presetName: maxPresetName },
        },
      },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const validation = validateComponentsV2MessageLimits(maxPayload);
    expect(validation.valid).toBe(true);
    expect(validation.violations).toEqual([]);

    const catalogPayload = buildSetupWizardPayload({
      draft: {
        schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
        actorDiscId: "123456789012345678",
        workspaceKey: "123456789012345678",
        context: "guild",
        policiesAccepted: true,
        requiresPolicies: true,
        providerAccess: {
          mode: "catalog",
          provider: maxProviderName,
          encryptedApiKey: Buffer.from(SECRET_KEY_STRING),
          keyVersion: 1,
        },
        startingSettings: {
          presetId: 1,
          humanizer: 0,
          timezoneOffset: -12,
          systemPrompt: { kind: "built-in" },
        },
      },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const catalogValidation = validateComponentsV2MessageLimits(catalogPayload);
    expect(catalogValidation.valid).toBe(true);
  });

  it("holds text and component budgets under user-byok provider mode", () => {
    const byokPayload = buildSetupWizardPayload({
      draft: {
        schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
        actorDiscId: "123456789012345678",
        workspaceKey: "123456789012345678",
        context: "guild",
        policiesAccepted: true,
        requiresPolicies: true,
        providerAccess: {
          mode: "user-byok",
        },
        startingSettings: {
          presetId: 1,
          humanizer: 1,
          timezoneOffset: 0,
          systemPrompt: { kind: "built-in" },
        },
      },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const byokValidation = validateComponentsV2MessageLimits(byokPayload);
    expect(byokValidation.valid).toBe(true);
    expect(byokValidation.violations).toEqual([]);
  });

  it("holds text and component budgets for custom-endpoint sub-area under pending and configured states", () => {
    const maxEndpointLabel = "e".repeat(40);
    const maxModelCode = "m".repeat(40);

    const pendingPayload = buildSetupWizardPayload({
      draft: {
        schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
        actorDiscId: "123456789012345678",
        workspaceKey: "123456789012345678",
        context: "guild",
        policiesAccepted: true,
        requiresPolicies: true,
        providerAccess: {
          mode: "custom-endpoint",
          connection: null,
          textModel: null,
        },
        startingSettings: {
          presetId: 1,
          humanizer: 1,
          timezoneOffset: 0,
          systemPrompt: { kind: "built-in" },
        },
      },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const pendingValidation = validateComponentsV2MessageLimits(pendingPayload);
    expect(pendingValidation.valid).toBe(true);
    expect(pendingValidation.violations).toEqual([]);

    const configuredPayload = buildSetupWizardPayload({
      draft: {
        schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
        actorDiscId: "123456789012345678",
        workspaceKey: "123456789012345678",
        context: "guild",
        policiesAccepted: true,
        requiresPolicies: true,
        providerAccess: {
          mode: "custom-endpoint",
          connection: {
            label: maxEndpointLabel,
            apiStyle: "openai-compatible",
            endpointUrl: "https://example.invalid/v1",
            encryptedAuthToken: Buffer.from(SECRET_KEY_STRING),
            keyVersion: 1,
          },
          textModel: {
            modelCode: maxModelCode,
            numCtx: 131072,
            capabilities: ["tools", "vision"],
          },
        },
        startingSettings: {
          presetId: 1,
          humanizer: 1,
          timezoneOffset: 0,
          systemPrompt: { kind: "built-in" },
        },
      },
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const configuredValidation = validateComponentsV2MessageLimits(configuredPayload);
    expect(configuredValidation.valid).toBe(true);
    expect(configuredValidation.violations).toEqual([]);
  });

  it("never leaks secrets, encrypted buffers, or nonces into rendered text", () => {
    const payload = buildSetupWizardPayload({
      ...createCompleteDraftInput(true),
      locale: "en-US",
      isHosted: true,
      nonce: TEST_NONCE,
    });

    const texts = extractAllText(payload);
    for (const text of texts) {
      expect(text).not.toContain(SECRET_KEY_STRING);
      expect(text).not.toContain(TEST_NONCE);
      expect(text).not.toContain("Buffer");
    }

    const json = JSON.stringify(payload);
    expect(json).not.toContain(SECRET_KEY_STRING);
    expect(json).not.toContain("Buffer");
  });

  it("validates cancelled and expired terminal payloads", () => {
    const cancelled = buildSetupCancelledPayload("en-US");
    const cancelledValidation = validateComponentsV2MessageLimits(cancelled);
    expect(cancelledValidation.valid).toBe(true);

    const expired = buildSetupExpiredPayload("en-US");
    const expiredValidation = validateComponentsV2MessageLimits(expired);
    expect(expiredValidation.valid).toBe(true);
  });

  it("renders the receipt as text displays inside the budget for every provider mode", () => {
    const maxEndpointLabel = "e".repeat(40);
    const maxModelCode = "m".repeat(200);

    const cases = [
      {
        label: "catalog with model",
        input: {
          providerAccess: {
            mode: "catalog",
            provider: "anthropic",
            encryptedApiKey: Buffer.from(SECRET_KEY_STRING),
            keyVersion: 1,
          } satisfies SetupDraftProviderAccess,
          modelName: "claude-sonnet-4",
          providerLabel: "Anthropic",
        },
      },
      {
        label: "catalog without a resolvable model",
        input: {
          providerAccess: {
            mode: "catalog",
            provider: "anthropic",
            encryptedApiKey: Buffer.from(SECRET_KEY_STRING),
            keyVersion: 1,
          } satisfies SetupDraftProviderAccess,
          modelName: null,
          providerLabel: "Anthropic",
        },
      },
      {
        label: "custom endpoint at maximum label and model length",
        input: {
          providerAccess: {
            mode: "custom-endpoint",
            connection: {
              label: maxEndpointLabel,
              apiStyle: "openai-compatible",
              endpointUrl: "https://example.invalid/v1",
              encryptedAuthToken: Buffer.from(SECRET_KEY_STRING),
              keyVersion: 1,
            },
            textModel: { modelCode: maxModelCode, numCtx: 131072, capabilities: ["tools"] },
          } satisfies SetupDraftProviderAccess,
          modelName: maxModelCode,
          providerLabel: maxEndpointLabel,
        },
      },
      {
        label: "user byok",
        input: {
          providerAccess: { mode: "user-byok" } satisfies SetupDraftProviderAccess,
          modelName: null,
          providerLabel: "",
        },
      },
    ] as const;

    for (const testCase of cases) {
      for (const context of ["guild", "dm"] as const) {
        const payload = buildSetupSuccessPayload({
          locale: "en-US",
          context,
          providerAccess: testCase.input.providerAccess,
          modelName: testCase.input.modelName,
          providerLabel: testCase.input.providerLabel,
          personaName: "Lighthouse",
          notes: [
            { label: "Expressions Disabled", detail: "Emoji and sticker usage have been automatically disabled." },
          ],
          learnMore: localizer("en-US", "commands.setup.wizard.receipt_learn_more", { help: "/help" }),
          footerKey: context === "dm" ? "commands.setup.wizard.receipt_footer_avatar_skipped_dm" : undefined,
        });

        const validation = validateComponentsV2MessageLimits(payload);
        expect(`${testCase.label}/${context}: ${JSON.stringify(validation.violations)}`).toBe(
          `${testCase.label}/${context}: []`,
        );
        expect(validation.valid).toBe(true);

        // The receipt is the terminal state, so it carries no components a stale press could reach.
        const json = JSON.stringify(payload);
        expect(json).not.toContain("setup:v1:");
        expect(json).not.toContain(SECRET_KEY_STRING);
      }
    }
  });

  it("flattens the receipt into text displays rather than embeds, because the anchor is V2", () => {
    const payload = buildSetupSuccessPayload({
      locale: "en-US",
      context: "guild",
      providerAccess: { mode: "user-byok" },
      modelName: null,
      providerLabel: "",
      personaName: "Lighthouse",
      notes: [],
      learnMore: "Learn more",
    });

    expect("embeds" in payload).toBe(false);
    const texts = extractAllText(payload as unknown as ReturnType<typeof buildSetupWizardPayload>);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]).toContain(localizer("en-US", "commands.setup.wizard.receipt_title"));
    expect(texts.join("\n")).toContain(localizer("en-US", "commands.setup.next_steps_title"));
    expect(texts.join("\n")).toContain(localizer("en-US", "commands.setup.learn_more_title"));
  });
});
