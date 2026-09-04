/**
 * Discord Components V2 limit constants, Unicode-safe text truncation, and payload validators.
 *
 * Discord rejects oversized or grammatically invalid component trees with a 400 Bad Request
 * at the REST boundary. These pure validators verify message and modal payloads against Discord's
 * documented constraints before transmission, preventing silent client interaction failures.
 */

import { ComponentType, MessageFlags } from "discord.js";
import type { TopLevelComponentData } from "discord.js";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { RawModalPayload } from "./configModals";

// Discord Component Limits
// Reference: https://discord.com/developers/docs/interactions/message-components
// Components V2 guide: docs/en/architecture/integrations/discord/message-components-v2.md

/**
 * Maximum total components across the entire serialized message tree.
 * Discord counts top-level layout components, nested children, and Section accessories.
 */
export const DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX = 40;

/**
 * Maximum total characters across all Text Display components in a single message.
 * Measured in Unicode codepoints matching Discord's backend length calculation.
 */
export const DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX = 4000;

/** Maximum buttons allowed in a single Action Row. */
export const DISCORD_ACTION_ROW_BUTTONS_MAX = 5;

/** Maximum select menus allowed in a single Action Row. */
export const DISCORD_ACTION_ROW_SELECTS_MAX = 1;

/** Minimum Text Displays required inside a Section component. */
export const DISCORD_SECTION_TEXT_DISPLAYS_MIN = 1;

/** Maximum Text Displays allowed inside a Section component. */
export const DISCORD_SECTION_TEXT_DISPLAYS_MAX = 3;

/** Minimum options in a String Select menu. */
export const DISCORD_SELECT_OPTIONS_MIN = 1;

/** Maximum options in a String Select menu. */
export const DISCORD_SELECT_OPTIONS_MAX = 25;

/** Maximum characters for a select option label. */
export const DISCORD_SELECT_OPTION_LABEL_MAX = 100;

/** Maximum characters for a select option value. */
export const DISCORD_SELECT_OPTION_VALUE_MAX = 100;

/** Maximum characters for a select option description. */
export const DISCORD_SELECT_OPTION_DESCRIPTION_MAX = 100;

/** Maximum characters for a select menu placeholder. */
export const DISCORD_SELECT_PLACEHOLDER_MAX = 150;

/** Maximum characters for a button label. */
export const DISCORD_BUTTON_LABEL_MAX = 80;

/** Minimum characters for an interactive component custom ID. */
export const DISCORD_CUSTOM_ID_MIN = 1;

/** Maximum characters for an interactive component custom ID. */
export const DISCORD_CUSTOM_ID_MAX = 100;

/** Maximum characters for a link button URL. */
export const DISCORD_BUTTON_URL_MAX = 512;

/** Maximum characters for Thumbnail or Media Gallery item alt text. */
export const DISCORD_MEDIA_DESCRIPTION_MAX = 1024;

/** Minimum items in a Media Gallery component. */
export const DISCORD_MEDIA_GALLERY_ITEMS_MIN = 1;

/** Maximum items in a Media Gallery component. */
export const DISCORD_MEDIA_GALLERY_ITEMS_MAX = 10;

/** Maximum characters for a modal dialog title. */
export const DISCORD_MODAL_TITLE_MAX = 45;

/** Minimum top-level components in a modal dialog. */
export const DISCORD_MODAL_COMPONENTS_MIN = 1;

/** Maximum top-level components in a modal dialog. */
export const DISCORD_MODAL_COMPONENTS_MAX = 5;

/** Maximum characters for a modal component label (Component Type 18 wrapper). */
export const DISCORD_MODAL_FIELD_LABEL_MAX = 45;

/** Maximum characters for a modal component description. */
export const DISCORD_MODAL_FIELD_DESCRIPTION_MAX = 100;

/** Minimum options in a modal Checkbox Group. */
export const DISCORD_CHECKBOX_GROUP_OPTIONS_MIN = 1;

/** Maximum options in a modal Checkbox Group. */
export const DISCORD_CHECKBOX_GROUP_OPTIONS_MAX = 10;

/** Minimum options in a modal Radio Group. */
export const DISCORD_RADIO_GROUP_OPTIONS_MIN = 1;

/** Maximum options in a modal Radio Group. */
export const DISCORD_RADIO_GROUP_OPTIONS_MAX = 10;

/** Maximum characters for a modal text input value or max_length. */
export const DISCORD_TEXT_INPUT_MAX = 4000;

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

