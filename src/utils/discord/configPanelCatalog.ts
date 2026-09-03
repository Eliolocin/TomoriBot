import { createHash } from "node:crypto";
import { buildInteractionRouteId, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildRouteSegments,
  decodeRouteSegments,
  indexCodecsByWireToken,
  parseNonNegativeInt,
  parseNonce,
  parsePositiveId,
  type RouteCodec,
  type RouteFieldCodec,
} from "@/utils/discord/panelRouteCodec";
import { parseLocale } from "@/utils/discord/panelRouteTokens";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import type { RandomTriggerRow } from "@/types/db/schema";
import type { AddressingStyle } from "@/types/personaNaming";

export const CONFIG_ROUTE_NAMESPACE = "config";
export const CONFIG_ROUTE_VERSION = "v1";

export type ConfigCategory = "persona" | "behavior" | "channels" | "permissions" | "models";

type PersonaPage = "general" | "memories" | "advanced" | "sprites";
type BehaviorPage = "general" | "trigger" | "experimental" | "notices" | "memory";
type ChannelsPage = "destinations" | "auto-trigger" | "rules" | "overrides";
type PermissionsPage = "capabilities" | "privacy";
type ModelsPage = "switch" | "parameters" | "fallbacks" | "image";

export type ConfigPage = PersonaPage | BehaviorPage | ChannelsPage | PermissionsPage | ModelsPage;

/**
 * Page identifiers are namespaced by category, so `general` names both a Persona page and a
 * Behavior page. The decoder resolves a page against the category that precedes it in the same
 * custom ID, which is why the category field must stay ahead of the page field in every codec.
 */
export const CONFIG_PAGES_BY_CATEGORY: Record<ConfigCategory, readonly ConfigPage[]> = {
  persona: ["general", "memories", "advanced", "sprites"],
  behavior: ["general", "trigger", "experimental", "notices", "memory"],
  channels: ["destinations", "auto-trigger", "rules", "overrides"],
  permissions: ["capabilities", "privacy"],
  models: ["switch", "parameters", "fallbacks", "image"],
};

export const CONFIG_CATEGORY_ORDER: readonly ConfigCategory[] = [
  "persona",
  "behavior",
  "channels",
  "permissions",
  "models",
];

export const DEFAULT_PAGE_FOR_CONFIG_CATEGORY: Record<ConfigCategory, ConfigPage> = {
  persona: "general",
  behavior: "general",
  channels: "destinations",
  permissions: "capabilities",
  models: "switch",
};

export const CONFIG_LANDING_CATEGORY: ConfigCategory = "persona";
export const CONFIG_LANDING_PAGE: ConfigPage = "general";

/** Discord rejects a String Select carrying more than 25 options. */
export const CONFIG_PERSONA_SELECT_PAGE_SIZE = 25;

/**
 * Collection selectors reserve one of Discord's 25 options for the add action, leaving 24 records
 * on each page so every page can keep that action first.
 */
export const CONFIG_PERSONA_COLLECTION_PAGE_SIZE = 24;

/**
 * Sprites are addressed in a route by list position plus a fingerprint rather than by
 * `sprite_key`. A key may be 64 characters, which pushes an edit route past the 100-character
 * custom-ID limit `buildInteractionRouteId` throws on, and route segments cannot carry a colon.
 */
export const CONFIG_PERSONA_SPRITE_PAGE_SIZE = 25;

/**
 * Trigger words one removal modal can present: five checkbox groups of ten is the whole modal.
 * Beyond this the modal presents the first fifty and the rest stay untouched, because a select-based
 * overflow cannot work here: a String Select caps at 25 options, which is fewer than the checkbox
 * capacity it would be relieving.
 */
export const CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE = 10;
const CONFIG_TRIGGER_CHECKBOX_GROUP_COUNT = 5;
export const CONFIG_TRIGGER_CHECKBOX_CAPACITY =
  CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE * CONFIG_TRIGGER_CHECKBOX_GROUP_COUNT;

export const CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE = 10;
const CONFIG_CONDITIONING_CHECKBOX_GROUP_COUNT = 5;
export const CONFIG_CONDITIONING_CHECKBOX_CAPACITY =
  CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE * CONFIG_CONDITIONING_CHECKBOX_GROUP_COUNT;

export const CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE = 10;
const CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_COUNT = 5;
export const CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY =
  CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_GROUP_COUNT;

/**
 * Binds a trigger removal to the exact list presented when the modal opened. Unchecked-means-remove
 * derives the removal set from positions in that list, so a concurrent add or remove must invalidate
 * the continuation rather than silently delete a different word.
 */
