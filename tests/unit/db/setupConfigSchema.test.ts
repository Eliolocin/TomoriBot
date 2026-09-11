import { describe, expect, it } from "bun:test";
import { setupConfigSchema } from "@/types/db/schema";

describe("setupConfigSchema", () => {
  const baseConfig = {
    serverId: "123456789012345678",
    presetId: 1,
    humanizer: 1,
    tomoriName: "Tomori",
    timezoneOffset: 0,
    locale: "en-US",
    registrationLocale: "en-US",
  };

  it("parses valid catalog provider access", () => {
    const parsed = setupConfigSchema.parse({
      ...baseConfig,
      providerAccess: {
        mode: "catalog",
        provider: "openai",
        encryptedApiKey: Buffer.from("encrypted"),
        keyVersion: 1,
      },
    });

    expect(parsed.providerAccess?.mode).toBe("catalog");
    if (parsed.providerAccess?.mode === "catalog") {
      expect(parsed.providerAccess.provider).toBe("openai");
      expect(parsed.providerAccess.keyVersion).toBe(1);
    }
  });

  it("parses valid user-byok provider access without requiring provider or api key", () => {
    const parsed = setupConfigSchema.parse({
      ...baseConfig,
      providerAccess: {
        mode: "user-byok",
      },
    });

    expect(parsed.providerAccess?.mode).toBe("user-byok");
  });

  it("parses valid custom-endpoint provider access", () => {
    const parsed = setupConfigSchema.parse({
      ...baseConfig,
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "my-endpoint",
          apiStyle: "openai-compatible",
          endpointUrl: "http://localhost:11434/v1",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "llama-3",
          numCtx: 4096,
          capabilities: ["tools"],
        },
      },
      systemPrompt: "You are a helpful assistant.",
    });

    expect(parsed.providerAccess?.mode).toBe("custom-endpoint");
    expect(parsed.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("rejects a config with no provider access at all", () => {
    // providerAccess is the only provider-selection field: the legacy `provider`/`encryptedApiKey`
    // pair and the `userByokMode`/`deferredCustomEndpointSetup` booleans are gone, so omitting it is
    // a missing field rather than a shape the refinement has to reason about.
    expect(() =>
      setupConfigSchema.parse({
        ...baseConfig,
        provider: "anthropic",
        encryptedApiKey: Buffer.from("key"),
      }),
    ).toThrow();
  });

  it("rejects a credential supplied outside provider access", () => {
    // Strict object: a caller still building the pre-wizard shape fails loudly instead of having its
    // credential silently dropped on the floor by a schema that no longer models it.
    expect(() =>
      setupConfigSchema.parse({
        ...baseConfig,
        providerAccess: { mode: "user-byok" },
        encryptedApiKey: Buffer.from("key"),
      }),
    ).toThrow();
  });

  it("rejects contradictory shapes in discriminated providerAccess", () => {
    expect(() =>
      setupConfigSchema.parse({
        ...baseConfig,
        providerAccess: {
          mode: "user-byok",
          provider: "openai",
        } as unknown as { mode: "user-byok" },
      }),
    ).toThrow();
  });

  it("serverRepository.setup rejects custom endpoint API style without text capability", async () => {
    const { serverRepository } = await import("@/utils/db/repositories/ServerRepository");
    const setupCall = serverRepository.setup(null, {
      ...baseConfig,
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "my-endpoint",
          apiStyle: "comfyui",
          endpointUrl: "http://localhost:8188",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "sd-model",
        },
      },
    });

    await expect(setupCall).rejects.toThrow("Custom endpoint API style 'comfyui' does not support text capability");
  });

  it("serverRepository.setup rejects custom endpoint with empty text model code", async () => {
    const { serverRepository } = await import("@/utils/db/repositories/ServerRepository");
    const setupCall = serverRepository.setup(null, {
      ...baseConfig,
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "my-endpoint",
          apiStyle: "openai-compatible",
          endpointUrl: "http://localhost:11434/v1",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "   ",
        },
      },
    });

    await expect(setupCall).rejects.toThrow("Custom endpoint setup requires a non-empty text model code");
  });

  it("rejects a capability token the setup transaction cannot map", () => {
    // The repository switches llms capability columns on exact tokens, so a near-miss spelling must fail at
    // validation rather than register the model with that capability quietly turned off.
    const parsed = setupConfigSchema.safeParse({
      ...baseConfig,
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "my-endpoint",
          apiStyle: "openai-compatible",
          endpointUrl: "http://localhost:11434/v1",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: { modelCode: "llama3", capabilities: ["image"] },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts every capability token the setup transaction maps", () => {
    const parsed = setupConfigSchema.safeParse({
      ...baseConfig,
      providerAccess: {
        mode: "custom-endpoint",
        connection: {
          label: "my-endpoint",
          apiStyle: "openai-compatible",
          endpointUrl: "http://localhost:11434/v1",
          encryptedAuthToken: null,
          keyVersion: 1,
        },
        textModel: {
          modelCode: "llama3",
          capabilities: [
            "tools",
            "vision",
            "video",
            "structured_output",
            "json",
            "strict_role_alternation",
            "prefix_completion",
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
