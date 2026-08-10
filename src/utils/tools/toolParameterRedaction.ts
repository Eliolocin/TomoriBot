export function redactToolParametersForStorage(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "update_user_info") return args;
  const changes = Array.isArray(args.changes)
    ? args.changes.map((change) => {
        if (!change || typeof change !== "object") return { invalid: true };
        const item = change as Record<string, unknown>;
        return { field: item.field, scope: item.scope, action: item.action };
      })
    : [];
  return {
    ...(typeof args.target_user === "string" ? { target_user: args.target_user } : {}),
    changes,
  };
}
