import { OpenAICompatibleStreamAdapter } from "@/providers/openaiCompatible/openaiCompatibleStreamAdapter";
import type { OpenAICompatibleStreamConfig } from "@/providers/openaiCompatible/openaiCompatibleTypes";
import {
  NVIDIA_THINKING_BUDGET_TOKENS,
  NVIDIA_THINKING_BUDGET_UNSUPPORTED_MODELS,
  NVIDIA_THINKING_MODELS,
} from "@/providers/nvidia/nvidiaConstants";

export interface NvidiaStreamConfig extends OpenAICompatibleStreamConfig {
  endpointUrl: string;
}

export class NvidiaStreamAdapter extends OpenAICompatibleStreamAdapter {
  constructor() {
    super({
      providerName: "nvidia",
      adapterName: "NvidiaStreamAdapter",
      localeNamespace: ["genai", "nvidia"].join("."),
      errorMessagePrefix: "NVIDIA API error",
      appendErrorDetailsForCodes: ["500"],
      // NIM answers "I do not support this input" with an opaque mid-SSE 500 rather than a
      // parameter rejection, so without this the ladder queues no retry at all. Gated on a
      // generic message, so a descriptive NVIDIA outage still fails fast into key/model fallback.
      degradeOnOpaque5xx: true,
      degradationPriorityKeys: ["reasoning_budget"],
      // chat_template_kwargs is what actually enables thinking, so a rung that drops it would
      // "succeed" while silently returning a non-thinking reply. Failing into key rotation and
      // model fallback is the honest outcome if NIM ever rejects it.
      mandatoryBodyKeys: ["chat_template_kwargs"],
      resolveApiUrl: (config) => {
        if (!config.endpointUrl) {
          throw new Error("NVIDIA endpoint URL is required");
        }
        return config.endpointUrl;
      },
      mutateRequestBody: ({ requestBody, config }) => {
        // Nemotron-style thinking models need reasoning_budget + chat_template_kwargs
        // to activate extended thinking mode; the backend ignores them for non-thinking requests.
        if (config.model && NVIDIA_THINKING_MODELS.has(config.model)) {
          if (!NVIDIA_THINKING_BUDGET_UNSUPPORTED_MODELS.has(config.model)) {
            requestBody.reasoning_budget = NVIDIA_THINKING_BUDGET_TOKENS;
          }
          requestBody.chat_template_kwargs = { enable_thinking: true };
        }
      },
    });
  }
}
