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
  "providers.workspace.speech-endpoint.activate",
  "providers.workspace.transcription-endpoint.activate",

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

  // personal-memories
  "personal-memories.personal.memory.add",
  "personal-memories.personal.memory.edit",
  "personal-memories.personal.memory.remove",
  "personal-memories.personal.stm.clear",

  // memories (workspace)
  "memories.workspace.memory.add",
  "memories.workspace.memory.edit",
  "memories.workspace.memory.remove",
  "memories.workspace.memory.vectorize",
  "memories.workspace.document.add",
  "memories.workspace.document.remove",
  "memories.workspace.history-document.remove",
  "memories.workspace.document-chunk.edit",
  "memories.workspace.document-chunk.remove",
  "memories.workspace.stm.clear",

  // personal-config
  "personal-config.personal.naming.set",
  "personal-config.personal.about.set",
  "personal-config.personal.language.set",
  "personal-config.personal.timezone.set",
  "personal-config.personal.appearance.set",
  "personal-config.personal.privacy.set",
  "personal-config.personal.crossserver-stm.set",
  "personal-config.personal.model.set",
  "personal-config.personal.model-routing.set",
  "personal-config.personal.parameters.set",
  "personal-config.personal.fallbacks.set",
  "personal-config.personal.randomizer.set",
  "personal-config.personal.trigger-mode.set",
  "personal-config.personal.tool-mode.set",
  "personal-config.personal.impersonation.set",
  "personal-config.personal.spotlight.set",
  "personal-config.personal.spotlight.remove",

  // server config panel; the surface avoids a bare "config" prefix because `check-locales` treats
  // that as a locale namespace root and would read these identifiers as missing locale keys
  "server-config.workspace.persona-avatar.set",
  "server-config.workspace.persona.rename",
  "server-config.workspace.persona-naming.set",
  "server-config.workspace.persona-trigger.add",
  "server-config.workspace.persona-trigger.remove",
  "server-config.workspace.persona.promote",
  "server-config.workspace.persona-attribute.add",
  "server-config.workspace.persona-attribute.edit",
  "server-config.workspace.persona-attribute.remove",
  "server-config.workspace.persona-dialogue.add",
  "server-config.workspace.persona-dialogue.edit",
  "server-config.workspace.persona-dialogue.remove",
  "server-config.workspace.persona-stm.edit",
  "server-config.workspace.persona-conditioning.remove",
  "server-config.workspace.persona-image-tags.set",
  "server-config.workspace.persona-character-reference.set",
  "server-config.workspace.persona-prompt.set",
  "server-config.workspace.persona-prompt.remove",
  "server-config.workspace.persona-context-note.set",
  "server-config.workspace.persona-humanizer.set",
  "server-config.workspace.persona-text-model.set",
  "server-config.workspace.persona-text-model.clear",
  "server-config.workspace.persona-sprite.add",
  "server-config.workspace.persona-sprite.edit",
  "server-config.workspace.persona-sprite.remove",
  "server-config.workspace.persona-sprite.import",
  "server-config.workspace.persona-sprite.export",
  "server-config.workspace.model.set",
  "server-config.workspace.model.clear",
  "server-config.workspace.parameters.set",
  "server-config.workspace.stop-strings.add",
  "server-config.workspace.stop-strings.manage",
  "server-config.workspace.logit-bias.add",
  "server-config.workspace.logit-bias.upload",
  "server-config.workspace.logit-bias.remove",
  "server-config.workspace.fallbacks.set",
  "server-config.workspace.randomizer.set",
  "server-config.workspace.image-tags.set",
  "server-config.workspace.nai-parameters.set",
  "server-config.workspace.system-prompt.set",
  "server-config.workspace.system-prompt.preset",
  "server-config.workspace.system-prompt.remove",
  "server-config.workspace.context-note.set",
  "server-config.workspace.humanizer.set",
  "server-config.workspace.message-fetch-limit.set",
  "server-config.workspace.timezone.set",
  "server-config.workspace.trigger-limits.set",
  "server-config.workspace.deliberate-trigger-mode.set",
  "server-config.workspace.always-reply.set",
  "server-config.workspace.cooldown.set",
  "server-config.workspace.random-trigger.add",
  "server-config.workspace.random-trigger.update",
  "server-config.workspace.random-trigger.remove",
  "server-config.workspace.deliberate-tool-mode.set",
  "server-config.workspace.deliberate-tool-context.set",
  "server-config.workspace.deliberate-tool-trigger.set",
  "server-config.workspace.send-limit.set",
  "server-config.workspace.self-debug.set",
  "server-config.workspace.workarounds.set",
  "server-config.workspace.notice-visibility.set",
  "server-config.workspace.speech-transcripts.set",
  "server-config.workspace.memory-tagging.set",
  "server-config.workspace.stm-parameters.set",
  "server-config.workspace.stm-categories.set",
  "server-config.workspace.stm-prompt.set",
  "server-config.workspace.tool-use.set",
  "server-config.workspace.capabilities.set",
  "server-config.workspace.stm-privacy-bypass.set",
  "personal-config.personal.character-reference.set",
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
