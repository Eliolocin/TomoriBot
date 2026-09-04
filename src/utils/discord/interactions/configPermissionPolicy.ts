import { PermissionsBitField } from "discord.js";
import {
  CONFIG_CATEGORY_ORDER,
  CONFIG_LANDING_CATEGORY,
  CONFIG_LANDING_PAGE,
  CONFIG_PAGES_BY_CATEGORY,
  DEFAULT_PAGE_FOR_CONFIG_CATEGORY,
  type ConfigCategory,
  type ConfigPage,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";

/**
 * `/config` opens over a guild or over a DM-backed personal workspace. A DM actor is the workspace
 * owner by construction, so the manager flag only discriminates guild members.
 */
export interface ConfigActor {
  workspaceKind: "guild" | "dm";
  isManager: boolean;
}

/**
 * `omitted` hides a surface entirely; `disabled` renders an inert control that explains a permission
 * boundary. Sensitive or context-inapplicable state is omitted rather than disabled, so a member
 * never sees a value they may not read.
 */
export type ConfigSurfaceState = "enabled" | "disabled" | "omitted";

/** A page whose controls are inert but whose explanatory prose still renders. */
export type ConfigPageState = "enabled" | "read-only" | "omitted";

export type ConfigPersonaGeneralAction = "avatar" | "rename" | "naming" | "trigger-add" | "trigger-remove" | "promote";
export type ConfigPersonaCollectionAction =
  | "attribute-add"
  | "attribute-edit"
  | "attribute-remove"
  | "dialogue-add"
  | "dialogue-edit"
  | "dialogue-remove";
export type ConfigPersonaMemoriesAction = "server-memory-open" | "personal-memory-open" | "stm-edit" | "conditioning";
export type ConfigPersonaSpritesAction = "inspect" | "export" | "add" | "edit" | "remove" | "import";
export type ConfigPersonaAdvancedAction =
  | "image-tags"
  | "character-reference"
  | "prompt"
  | "context-note"
  | "humanizer"
  | "text-override";

export type ConfigBehaviorGeneralAction = "prompt" | "context-note" | "humanizer" | "fetch-limit" | "timezone";
export type ConfigBehaviorTriggerAction =
  | "random-add"
  | "random-remove"
  | "matching-limits"
  | "deliberate-trigger-mode"
  | "always-reply"
  | "cooldown";

export type ConfigBehaviorExperimentalAction =
  | "tool-mode"
  | "tool-context"
  | "tool-trigger"
  | "send-limit"
  | "self-debug"
  | "workarounds";
export type ConfigBehaviorNoticesAction = "notice-visibility" | "speech-transcripts";
export type ConfigBehaviorMemoryAction = "memory-tagging" | "stm-parameters" | "stm-categories" | "stm-prompt";
export type ConfigPermissionsCapabilitiesAction = "tool-use" | "manage";
export type ConfigPermissionsPrivacyAction = "privacy-bypass";
export type ConfigChannelsDestinationsAction = "log" | "welcome";
export type ConfigChannelsAutoTriggerAction = "auto-trigger" | "threshold";
export type ConfigChannelsRulesAction = "private" | "roleplay" | "blocklist";
export type ConfigChannelsOverridesAction = "prompt" | "context-note" | "text-model";

/**
 * Derives the acting workspace identity from the interaction alone.
 *
 * No repository read is involved, which is what lets authorization run before the workspace loads:
 * a forged custom ID is rejected without ever touching the database. Outside a guild the actor is
 * the DM recipient, who owns that workspace by construction.
 */
export function resolveConfigActor(interaction: {
  guildId: string | null;
  memberPermissions: { has(flag: bigint): boolean } | null;
}): ConfigActor {
  if (!interaction.guildId) return { workspaceKind: "dm", isManager: true };
  return {
    workspaceKind: "guild",
    isManager: interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false,
  };
}

export function resolveConfigCategoryState(category: ConfigCategory, actor: ConfigActor): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") {
    // Channel configuration names guild channels, which a DM workspace has none of.
    return category === "channels" ? "omitted" : "enabled";
  }
  if (actor.isManager) return "enabled";

  return category === "persona" ? "enabled" : "disabled";
}