export function computeTriggerRemoveFingerprint(personaId: number, triggerWords: readonly string[]): string {
  const normalized = triggerWords.map((word) => normalizeTriggerWord(word)).join("\u0000");
  return createHash("sha256")
    .update(`config-trigger-remove:${personaId}:${normalized}`)
    .digest("base64url")
    .slice(0, 8);
}

/**
 * Binds random-trigger removal to the exact rows shown in its modal. Trigger IDs identify the
 * delete targets while the other persisted fields detect an edit that reused an existing ID.
 */
export function computeRandomTriggerRemoveFingerprint(
  serverId: number,
  triggers: readonly (RandomTriggerRow & { trigger_id: number })[],
): string {
  const fingerprintRows = triggers.map((trigger) => ({
    triggerId: trigger.trigger_id,
    channelDiscId: trigger.channel_disc_id,
    personaId: trigger.persona_id ?? null,
    timerHours: trigger.timer_hours,
    randomOffsetRange: trigger.random_offset_range ?? null,
    chancePercent: trigger.chance_percent,
    silenceThresholdHours: trigger.silence_threshold_hours ?? null,
    respondToSelf: trigger.respond_to_self,
    customPrompt: trigger.custom_prompt ?? null,
    failureThreshold: trigger.failure_threshold ?? null,
  }));
  return createHash("sha256")
    .update(`config-random-trigger-remove:${serverId}:${JSON.stringify(fingerprintRows)}`)
    .digest("base64url")
    .slice(0, 8);
}

function computePersonaRecordFingerprint(
  personaId: number,
  kind: string,
  index: number,
  values: readonly unknown[],
): string {
  return createHash("sha256")
    .update(`config-${kind}:${personaId}:${index}:${JSON.stringify(values)}`)
    .digest("base64url")
    .slice(0, 8);
}

export function computeAttributeFingerprint(
  personaId: number,
  index: number,
  attributeText: string,
  isPublic: boolean,
): string {
  return computePersonaRecordFingerprint(personaId, "attribute", index, [attributeText, isPublic]);
}

export function computeDialogueFingerprint(personaId: number, index: number, input: string, output: string): string {
  return computePersonaRecordFingerprint(personaId, "dialogue", index, [input, output]);
}

/**
 * Binds a sprite route to the exact key that sat at that list position when the control rendered,
 * so a concurrent add, rename, or removal invalidates the continuation instead of resolving the
 * position to a different sprite.
 */
export function computeSpriteFingerprint(personaId: number, index: number, spriteKey: string): string {
  return computePersonaRecordFingerprint(personaId, "sprite", index, [spriteKey]);
}

/**
 * Binds conditioning removal to the exact ordered groups shown in its modal. Removal derives from
 * checkbox positions, so a concurrent conditioning event must invalidate the continuation.
 */
export function computeConditioningRemoveFingerprint(
  personaId: number,
  groups: readonly { conditioningType: string; actionKey: string; reasonNormalized: string }[],
): string {
  return createHash("sha256")
    .update(`config-conditioning-remove:${personaId}:${JSON.stringify(groups)}`)
    .digest("base64url")
    .slice(0, 8);
}

/**
 * The six server-default model slots on Models > Switch Models.
 *
 * `image` and `nai-image` are two slots over one absorbed command: `/model image` picks its target
 * column from the chosen provider's `featureSupport.imageGeneration`, so the panel has to carry the
 * slot on the wire instead of re-deriving it, or a custom provider picked in the NovelAI slot would
 * write the standard column.
 */
export type ConfigModelCapability = "text" | "vision" | "embedding" | "image" | "nai-image" | "video";

export const CONFIG_MODEL_CAPABILITY_ORDER: readonly ConfigModelCapability[] = [
  "text",
  "vision",
  "embedding",
  "image",
  "nai-image",
  "video",
];

/**
 * Slots whose absorbed command offers a clear path. `/model vision` carries a clear sentinel and
 * `/model image` a clear option per column; `/model embedding`, `/model video`, and the Text
 * primary have none, so offering one there would broaden the command surface.
 */
export const CONFIG_CLEARABLE_MODEL_CAPABILITIES: ReadonlySet<ConfigModelCapability> = new Set([
  "vision",
  "image",
  "nai-image",
]);

/** Sentinel the model select carries for the clear path of a nullable slot. */
export const CONFIG_MODEL_CLEAR_VALUE = "__clear__";

/** Discord rejects a String Select carrying more than 25 options. */
export const CONFIG_MODEL_PAGE_SIZE = 25;

/**
 * The fallback modal reserves one option for its clear entry, so a provider page holds 24 models.
 * The five slot selects share one option list, which is why the range is chosen before the modal
 * opens rather than paged inside it.
 */
export const CONFIG_FALLBACK_PAGE_SIZE = 24;

