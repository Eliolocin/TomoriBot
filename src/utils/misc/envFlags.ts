/**
 * Shared parsing for the integer tuning knobs read from the environment.
 *
 * Every one of these knobs is a bound on runtime work, so a malformed value must fall back
 * to the documented default rather than disabling the bound: `Number.parseInt` returns
 * `NaN`, and every comparison against `NaN` is false, which turns a ceiling into no ceiling
 * at all.
 */

/**
 * @param value - Raw environment value; `undefined` and non-integers fall back to the default.
 * @param defaultValue - Used when the value is absent or unparsable.
 * @param minimum - Floor applied to a parsed value, so a knob can never be configured below
 *                  the bound its caller needs.
 */
export function parseIntegerEnvFlag(value: string | undefined, defaultValue: number, minimum: number): number {
  if (typeof value !== "string" || value.trim() === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}
