/**
 * Legacy Custom Provider Utilities
 *
 * Shared constants and helpers left over from the retired inline custom-provider setup flow.
 * User-facing setup now lives in /providers and /personal providers.
 *
 * The interactive parts of that old flow were removed once they had no callers left. What
 * remains are the constants and pure helpers that live code still imports.
 */

/**
 * Placeholder API key value for custom provider
 * This satisfies existing validation logic that expects a non-empty API key
 */
export const CUSTOM_ENDPOINT_PLACEHOLDER_KEY = "custom-endpoint-configured";
