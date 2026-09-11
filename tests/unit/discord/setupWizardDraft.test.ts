import { describe, expect, it } from "bun:test";
import {
  SETUP_DRAFT_SCHEMA_VERSION,
  isProviderAccessAllowedInContext,
  isSetupDraftComplete,
  isSetupDraftProviderAccessComplete,
  setupDraftCatalogAccessSchema,
  setupDraftCustomEndpointAccessSchema,
  setupDraftEndpointConnectionSchema,
  setupDraftEndpointModelSchema,
  setupDraftProviderAccessSchema,
  setupDraftRecordSchema,
  setupDraftStartingSettingsSchema,
  setupDraftSystemPromptSchema,
  setupDraftUserByokAccessSchema,
  type SetupDraftCatalogAccess,
  type SetupDraftCustomEndpointAccess,
  type SetupDraftRecord,
  type SetupDraftStartingSettings,
  type SetupDraftUserByokAccess,
} from "@/types/discord/setupWizard";

function makeStartingSettings(overrides: Partial<SetupDraftStartingSettings> = {}): SetupDraftStartingSettings {
  return {
    presetId: 1,
    humanizer: 1,
    timezoneOffset: 9,
    systemPrompt: { kind: "built-in" },
    ...overrides,
  };
}

function makeDraftRecord(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
  return {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: "actor-1",
    workspaceKey: "workspace-1",
    context: "guild",
    providerAccess: {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("secret-api-key"),
      keyVersion: 1,
    },
    startingSettings: makeStartingSettings(),
    policiesAccepted: false,
    requiresPolicies: false,
    ...overrides,
  };
}