export function resolveConfigPageState(
  category: ConfigCategory,
  page: ConfigPage,
  actor: ConfigActor,
): ConfigPageState {
  if (resolveConfigCategoryState(category, actor) !== "enabled") return "omitted";

  if (actor.workspaceKind === "dm") {
    if (category === "persona" && page === "triggers") return "omitted";
    if (category === "behavior") return page === "trigger" || page === "memory" ? "omitted" : "enabled";
    if (category === "permissions") return page === "privacy" ? "omitted" : "enabled";
    if (category === "models") return page === "image" ? "omitted" : "enabled";
    return "enabled";
  }

  if (actor.isManager) return "enabled";

  if (category === "persona") {
    // Appearance and Advanced hold manager-owned image, prompt, note, and routing state.
    if (page === "appearance" || page === "advanced") return "omitted";
    return page === "general" ? "enabled" : "read-only";
  }

  return page === "notices" ? "enabled" : "read-only";
}

/**
 * Pages a filtered selector may present. A String Select option cannot be disabled, so an omitted
 * page must not appear at all; a read-only page still appears because its prose is safe.
 */
export function visibleConfigPages(category: ConfigCategory, actor: ConfigActor): ConfigPage[] {
  return CONFIG_PAGES_BY_CATEGORY[category].filter(
    (page) => resolveConfigPageState(category, page, actor) !== "omitted",
  );
}

export function visibleConfigCategories(actor: ConfigActor): Array<{ category: ConfigCategory; disabled: boolean }> {
  return CONFIG_CATEGORY_ORDER.flatMap((category) => {
    const state = resolveConfigCategoryState(category, actor);
    return state === "omitted" ? [] : [{ category, disabled: state === "disabled" }];
  });
}

/**
 * Resolves where the panel opens, and where a denied or stale navigation falls back to. Prefers the
 * declared landing location and degrades to the first surface this actor may actually open.
 */
export function resolveConfigLanding(actor: ConfigActor): { category: ConfigCategory; page: ConfigPage } {
  if (
    resolveConfigCategoryState(CONFIG_LANDING_CATEGORY, actor) === "enabled" &&
    resolveConfigPageState(CONFIG_LANDING_CATEGORY, CONFIG_LANDING_PAGE, actor) !== "omitted"
  ) {
    return { category: CONFIG_LANDING_CATEGORY, page: CONFIG_LANDING_PAGE };
  }

  for (const category of CONFIG_CATEGORY_ORDER) {
    if (resolveConfigCategoryState(category, actor) !== "enabled") continue;
    const pages = visibleConfigPages(category, actor);
    const page = pages.includes(DEFAULT_PAGE_FOR_CONFIG_CATEGORY[category])
      ? DEFAULT_PAGE_FOR_CONFIG_CATEGORY[category]
      : pages[0];
    if (page) return { category, page };
  }

  return { category: CONFIG_LANDING_CATEGORY, page: CONFIG_LANDING_PAGE };
}

/**
 * Per-action policy for Persona > General, re-derived from the commands these actions absorb.
 * Identity, naming, trigger, and promotion mutations are manager-owned in a guild. Rename and
 * naming remain available in a DM workspace because the actor owns that workspace.
 */
export function resolvePersonaGeneralActionState(
  action: ConfigPersonaGeneralAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") {
    return action === "rename" || action === "naming" ? "enabled" : "omitted";
  }
  if (actor.isManager) return "enabled";
  return "disabled";
}

/**
 * Collection actions share the General page's static access. Teaching flags and blacklist state
 * are workspace data, so the route layer applies those dynamic gates after it loads the scope.
 */
export function resolvePersonaCollectionActionState(
  _action: ConfigPersonaCollectionAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  return resolveConfigPageState("persona", "general", actor) === "enabled" ? "enabled" : "omitted";
}

/**
 * Long-term memory navigation and STM inspection are readable on the mixed-permission Memories page;
 * STM editing remains a guild-manager action while the legacy command permits DM editing.
 */