export type DiscordLimitViolationCode =
  | "TOTAL_COMPONENTS_EXCEEDED"
  | "TEXT_DISPLAY_TOTAL_EXCEEDED"
  | "MISSING_V2_FLAG"
  | "LEGACY_FIELD_FORBIDDEN"
  | "INVALID_TOP_LEVEL_COMPONENT"
  | "ACTION_ROW_EMPTY"
  | "ACTION_ROW_OVERSIZED"
  | "ACTION_ROW_MIXED"
  | "ACTION_ROW_INVALID_CHILD"
  | "SECTION_EMPTY"
  | "SECTION_OVERSIZED"
  | "SECTION_INVALID_CHILD"
  | "SECTION_MISSING_ACCESSORY"
  | "SECTION_INVALID_ACCESSORY"
  | "CONTAINER_EMPTY"
  | "CONTAINER_INVALID_CHILD"
  | "SELECT_OPTIONS_EMPTY"
  | "SELECT_OPTIONS_OVERSIZED"
  | "SELECT_OPTION_LABEL_OVERSIZED"
  | "SELECT_OPTION_VALUE_OVERSIZED"
  | "SELECT_OPTION_DESCRIPTION_OVERSIZED"
  | "SELECT_PLACEHOLDER_OVERSIZED"
  | "SELECT_MIN_VALUES_INVALID"
  | "SELECT_MAX_VALUES_INVALID"
  | "SELECT_OPTION_VALUE_DUPLICATE"
  | "BUTTON_LABEL_OVERSIZED"
  | "BUTTON_URL_OVERSIZED"
  | "CUSTOM_ID_MISSING"
  | "CUSTOM_ID_EMPTY"
  | "CUSTOM_ID_OVERSIZED"
  | "CUSTOM_ID_DUPLICATE"
  | "COMPONENT_ID_INVALID"
  | "COMPONENT_ID_DUPLICATE"
  | "MEDIA_DESCRIPTION_OVERSIZED"
  | "MEDIA_GALLERY_ITEMS_EMPTY"
  | "MEDIA_GALLERY_ITEMS_OVERSIZED"
  | "MODAL_TITLE_OVERSIZED"
  | "MODAL_COMPONENTS_EMPTY"
  | "MODAL_COMPONENTS_OVERSIZED"
  | "MODAL_FIELD_LABEL_OVERSIZED"
  | "MODAL_FIELD_DESCRIPTION_OVERSIZED"
  | "MODAL_OPTION_COUNT_INVALID";

export interface DiscordComponentLimitViolation {
  path: string;
  componentType?: number;
  observed: number | string;
  limit: number | string;
  code: DiscordLimitViolationCode;
  message?: string;
}

export interface DiscordComponentValidationResult {
  valid: boolean;
  violations: DiscordComponentLimitViolation[];
}

export class ComponentsV2LimitError extends Error {
  public readonly violations: DiscordComponentLimitViolation[];

  public constructor(message: string, violations: DiscordComponentLimitViolation[]) {
    super(message);
    this.name = "ComponentsV2LimitError";
    this.violations = violations;
  }
}

export interface ComponentsV2MessagePayload {
  components: readonly TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2 | number;
  content?: unknown;
  embeds?: unknown;
  poll?: unknown;
  stickers?: unknown;
}

function isSelectComponentType(type: number): boolean {
  return (
    type === ComponentType.StringSelect ||
    type === ComponentType.UserSelect ||
    type === ComponentType.RoleSelect ||
    type === ComponentType.MentionableSelect ||
    type === ComponentType.ChannelSelect
  );
}

/**
 * Validates a Components V2 message payload against Discord's structural and length limits.
 * Pure and non-mutating. Returns structured violations with no sensitive prompt or user text.
 */
