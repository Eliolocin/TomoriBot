import { beforeAll, describe, expect, it } from "bun:test";
import {
  createOpenAICompatibleErrorDescription,
  createOpenAICompatibleHttpError,
  normalizeOpenAICompatibleProviderError,
} from "@/providers/openaiCompatible/openaiCompatibleErrorFormatter";
import { initializeLocalizer } from "@/utils/text/localizer";

describe("openAI-compatible provider error formatting", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  it("extracts FastAPI detail text from HTTP errors", () => {
    const error = createOpenAICompatibleHttpError(
      400,
      "Bad Request",
      '{"detail":"Unsupported model `Deepseek` for provider `DeepSeek`. Supported IDs: `deepseek-auto`."}',
    );

    expect(error.message).toBe(
      "HTTP 400: Unsupported model `Deepseek` for provider `DeepSeek`. Supported IDs: `deepseek-auto`.",
    );
  });

  it("classifies unsupported-model errors as non-retryable model errors with details", () => {
    const rawError = new Error(
      "HTTP 400: Unsupported model `Deepseek` for provider `DeepSeek`. Supported IDs: `deepseek-auto`.",
    );
    const providerError = normalizeOpenAICompatibleProviderError(rawError, {
      errorMessagePrefix: "Custom endpoint error",
    });

    expect(providerError.type).toBe("model_error");
    expect(providerError.code).toBe("400_model");
    expect(providerError.retryable).toBe(false);

    const description = createOpenAICompatibleErrorDescription(providerError, "en-US", {
      localeNamespace: "genai.custom",
      fallbackMessage: "Custom endpoint failed.",
    });

    expect(description).toContain("The selected model was rejected by the provider");
    expect(description).toContain("Unsupported model `Deepseek`");
    expect(description).toContain("Supported IDs: `deepseek-auto`");
  });

  it("uses generic unknown fallbacks for OpenAI-compatible provider namespaces", () => {
    for (const localeNamespace of ["genai.custom", "genai.deepseek", "genai.zai", "genai.nvidia"]) {
      const description = createOpenAICompatibleErrorDescription(
        {
          type: "api_error",
          message: "Provider returned an unexpected failure",
          code: "599",
          retryable: false,
        },
        "en-US",
        {
          localeNamespace,
          fallbackMessage: "Fallback should not be needed",
        },
      );

      expect(description).toContain("An unexpected error occurred");
      expect(description).not.toContain(`${localeNamespace}.unknown_default_message`);
    }
  });

  it("describes 5xx overloads as overloads for namespaces that define no 5xx strings", () => {
    const cases = [
      { localeNamespace: "genai.deepseek", code: "503" },
      { localeNamespace: "genai.deepseek", code: "500" },
      { localeNamespace: "genai.custom", code: "502" },
      { localeNamespace: "genai.zai", code: "503" },
    ] as const;

    for (const { localeNamespace, code } of cases) {
      const description = createOpenAICompatibleErrorDescription(
        {
          type: "provider_overloaded",
          message: `DeepSeek API error: HTTP ${code}: Service is too busy.`,
          code,
          retryable: true,
        },
        "en-US",
        {
          localeNamespace,
          fallbackMessage: "Fallback should not be needed",
        },
      );

      expect(description).toContain("The provider is currently overloaded or temporarily unavailable");
      expect(description).not.toContain("An unexpected error occurred");
    }
  });

  it("prefers a namespace-specific 5xx string over the shared overload fallback", () => {
    const description = createOpenAICompatibleErrorDescription(
      {
        type: "provider_overloaded",
        message: "OpenRouter API error: HTTP 503: upstream overloaded",
        code: "503",
        retryable: true,
      },
      "en-US",
      {
        localeNamespace: "genai.openrouter",
        fallbackMessage: "Fallback should not be needed",
      },
    );

    expect(description).toContain("The upstream AI model is currently overloaded");
  });

  it("uses NVIDIA 500 parameter guidance and keeps provider details visible", () => {
    const description = createOpenAICompatibleErrorDescription(
      {
        type: "provider_overloaded",
        message:
          "NVIDIA API error: HTTP 500: ValueError: The min_p and logit_bias sampling parameters are not yet supported with speculative decoding.",
        code: "500",
        retryable: false,
      },
      "en-US",
      {
        localeNamespace: "genai.nvidia",
        fallbackMessage: "Fallback should not be needed",
        appendDetailsForCodes: ["500"],
      },
    );

    expect(description).toContain("NVIDIA rejected one or more request parameters");
    expect(description).toContain("set them to `0` with `/model parameters`");
    expect(description).toContain("`/model logit-bias remove`");
    expect(description).toContain("**Details:**");
    expect(description).toContain("min_p and logit_bias");
  });

  it("does not blame a parameter on an opaque NVIDIA 500", () => {
    // A user acted on the old unconditional copy and changed a setting the payload never carried.
    // Wrong copy is worse than no copy, so the remediation is gated on NVIDIA naming a parameter.
    const description = createOpenAICompatibleErrorDescription(
      {
        type: "provider_overloaded",
        message: "NVIDIA API error: HTTP 500: Internal server error (internal_server_error)",
        code: "500",
        retryable: true,
      },
      "en-US",
      {
        localeNamespace: "genai.nvidia",
        fallbackMessage: "Fallback should not be needed",
        appendDetailsForCodes: ["500"],
      },
    );

    expect(description).not.toContain("`/model parameters`");
    expect(description).not.toContain("`/model logit-bias remove`");
    expect(description).toContain("The NVIDIA backend serving this model failed");
    expect(description).toContain("**Details:**");
    expect(description).toContain("internal_server_error");
  });
});
