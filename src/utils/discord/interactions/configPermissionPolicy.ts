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
