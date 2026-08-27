/**
 * Action identifier registry for semantic panel-action telemetry.
 *
 * Each entry represents one successfully completed UI operation behind a panel.
 * Format follows the durable grammar:
 *
 *   <surface>.<scope>.<resource>.<verb>
 *
 * - <scope> is "workspace" (guild- or DM-backed workspace) or "personal" (account-owned).
 * - Identifiers describe the UI contract, not implementation details or resource IDs.
 * - Metric keys are strictly closed to this registry to guarantee bounded cardinality.
 */

export const PANEL_ACTIONS = [
  // mcps
  "mcps.workspace.server.add",
  "mcps.workspace.server.enable",
  "mcps.workspace.server.disable",
  "mcps.workspace.server.remove",

  // st-presets
  "st-presets.workspace.preset.add",
  "st-presets.workspace.preset.activate",
  "st-presets.workspace.preset.deactivate",
  "st-presets.workspace.preset.remove",
  "st-presets.workspace.nodes.save",

  // providers (workspace)
  "providers.workspace.provider.add",
  "providers.workspace.provider.edit",
  "providers.workspace.endpoint.add",
  "providers.workspace.endpoint.edit",
  "providers.workspace.model.save",
  "providers.workspace.entry.remove",

  // providers (personal)
  "providers.personal.provider.add",
  "providers.personal.provider.edit",
  "providers.personal.endpoint.add",
  "providers.personal.endpoint.edit",
  "providers.personal.model.save",
  "providers.personal.entry.remove",

  // moderation
  "moderation.workspace.member-access.set",
  "moderation.workspace.model-access.set",
  "moderation.workspace.user-blacklist.add",
  "moderation.workspace.user-blacklist.remove",
  "moderation.workspace.persona-block.remove",
  "moderation.workspace.whitelist-channel.add",
  "moderation.workspace.whitelist-channel.remove",
  "moderation.workspace.whitelist-role.add",
  "moderation.workspace.whitelist-role.remove",
  "moderation.workspace.persona-channel.add",
  "moderation.workspace.persona-channel.remove",
  "moderation.workspace.quota.set",
] as const;

/** Union of all valid panel action metric keys. */
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export type ProviderPanelResourceAndVerb =
  | "provider.add"
  | "provider.edit"
  | "endpoint.add"
  | "endpoint.edit"
  | "model.save"
  | "entry.remove";

/**
 * Maps a provider panel scope kind to its canonical workspace or personal action identifier.
 * Treats anything other than "personal" as workspace scope.
 */
export function resolveProviderPanelAction(
  scopeKind: "server" | "personal" | undefined,
  resourceAndVerb: ProviderPanelResourceAndVerb,
): PanelAction {
  const scope = scopeKind === "personal" ? "personal" : "workspace";
  // No cast: the two operand unions cross-multiply to exactly the twelve providers entries above, so a
  // registry entry deleted without updating this signature is a compile error rather than a silent bad key.
  return `providers.${scope}.${resourceAndVerb}`;
}