describe("setup wizard draft schemas and invariants", () => {
  it("parses valid provider access schemas", () => {
    const catalog: SetupDraftCatalogAccess = {
      mode: "catalog",
      provider: "anthropic",
      encryptedApiKey: Buffer.from("catalog-key"),
      keyVersion: 1,
    };
    expect(setupDraftCatalogAccessSchema.safeParse(catalog).success).toBe(true);

    const custom: SetupDraftCustomEndpointAccess = {
      mode: "custom-endpoint",
      connection: {
        label: "Local Ollama",
        apiStyle: "ollama",
        endpointUrl: "http://localhost:11434",
        encryptedAuthToken: null,
        keyVersion: 1,
      },
      textModel: {
        modelCode: "llama3",
        numCtx: 4096,
        capabilities: ["chat"],
      },
    };
    expect(setupDraftCustomEndpointAccessSchema.safeParse(custom).success).toBe(true);

    const byok: SetupDraftUserByokAccess = { mode: "user-byok" };
    expect(setupDraftUserByokAccessSchema.safeParse(byok).success).toBe(true);
  });

  it("enforces union exclusivity by rejecting unrecognized keys across provider modes", () => {
    // A user-byok draft carrying an encryptedApiKey must fail to parse: modes are strictly mutually exclusive.
    const illegalByok = {
      mode: "user-byok",
      encryptedApiKey: Buffer.from("leak-key"),
    };
    expect(setupDraftProviderAccessSchema.safeParse(illegalByok).success).toBe(false);

    const illegalCatalog = {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("key"),
      keyVersion: 1,
      connection: null,
    };
    expect(setupDraftProviderAccessSchema.safeParse(illegalCatalog).success).toBe(false);
  });

  it("validates endpoint connection and model schemas", () => {
    const validConnection = {
      label: "Custom",
      apiStyle: "openai-compatible",
      endpointUrl: "https://api.example.com",
      encryptedAuthToken: Buffer.from("auth-token"),
      keyVersion: 2,
    };
    expect(setupDraftEndpointConnectionSchema.safeParse(validConnection).success).toBe(true);

    const validModel = {
      modelCode: "gpt-4o",
      numCtx: null,
      capabilities: ["streaming"],
    };
    expect(setupDraftEndpointModelSchema.safeParse(validModel).success).toBe(true);
  });

  it("enforces system prompt discriminated union", () => {
    expect(setupDraftSystemPromptSchema.safeParse({ kind: "built-in" }).success).toBe(true);
    expect(setupDraftSystemPromptSchema.safeParse({ kind: "preset", presetName: "assistant" }).success).toBe(true);
    expect(setupDraftSystemPromptSchema.safeParse({ kind: "preset" }).success).toBe(false);
    expect(setupDraftSystemPromptSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });

  it("enforces starting settings bounds", () => {
    const validSettings = makeStartingSettings();
    expect(setupDraftStartingSettingsSchema.safeParse(validSettings).success).toBe(true);

    // Humanizer must be an integer in 0-3.
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ humanizer: -1 })).success).toBe(false);
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ humanizer: 4 })).success).toBe(false);
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ humanizer: 1.5 })).success).toBe(false);

    // Timezone offset must be an integer in -12..14.
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ timezoneOffset: -13 })).success).toBe(
      false,
    );
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ timezoneOffset: 15 })).success).toBe(
      false,
    );
    expect(setupDraftStartingSettingsSchema.safeParse(makeStartingSettings({ timezoneOffset: 9.5 })).success).toBe(
      false,
    );
  });

  it("validates setup draft record schema", () => {
    const validRecord = makeDraftRecord();
    expect(setupDraftRecordSchema.safeParse(validRecord).success).toBe(true);

    const nullStepsRecord = makeDraftRecord({ providerAccess: null, startingSettings: null });
    expect(setupDraftRecordSchema.safeParse(nullStepsRecord).success).toBe(true);

    const missingFields = { schemaVersion: 1, actorDiscId: "actor-1" };
    expect(setupDraftRecordSchema.safeParse(missingFields).success).toBe(false);
  });

  it("rejects BYOK in DM context and permits it in guild context", () => {
    expect(isProviderAccessAllowedInContext("user-byok", "dm")).toBe(false);
    expect(isProviderAccessAllowedInContext("user-byok", "guild")).toBe(true);
    expect(isProviderAccessAllowedInContext("catalog", "dm")).toBe(true);
    expect(isProviderAccessAllowedInContext("catalog", "guild")).toBe(true);
    expect(isProviderAccessAllowedInContext("custom-endpoint", "dm")).toBe(true);
    expect(isProviderAccessAllowedInContext("custom-endpoint", "guild")).toBe(true);
  });

  it("derives provider access completeness correctly across all modes", () => {
    expect(isSetupDraftProviderAccessComplete(null)).toBe(false);

    const catalogAccess: SetupDraftCatalogAccess = {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("api-key"),
      keyVersion: 1,
    };
    expect(isSetupDraftProviderAccessComplete(catalogAccess)).toBe(true);

    const byokAccess: SetupDraftUserByokAccess = { mode: "user-byok" };
    expect(isSetupDraftProviderAccessComplete(byokAccess)).toBe(true);

    // Custom endpoint must be incomplete without both connection and textModel.
    const emptyEndpoint: SetupDraftCustomEndpointAccess = {
      mode: "custom-endpoint",
      connection: null,
      textModel: null,
    };
    expect(isSetupDraftProviderAccessComplete(emptyEndpoint)).toBe(false);

    const connectionOnly: SetupDraftCustomEndpointAccess = {
      mode: "custom-endpoint",
      connection: {
        label: "Local Ollama",
        apiStyle: "ollama",
        endpointUrl: "http://localhost:11434",
        encryptedAuthToken: null,
        keyVersion: 1,
      },
      textModel: null,
    };
    expect(isSetupDraftProviderAccessComplete(connectionOnly)).toBe(false);

    const modelOnly: SetupDraftCustomEndpointAccess = {
      mode: "custom-endpoint",
      connection: null,
      textModel: {
        modelCode: "llama3",
        numCtx: null,
        capabilities: ["chat"],
      },
    };
    expect(isSetupDraftProviderAccessComplete(modelOnly)).toBe(false);

    const completeEndpoint: SetupDraftCustomEndpointAccess = {
      mode: "custom-endpoint",
      connection: connectionOnly.connection,
      textModel: modelOnly.textModel,
    };
    expect(isSetupDraftProviderAccessComplete(completeEndpoint)).toBe(true);
  });

  it("derives overall draft completion respecting policy requirement flag", () => {
    const completeCatalogAccess: SetupDraftCatalogAccess = {
      mode: "catalog",
      provider: "openai",
      encryptedApiKey: Buffer.from("api-key"),
      keyVersion: 1,
    };
    const startingSettings = makeStartingSettings();

    // Incomplete when providerAccess is null or incomplete.
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: null,
          startingSettings,
          requiresPolicies: false,
          policiesAccepted: false,
        }),
      ),
    ).toBe(false);

    // Incomplete when startingSettings is null.
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: completeCatalogAccess,
          startingSettings: null,
          requiresPolicies: false,
          policiesAccepted: false,
        }),
      ),
    ).toBe(false);

    // When requiresPolicies is false, policiesAccepted is ignored.
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: completeCatalogAccess,
          startingSettings,
          requiresPolicies: false,
          policiesAccepted: false,
        }),
      ),
    ).toBe(true);
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: completeCatalogAccess,
          startingSettings,
          requiresPolicies: false,
          policiesAccepted: true,
        }),
      ),
    ).toBe(true);

    // When requiresPolicies is true, policiesAccepted must be true.
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: completeCatalogAccess,
          startingSettings,
          requiresPolicies: true,
          policiesAccepted: false,
        }),
      ),
    ).toBe(false);
    expect(
      isSetupDraftComplete(
        makeDraftRecord({
          providerAccess: completeCatalogAccess,
          startingSettings,
          requiresPolicies: true,
          policiesAccepted: true,
        }),
      ),
    ).toBe(true);
  });
});