export const CONFIG_FALLBACK_SLOT_COUNT = 5;

/** Logit-bias entries one removal modal can present: five checkbox groups of ten. */
export const CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE = 10;
const CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_COUNT = 5;
export const CONFIG_LOGIT_BIAS_PAGE_SIZE =
  CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_SIZE * CONFIG_LOGIT_BIAS_CHECKBOX_GROUP_COUNT;

/** Stop strings one management modal can present beside its speaker-pattern checkbox. */
export const CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE = 10;
const CONFIG_STOP_STRING_CHECKBOX_GROUP_COUNT = 4;
export const CONFIG_STOP_STRING_CAPACITY =
  CONFIG_STOP_STRING_CHECKBOX_GROUP_SIZE * CONFIG_STOP_STRING_CHECKBOX_GROUP_COUNT;

/**
 * Binds a stop-string removal to the exact list its modal presented. Unchecked-means-remove derives
 * the removal set from positions, so a concurrent add must invalidate the continuation rather than
 * delete a different string.
 */
export function computeStopStringFingerprint(serverId: number, stopStrings: readonly string[]): string {
  return createHash("sha256")
    .update(`config-stop-strings:${serverId}:${JSON.stringify(stopStrings)}`)
    .digest("base64url")
    .slice(0, 8);
}

/** Binds a logit-bias removal to the exact page of entry ids its modal presented. */
export function computeLogitBiasFingerprint(serverId: number, entryIds: readonly string[]): string {
  return createHash("sha256")
    .update(`config-logit-bias:${serverId}:${JSON.stringify(entryIds)}`)
    .digest("base64url")
    .slice(0, 8);
}

