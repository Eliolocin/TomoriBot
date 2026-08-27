export const NVIDIA_CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
export const NVIDIA_EMBEDDINGS_URL = "https://integrate.api.nvidia.com/v1/embeddings";
/**
 * Image generation stayed on the older per-function NVCF gateway when chat and embeddings moved to
 * the OpenAI-compatible `integrate.api.nvidia.com` surface. The full URL is `{base}/{codename}`,
 * built per model in `nvidiaImageGeneration.ts`.
 */
export const NVIDIA_IMAGE_GENERATION_BASE_URL = "https://ai.api.nvidia.com/v1/genai";

export const NVIDIA_DEFAULT_TEXT_MODEL = "meta/llama-3.3-70b-instruct";
export const NVIDIA_DEFAULT_EMBEDDING_MODEL = "nv-embed-v1";
export const NVIDIA_STRUCTURED_OUTPUT_MODELS = new Set([
  "deepseek-ai/deepseek-v3.2",
  "qwen/qwen3.5-397b-a17b",
  "z.ai/glm-4.7",
  "z-ai/glm-5.2",
  "minimaxai/minimax-m3",
  "moonshotai/kimi-k2.6",
  "nvidia/nemotron-3-ultra-550b-a55b",
]);

export const NVIDIA_STRUCTURED_OUTPUT_VISION_MODELS = new Set(["qwen/qwen3.5-397b-a17b"]);

/**
 * NVIDIA currently runs these models with speculative decoding backends that reject `min_p`.
 */
export const NVIDIA_MIN_P_UNSUPPORTED_MODELS = new Set(["nvidia/nemotron-3-ultra-550b-a55b"]);

/**
 * Models that require extended-thinking parameters injected at request time.
 * These receive `reasoning_budget` and `chat_template_kwargs: { enable_thinking: true }`
 * in addition to the standard chat-completion body.
 */
export const NVIDIA_THINKING_MODELS = new Set(["nvidia/nemotron-3-ultra-550b-a55b"]);

/**
 * Default reasoning budget (tokens) for Nemotron-style thinking-enabled models.
 *
 * Unused while every thinking model is in {@link NVIDIA_THINKING_BUDGET_UNSUPPORTED_MODELS}. It is
 * also four times the 4096 `maxOutputTokens` default in `nvidiaProvider.ts`, so reconcile the two
 * before re-enabling it anywhere rather than restoring this value as-is.
 */
export const NVIDIA_THINKING_BUDGET_TOKENS = 16384;

/**
 * Models whose NIM deployment has moved to the vLLM V2 model runner, which dropped the
 * thinking-budget parameter. Sending `reasoning_budget` to one of these returns a clean 400
 * (`thinking_token_budget is not yet supported by the V2 model runner`) when non-streaming and an
 * opaque mid-SSE 500 when streaming, which is the only path we use. `chat_template_kwargs` is
 * verified to still work on the V2 runner and must stay: it is what actually enables thinking.
 *
 * Kept as a denylist rather than deleting the injection so restoring the parameter is one line if
 * NVIDIA re-adds it (see the budget-vs-output-cap note on {@link NVIDIA_THINKING_BUDGET_TOKENS}).
 */
export const NVIDIA_THINKING_BUDGET_UNSUPPORTED_MODELS = new Set(["nvidia/nemotron-3-ultra-550b-a55b"]);
