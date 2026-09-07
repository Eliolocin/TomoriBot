import { describe, expect, it } from "bun:test";
import type { CustomEndpointApiStyle, CustomEndpointRow, TomoriState, VoiceSampleRow } from "@/types/db/schema";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import {
  loadConfigPersonaVoiceView,
  resolveActiveSpeechCapability,
  type ConfigPersonaVoiceLoaderDependencies,
  type ConfigPersonaVoiceResolverDependencies,
} from "@/utils/discord/interactions/configPersonaVoiceLoader";

function endpoint(apiStyle: CustomEndpointApiStyle, extraConfig: Record<string, unknown> = {}): CustomEndpointRow {
  return {
    connection_id: 73,
    server_id: 42,
    user_id: null,
    label: "private speech endpoint",
    capability: "speech",
    api_style: apiStyle,
    endpoint_url: "https://credentials.example.invalid/private",
    requires_auth: true,
    extra_config: extraConfig,
    custom_endpoint_id: 91,
    model_name: null,
    model_ref_id: null,
    num_ctx: null,
    has_tools: false,
    sees_images: false,
    sees_videos: false,
    supports_structoutput: false,
    strict_role_alternation: false,
    supports_prefix_completion: false,
    is_default: true,
  };
}

function resolverDependencies(
  activeEndpoint: CustomEndpointRow | null,
  legacyKeyExists = false,
): ConfigPersonaVoiceResolverDependencies {
  return {
    loadActiveEndpoint: async () => activeEndpoint,
    hasOptApiKey: async () => legacyKeyExists,
  };
}

function state(): TomoriState {
  return { server_id: 42 } as TomoriState;
}

describe("Persona > Voice speech capability loading", () => {
  it("keeps a clone endpoint assignable and designable only with instruct support", async () => {
    const supported = await resolveActiveSpeechCapability(
      42,
      resolverDependencies(endpoint("tts-clone", { supports_instruct: true })),
    );
    const unsupported = await resolveActiveSpeechCapability(
      42,
      resolverDependencies(endpoint("tts-clone", { supports_instruct: false })),
    );

    expect(supported).toEqual({ apiStyle: "tts-clone", assignable: true, supportsVoiceDesign: true });
    expect(unsupported).toEqual({ apiStyle: "tts-clone", assignable: true, supportsVoiceDesign: false });
  });

  it("reports an ElevenLabs endpoint as assignable without loading credentials", async () => {
    const result = await resolveActiveSpeechCapability(42, resolverDependencies(endpoint("elevenlabs")));

    expect(result).toEqual({ apiStyle: "elevenlabs", assignable: true, supportsVoiceDesign: false });
    expect(result).not.toHaveProperty("endpoint_url");
    expect(result).not.toHaveProperty("connection_id");
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("api_key");
    expect(result).not.toHaveProperty("encryptedApiKey");
    expect(result).not.toHaveProperty("endpoint");
    expect(JSON.stringify(result)).not.toContain("credentials.example.invalid");
  });

  it("uses the existence-only legacy ElevenLabs key probe when no endpoint exists", async () => {
    const calls: Array<{ serverId: number; serviceName: string }> = [];
    const result = await resolveActiveSpeechCapability(42, {
      loadActiveEndpoint: async () => null,
      hasOptApiKey: async (serverId, serviceName) => {
        calls.push({ serverId, serviceName });
        return true;
      },
    });

    expect(result).toEqual({ apiStyle: "elevenlabs", assignable: true, supportsVoiceDesign: false });
    expect(calls).toEqual([{ serverId: 42, serviceName: ELEVENLABS_SERVICE_NAME }]);
  });

  it("reports missing endpoint and key as unavailable", async () => {
    const result = await resolveActiveSpeechCapability(42, resolverDependencies(null));

    expect(result).toEqual({ apiStyle: null, assignable: false, supportsVoiceDesign: false });
  });

  it("treats a rejecting endpoint dependency as unavailable without falling back", async () => {
    let legacyProbeCalled = false;
    const result = await resolveActiveSpeechCapability(42, {
      loadActiveEndpoint: async () => {
        throw new Error("endpoint lookup failed with credential-shaped details");
      },
      hasOptApiKey: async () => {
        legacyProbeCalled = true;
        return true;
      },
    });

    expect(result).toEqual({ apiStyle: null, assignable: false, supportsVoiceDesign: false });
    expect(legacyProbeCalled).toBe(false);
  });

  it("loads and projects local samples only for a clone capability", async () => {
    const sample: VoiceSampleRow = {
      sample_id: 5,
      server_id: 42,
      name: "demo",
      file_path: "data/voice-samples/secret.wav",
      ref_text: "Hello",
      duration_ms: 1200,
      created_at: new Date(0),
    };
    let sampleLoadCalls = 0;
    const dependencies: ConfigPersonaVoiceLoaderDependencies = {
      ...resolverDependencies(endpoint("tts-clone", { supports_instruct: false })),
      loadVoiceSamples: async () => {
        sampleLoadCalls += 1;
        return [sample];
      },
    };

    const cloneView = await loadConfigPersonaVoiceView(state(), dependencies);
    expect(cloneView).toEqual({
      capability: { apiStyle: "tts-clone", assignable: true, supportsVoiceDesign: false },
      samples: [{ sample_id: 5, name: "demo", ref_text: "Hello", duration_ms: 1200 }],
    });
    expect(cloneView).not.toHaveProperty("endpoint_url");
    expect(JSON.stringify(cloneView)).not.toContain("secret.wav");
    expect(sampleLoadCalls).toBe(1);

    const elevenLabsView = await loadConfigPersonaVoiceView(state(), {
      ...resolverDependencies(endpoint("elevenlabs")),
      loadVoiceSamples: async () => {
        sampleLoadCalls += 1;
        return [sample];
      },
    });
    expect(elevenLabsView.samples).toEqual([]);
    expect(sampleLoadCalls).toBe(1);
  });
});
