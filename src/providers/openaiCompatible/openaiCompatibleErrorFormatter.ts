import { errorMessageNamesRejectableParam } from "@/providers/utils/paramDegradation";
import type { ProviderError } from "@/types/stream/interfaces";
import { isProviderModelErrorMessage } from "@/utils/provider/providerErrorClassification";
import { localizer } from "@/utils/text/localizer";

interface ParsedOpenAICompatibleErrorPayload {
  message: string;
  code?: string;
}

interface CreateErrorDescriptionOptions {
  localeNamespace: string;
  fallbackMessage: string;
  connectionRefusedMessage?: string;
  appendDetailsForCodes?: readonly string[];
}

interface NormalizeProviderErrorOptions {
  errorMessagePrefix: string;
}

export function createOpenAICompatibleHttpError(statusCode: number, statusText: string, errorText: string): Error {
  const parsed = parseOpenAICompatibleErrorPayload(errorText);
  const message = parsed.message || statusText || "Unknown error";
  return new Error(`HTTP ${statusCode}: ${message}`);
}

/** Normalized type/code/retryable triple derived from one upstream failure. */
export interface OpenAICompatibleErrorClassification {
  type: ProviderError["type"];
  code: string;
  retryable: boolean;
}

/**
 * Map an HTTP-or-SSE status code plus its message onto a {@link ProviderError} type.
 *
 * Shared by `normalizeOpenAICompatibleProviderError` (thrown fetch failures) and the adapter's
 * `processChunk` (errors injected mid-SSE after a 200) so both paths agree. They previously
 * disagreed: the SSE path hardcoded a non-retryable `api_error`, which reported a transient
 * mid-stream 500 to the user as a permanent request error.
 *
 * @param statusCode - Upstream status, or null when the failure carried none.
 */
export function classifyOpenAICompatibleStatus(
  statusCode: number | null,
  message: string,
): OpenAICompatibleErrorClassification {
  if (statusCode === null) {
    return { type: "unknown", code: "unknown", retryable: false };
  }

  const code = String(statusCode);

  if (statusCode === 401 || statusCode === 403 || statusCode === 400 || statusCode === 404) {
    return { type: "api_error", code, retryable: false };
  }
  if (statusCode === 429) {
    // Some providers (e.g. Z.ai) use 429 for billing/plan/access denial, not just rate limiting.
    // Detect these by checking the error message for subscription or balance keywords.
    const lowerMessage = message.toLowerCase();
    const isBalanceDenial =
      lowerMessage.includes("insufficient balance") ||
      lowerMessage.includes("insufficient credits") ||
      lowerMessage.includes("not enough credits") ||
      lowerMessage.includes("no resource package") ||
      lowerMessage.includes("please recharge");
    const isPlanAccessDenial =
      lowerMessage.includes("subscription plan") ||
      lowerMessage.includes("does not yet include access") ||
      lowerMessage.includes("plan does not include");
    if (isBalanceDenial) {
      return { type: "api_error", code: "429_balance", retryable: false };
    }
    if (isPlanAccessDenial) {
      return { type: "api_error", code: "429_plan_access", retryable: false };
    }
    return { type: "rate_limit", code, retryable: true };
  }
  if (statusCode === 408 || statusCode === 504) {
    return { type: "timeout", code, retryable: true };
  }
  if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
    return { type: "provider_overloaded", code, retryable: true };
  }
  return { type: "api_error", code, retryable: false };
}

export function normalizeOpenAICompatibleProviderError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): ProviderError {
  const errorMessage = error instanceof Error ? error.message : String(error);

  let errorCode = "unknown";
  let errorType: ProviderError["type"] = "unknown";
  let retryable = false;

  if (errorMessage.includes("HTTP 4") || errorMessage.includes("HTTP 5")) {
    const statusMatch = errorMessage.match(/HTTP (\d{3})/);
    if (statusMatch) {
      const classification = classifyOpenAICompatibleStatus(Number.parseInt(statusMatch[1], 10), errorMessage);
      errorType = classification.type;
      errorCode = classification.code;
      retryable = classification.retryable;
    }
  }

  if (isProviderModelErrorMessage(errorMessage)) {
    errorType = "model_error";
    errorCode = errorCode === "unknown" ? "model_error" : `${errorCode}_model`;
    retryable = false;
  }

  const normalizedMessage = errorMessage.toLowerCase();
  if (normalizedMessage.includes("econnrefused") || normalizedMessage.includes("connection refused")) {
    errorType = "api_error";
    errorCode = "ECONNREFUSED";
    retryable = false;
  }

  if (normalizedMessage.includes("timeout")) {
    errorType = "timeout";
    retryable = true;
  }

  return {
    type: errorType,
    message: `${options.errorMessagePrefix}: ${errorMessage}`,
    code: errorCode,
    retryable,
    originalError: error,
  };
}

