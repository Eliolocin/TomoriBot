/** Default wait for a Python sidecar to report a ready health status. */
export const DEFAULT_PYTHON_HEALTH_TIMEOUT_MS = 300_000;

/**
 * Resolves a positive timeout override without allowing malformed configuration to skip readiness.
 */
export function resolvePositiveTimeoutMs(rawValue: string | undefined, fallbackMs: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(1, Math.ceil(parsed));
}
