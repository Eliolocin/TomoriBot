import { ThinkingLevel, type ThinkingConfig } from "@google/genai";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVEL_LOCALIZER_KEYS,
  type ThinkingLevelValue,
  isThinkingLevelValue,
} from "@/constants/thinkingLevels";

const DEFAULT_LOW_BUDGET_TOKENS = 1024;
const DEFAULT_MEDIUM_BUDGET_TOKENS = 4096;
const DEFAULT_HIGH_BUDGET_TOKENS = 8192;
const GOOGLE_GEMINI_25_PRO_MIN_BUDGET = 128;
const GOOGLE_GEMINI_25_FLASH_LITE_MIN_BUDGET = 512;

export interface AnthropicThinkingRequest {
  thinking?: {
    type: "adaptive" | "disabled";
  };
  output_config?: {
    effort: "low" | "medium" | "high";
  };
  omitSampling: boolean;
}

export interface OpenRouterReasoningRequest {
  reasoning?: {
    effort: "none" | "low" | "medium" | "high";
  };
}

export interface ThinkingModeRequest {
  thinking?: {
    type: "enabled" | "disabled";
  };
  omitSampling: boolean;
}

export interface CustomThinkingRequest {
  /** Ollama-native boolean thinking toggle (on/off only). */
  think?: boolean;
  /** OpenAI-convention effort level (vLLM, other compatible servers). */
  reasoning_effort?: "none" | "low" | "medium" | "high";
}

type ProviderEffortLevel = "low" | "medium" | "high";
type ProviderReasoningEffortLevel = "none" | ProviderEffortLevel;

function parseBudgetEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getLevelBudget(level: Exclude<ThinkingLevelValue, "auto" | "none">): number {
  switch (level) {
    case "minimal":
      return 1;
    case "low":
      return parseBudgetEnv("THINKING_LEVEL_BUDGET_LOW_TOKENS", DEFAULT_LOW_BUDGET_TOKENS);
    case "medium":
      return parseBudgetEnv("THINKING_LEVEL_BUDGET_MEDIUM_TOKENS", DEFAULT_MEDIUM_BUDGET_TOKENS);
    case "high":
      return parseBudgetEnv("THINKING_LEVEL_BUDGET_HIGH_TOKENS", DEFAULT_HIGH_BUDGET_TOKENS);
  }
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function isGemini25Model(model: string): boolean {
  return normalizeModel(model).startsWith("gemini-2.5");
}

function isGemini3FamilyModel(model: string): boolean {
  const normalized = normalizeModel(model);
  return normalized.startsWith("gemini-3") || normalized.startsWith("gemini-3.1");
}

function isGeminiFlashModel(model: string): boolean {
  return normalizeModel(model).includes("flash");
}

function isGeminiFlashLiteModel(model: string): boolean {
  return normalizeModel(model).includes("flash-lite");
}

function isGeminiProModel(model: string): boolean {
  return normalizeModel(model).includes("pro");
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const normalized = normalizeModel(model);
  return (
    normalized.includes("claude-sonnet-4-6") ||
    normalized.includes("claude-opus-4-6") ||
    normalized.includes("claude-opus-4-7") ||
    normalized.includes("claude-mythos-preview")
  );
}

function isDeepSeekReasonerModel(model: string): boolean {
  return normalizeModel(model) === "deepseek-reasoner";
}

// deepseek-v4-flash absorbed deepseek-chat's opt-in thinking toggle; deepseek-chat stays
// listed so servers still configured with the deprecated codename keep working unchanged.
function isDeepSeekChatModel(model: string): boolean {
  const normalized = normalizeModel(model);
  return normalized === "deepseek-chat" || normalized === "deepseek-v4-flash";
}

function looksLikeOllamaEndpoint(endpointUrl: string): boolean {
  try {
    const { hostname, port } = new URL(endpointUrl);
    const normalizedHost = hostname.toLowerCase();
    return normalizedHost.includes("ollama") || port === "11434";
  } catch {
    return endpointUrl.toLowerCase().includes("ollama");
  }
}

function toProviderEffortLevel(level: Exclude<ThinkingLevelValue, "auto" | "none">): ProviderEffortLevel {
  return level === "minimal" ? "low" : level;
}

function toProviderReasoningEffortLevel(level: Exclude<ThinkingLevelValue, "auto">): ProviderReasoningEffortLevel {
  return level === "none" ? "none" : toProviderEffortLevel(level);
}

function resolveConfiguredThinkingLevel(value: string | null | undefined): ThinkingLevelValue {
  return value && isThinkingLevelValue(value) ? value : DEFAULT_THINKING_LEVEL;
}

function resolveEffectiveThinkingLevel(
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): ThinkingLevelValue {
  const resolved = resolveConfiguredThinkingLevel(configuredLevel);
  if (forceReason && (resolved === "auto" || resolved === "none")) {
    return "high";
  }
  return resolved;
}

export function getThinkingLevelLocalizerKey(value: string | null | undefined): string {
  return THINKING_LEVEL_LOCALIZER_KEYS[resolveConfiguredThinkingLevel(value)];
}

export function buildGoogleThinkingConfig(
  model: string,
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): ThinkingConfig | undefined {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);

  if (isGemini25Model(model)) {
    if (effectiveLevel === "auto") {
      return { thinkingBudget: -1 };
    }

    if (effectiveLevel === "none") {
      if (isGeminiProModel(model)) {
        return { thinkingBudget: GOOGLE_GEMINI_25_PRO_MIN_BUDGET };
      }
      return { thinkingBudget: 0 };
    }

    const requestedBudget = getLevelBudget(effectiveLevel);
    const minimumBudget = isGeminiProModel(model)
      ? GOOGLE_GEMINI_25_PRO_MIN_BUDGET
      : isGeminiFlashLiteModel(model)
        ? GOOGLE_GEMINI_25_FLASH_LITE_MIN_BUDGET
        : 1;

    return {
      thinkingBudget: Math.max(requestedBudget, minimumBudget),
    };
  }

  if (!isGemini3FamilyModel(model)) {
    return undefined;
  }

  if (effectiveLevel === "auto") {
    return undefined;
  }

  if (effectiveLevel === "none") {
    const isMinimalSupported = isGeminiFlashModel(model) && !model.includes("3.7");
    return {
      thinkingLevel: isMinimalSupported ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
    };
  }

  if (effectiveLevel === "minimal") {
    const isMinimalSupported = !model.includes("3.7");
    return {
      thinkingLevel: isMinimalSupported ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
    };
  }

  if (effectiveLevel === "low") {
    return { thinkingLevel: ThinkingLevel.LOW };
  }

  if (effectiveLevel === "medium") {
    return { thinkingLevel: ThinkingLevel.MEDIUM };
  }

  return { thinkingLevel: ThinkingLevel.HIGH };
}

