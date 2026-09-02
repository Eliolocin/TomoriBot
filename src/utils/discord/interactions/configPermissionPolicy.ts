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
export type ConfigPersonaAdvancedAction =
  | "image-tags"
  | "character-reference"
  | "prompt"
  | "context-note"
  | "humanizer"
  | "text-override";

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

  switch (category) {
    case "persona":
      return "enabled";
    case "behavior":
      // Speech Transcripts under Notices carries no Manage Guild gate today, so the category stays
      // reachable for members rather than collapsing to the manager-only majority of its pages.
      return "enabled";
    default:
      return "disabled";
  }
}

export function resolveConfigPageState(
  category: ConfigCategory,
  page: ConfigPage,
  actor: ConfigActor,
): ConfigPageState {
  if (resolveConfigCategoryState(category, actor) !== "enabled") return "omitted";

  if (actor.workspaceKind === "dm") {
    if (category === "behavior") return page === "trigger" || page === "memory" ? "omitted" : "enabled";
    if (category === "permissions") return page === "privacy" ? "omitted" : "enabled";
    if (category === "models") return page === "image" ? "omitted" : "enabled";
    return "enabled";
  }

  if (actor.isManager) return "enabled";

  if (category === "persona") {
    // Advanced holds prompt, note, image, and routing state that is manager-owned in full.
    if (page === "advanced") return "omitted";
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
 * `/persona avatar`, `rename`, `naming-habits`, and `swap` gate on Manage Guild in a guild;
 * `avatar`, both `trigger` leaves, and `swap` are guild-only; the trigger leaves carry no manager
 * gate at all.
 */
export function resolvePersonaGeneralActionState(
  action: ConfigPersonaGeneralAction,
  actor: ConfigActor,
): ConfigSurfaceState {
  if (actor.workspaceKind === "dm") {
    return action === "rename" || action === "naming" ? "enabled" : "omitted";
  }
  if (actor.isManager) return "enabled";
  return action === "trigger-add" || action === "trigger-remove" ? "enabled" : "disabled";
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
  "text-override-open": "text-override",
  "text-override-provider-select": "text-override",
  "text-override-model-select": "text-override",
  "text-override-model-page": "text-override",
  "text-override-clear": "text-override",
};

/**
 * The authorization gate every route and modal submit re-runs. Rendering a control is never the
 * gate: a custom ID that was legitimately issued to a manager can be replayed by any member who can
 * read the message, so the answer must come from the actor resolved on this interaction.
 */
export function isConfigRouteAuthorized(route: ConfigPanelRoute, actor: ConfigActor): boolean {
  const personaAction = PERSONA_GENERAL_ACTION_BY_ROUTE[route.action];
  if (personaAction) {
    if (resolveConfigPageState("persona", "general", actor) !== "enabled") return false;
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

  const advancedAction = PERSONA_ADVANCED_ACTION_BY_ROUTE[route.action];
  if (advancedAction) {
    if (resolveConfigPageState("persona", "advanced", actor) === "omitted") return false;
    return resolvePersonaAdvancedActionState(advancedAction, actor) === "enabled";
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