export function resolvePersonaMemoriesActionState(
  action: ConfigPersonaMemoriesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (action === "server-memory-open" || action === "personal-memory-open") {
    return resolveConfigPageState("persona", "memories", actor) === "omitted" ? "omitted" : "enabled";
  }
  if (action === "stm-edit") {
    return actor.workspaceKind === "dm" || actor.isManager ? "enabled" : "disabled";
  }
  return actor.workspaceKind === "guild" && actor.isManager ? "enabled" : "omitted";
}

/**
 * Per-action policy for Persona > Advanced, re-derived from the four commands these actions absorb.
 * The gates are not uniform: `/persona image-tags` and the `persona` target of
 * `/novelai character-reference` require a guild, while `/persona prompt set|remove` gate on Manage
 * Guild only inside `if (interaction.guild)`, so a DM workspace owner may write. `/config humanizer`,
 * `/config context-note set`, and `/model text` carry no handler gate at all, so the route is their
 * only gate once the bare root drops its registration default.
 */
export function resolvePersonaAdvancedActionState(
  action: ConfigPersonaAdvancedAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") {
    return action === "image-tags" || action === "character-reference" ? "omitted" : "enabled";
  }
  if (actor.isManager) return "enabled";
  return "omitted";
}

/**
 * Per-action policy for Persona > Sprites, re-derived from the five commands these actions absorb.
 * `/persona sprites export` carries neither a guild nor a Manage Guild gate and keys its workspace
 * as `interaction.guild?.id ?? interaction.user.id`, so it stays available to a guild member and in
 * a DM. `add`, `edit`, `import`, and `remove` all require a guild and Manage Guild.
 *
 * The page itself resolves to `read-only` for a guild member, so Export is authorized on a page
 * whose state is not `enabled`. That is why the sprites branch of {@link isConfigRouteAuthorized}
 * tests for `omitted` rather than copying the Persona General branch's `!== "enabled"` shape.
 */