export function serializeGoogleThinkingConfig(thinkingConfig?: ThinkingConfig): Record<string, unknown> | undefined {
  if (!thinkingConfig) {
    return undefined;
  }

  const out: Record<string, unknown> = {};
  if (thinkingConfig.thinkingBudget !== undefined) {
    out.thinking_budget = thinkingConfig.thinkingBudget;
  }
  if (thinkingConfig.thinkingLevel !== undefined) {
    out.thinking_level = thinkingConfig.thinkingLevel;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildAnthropicThinkingRequest(
  model: string,
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): AnthropicThinkingRequest {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);
  if (!supportsAnthropicAdaptiveThinking(model)) {
    return { omitSampling: false };
  }

  if (effectiveLevel === "none") {
    return {
      thinking: { type: "disabled" },
      omitSampling: false,
    };
  }

  if (effectiveLevel === "auto") {
    return {
      thinking: { type: "adaptive" },
      omitSampling: true,
    };
  }

  return {
    thinking: { type: "adaptive" },
    output_config: { effort: toProviderEffortLevel(effectiveLevel) },
    omitSampling: true,
  };
}

export function buildOpenRouterReasoningRequest(
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): OpenRouterReasoningRequest {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);
  if (effectiveLevel === "auto") {
    return {};
  }

  return {
    reasoning: {
      effort: toProviderReasoningEffortLevel(effectiveLevel),
    },
  };
}

export function buildDeepSeekThinkingRequest(
  model: string,
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): ThinkingModeRequest {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);
  if (isDeepSeekReasonerModel(model)) {
    return { omitSampling: true };
  }

  if (isDeepSeekChatModel(model) && effectiveLevel !== "auto" && effectiveLevel !== "none") {
    return {
      thinking: { type: "enabled" },
      omitSampling: true,
    };
  }

  return { omitSampling: false };
}

export function buildZaiThinkingRequest(
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): ThinkingModeRequest {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);

  if (effectiveLevel === "auto") {
    return { omitSampling: false };
  }

  if (effectiveLevel === "none") {
    return {
      thinking: { type: "disabled" },
      omitSampling: false,
    };
  }

  return {
    thinking: { type: "enabled" },
    omitSampling: true,
  };
}

export function buildCustomThinkingRequest(
  endpointUrl: string | null | undefined,
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): CustomThinkingRequest {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);
  if (effectiveLevel === "auto") {
    return {};
  }

  // Ollama supports a boolean think toggle only (no budget levels).
  if (endpointUrl && looksLikeOllamaEndpoint(endpointUrl)) {
    return { think: effectiveLevel !== "none" };
  }

  // Non-Ollama OpenAI-compatible servers (vLLM, etc.) may support reasoning_effort.
  return { reasoning_effort: toProviderReasoningEffortLevel(effectiveLevel) };
}

export function getNovelAiThinkingDirective(
  configuredLevel: string | null | undefined,
  forceReason?: boolean,
): "<think></think>" | "/nothink" {
  const effectiveLevel = resolveEffectiveThinkingLevel(configuredLevel, forceReason);
  if (effectiveLevel === "none") {
    return "/nothink";
  }
  if (effectiveLevel === "auto") {
    return (process.env.NAI_GLM_THINKING_ENABLED ?? "true").toLowerCase() === "true" ? "<think></think>" : "/nothink";
  }
  return "<think></think>";
}