export type ConfigPanelRoute =
  | { action: "category"; locale: string; category: ConfigCategory; page: ConfigPage }
  | { action: "page"; locale: string; category: ConfigCategory; page: ConfigPage }
  | { action: "persona-select"; locale: string; personaId: number }
  | { action: "persona-page"; locale: string; personaId: number; start: number }
  | { action: "avatar-open"; locale: string; personaId: number }
  | { action: "avatar-submit"; locale: string; personaId: number; nonce: string }
  | { action: "rename-open"; locale: string; personaId: number }
  | { action: "rename-submit"; locale: string; personaId: number; nonce: string }
  | { action: "naming-style-select"; locale: string; personaId: number }
  | { action: "naming-open"; locale: string; personaId: number; style: AddressingStyle }
  | { action: "naming-submit"; locale: string; personaId: number; style: AddressingStyle; nonce: string }
  | { action: "trigger-add-open"; locale: string; personaId: number }
  | { action: "trigger-add-submit"; locale: string; personaId: number; nonce: string }
  | { action: "trigger-remove-open"; locale: string; personaId: number }
  | { action: "trigger-remove-submit"; locale: string; personaId: number; fp: string; nonce: string }
  | { action: "attribute-select"; locale: string; personaId: number }
  | { action: "attribute-page"; locale: string; personaId: number; start: number }
  | { action: "attribute-add-open"; locale: string; personaId: number }
  | { action: "attribute-add-submit"; locale: string; personaId: number; nonce: string }
  | { action: "attribute-edit-open"; locale: string; personaId: number; index: number; fp: string }
  | { action: "attribute-edit-submit"; locale: string; personaId: number; index: number; fp: string; nonce: string }
  | { action: "attribute-remove"; locale: string; personaId: number; index: number; fp: string }
  | { action: "dialogue-select"; locale: string; personaId: number }
  | { action: "dialogue-page"; locale: string; personaId: number; start: number }
  | { action: "dialogue-add-open"; locale: string; personaId: number }
  | { action: "dialogue-add-submit"; locale: string; personaId: number; nonce: string }
  | { action: "dialogue-edit-open"; locale: string; personaId: number; index: number; fp: string }
  | { action: "dialogue-edit-submit"; locale: string; personaId: number; index: number; fp: string; nonce: string }
  | { action: "dialogue-remove"; locale: string; personaId: number; index: number; fp: string }
  | { action: "promote-view"; locale: string; personaId: number }
  | { action: "promote-confirm"; locale: string; personaId: number; nonce: string }
  | { action: "promote-cancel"; locale: string; personaId: number }
  | { action: "server-memory-open"; locale: string; personaId: number }
  | { action: "personal-memory-open"; locale: string; personaId: number }
  | { action: "stm-edit-open"; locale: string; personaId: number }
  | { action: "stm-edit-submit"; locale: string; personaId: number; nonce: string }
  | { action: "conditioning-open"; locale: string; personaId: number }
  | { action: "conditioning-submit"; locale: string; personaId: number; fp: string; nonce: string }
  | { action: "image-tags-open"; locale: string; personaId: number }
  | { action: "image-tags-submit"; locale: string; personaId: number; nonce: string }
  | { action: "character-reference-open"; locale: string; personaId: number }
  | { action: "character-reference-submit"; locale: string; personaId: number; nonce: string }
  | { action: "character-reference-clear-view"; locale: string; personaId: number }
  | { action: "character-reference-clear-confirm"; locale: string; personaId: number; nonce: string }
  | { action: "character-reference-clear-cancel"; locale: string; personaId: number }
  | { action: "prompt-open"; locale: string; personaId: number }
  | { action: "prompt-submit"; locale: string; personaId: number; nonce: string }
  | { action: "prompt-remove"; locale: string; personaId: number }
  | { action: "context-note-open"; locale: string; personaId: number }
  | { action: "context-note-submit"; locale: string; personaId: number; nonce: string }
  | { action: "humanizer-open"; locale: string; personaId: number }
  | { action: "humanizer-select"; locale: string; personaId: number }
  | { action: "text-override-open"; locale: string; personaId: number }
  | { action: "text-override-provider-select"; locale: string; personaId: number }
  | { action: "text-override-model-select"; locale: string; personaId: number; provider: string }
  | { action: "text-override-model-page"; locale: string; personaId: number; provider: string; start: number }
  | { action: "text-override-clear"; locale: string; personaId: number }
  | { action: "sprite-select"; locale: string; personaId: number }
  | { action: "sprite-page"; locale: string; personaId: number; start: number }
  | { action: "sprite-add-open"; locale: string; personaId: number }
  | { action: "sprite-add-submit"; locale: string; personaId: number; nonce: string }
  | { action: "sprite-edit-open"; locale: string; personaId: number; index: number; fp: string }
  | { action: "sprite-edit-submit"; locale: string; personaId: number; index: number; fp: string; nonce: string }
  | { action: "sprite-remove-view"; locale: string; personaId: number; index: number; fp: string }
  | {
      action: "sprite-remove-confirm";
      locale: string;
      personaId: number;
      index: number;
      fp: string;
      nonce: string;
    }
  | { action: "sprite-remove-cancel"; locale: string; personaId: number }
  | { action: "sprite-import-open"; locale: string; personaId: number }
  | { action: "sprite-import-submit"; locale: string; personaId: number; nonce: string }
  | { action: "sprite-export"; locale: string; personaId: number }
  | { action: "model-provider-select"; locale: string; capability: ConfigModelCapability }
  | { action: "model-provider-page"; locale: string; capability: ConfigModelCapability; start: number }
  | { action: "model-select"; locale: string; capability: ConfigModelCapability; provider: string }
  | { action: "model-page"; locale: string; capability: ConfigModelCapability; provider: string; start: number }
  | { action: "model-cancel"; locale: string; capability: ConfigModelCapability }
  | { action: "parameters-provider-select"; locale: string }
  | { action: "sampling-open"; locale: string; provider: string }
  | { action: "sampling-submit"; locale: string; provider: string; nonce: string }
  | { action: "generation-open"; locale: string; provider: string }
  | { action: "generation-submit"; locale: string; provider: string; nonce: string }
  | { action: "stop-add-open"; locale: string }
  | { action: "stop-add-submit"; locale: string; nonce: string }
  | { action: "stop-manage-open"; locale: string }
  | { action: "stop-manage-submit"; locale: string; fp: string; nonce: string }
  | { action: "logit-add-open"; locale: string }
  | { action: "logit-add-submit"; locale: string; nonce: string }
  | { action: "logit-upload-open"; locale: string }
  | { action: "logit-upload-submit"; locale: string; nonce: string }
  | { action: "logit-manage-select"; locale: string }
  | { action: "logit-manage-open"; locale: string; start: number }
  | { action: "logit-manage-submit"; locale: string; start: number; fp: string; nonce: string }
  | { action: "fallback-provider-select"; locale: string }
  | { action: "fallback-submit"; locale: string; provider: string; start: number; nonce: string }
  | { action: "randomizer-set"; locale: string; enabled: boolean }
  | { action: "image-tags-default-open"; locale: string; negative: boolean }
  | { action: "image-tags-default-submit"; locale: string; negative: boolean; nonce: string }
  | { action: "nai-parameters-open"; locale: string }
  | { action: "nai-parameters-submit"; locale: string; nonce: string }
  | { action: "behavior-prompt-open"; locale: string }
  | { action: "behavior-prompt-submit"; locale: string; nonce: string }
  | { action: "behavior-preset-open"; locale: string }
  | { action: "behavior-preset-submit"; locale: string; nonce: string }
  | { action: "behavior-prompt-remove"; locale: string }
  | { action: "behavior-context-open"; locale: string }
  | { action: "behavior-context-submit"; locale: string; nonce: string }
  | { action: "behavior-humanizer-open"; locale: string }
  | { action: "behavior-humanizer-submit"; locale: string; nonce: string }
  | { action: "behavior-fetch-open"; locale: string }
  | { action: "behavior-fetch-submit"; locale: string; nonce: string }
  | { action: "behavior-timezone-open"; locale: string }
  | { action: "behavior-timezone-submit"; locale: string; nonce: string }
  | { action: "behavior-random-add-open"; locale: string }
  | { action: "behavior-random-add-submit"; locale: string; nonce: string }
  | { action: "behavior-random-remove-open"; locale: string; start?: number }
  | { action: "behavior-random-remove-select"; locale: string }
  | { action: "behavior-random-remove-page"; locale: string; start: number }
  | { action: "behavior-random-remove-submit"; locale: string; start: number; fp: string; nonce: string }
  | { action: "behavior-limits-open"; locale: string }
  | { action: "behavior-limits-submit"; locale: string; nonce: string }
  | { action: "behavior-dtm-set"; locale: string; enabled: boolean }
  | { action: "behavior-always-set"; locale: string; enabled: boolean }
  | { action: "behavior-cooldown-open"; locale: string }
  | { action: "behavior-cooldown-submit"; locale: string; nonce: string }
  | {
      action: "retry" | "refresh";
      locale: string;
      category: ConfigCategory;
      page: ConfigPage;
      personaId?: number;
    };