export function resolvePersonaSpritesActionState(
  action: ConfigPersonaSpritesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (resolveConfigPageState("persona", "sprites", actor) === "omitted") return "omitted";
  if (action === "inspect" || action === "export") return "enabled";
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

const PERSONA_GENERAL_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigPersonaGeneralAction>> = {
  "avatar-open": "avatar",
  "avatar-submit": "avatar",
  "rename-open": "rename",
  "rename-submit": "rename",
  "naming-style-select": "naming",
  "naming-open": "naming",
  "naming-submit": "naming",
  "trigger-add-open": "trigger-add",
  "trigger-add-submit": "trigger-add",
  "trigger-remove-open": "trigger-remove",
  "trigger-remove-submit": "trigger-remove",
  "promote-view": "promote",
  "promote-confirm": "promote",
  "promote-cancel": "promote",
};

const PERSONA_COLLECTION_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigPersonaCollectionAction>> = {
  "attribute-select": "attribute-edit",
  "attribute-page": "attribute-edit",
  "attribute-add-open": "attribute-add",
  "attribute-add-submit": "attribute-add",
  "attribute-edit-open": "attribute-edit",
  "attribute-edit-submit": "attribute-edit",
  "attribute-remove": "attribute-remove",
  "dialogue-select": "dialogue-edit",
  "dialogue-page": "dialogue-edit",
  "dialogue-add-open": "dialogue-add",
  "dialogue-add-submit": "dialogue-add",
  "dialogue-edit-open": "dialogue-edit",
  "dialogue-edit-submit": "dialogue-edit",
  "dialogue-remove": "dialogue-remove",
};

const PERSONA_MEMORIES_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigPersonaMemoriesAction>> = {
  "server-memory-open": "server-memory-open",
  "personal-memory-open": "personal-memory-open",
  "stm-edit-open": "stm-edit",
  "stm-edit-submit": "stm-edit",
  "conditioning-open": "conditioning",
  "conditioning-submit": "conditioning",
};

export const PERSONA_ADVANCED_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigPersonaAdvancedAction>
> = {
  "image-tags-open": "image-tags",
  "image-tags-submit": "image-tags",
  "character-reference-open": "character-reference",
  "character-reference-submit": "character-reference",
  "character-reference-clear-view": "character-reference",
  "character-reference-clear-confirm": "character-reference",
  "character-reference-clear-cancel": "character-reference",
  "prompt-open": "prompt",
  "prompt-submit": "prompt",
  "prompt-remove": "prompt",
  "context-note-open": "context-note",
  "context-note-submit": "context-note",
  "humanizer-open": "humanizer",
  "humanizer-select": "humanizer",
  "humanizer-submit": "humanizer",
  "text-override-open": "text-override",
  "text-override-provider-select": "text-override",
  "text-override-model-select": "text-override",
  "text-override-model-submit": "text-override",
  "text-override-model-page": "text-override",
  "text-override-clear": "text-override",
};

export const PERSONA_SPRITES_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigPersonaSpritesAction>> =
  {
    "sprite-select": "inspect",
    "sprite-page": "inspect",
    "sprite-remove-cancel": "inspect",
    "sprite-export": "export",
    "sprite-add-open": "add",
    "sprite-add-submit": "add",
    "sprite-edit-open": "edit",
    "sprite-edit-submit": "edit",
    "sprite-remove-view": "remove",
    "sprite-remove-confirm": "remove",
    "sprite-import-open": "import",
    "sprite-import-submit": "import",
  };

/**
 * Behavior General keeps the DM-capable global settings from their legacy commands. Timezone is
 * the one exception because its source command requires a guild interaction.
 */
export const BEHAVIOR_GENERAL_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigBehaviorGeneralAction>
> = {
  "behavior-prompt-open": "prompt",
  "behavior-prompt-submit": "prompt",
  "behavior-preset-open": "prompt",
  "behavior-preset-submit": "prompt",
  "behavior-prompt-remove": "prompt",
  "behavior-context-open": "context-note",
  "behavior-context-submit": "context-note",
  "behavior-humanizer-open": "humanizer",
  "behavior-humanizer-submit": "humanizer",
  "behavior-fetch-open": "fetch-limit",
  "behavior-fetch-submit": "fetch-limit",
  "behavior-timezone-open": "timezone",
  "behavior-timezone-submit": "timezone",
};

/** All Trigger writes are guild-manager operations; Trigger itself is omitted in DMs. */
export const BEHAVIOR_TRIGGER_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigBehaviorTriggerAction>
> = {
  "behavior-random-add-open": "random-add",
  "behavior-random-add-submit": "random-add",
  "behavior-random-remove-open": "random-remove",
  "behavior-random-remove-select": "random-remove",
  "behavior-random-remove-page": "random-remove",
  "behavior-random-remove-submit": "random-remove",
  "behavior-limits-open": "matching-limits",
  "behavior-limits-submit": "matching-limits",
  "behavior-dtm-set": "deliberate-trigger-mode",
  "behavior-always-set": "always-reply",
  "behavior-cooldown-open": "cooldown",
  "behavior-cooldown-submit": "cooldown",
};

export const BEHAVIOR_EXPERIMENTAL_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigBehaviorExperimentalAction>
> = {
  "behavior-tool-mode-set": "tool-mode",
  "behavior-tool-context-open": "tool-context",
  "behavior-tool-context-submit": "tool-context",
  "behavior-tool-trigger-add-open": "tool-trigger",
  "behavior-tool-trigger-add-submit": "tool-trigger",
  "behavior-tool-trigger-remove-open": "tool-trigger",
  "behavior-tool-trigger-remove-submit": "tool-trigger",
  "behavior-send-limit-open": "send-limit",
  "behavior-send-limit-submit": "send-limit",
  "behavior-self-debug-set": "self-debug",
  "behavior-workarounds-open": "workarounds",
  "behavior-workarounds-submit": "workarounds",
};

export const BEHAVIOR_NOTICES_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigBehaviorNoticesAction>
> = {
  "behavior-notice-visibility-open": "notice-visibility",
  "behavior-notice-visibility-submit": "notice-visibility",
  "behavior-speech-transcripts-set": "speech-transcripts",
};

export const BEHAVIOR_MEMORY_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigBehaviorMemoryAction>> =
  {
    "behavior-memory-tagging-open": "memory-tagging",
    "behavior-memory-tagging-submit": "memory-tagging",
    "behavior-stm-parameters-open": "stm-parameters",
    "behavior-stm-parameters-submit": "stm-parameters",
    "behavior-stm-categories-open": "stm-categories",
    "behavior-stm-categories-submit": "stm-categories",
    "behavior-stm-prompt-open": "stm-prompt",
    "behavior-stm-prompt-submit": "stm-prompt",
  };

export const PERMISSIONS_CAPABILITIES_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigPermissionsCapabilitiesAction>
> = {
  "permissions-tool-use-set": "tool-use",
  "permissions-manage-open": "manage",
  "permissions-manage-submit": "manage",
};

export const PERMISSIONS_PRIVACY_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigPermissionsPrivacyAction>
> = {
  "permissions-privacy-bypass-set": "privacy-bypass",
};

export const CHANNELS_DESTINATIONS_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigChannelsDestinationsAction>
> = {
  "channels-log-open": "log",
  "channels-log-submit": "log",
  "channels-log-clear": "log",
  "channels-welcome-open": "welcome",
  "channels-welcome-range-select": "welcome",
  "channels-welcome-submit": "welcome",
  "channels-welcome-clear": "welcome",
};

export const CHANNELS_AUTO_TRIGGER_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigChannelsAutoTriggerAction>
> = {
  "channels-autoch-manage-open": "auto-trigger",
  "channels-autoch-submit": "auto-trigger",
  "channels-autoch-page": "auto-trigger",
  "channels-autoch-configure-open": "auto-trigger",
  "channels-autoch-range-select": "auto-trigger",
  "channels-autoch-configure-submit": "auto-trigger",
  "channels-autoch-threshold-open": "threshold",
  "channels-autoch-threshold-submit": "threshold",
};

export const CHANNELS_RULES_ACTION_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigChannelsRulesAction>> = {
  "channels-private-manage-open": "private",
  "channels-private-submit": "private",
  "channels-private-page": "private",
  "channels-rp-manage-open": "roleplay",
  "channels-rp-submit": "roleplay",
  "channels-rp-page": "roleplay",
  "channels-blocklist-manage-open": "blocklist",
  "channels-blocklist-submit": "blocklist",
  "channels-blocklist-page": "blocklist",
};

export const CHANNELS_OVERRIDES_ACTION_BY_ROUTE: Partial<
  Record<ConfigPanelRoute["action"], ConfigChannelsOverridesAction>
> = {
  "channels-overrides-select": "prompt",
  "channels-overrides-prompt-open": "prompt",
  "channels-overrides-prompt-submit": "prompt",
  "channels-overrides-prompt-clear": "prompt",
  "channels-overrides-context-note-open": "context-note",
  "channels-overrides-context-note-submit": "context-note",
  "channels-overrides-text-open": "text-model",
  "channels-overrides-text-provider-select": "text-model",
  "channels-overrides-text-model-select": "text-model",
  "channels-overrides-text-model-page": "text-model",
  "channels-overrides-text-clear": "text-model",
};

export function resolveBehaviorGeneralActionState(
  action: ConfigBehaviorGeneralAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (action === "timezone" && actor.workspaceKind === "dm") return "omitted";
  if (actor.workspaceKind === "dm") return "enabled";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveBehaviorTriggerActionState(
  _action: ConfigBehaviorTriggerAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveBehaviorExperimentalActionState(
  _action: ConfigBehaviorExperimentalAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveBehaviorNoticesActionState(
  action: ConfigBehaviorNoticesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "enabled";
  if (action === "notice-visibility" || action === "speech-transcripts") {
    return actor.isManager ? "enabled" : "disabled";
  }
  return "disabled";
}

export function resolveBehaviorMemoryActionState(
  _action: ConfigBehaviorMemoryAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolvePermissionsCapabilitiesActionState(
  _action: ConfigPermissionsCapabilitiesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "enabled";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolvePermissionsPrivacyActionState(
  _action: ConfigPermissionsPrivacyAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveChannelsDestinationsActionState(
  _action: ConfigChannelsDestinationsAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveChannelsAutoTriggerActionState(
  _action: ConfigChannelsAutoTriggerAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveChannelsRulesActionState(
  _action: ConfigChannelsRulesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

export function resolveChannelsOverridesActionState(
  _action: ConfigChannelsOverridesAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") return "omitted";
  return actor.isManager ? "enabled" : "disabled";
}

/**
 * Every Models route resolves to the page that owns it.
 *
 * Models carries no per-action exception: re-derived from source, `/model text|vision|embedding|
 * image|video`, `/model parameters|fallback|stop-strings|logit-bias`, `/config model-randomizer`,
 * and `/config image-tags` carry no handler Manage Guild gate at all, so their whole protection was
 * the registration default. The page state is therefore the entire gate, and it is what the route
 * layer re-resolves on every interaction.
 */
export const MODELS_PAGE_BY_ROUTE: Partial<Record<ConfigPanelRoute["action"], ConfigPage>> = {
  "model-provider-select": "switch",
  "model-modal-submit": "switch",
  "parameters-provider-select": "parameters",
  "sampling-open": "parameters",
  "sampling-submit": "parameters",
  "generation-open": "parameters",
  "generation-submit": "parameters",
  "stop-add-open": "parameters",
  "stop-add-submit": "parameters",
  "stop-manage-open": "parameters",
  "stop-manage-submit": "parameters",
  "logit-add-open": "parameters",
  "logit-add-submit": "parameters",
  "logit-upload-open": "parameters",
  "logit-upload-submit": "parameters",
  "logit-manage-select": "parameters",
  "logit-manage-open": "parameters",
  "logit-manage-submit": "parameters",
  "fallback-provider-select": "fallbacks",
  "fallback-provider-range": "fallbacks",
  "fallback-provider-page": "fallbacks",
  "fallback-submit": "fallbacks",
  "randomizer-set": "fallbacks",
  "image-tags-default-open": "image",
  "image-tags-default-submit": "image",
  "nai-parameters-open": "image",
  "nai-parameters-submit": "image",
};

/**
 * The authorization gate every route and modal submit re-runs. Rendering a control is never the
 * gate: a custom ID that was legitimately issued to a manager can be replayed by any member who can
 * read the message, so the answer must come from the actor resolved on this interaction.
 */
export function isConfigRouteAuthorized(route: ConfigPanelRoute, actor: ConfigActor): boolean {
  const personaAction = PERSONA_GENERAL_ACTION_BY_ROUTE[route.action];
  if (personaAction) {
    const page = personaAction === "trigger-add" || personaAction === "trigger-remove" ? "triggers" : "general";
    if (resolveConfigPageState("persona", page, actor) === "omitted") return false;
    return resolvePersonaGeneralActionState(personaAction, actor) === "enabled";
  }

  const collectionAction = PERSONA_COLLECTION_ACTION_BY_ROUTE[route.action];
  if (collectionAction) {
    return resolvePersonaCollectionActionState(collectionAction, actor) === "enabled";
  }

  const memoriesAction = PERSONA_MEMORIES_ACTION_BY_ROUTE[route.action];
  if (memoriesAction) {
    return resolvePersonaMemoriesActionState(memoriesAction, actor) === "enabled";
  }

  const spritesAction = PERSONA_SPRITES_ACTION_BY_ROUTE[route.action];
  if (spritesAction) {
    return resolvePersonaSpritesActionState(spritesAction, actor) === "enabled";
  }

  const modelsPage = MODELS_PAGE_BY_ROUTE[route.action];
  if (modelsPage) {
    return (
      resolveConfigCategoryState("models", actor) === "enabled" &&
      resolveConfigPageState("models", modelsPage, actor) === "enabled"
    );
  }

  const advancedAction = PERSONA_ADVANCED_ACTION_BY_ROUTE[route.action];
  if (advancedAction) {
    if (resolveConfigPageState("persona", "advanced", actor) === "omitted") return false;
    return resolvePersonaAdvancedActionState(advancedAction, actor) === "enabled";
  }

  const generalBehaviorAction = BEHAVIOR_GENERAL_ACTION_BY_ROUTE[route.action];
  if (generalBehaviorAction) {
    if (resolveConfigPageState("behavior", "general", actor) === "omitted") return false;
    return resolveBehaviorGeneralActionState(generalBehaviorAction, actor) === "enabled";
  }

  const triggerBehaviorAction = BEHAVIOR_TRIGGER_ACTION_BY_ROUTE[route.action];
  if (triggerBehaviorAction) {
    if (resolveConfigPageState("behavior", "trigger", actor) === "omitted") return false;
    return resolveBehaviorTriggerActionState(triggerBehaviorAction, actor) === "enabled";
  }

  const experimentalAction = BEHAVIOR_EXPERIMENTAL_ACTION_BY_ROUTE[route.action];
  if (experimentalAction) {
    if (resolveConfigPageState("behavior", "experimental", actor) === "omitted") return false;
    return resolveBehaviorExperimentalActionState(experimentalAction, actor) === "enabled";
  }

  const noticesAction = BEHAVIOR_NOTICES_ACTION_BY_ROUTE[route.action];
  if (noticesAction) {
    if (resolveConfigPageState("behavior", "notices", actor) === "omitted") return false;
    return resolveBehaviorNoticesActionState(noticesAction, actor) === "enabled";
  }

  const memoryAction = BEHAVIOR_MEMORY_ACTION_BY_ROUTE[route.action];
  if (memoryAction) {
    if (resolveConfigPageState("behavior", "memory", actor) === "omitted") return false;
    return resolveBehaviorMemoryActionState(memoryAction, actor) === "enabled";
  }

  const permissionsCapabilitiesAction = PERMISSIONS_CAPABILITIES_ACTION_BY_ROUTE[route.action];
  if (permissionsCapabilitiesAction) {
    if (resolveConfigPageState("permissions", "capabilities", actor) === "omitted") return false;
    return resolvePermissionsCapabilitiesActionState(permissionsCapabilitiesAction, actor) === "enabled";
  }

  const permissionsPrivacyAction = PERMISSIONS_PRIVACY_ACTION_BY_ROUTE[route.action];
  if (permissionsPrivacyAction) {
    if (resolveConfigPageState("permissions", "privacy", actor) === "omitted") return false;
    return resolvePermissionsPrivacyActionState(permissionsPrivacyAction, actor) === "enabled";
  }

  const channelsDestinationsAction = CHANNELS_DESTINATIONS_ACTION_BY_ROUTE[route.action];
  if (channelsDestinationsAction) {
    if (resolveConfigPageState("channels", "destinations", actor) === "omitted") return false;
    return resolveChannelsDestinationsActionState(channelsDestinationsAction, actor) === "enabled";
  }

  const channelsAutoTriggerAction = CHANNELS_AUTO_TRIGGER_ACTION_BY_ROUTE[route.action];
  if (channelsAutoTriggerAction) {
    if (resolveConfigPageState("channels", "auto-trigger", actor) === "omitted") return false;
    return resolveChannelsAutoTriggerActionState(channelsAutoTriggerAction, actor) === "enabled";
  }

  const channelsRulesAction = CHANNELS_RULES_ACTION_BY_ROUTE[route.action];
  if (channelsRulesAction) {
    if (resolveConfigPageState("channels", "rules", actor) === "omitted") return false;
    return resolveChannelsRulesActionState(channelsRulesAction, actor) === "enabled";
  }

  const channelsOverridesAction = CHANNELS_OVERRIDES_ACTION_BY_ROUTE[route.action];
  if (channelsOverridesAction) {
    if (resolveConfigPageState("channels", "overrides", actor) === "omitted") return false;
    return resolveChannelsOverridesActionState(channelsOverridesAction, actor) === "enabled";
  }

  switch (route.action) {
    case "category":
    case "page":
    case "retry":
    case "refresh":
      return (
        resolveConfigCategoryState(route.category, actor) === "enabled" &&
        resolveConfigPageState(route.category, route.page, actor) !== "omitted"
      );
    case "persona-select":
    case "persona-page":
      return resolveConfigCategoryState("persona", actor) === "enabled";
    default:
      return false;
  }
}
