/** Helper to escape special RegExp characters in a string. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Unicode-aware equivalent of wrapping `pattern` in `\b...\b`. `\b` is defined against ASCII
 * `\w`, so it treats any accented letter (é, ö, ñ, ...) as a non-word character and fakes a
 * boundary right beside it, letting the wrapped pattern match mid-word (e.g. "ren" inside
 * "zuhören"). The returned source requires the "u" regex flag on the RegExp it's used in.
 *
 * `\p{M}` is in the class because Discord delivers whatever normalization the sending client
 * used: Apple clients send NFD, where "zuhören" ends in a bare "o" plus a combining diaeresis.
 * Without it the mark itself becomes the fake boundary and the mid-word match survives.
 */
export function wrapWithWordBoundary(pattern: string): string {
  return `(?<![\\p{L}\\p{N}\\p{M}_])${pattern}(?![\\p{L}\\p{N}\\p{M}_])`;
}