type ConfigAction = ConfigPanelRoute["action"];

type ConfigRouteForAction<A extends ConfigAction> = ConfigPanelRoute extends infer R
  ? R extends { action: string }
    ? A extends R["action"]
      ? R & { action: A }
      : never
    : never
  : never;

export type ConfigRouteCodecs = {
  [A in ConfigAction]: RouteCodec<ConfigRouteForAction<A>>;
};

function parseConfigCategory(value: string | undefined): ConfigCategory | null {
  return CONFIG_CATEGORY_ORDER.includes(value as ConfigCategory) ? (value as ConfigCategory) : null;
}

function parseConfigPage(category: ConfigCategory, value: string | undefined): ConfigPage | null {
  if (!value) return null;
  return CONFIG_PAGES_BY_CATEGORY[category].includes(value as ConfigPage) ? (value as ConfigPage) : null;
}

function parseAddressingStyle(value: string | undefined): AddressingStyle | null {
  if (value === "masculine" || value === "feminine" || value === "neutral") return value;
  return null;
}

function parseFingerprint(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8}$/.test(value) ? value : null;
}

const categoryField: RouteFieldCodec<"category", ConfigCategory> = {
  key: "category",
  encode: (v) => String(v),
  decode: (v) => parseConfigCategory(v),
};

const pageField: RouteFieldCodec<"page", ConfigPage> = {
  key: "page",
  encode: (v) => String(v),
  decode: (v, r) => (r.category ? parseConfigPage(r.category as ConfigCategory, v) : null),
};