export function validateComponentsV2MessageLimits(
  payload: ComponentsV2MessagePayload,
): DiscordComponentValidationResult {
  const violations: DiscordComponentLimitViolation[] = [];

  if (!(payload.flags & MessageFlags.IsComponentsV2)) {
    violations.push({
      path: "flags",
      observed: payload.flags ?? 0,
      limit: MessageFlags.IsComponentsV2,
      code: "MISSING_V2_FLAG",
    });
  }

  if (payload.content !== undefined) {
    violations.push({
      path: "content",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });
  }
  if (payload.embeds !== undefined) {
    violations.push({
      path: "embeds",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });
  }
  if (payload.poll !== undefined) {
    violations.push({
      path: "poll",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });
  }
  if (payload.stickers !== undefined) {
    violations.push({
      path: "stickers",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });
  }

  let totalComponents = 0;
  let totalTextDisplayLength = 0;
  const customIds = new Set<string>();
  const componentIds = new Set<number>();

  const checkComponentId = (id: unknown, path: string, type: number): void => {
    if (id === undefined || id === 0) return;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 2147483647) {
      violations.push({
        path: `${path}.id`,
        componentType: type,
        observed: typeof id === "number" ? id : String(id),
        limit: "positive 32-bit integer",
        code: "COMPONENT_ID_INVALID",
      });
      return;
    }
    if (componentIds.has(id)) {
      violations.push({
        path: `${path}.id`,
        componentType: type,
        observed: "duplicate_id",
        limit: "unique",
        code: "COMPONENT_ID_DUPLICATE",
      });
    } else {
      componentIds.add(id);
    }
  };

  const checkCustomId = (customId: unknown, path: string, type: number): void => {
    if (typeof customId !== "string") {
      violations.push({
        path: `${path}.customId`,
        componentType: type,
        observed: "missing",
        limit: `${DISCORD_CUSTOM_ID_MIN}-${DISCORD_CUSTOM_ID_MAX} characters`,
        code: "CUSTOM_ID_MISSING",
      });
      return;
    }
    const len = getDiscordTextLength(customId);
    if (len < DISCORD_CUSTOM_ID_MIN) {
      violations.push({
        path: `${path}.customId`,
        componentType: type,
        observed: len,
        limit: `${DISCORD_CUSTOM_ID_MIN}-${DISCORD_CUSTOM_ID_MAX} characters`,
        code: "CUSTOM_ID_EMPTY",
      });
    } else if (len > DISCORD_CUSTOM_ID_MAX) {
      violations.push({
        path: `${path}.customId`,
        componentType: type,
        observed: len,
        limit: DISCORD_CUSTOM_ID_MAX,
        code: "CUSTOM_ID_OVERSIZED",
      });
    }
    if (customIds.has(customId)) {
      violations.push({
        path: `${path}.customId`,
        componentType: type,
        observed: "duplicate_custom_id",
        limit: "unique",
        code: "CUSTOM_ID_DUPLICATE",
      });
    } else {
      customIds.add(customId);
    }
  };

  const validateComponentData = (comp: Record<string, unknown>, path: string): void => {
    const compType = Number(comp.type);
    checkComponentId(comp.id, path, compType);

    if (compType === ComponentType.Button) {
      const style = Number(comp.style);
      if (style === 5) {
        if (typeof comp.url === "string") {
          const urlLen = getDiscordTextLength(comp.url);
          if (urlLen > DISCORD_BUTTON_URL_MAX) {
            violations.push({
              path: `${path}.url`,
              componentType: compType,
              observed: urlLen,
              limit: DISCORD_BUTTON_URL_MAX,
              code: "BUTTON_URL_OVERSIZED",
            });
          }
        }
      } else if (style !== 6) {
        const cid = comp.customId ?? comp.custom_id;
        checkCustomId(cid, path, compType);
      }

      if (typeof comp.label === "string") {
        const labelLen = getDiscordTextLength(comp.label);
        if (labelLen > DISCORD_BUTTON_LABEL_MAX) {
          violations.push({
            path: `${path}.label`,
            componentType: compType,
            observed: labelLen,
            limit: DISCORD_BUTTON_LABEL_MAX,
            code: "BUTTON_LABEL_OVERSIZED",
          });
        }
      }
    } else if (isSelectComponentType(compType)) {
      const cid = comp.customId ?? comp.custom_id;
      checkCustomId(cid, path, compType);

      if (typeof comp.placeholder === "string") {
        const pLen = getDiscordTextLength(comp.placeholder);
        if (pLen > DISCORD_SELECT_PLACEHOLDER_MAX) {
          violations.push({
            path: `${path}.placeholder`,
            componentType: compType,
            observed: pLen,
            limit: DISCORD_SELECT_PLACEHOLDER_MAX,
            code: "SELECT_PLACEHOLDER_OVERSIZED",
          });
        }
      }

      if (compType === ComponentType.StringSelect) {
        const options = Array.isArray(comp.options) ? comp.options : [];
        if (options.length < DISCORD_SELECT_OPTIONS_MIN) {
          violations.push({
            path: `${path}.options`,
            componentType: compType,
            observed: options.length,
            limit: DISCORD_SELECT_OPTIONS_MIN,
            code: "SELECT_OPTIONS_EMPTY",
          });
        } else if (options.length > DISCORD_SELECT_OPTIONS_MAX) {
          violations.push({
            path: `${path}.options`,
            componentType: compType,
            observed: options.length,
            limit: DISCORD_SELECT_OPTIONS_MAX,
            code: "SELECT_OPTIONS_OVERSIZED",
          });
        }

        const minVal = comp.minValues ?? comp.min_values;
        const maxVal = comp.maxValues ?? comp.max_values;
        if (typeof minVal === "number") {
          if (minVal < 0 || minVal > options.length) {
            violations.push({
              path: `${path}.minValues`,
              componentType: compType,
              observed: minVal,
              limit: `0-${options.length}`,
              code: "SELECT_MIN_VALUES_INVALID",
            });
          }
        }
        if (typeof maxVal === "number") {
          if (maxVal < 1 || maxVal > options.length) {
            violations.push({
              path: `${path}.maxValues`,
              componentType: compType,
              observed: maxVal,
              limit: `1-${options.length}`,
              code: "SELECT_MAX_VALUES_INVALID",
            });
          }
        }
        if (typeof minVal === "number" && typeof maxVal === "number" && minVal > maxVal) {
          violations.push({
            path: `${path}.minValues`,
            componentType: compType,
            observed: minVal,
            limit: `<= maxValues (${maxVal})`,
            code: "SELECT_MIN_VALUES_INVALID",
          });
        }

        const optionValues = new Set<string>();
        for (let optIdx = 0; optIdx < options.length; optIdx += 1) {
          const opt = options[optIdx] as Record<string, unknown>;
          const optPath = `${path}.options[${optIdx}]`;
          if (typeof opt?.label === "string") {
            const labelLen = getDiscordTextLength(opt.label);
            if (labelLen > DISCORD_SELECT_OPTION_LABEL_MAX) {
              violations.push({
                path: `${optPath}.label`,
                componentType: compType,
                observed: labelLen,
                limit: DISCORD_SELECT_OPTION_LABEL_MAX,
                code: "SELECT_OPTION_LABEL_OVERSIZED",
              });
            }
          }
          if (typeof opt?.value === "string") {
            const valLen = getDiscordTextLength(opt.value);
            if (valLen > DISCORD_SELECT_OPTION_VALUE_MAX) {
              violations.push({
                path: `${optPath}.value`,
                componentType: compType,
                observed: valLen,
                limit: DISCORD_SELECT_OPTION_VALUE_MAX,
                code: "SELECT_OPTION_VALUE_OVERSIZED",
              });
            }
            if (optionValues.has(opt.value)) {
              violations.push({
                path: `${optPath}.value`,
                componentType: compType,
                observed: "duplicate_value",
                limit: "unique",
                code: "SELECT_OPTION_VALUE_DUPLICATE",
              });
            } else {
              optionValues.add(opt.value);
            }
          }
          if (typeof opt?.description === "string") {
            const descLen = getDiscordTextLength(opt.description);
            if (descLen > DISCORD_SELECT_OPTION_DESCRIPTION_MAX) {
              violations.push({
                path: `${optPath}.description`,
                componentType: compType,
                observed: descLen,
                limit: DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
                code: "SELECT_OPTION_DESCRIPTION_OVERSIZED",
              });
            }
          }
        }
      }
    } else if (compType === ComponentType.TextDisplay) {
      if (typeof comp.content === "string") {
        totalTextDisplayLength += getDiscordTextLength(comp.content);
      }
    } else if (compType === ComponentType.Thumbnail) {
      if (typeof comp.description === "string") {
        const descLen = getDiscordTextLength(comp.description);
        if (descLen > DISCORD_MEDIA_DESCRIPTION_MAX) {
          violations.push({
            path: `${path}.description`,
            componentType: compType,
            observed: descLen,
            limit: DISCORD_MEDIA_DESCRIPTION_MAX,
            code: "MEDIA_DESCRIPTION_OVERSIZED",
          });
        }
      }
    } else if (compType === ComponentType.MediaGallery) {
      const items = Array.isArray(comp.items) ? comp.items : [];
      if (items.length < DISCORD_MEDIA_GALLERY_ITEMS_MIN) {
        violations.push({
          path: `${path}.items`,
          componentType: compType,
          observed: items.length,
          limit: DISCORD_MEDIA_GALLERY_ITEMS_MIN,
          code: "MEDIA_GALLERY_ITEMS_EMPTY",
        });
      } else if (items.length > DISCORD_MEDIA_GALLERY_ITEMS_MAX) {
        violations.push({
          path: `${path}.items`,
          componentType: compType,
          observed: items.length,
          limit: DISCORD_MEDIA_GALLERY_ITEMS_MAX,
          code: "MEDIA_GALLERY_ITEMS_OVERSIZED",
        });
      }
      for (let itemIdx = 0; itemIdx < items.length; itemIdx += 1) {
        const item = items[itemIdx] as Record<string, unknown>;
        if (typeof item?.description === "string") {
          const descLen = getDiscordTextLength(item.description);
          if (descLen > DISCORD_MEDIA_DESCRIPTION_MAX) {
            violations.push({
              path: `${path}.items[${itemIdx}].description`,
              componentType: compType,
              observed: descLen,
              limit: DISCORD_MEDIA_DESCRIPTION_MAX,
              code: "MEDIA_DESCRIPTION_OVERSIZED",
            });
          }
        }
      }
    }
  };

  const validateActionRow = (comp: Record<string, unknown>, path: string): void => {
    validateComponentData(comp, path);
    const children = Array.isArray(comp.components) ? (comp.components as Record<string, unknown>[]) : [];
    if (children.length === 0) {
      violations.push({
        path,
        componentType: ComponentType.ActionRow,
        observed: 0,
        limit: "1-5 buttons or 1 select",
        code: "ACTION_ROW_EMPTY",
      });
      return;
    }

    let buttonCount = 0;
    let selectCount = 0;
    for (let cIdx = 0; cIdx < children.length; cIdx += 1) {
      const child = children[cIdx];
      const childPath = `${path}.components[${cIdx}]`;
      totalComponents += 1;
      const childType = Number(child.type);
      if (childType === ComponentType.Button) {
        buttonCount += 1;
        validateComponentData(child, childPath);
      } else if (isSelectComponentType(childType)) {
        selectCount += 1;
        validateComponentData(child, childPath);
      } else {
        violations.push({
          path: childPath,
          componentType: childType,
          observed: childType,
          limit: "Button or Select",
          code: "ACTION_ROW_INVALID_CHILD",
        });
        validateComponentData(child, childPath);
      }
    }

    if (buttonCount > 0 && selectCount > 0) {
      violations.push({
        path,
        componentType: ComponentType.ActionRow,
        observed: `buttons: ${buttonCount}, selects: ${selectCount}`,
        limit: "buttons only or 1 select",
        code: "ACTION_ROW_MIXED",
      });
    } else if (selectCount > 1) {
      violations.push({
        path,
        componentType: ComponentType.ActionRow,
        observed: selectCount,
        limit: 1,
        code: "ACTION_ROW_MIXED",
      });
    } else if (buttonCount > DISCORD_ACTION_ROW_BUTTONS_MAX) {
      violations.push({
        path,
        componentType: ComponentType.ActionRow,
        observed: buttonCount,
        limit: DISCORD_ACTION_ROW_BUTTONS_MAX,
        code: "ACTION_ROW_OVERSIZED",
      });
    }
  };

  const validateSection = (comp: Record<string, unknown>, path: string): void => {
    validateComponentData(comp, path);
    const children = Array.isArray(comp.components) ? (comp.components as Record<string, unknown>[]) : [];
    if (children.length < DISCORD_SECTION_TEXT_DISPLAYS_MIN) {
      violations.push({
        path,
        componentType: ComponentType.Section,
        observed: children.length,
        limit: DISCORD_SECTION_TEXT_DISPLAYS_MIN,
        code: "SECTION_EMPTY",
      });
    } else if (children.length > DISCORD_SECTION_TEXT_DISPLAYS_MAX) {
      violations.push({
        path,
        componentType: ComponentType.Section,
        observed: children.length,
        limit: DISCORD_SECTION_TEXT_DISPLAYS_MAX,
        code: "SECTION_OVERSIZED",
      });
    }

    for (let cIdx = 0; cIdx < children.length; cIdx += 1) {
      const child = children[cIdx];
      const childPath = `${path}.components[${cIdx}]`;
      totalComponents += 1;
      const childType = Number(child.type);
      if (childType !== ComponentType.TextDisplay) {
        violations.push({
          path: childPath,
          componentType: childType,
          observed: childType,
          limit: ComponentType.TextDisplay,
          code: "SECTION_INVALID_CHILD",
        });
      }
      validateComponentData(child, childPath);
    }

    const accessory = comp.accessory as Record<string, unknown> | undefined;
    if (!accessory) {
      violations.push({
        path: `${path}.accessory`,
        componentType: ComponentType.Section,
        observed: "missing",
        limit: "Button or Thumbnail",
        code: "SECTION_MISSING_ACCESSORY",
      });
    } else {
      totalComponents += 1;
      const accPath = `${path}.accessory`;
      const accType = Number(accessory.type);
      if (accType !== ComponentType.Button && accType !== ComponentType.Thumbnail) {
        violations.push({
          path: accPath,
          componentType: accType,
          observed: accType,
          limit: "Button or Thumbnail",
          code: "SECTION_INVALID_ACCESSORY",
        });
      }
      validateComponentData(accessory, accPath);
    }
  };

  const validateContainer = (comp: Record<string, unknown>, path: string): void => {
    validateComponentData(comp, path);
    const children = Array.isArray(comp.components) ? (comp.components as Record<string, unknown>[]) : [];
    if (children.length === 0) {
      violations.push({
        path,
        componentType: ComponentType.Container,
        observed: 0,
        limit: "> 0",
        code: "CONTAINER_EMPTY",
      });
      return;
    }

    for (let cIdx = 0; cIdx < children.length; cIdx += 1) {
      const child = children[cIdx];
      const childPath = `${path}.components[${cIdx}]`;
      totalComponents += 1;
      const childType = Number(child.type);

      if (childType === ComponentType.ActionRow) {
        validateActionRow(child, childPath);
      } else if (childType === ComponentType.Section) {
        validateSection(child, childPath);
      } else if (
        childType === ComponentType.TextDisplay ||
        childType === ComponentType.MediaGallery ||
        childType === ComponentType.Separator ||
        childType === ComponentType.File
      ) {
        validateComponentData(child, childPath);
      } else {
        violations.push({
          path: childPath,
          componentType: childType,
          observed: childType,
          limit: "ActionRow, TextDisplay, Section, MediaGallery, Separator, or File",
          code: "CONTAINER_INVALID_CHILD",
        });
        validateComponentData(child, childPath);
      }
    }
  };

  const topLevelComponents = Array.isArray(payload.components) ? payload.components : [];
  for (let i = 0; i < topLevelComponents.length; i += 1) {
    const comp = topLevelComponents[i] as unknown as Record<string, unknown>;
    const compPath = `components[${i}]`;
    totalComponents += 1;
    const compType = Number(comp.type);

    if (compType === ComponentType.Container) {
      validateContainer(comp, compPath);
    } else if (compType === ComponentType.Section) {
      validateSection(comp, compPath);
    } else if (compType === ComponentType.ActionRow) {
      validateActionRow(comp, compPath);
    } else if (
      compType === ComponentType.TextDisplay ||
      compType === ComponentType.MediaGallery ||
      compType === ComponentType.Separator ||
      compType === ComponentType.File
    ) {
      validateComponentData(comp, compPath);
    } else {
      violations.push({
        path: compPath,
        componentType: compType,
        observed: compType,
        limit: "top-level component type",
        code: "INVALID_TOP_LEVEL_COMPONENT",
      });
      validateComponentData(comp, compPath);
    }
  }

  if (totalComponents > DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX) {
    violations.push({
      path: "components",
      observed: totalComponents,
      limit: DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX,
      code: "TOTAL_COMPONENTS_EXCEEDED",
    });
  }

  if (totalTextDisplayLength > DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX) {
    violations.push({
      path: "components",
      observed: totalTextDisplayLength,
      limit: DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
      code: "TEXT_DISPLAY_TOTAL_EXCEEDED",
    });
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Asserts that a Components V2 message payload complies with Discord limits.
 * Throws ComponentsV2LimitError if violations are found.
 */
export function assertComponentsV2MessageLimits(payload: ComponentsV2MessagePayload): void {
  const result = validateComponentsV2MessageLimits(payload);
  if (!result.valid) {
    const summary = result.violations
      .map((v) => `${v.path}: [${v.code}] observed ${v.observed} (limit ${v.limit})`)
      .join("; ");
    throw new ComponentsV2LimitError(`Components V2 payload exceeded Discord limits: ${summary}`, result.violations);
  }
}

/**
 * Validates a raw modal wire payload against Discord limits.
 * Pure and non-mutating. Returns structured path-aware violations.
 */
export function validateRawModalLimits(payload: RawModalPayload): DiscordComponentValidationResult {
  const violations: DiscordComponentLimitViolation[] = [];

  const titleLen = getDiscordTextLength(payload.title ?? "");
  if (titleLen > DISCORD_MODAL_TITLE_MAX) {
    violations.push({
      path: "title",
      observed: titleLen,
      limit: DISCORD_MODAL_TITLE_MAX,
      code: "MODAL_TITLE_OVERSIZED",
    });
  }

  const components = Array.isArray(payload.components) ? payload.components : [];
  if (components.length < DISCORD_MODAL_COMPONENTS_MIN) {
    violations.push({
      path: "components",
      observed: components.length,
      limit: DISCORD_MODAL_COMPONENTS_MIN,
      code: "MODAL_COMPONENTS_EMPTY",
    });
  } else if (components.length > DISCORD_MODAL_COMPONENTS_MAX) {
    violations.push({
      path: "components",
      observed: components.length,
      limit: DISCORD_MODAL_COMPONENTS_MAX,
      code: "MODAL_COMPONENTS_OVERSIZED",
    });
  }

  const customIds = new Set<string>();
  const componentIds = new Set<number>();

  const checkComponent = (comp: RawDiscordComponent, path: string): void => {
    if (comp.id !== undefined && comp.id !== 0) {
      if (typeof comp.id !== "number" || !Number.isInteger(comp.id) || comp.id <= 0 || comp.id > 2147483647) {
        violations.push({
          path: `${path}.id`,
          componentType: comp.type,
          observed: comp.id,
          limit: "positive 32-bit integer",
          code: "COMPONENT_ID_INVALID",
        });
      } else if (componentIds.has(comp.id)) {
        violations.push({
          path: `${path}.id`,
          componentType: comp.type,
          observed: "duplicate_id",
          limit: "unique",
          code: "COMPONENT_ID_DUPLICATE",
        });
      } else {
        componentIds.add(comp.id);
      }
    }

    if (comp.custom_id !== undefined) {
      const cidLen = getDiscordTextLength(comp.custom_id);
      if (cidLen < DISCORD_CUSTOM_ID_MIN) {
        violations.push({
          path: `${path}.custom_id`,
          componentType: comp.type,
          observed: cidLen,
          limit: `${DISCORD_CUSTOM_ID_MIN}-${DISCORD_CUSTOM_ID_MAX} characters`,
          code: "CUSTOM_ID_EMPTY",
        });
      } else if (cidLen > DISCORD_CUSTOM_ID_MAX) {
        violations.push({
          path: `${path}.custom_id`,
          componentType: comp.type,
          observed: cidLen,
          limit: DISCORD_CUSTOM_ID_MAX,
          code: "CUSTOM_ID_OVERSIZED",
        });
      }
      if (customIds.has(comp.custom_id)) {
        violations.push({
          path: `${path}.custom_id`,
          componentType: comp.type,
          observed: "duplicate_custom_id",
          limit: "unique",
          code: "CUSTOM_ID_DUPLICATE",
        });
      } else {
        customIds.add(comp.custom_id);
      }
    }

    if (comp.type === 18) {
      if (typeof comp.label === "string") {
        const labelLen = getDiscordTextLength(comp.label);
        if (labelLen > DISCORD_MODAL_FIELD_LABEL_MAX) {
          violations.push({
            path: `${path}.label`,
            componentType: comp.type,
            observed: labelLen,
            limit: DISCORD_MODAL_FIELD_LABEL_MAX,
            code: "MODAL_FIELD_LABEL_OVERSIZED",
          });
        }
      }
      if (typeof comp.description === "string") {
        const descLen = getDiscordTextLength(comp.description);
        if (descLen > DISCORD_MODAL_FIELD_DESCRIPTION_MAX) {
          violations.push({
            path: `${path}.description`,
            componentType: comp.type,
            observed: descLen,
            limit: DISCORD_MODAL_FIELD_DESCRIPTION_MAX,
            code: "MODAL_FIELD_DESCRIPTION_OVERSIZED",
          });
        }
      }
      if (comp.component) {
        checkComponent(comp.component, `${path}.component`);
      }
    }

    if (comp.type === 3) {
      const options = Array.isArray(comp.options) ? comp.options : [];
      if (options.length < DISCORD_SELECT_OPTIONS_MIN || options.length > DISCORD_SELECT_OPTIONS_MAX) {
        violations.push({
          path: `${path}.options`,
          componentType: comp.type,
          observed: options.length,
          limit: `${DISCORD_SELECT_OPTIONS_MIN}-${DISCORD_SELECT_OPTIONS_MAX}`,
          code: "MODAL_OPTION_COUNT_INVALID",
        });
      }
      const seenValues = new Set<string>();
      for (let optIdx = 0; optIdx < options.length; optIdx += 1) {
        const opt = options[optIdx];
        const optPath = `${path}.options[${optIdx}]`;
        if (typeof opt?.label === "string") {
          const lLen = getDiscordTextLength(opt.label);
          if (lLen > DISCORD_SELECT_OPTION_LABEL_MAX) {
            violations.push({
              path: `${optPath}.label`,
              componentType: comp.type,
              observed: lLen,
              limit: DISCORD_SELECT_OPTION_LABEL_MAX,
              code: "SELECT_OPTION_LABEL_OVERSIZED",
            });
          }
        }
        if (typeof opt?.value === "string") {
          const vLen = getDiscordTextLength(opt.value);
          if (vLen > DISCORD_SELECT_OPTION_VALUE_MAX) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: vLen,
              limit: DISCORD_SELECT_OPTION_VALUE_MAX,
              code: "SELECT_OPTION_VALUE_OVERSIZED",
            });
          }
          if (seenValues.has(opt.value)) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: "duplicate_value",
              limit: "unique",
              code: "SELECT_OPTION_VALUE_DUPLICATE",
            });
          } else {
            seenValues.add(opt.value);
          }
        }
        if (typeof opt?.description === "string") {
          const dLen = getDiscordTextLength(opt.description);
          if (dLen > DISCORD_SELECT_OPTION_DESCRIPTION_MAX) {
            violations.push({
              path: `${optPath}.description`,
              componentType: comp.type,
              observed: dLen,
              limit: DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
              code: "SELECT_OPTION_DESCRIPTION_OVERSIZED",
            });
          }
        }
      }
    }

    if (comp.type === 21) {
      const options = Array.isArray(comp.options) ? comp.options : [];
      if (options.length < DISCORD_RADIO_GROUP_OPTIONS_MIN || options.length > DISCORD_RADIO_GROUP_OPTIONS_MAX) {
        violations.push({
          path: `${path}.options`,
          componentType: comp.type,
          observed: options.length,
          limit: `${DISCORD_RADIO_GROUP_OPTIONS_MIN}-${DISCORD_RADIO_GROUP_OPTIONS_MAX}`,
          code: "MODAL_OPTION_COUNT_INVALID",
        });
      }
      const seenValues = new Set<string>();
      for (let optIdx = 0; optIdx < options.length; optIdx += 1) {
        const opt = options[optIdx];
        const optPath = `${path}.options[${optIdx}]`;
        if (typeof opt?.label === "string") {
          const lLen = getDiscordTextLength(opt.label);
          if (lLen > DISCORD_SELECT_OPTION_LABEL_MAX) {
            violations.push({
              path: `${optPath}.label`,
              componentType: comp.type,
              observed: lLen,
              limit: DISCORD_SELECT_OPTION_LABEL_MAX,
              code: "SELECT_OPTION_LABEL_OVERSIZED",
            });
          }
        }
        if (typeof opt?.value === "string") {
          const vLen = getDiscordTextLength(opt.value);
          if (vLen > DISCORD_SELECT_OPTION_VALUE_MAX) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: vLen,
              limit: DISCORD_SELECT_OPTION_VALUE_MAX,
              code: "SELECT_OPTION_VALUE_OVERSIZED",
            });
          }
          if (seenValues.has(opt.value)) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: "duplicate_value",
              limit: "unique",
              code: "SELECT_OPTION_VALUE_DUPLICATE",
            });
          } else {
            seenValues.add(opt.value);
          }
        }
      }
    }

    if (comp.type === 22) {
      const options = Array.isArray(comp.options) ? comp.options : [];
      if (options.length < DISCORD_CHECKBOX_GROUP_OPTIONS_MIN || options.length > DISCORD_CHECKBOX_GROUP_OPTIONS_MAX) {
        violations.push({
          path: `${path}.options`,
          componentType: comp.type,
          observed: options.length,
          limit: `${DISCORD_CHECKBOX_GROUP_OPTIONS_MIN}-${DISCORD_CHECKBOX_GROUP_OPTIONS_MAX}`,
          code: "MODAL_OPTION_COUNT_INVALID",
        });
      }
      const seenValues = new Set<string>();
      for (let optIdx = 0; optIdx < options.length; optIdx += 1) {
        const opt = options[optIdx];
        const optPath = `${path}.options[${optIdx}]`;
        if (typeof opt?.label === "string") {
          const lLen = getDiscordTextLength(opt.label);
          if (lLen > DISCORD_SELECT_OPTION_LABEL_MAX) {
            violations.push({
              path: `${optPath}.label`,
              componentType: comp.type,
              observed: lLen,
              limit: DISCORD_SELECT_OPTION_LABEL_MAX,
              code: "SELECT_OPTION_LABEL_OVERSIZED",
            });
          }
        }
        if (typeof opt?.value === "string") {
          const vLen = getDiscordTextLength(opt.value);
          if (vLen > DISCORD_SELECT_OPTION_VALUE_MAX) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: vLen,
              limit: DISCORD_SELECT_OPTION_VALUE_MAX,
              code: "SELECT_OPTION_VALUE_OVERSIZED",
            });
          }
          if (seenValues.has(opt.value)) {
            violations.push({
              path: `${optPath}.value`,
              componentType: comp.type,
              observed: "duplicate_value",
              limit: "unique",
              code: "SELECT_OPTION_VALUE_DUPLICATE",
            });
          } else {
            seenValues.add(opt.value);
          }
        }
      }
    }

    if (comp.components) {
      for (let cIdx = 0; cIdx < comp.components.length; cIdx += 1) {
        checkComponent(comp.components[cIdx], `${path}.components[${cIdx}]`);
      }
    }
  };

  for (let i = 0; i < components.length; i += 1) {
    checkComponent(components[i], `components[${i}]`);
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Asserts that a raw modal payload complies with Discord limits.
 * Throws ComponentsV2LimitError if violations are found.
 */
export function assertRawModalLimits(payload: RawModalPayload): void {
  const result = validateRawModalLimits(payload);
  if (!result.valid) {
    const summary = result.violations
      .map((v) => `${v.path}: [${v.code}] observed ${v.observed} (limit ${v.limit})`)
      .join("; ");
    throw new ComponentsV2LimitError(`Raw modal payload exceeded Discord limits: ${summary}`, result.violations);
  }
}