export function createOpenAICompatibleErrorDescription(
  error: ProviderError,
  locale: string,
  options: CreateErrorDescriptionOptions,
): string {
  const errorCode = error.code || "unknown";

  if (errorCode === "ECONNREFUSED" && options.connectionRefusedMessage) {
    return `Error Code ECONNREFUSED: ${options.connectionRefusedMessage}`;
  }

  let messageKey: string;
  switch (error.type) {
    case "model_error":
      messageKey = "model_error_default_message";
      break;
    case "rate_limit":
      messageKey = "429_default_message";
      break;
    case "timeout":
      messageKey = "408_default_message";
      break;
    case "provider_overloaded":
      messageKey = `${errorCode}_default_message`;
      break;
    case "api_error":
      messageKey = `${errorCode}_default_message`;
      break;
    default:
      messageKey = "unknown_default_message";
      break;
  }

  // A 5xx that names a request parameter is a rejection wearing an outage's status code, so a
  // namespace may define remediation copy for exactly that case. Gating it on the upstream text
  // is the point: asserting a parameter cause on every 5xx sends users to change settings the
  // failing payload never carried.
  const parameterMessage =
    (error.type === "api_error" || error.type === "provider_overloaded") &&
    errorMessageNamesRejectableParam(error.message)
      ? resolveLocalizedOrNull(locale, `${options.localeNamespace}.${errorCode}_parameter_default_message`)
      : null;

  const localeKey = `${options.localeNamespace}.${messageKey}`;
  let message = parameterMessage ?? localizer(locale, localeKey);
  let detailsAppended = false;

  if (error.type === "model_error") {
    const details = getProviderErrorDisplayMessage(error);
    if (message === localeKey) {
      message = localizer(locale, "genai.stream.model_error_description");
    }
    if (details && !message.includes(details)) {
      message += `\n\n**Details:**\n${details}`;
      detailsAppended = true;
    }
  } else {
    if (message === localeKey && error.type === "provider_overloaded") {
      // A namespace with no entry for this 5xx still knows the provider is overloaded, so borrow its
      // 503 string when it has one and otherwise the shared cross-provider string. Without the shared
      // step, a namespace carrying no 5xx entries at all (deepseek, custom, zai) renders every
      // overload as "An unexpected error occurred", which reads as a bug on our side.
      message =
        resolveLocalizedOrNull(locale, `${options.localeNamespace}.503_default_message`) ??
        resolveLocalizedOrNull(locale, "genai.stream.provider_overloaded_description") ??
        localeKey;
    }

    if (message === localeKey) {
      message = localizer(locale, `${options.localeNamespace}.unknown_default_message`);

      if (message === `${options.localeNamespace}.unknown_default_message`) {
        message = options.fallbackMessage;
      }

      message = appendProviderErrorDetails(message, error);
      detailsAppended = true;
    }
  }

  if (!detailsAppended && options.appendDetailsForCodes?.includes(errorCode)) {
    message = appendProviderErrorDetails(message, error);
  }

  return `Error Code ${errorCode}: ${message}`;
}

/**
 * Localizes a key, returning null instead of the key itself when no string is defined for it.
 */
function resolveLocalizedOrNull(locale: string, key: string): string | null {
  const value = localizer(locale, key);
  return value === key ? null : value;
}

function appendProviderErrorDetails(message: string, error: ProviderError): string {
  const maxErrorLength = 500;
  const detail = error.message.trim();
  if (!detail || message.includes(detail)) {
    return message;
  }

  const errorSnippet = detail.length > maxErrorLength ? `${detail.substring(0, maxErrorLength)}...` : detail;
  return `${message}\n\n**Details:**\n${errorSnippet}`;
}

function parseOpenAICompatibleErrorPayload(errorText: string): ParsedOpenAICompatibleErrorPayload {
  if (!errorText) {
    return { message: "" };
  }

  try {
    const parsed = JSON.parse(errorText) as Record<string, unknown>;
    const nestedError =
      parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : parsed;

    const detailMessage =
      typeof parsed.detail === "string"
        ? parsed.detail
        : parsed.detail !== undefined
          ? JSON.stringify(parsed.detail)
          : undefined;

    const message =
      typeof nestedError.message === "string"
        ? nestedError.message
        : typeof parsed.message === "string"
          ? parsed.message
          : detailMessage
            ? detailMessage
            : errorText;

    const codeValue =
      typeof nestedError.code === "string" || typeof nestedError.code === "number"
        ? String(nestedError.code)
        : typeof parsed.code === "string" || typeof parsed.code === "number"
          ? String(parsed.code)
          : undefined;

    return {
      message,
      code: codeValue,
    };
  } catch {
    return {
      message: errorText,
    };
  }
}

function getProviderErrorDisplayMessage(error: ProviderError): string | null {
  const maxErrorLength = 1200;
  const detail = error.userMessage?.trim() || error.message.trim();
  if (!detail) {
    return null;
  }
  return detail.length > maxErrorLength ? `${detail.substring(0, maxErrorLength)}...` : detail;
}