const personaIdField: RouteFieldCodec<"personaId", number> = {
  key: "personaId",
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const optionalPersonaIdField: RouteFieldCodec<"personaId", number> = {
  key: "personaId",
  optional: true,
  encode: (v) => String(v),
  decode: (v) => parsePositiveId(v),
};

const startField: RouteFieldCodec<"start", number> = {
  key: "start",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const optionalStartField: RouteFieldCodec<"start", number> = {
  key: "start",
  optional: true,
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const indexField: RouteFieldCodec<"index", number> = {
  key: "index",
  encode: (v) => String(v),
  decode: (v) => parseNonNegativeInt(v),
};

const styleField: RouteFieldCodec<"style", AddressingStyle> = {
  key: "style",
  encode: (v) => String(v),
  decode: (v) => parseAddressingStyle(v),
};

const fpField: RouteFieldCodec<"fp", string> = {
  key: "fp",
  encode: (v) => String(v),
  decode: (v) => parseFingerprint(v),
};

const nonceField: RouteFieldCodec<"nonce", string> = {
  key: "nonce",
  encode: (v) => String(v),
  decode: (v) => parseNonce(v),
};

function parseModelCapability(value: string | undefined): ConfigModelCapability | null {
  return CONFIG_MODEL_CAPABILITY_ORDER.includes(value as ConfigModelCapability)
    ? (value as ConfigModelCapability)
    : null;
}

const capabilityField: RouteFieldCodec<"capability", ConfigModelCapability> = {
  key: "capability",
  encode: (v) => String(v),
  decode: (v) => parseModelCapability(v),
};

const negativeField: RouteFieldCodec<"negative", boolean> = {
  key: "negative",
  encode: (v) => (v ? "1" : "0"),
  decode: (v) => (v === "1" ? true : v === "0" ? false : null),
};

const enabledField: RouteFieldCodec<"enabled", boolean> = {
  key: "enabled",
  encode: (v) => (v ? "1" : "0"),
  decode: (v) => (v === "1" ? true : v === "0" ? false : null),
};

const providerField: RouteFieldCodec<"provider", string> = {
  key: "provider",
  encode: (v) => String(v).replace(/:/g, "~"),
  decode: (v) => (v ? v.replace(/~/g, ":") : null),
};

/**
 * Authoritative codec table for every `/config` panel route, keyed by semantic action so a new
 * action is a compile error until it has a wire token.
 */
export const CONFIG_ROUTE_CODECS: ConfigRouteCodecs = {
  category: { wireToken: "category", fields: [categoryField, pageField] },
  page: { wireToken: "page", fields: [categoryField, pageField] },
  "persona-select": { wireToken: "persona-select", fields: [personaIdField] },
  "persona-page": { wireToken: "persona-page", fields: [personaIdField, startField] },
  "avatar-open": { wireToken: "avatar-open", fields: [personaIdField] },
  "avatar-submit": { wireToken: "avatar-submit", fields: [personaIdField, nonceField] },
  "rename-open": { wireToken: "rename-open", fields: [personaIdField] },
  "rename-submit": { wireToken: "rename-submit", fields: [personaIdField, nonceField] },
  "naming-style-select": { wireToken: "naming-style", fields: [personaIdField] },
  "naming-open": { wireToken: "naming-open", fields: [personaIdField, styleField] },
  "naming-submit": { wireToken: "naming-submit", fields: [personaIdField, styleField, nonceField] },
  "trigger-add-open": { wireToken: "trig-add-open", fields: [personaIdField] },
  "trigger-add-submit": { wireToken: "trig-add-sub", fields: [personaIdField, nonceField] },
  "trigger-remove-open": { wireToken: "trig-rem-open", fields: [personaIdField] },
  "trigger-remove-submit": { wireToken: "trig-rem-sub", fields: [personaIdField, fpField, nonceField] },
  "attribute-select": { wireToken: "attr-select", fields: [personaIdField] },
  "attribute-page": { wireToken: "attr-page", fields: [personaIdField, startField] },
  "attribute-add-open": { wireToken: "attr-add-open", fields: [personaIdField] },
  "attribute-add-submit": { wireToken: "attr-add-sub", fields: [personaIdField, nonceField] },
  "attribute-edit-open": { wireToken: "attr-edit-open", fields: [personaIdField, indexField, fpField] },
  "attribute-edit-submit": {
    wireToken: "attr-edit-sub",
    fields: [personaIdField, indexField, fpField, nonceField],
  },
  "attribute-remove": { wireToken: "attr-remove", fields: [personaIdField, indexField, fpField] },
  "dialogue-select": { wireToken: "dlg-select", fields: [personaIdField] },
  "dialogue-page": { wireToken: "dlg-page", fields: [personaIdField, startField] },
  "dialogue-add-open": { wireToken: "dlg-add-open", fields: [personaIdField] },
  "dialogue-add-submit": { wireToken: "dlg-add-sub", fields: [personaIdField, nonceField] },
  "dialogue-edit-open": { wireToken: "dlg-edit-open", fields: [personaIdField, indexField, fpField] },
  "dialogue-edit-submit": {
    wireToken: "dlg-edit-sub",
    fields: [personaIdField, indexField, fpField, nonceField],
  },
  "dialogue-remove": { wireToken: "dlg-remove", fields: [personaIdField, indexField, fpField] },
  "promote-view": { wireToken: "promote-view", fields: [personaIdField] },
  "promote-confirm": { wireToken: "promote-confirm", fields: [personaIdField, nonceField] },
  "promote-cancel": { wireToken: "promote-cancel", fields: [personaIdField] },
  "server-memory-open": { wireToken: "server-memory", fields: [personaIdField] },
  "personal-memory-open": { wireToken: "personal-memory", fields: [personaIdField] },
  "stm-edit-open": { wireToken: "stm-edit-open", fields: [personaIdField] },
  "stm-edit-submit": { wireToken: "stm-edit-submit", fields: [personaIdField, nonceField] },
  "conditioning-open": { wireToken: "conditioning-open", fields: [personaIdField] },
  "conditioning-submit": { wireToken: "conditioning-submit", fields: [personaIdField, fpField, nonceField] },
  "image-tags-open": { wireToken: "image-tags-open", fields: [personaIdField] },
  "image-tags-submit": { wireToken: "image-tags-submit", fields: [personaIdField, nonceField] },
  "character-reference-open": { wireToken: "char-ref-open", fields: [personaIdField] },
  "character-reference-submit": { wireToken: "char-ref-submit", fields: [personaIdField, nonceField] },
  "character-reference-clear-view": { wireToken: "char-ref-clear-view", fields: [personaIdField] },
  "character-reference-clear-confirm": {
    wireToken: "char-ref-clear-confirm",
    fields: [personaIdField, nonceField],
  },
  "character-reference-clear-cancel": { wireToken: "char-ref-clear-cancel", fields: [personaIdField] },
  "prompt-open": { wireToken: "prompt-open", fields: [personaIdField] },
  "prompt-submit": { wireToken: "prompt-submit", fields: [personaIdField, nonceField] },
  "prompt-remove": { wireToken: "prompt-remove", fields: [personaIdField] },
  "context-note-open": { wireToken: "context-open", fields: [personaIdField] },
  "context-note-submit": { wireToken: "context-submit", fields: [personaIdField, nonceField] },
  "humanizer-open": { wireToken: "humanizer-open", fields: [personaIdField] },
  "humanizer-select": { wireToken: "humanizer-select", fields: [personaIdField] },
  "text-override-open": { wireToken: "text-override-open", fields: [personaIdField] },
  "text-override-provider-select": { wireToken: "text-override-provider-select", fields: [personaIdField] },
  "text-override-model-select": {
    wireToken: "text-override-model-select",
    fields: [personaIdField, providerField],
  },
  "text-override-model-page": {
    wireToken: "text-override-model-page",
    fields: [personaIdField, providerField, startField],
  },
  "text-override-clear": { wireToken: "text-override-clear", fields: [personaIdField] },
  "sprite-select": { wireToken: "sprite-select", fields: [personaIdField] },
  "sprite-page": { wireToken: "sprite-page", fields: [personaIdField, startField] },
  "sprite-add-open": { wireToken: "sprite-add-open", fields: [personaIdField] },
  "sprite-add-submit": { wireToken: "sprite-add-sub", fields: [personaIdField, nonceField] },
  "sprite-edit-open": { wireToken: "sprite-edit-open", fields: [personaIdField, indexField, fpField] },
  "sprite-edit-submit": {
    wireToken: "sprite-edit-sub",
    fields: [personaIdField, indexField, fpField, nonceField],
  },
  "sprite-remove-view": { wireToken: "sprite-rem-view", fields: [personaIdField, indexField, fpField] },
  "sprite-remove-confirm": {
    wireToken: "sprite-rem-confirm",
    fields: [personaIdField, indexField, fpField, nonceField],
  },
  "sprite-remove-cancel": { wireToken: "sprite-rem-cancel", fields: [personaIdField] },
  "sprite-import-open": { wireToken: "sprite-import-open", fields: [personaIdField] },
  "sprite-import-submit": { wireToken: "sprite-import-sub", fields: [personaIdField, nonceField] },
  "sprite-export": { wireToken: "sprite-export", fields: [personaIdField] },
  "model-provider-select": { wireToken: "model-prov-select", fields: [capabilityField] },
  "model-provider-page": { wireToken: "model-prov-page", fields: [capabilityField, startField] },
  "model-select": { wireToken: "model-select", fields: [capabilityField, providerField] },
  "model-page": { wireToken: "model-page", fields: [capabilityField, providerField, startField] },
  "model-cancel": { wireToken: "model-cancel", fields: [capabilityField] },
  "parameters-provider-select": { wireToken: "param-prov-select", fields: [] },
  "sampling-open": { wireToken: "sampling-open", fields: [providerField] },
  "sampling-submit": { wireToken: "sampling-sub", fields: [providerField, nonceField] },
  "generation-open": { wireToken: "generation-open", fields: [providerField] },
  "generation-submit": { wireToken: "generation-sub", fields: [providerField, nonceField] },
  "stop-add-open": { wireToken: "stop-add-open", fields: [] },
  "stop-add-submit": { wireToken: "stop-add-sub", fields: [nonceField] },
  "stop-manage-open": { wireToken: "stop-man-open", fields: [] },
  "stop-manage-submit": { wireToken: "stop-man-sub", fields: [fpField, nonceField] },
  "logit-add-open": { wireToken: "logit-add-open", fields: [] },
  "logit-add-submit": { wireToken: "logit-add-sub", fields: [nonceField] },
  "logit-upload-open": { wireToken: "logit-up-open", fields: [] },
  "logit-upload-submit": { wireToken: "logit-up-sub", fields: [nonceField] },
  "logit-manage-select": { wireToken: "logit-man-select", fields: [] },
  "logit-manage-open": { wireToken: "logit-man-open", fields: [startField] },
  "logit-manage-submit": { wireToken: "logit-man-sub", fields: [startField, fpField, nonceField] },
  "fallback-provider-select": { wireToken: "fb-prov-select", fields: [] },
  "fallback-submit": { wireToken: "fb-sub", fields: [providerField, startField, nonceField] },
  "randomizer-set": { wireToken: "randomizer-set", fields: [enabledField] },
  "image-tags-default-open": { wireToken: "img-tags-open", fields: [negativeField] },
  "image-tags-default-submit": { wireToken: "img-tags-sub", fields: [negativeField, nonceField] },
  "nai-parameters-open": { wireToken: "nai-params-open", fields: [] },
  "nai-parameters-submit": { wireToken: "nai-params-sub", fields: [nonceField] },
  "behavior-prompt-open": { wireToken: "beh-prompt-open", fields: [] },
  "behavior-prompt-submit": { wireToken: "beh-prompt-sub", fields: [nonceField] },
  "behavior-preset-open": { wireToken: "beh-preset-open", fields: [] },
  "behavior-preset-submit": { wireToken: "beh-preset-sub", fields: [nonceField] },
  "behavior-prompt-remove": { wireToken: "beh-prompt-remove", fields: [] },
  "behavior-context-open": { wireToken: "beh-context-open", fields: [] },
  "behavior-context-submit": { wireToken: "beh-context-sub", fields: [nonceField] },
  "behavior-humanizer-open": { wireToken: "beh-humanizer-open", fields: [] },
  "behavior-humanizer-submit": { wireToken: "beh-humanizer-sub", fields: [nonceField] },
  "behavior-fetch-open": { wireToken: "beh-fetch-open", fields: [] },
  "behavior-fetch-submit": { wireToken: "beh-fetch-sub", fields: [nonceField] },
  "behavior-timezone-open": { wireToken: "beh-timezone-open", fields: [] },
  "behavior-timezone-submit": { wireToken: "beh-timezone-sub", fields: [nonceField] },
  "behavior-random-add-open": { wireToken: "beh-random-add-open", fields: [] },
  "behavior-random-add-submit": { wireToken: "beh-random-add-sub", fields: [nonceField] },
  "behavior-random-remove-open": { wireToken: "beh-random-rem-open", fields: [optionalStartField] },
  "behavior-random-remove-select": { wireToken: "beh-random-rem-select", fields: [] },
  "behavior-random-remove-page": { wireToken: "beh-random-rem-page", fields: [startField] },
  "behavior-random-remove-submit": { wireToken: "beh-random-rem-sub", fields: [startField, fpField, nonceField] },
  "behavior-limits-open": { wireToken: "beh-limits-open", fields: [] },
  "behavior-limits-submit": { wireToken: "beh-limits-sub", fields: [nonceField] },
  "behavior-dtm-set": { wireToken: "beh-dtm-set", fields: [enabledField] },
  "behavior-always-set": { wireToken: "beh-always-set", fields: [enabledField] },
  "behavior-cooldown-open": { wireToken: "beh-cooldown-open", fields: [] },
  "behavior-cooldown-submit": { wireToken: "beh-cooldown-sub", fields: [nonceField] },
  retry: { wireToken: "retry", fields: [categoryField, pageField, optionalPersonaIdField] },
  refresh: { wireToken: "refresh", fields: [categoryField, pageField, optionalPersonaIdField] },
};

const CODECS_BY_WIRE_TOKEN = indexCodecsByWireToken<ConfigAction, ConfigPanelRoute>(CONFIG_ROUTE_CODECS);

export function buildConfigRouteSegments(route: ConfigPanelRoute): string[] {
  return buildRouteSegments(CONFIG_ROUTE_CODECS[route.action], route);
}

export function buildConfigRouteId(route: ConfigPanelRoute): string {
  return buildInteractionRouteId(CONFIG_ROUTE_NAMESPACE, CONFIG_ROUTE_VERSION, ...buildConfigRouteSegments(route));
}

export function parseConfigPanelRoute(route: ParsedInteractionRoute): ConfigPanelRoute | null {
  if (route.namespace !== CONFIG_ROUTE_NAMESPACE || route.version !== CONFIG_ROUTE_VERSION) {
    return null;
  }

  const [rawWireToken, rawLocale, ...tail] = route.segments;
  if (!rawWireToken || !rawLocale) return null;

  const locale = parseLocale(rawLocale);
  if (!locale) return null;

  const entry = CODECS_BY_WIRE_TOKEN.get(rawWireToken);
  if (!entry) return null;

  return decodeRouteSegments(entry.codec, entry.action, locale, tail);
}
