/**
 * Shared Unicode measurement, grapheme-safe truncation, and markdown fence guards.
 *
 * Kept free of discord.js dependencies so tool execution paths can budget Discord
 * text safely without loading the Discord client runtime.
 */

/** Zero-width space: renders as nothing, but stops a backtick run from parsing as a fence. */
export const FENCE_GUARD = "​";

/**
 * Breaks up every run of two or more backticks so stored content cannot close the fence it is
 * rendered inside.
 *
 * Replacing the literal triple backtick instead leaves a fence intact for some run lengths: five
 * backticks guard to `` `<zwsp>```` ``, whose tail is still a closing delimiter, and applying the
 * same replacement twice does not converge. Interleaving the whole run leaves no two backticks
 * adjacent at any length.
 */
export function neutralizeFenceRuns(content: string): string {
  return content.replace(/`{2,}/g, (run) => run.split("").join(FENCE_GUARD));
}

/**
 * Measures text length in Unicode codepoints, matching Discord's backend length calculation.
 */
export function getDiscordTextLength(text: string): number {
  return [...text].length;
}

/**
 * Truncates text so its Discord codepoint length stays within maxLength without splitting
 * surrogate pairs or combining-mark grapheme clusters.
 */
export function truncateDiscordText(text: string, maxLength: number, suffix = "..."): string {
  if (maxLength <= 0) return "";
  const totalLength = getDiscordTextLength(text);
  if (totalLength <= maxLength) {
    return text;
  }

  const suffixLength = getDiscordTextLength(suffix);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  if (maxLength <= suffixLength) {
    let result = "";
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
      const segLen = getDiscordTextLength(segment);
      if (count + segLen > maxLength) break;
      result += segment;
      count += segLen;
    }
    return result;
  }

  const available = maxLength - suffixLength;
  let result = "";
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    const segLen = getDiscordTextLength(segment);
    if (count + segLen > available) break;
    result += segment;
    count += segLen;
  }
  return `${result}${suffix}`;
}
