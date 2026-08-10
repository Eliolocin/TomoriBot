// Input types for the human-authored seed catalogs (`*.ts`).
//
// These are deliberately *narrower* than the DB row schemas in
// `src/types/db/schema.ts`: boolean flags are optional and default to `false`,
// so an author only ever writes the flags that are `true`. The catalog seeders
// expand these into INSERT … ON CONFLICT upserts and seed them at startup.

/**
 * One commented group of rows in a table's seed.
 * @property comment Section header rendered as a SQL `--` comment above the rows.
 *   A string array renders as consecutive comment lines.
 * @property rows The model rows belonging to this section, in file order.
 */
export interface CatalogSection<T> {
  comment: string | string[];
  rows: T[];
}

/** Backward-compatible alias for the existing model catalog imports. */
export type ModelSection<T> = CatalogSection<T>;

/** Fields shared by every model table. */
interface CommonInput {
  /** Provider key (e.g. "google", "openrouter"). */
  provider: string;
  /** Provider-specific model codename used at the API layer. */
  codename: string;
  /** English description; `null` emits SQL `NULL`. */
  desc: string | null;
  /** Japanese description; `null` emits SQL `NULL`. */
  ja: string | null;
  /** Marks the provider's default model. Exactly one per provider (see validator). */
  isDefault?: boolean;
  /** Hides the model from selection; deprecated rows are split into a separate INSERT. */
  isDeprecated?: boolean;
}

/** A row in the `llms` (text/chat) table. */
export interface LlmInput extends CommonInput {
  /** Marks the provider's most capable model. At least one per provider. */
  isSmartest?: boolean;
  isReasoning?: boolean;
  isFree?: boolean;
  hasTools?: boolean;
  seesImages?: boolean;
  seesVideos?: boolean;
  seesYoutube?: boolean;
  isUncensored?: boolean;
  supportsStructoutput?: boolean;
  /**
   * Requires strict role alternation (merge consecutive same-role turns + leading user turn).
   * Required for anthropic; enforced by the check-seed-catalogs per-provider invariant.
   */
  strictRoleAlternation?: boolean;
  /**
   * Supports assistant prefix-completion (`prefix: true` on the trailing prefill turn).
   * Required for deepseek/zai/zaicoding; enforced by the check-seed-catalogs per-provider invariant.
   */
  supportsPrefixCompletion?: boolean;
  /**
   * Official uncached input price in USD per million tokens. Omit for OpenRouter (priced live from its
   * API) and free/non-metered models, so the column stays NULL and the cost command falls back.
   */
  inputPricePerMillion?: number;
  /** Official uncached output price in USD per million tokens. See {@link inputPricePerMillion}. */
  outputPricePerMillion?: number;
}

/** A row in the `image_diffusion_models` table. */
export interface ImageInput extends CommonInput {
  isFree?: boolean;
  isUncensored?: boolean;
}

/** A row in the `video_generation_models` table. */
export interface VideoInput extends CommonInput {
  isFree?: boolean;
}

/** A row in the `embedding_models` table. */
export interface EmbeddingInput extends CommonInput {
  /** Embedding family key (groups codenames that share vector dimensionality). */
  family: string;
}

/**
 * One official preset sprite, authored in the persona catalog.
 * The image file lives inside the persona's `avatarPath` directory and is
 * uploaded once to shared storage at seed time; pointer personas resolve it live.
 * @property name Display label / lookup label, e.g. `"mad"` (normalized to a key).
 * @property file Image path relative to the persona's `avatarPath` dir, e.g. `"sprites/mad.png"`.
 * @property usageInstructions Optional prompt guidance for when to use this sprite.
 * @property isIdentity When true, renders the decorated `sprite (Persona)` name (DID alter style).
 */
export interface PresetSpriteInput {
  name: string;
  file: string;
  usageInstructions?: string;
  isIdentity?: boolean;
}

/** A row in the `persona_presets` seed catalog. */
export interface PersonaInput {
  name: string;
  desc: string;
  attributes: string[];
  sampleDialoguesIn: string[];
  sampleDialoguesOut: string[];
  language: string;
  avatarPath: string;
  triggerWords: string[];
  lineageId: number;
  namingConfig: import("@/types/personaNaming").PersonaNamingConfig;
  /**
   * Optional official sprite set for this preset. Seeded into `preset_sprites`
   * and resolved live by pointer personas. Omit (or leave empty) and the persona
   * simply has no default sprites, so a graceful no-op.
   */
  sprites?: PresetSpriteInput[];
}

/** A row in the `system_prompt_presets` seed catalog. */
export interface SystemPromptInput {
  name: string;
  desc: string;
  jaDescription: string;
  promptText: string;
}

export type NaiModelTarget = "kayra" | "erato";

type NaiPhraseRepPen = "off" | "light" | "medium" | "aggressive" | "very_aggressive";

/** NovelAI sampling parameter JSON stored in `nai_presets.parameters`. */
interface NaiSamplingParameters {
  order?: number[];
  temperature?: number;
  max_length?: number;
  min_length?: number;
  top_k?: number;
  top_p?: number;
  top_a?: number;
  typical_p?: number;
  tail_free_sampling?: number;
  repetition_penalty?: number;
  repetition_penalty_range?: number;
  repetition_penalty_slope?: number;
  repetition_penalty_frequency?: number;
  repetition_penalty_presence?: number;
  phrase_rep_pen?: NaiPhraseRepPen;
  min_p?: number;
  mirostat_lr?: number;
  mirostat_tau?: number;
}

/** A row in the `nai_presets` seed catalog. */
export interface NaiPresetInput {
  name: string;
  modelTarget: NaiModelTarget;
  isDefault?: boolean;
  desc: string;
  jaDesc: string;
  parameters: NaiSamplingParameters;
}
