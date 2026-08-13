/**
 * Strips submitted values from `update_user_info` arguments before they reach
 * execution history, thought-log details, or structured logs, keeping only which
 * fields were touched. Gender, pronouns, and nicknames are the target's own data
 * and have no place in diagnostic storage.
 *
 * Value fields are derived by exclusion rather than listed, so adding a field to
 * the tool cannot silently leak it here.
 */
export function redactToolParametersForStorage(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "update_user_info") return args;

  const { target_user: targetUser, clear, ...values } = args;
  const changedFields = Object.keys(values);
  const clearedFields = Array.isArray(clear) ? clear.filter((field): field is string => typeof field === "string") : [];

  return {
    ...(typeof targetUser === "string" ? { target_user: targetUser } : {}),
    ...(changedFields.length > 0 ? { changed_fields: changedFields } : {}),
    ...(clearedFields.length > 0 ? { cleared_fields: clearedFields } : {}),
  };
}
