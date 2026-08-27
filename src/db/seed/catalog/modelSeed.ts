// Runtime model seeding from the typed catalog (`models.ts`).
//
// This is the single source of truth for seeded models: the catalog is rendered
// into INSERT … ON CONFLICT statements and executed directly during database
// initialization (see `seedModelsFromCatalog`). There is no generated .sql file
// to keep in sync, so editing `models.ts` is all that's needed.
//
// The same row tuples and ON CONFLICT upserts used by the old 01_models.sql are
// reproduced here, so seeding behavior (idempotent upsert on every startup) is
// unchanged.

import type { SQL } from "bun";
import { embeddingSections, imageSections, llmSections, videoSections } from "./models";
import { bool, desc, num, str } from "./sql";
import type { EmbeddingInput, ImageInput, LlmInput, ModelSection, VideoInput } from "./types";

/** Providers exempt from the default/smartest invariants (bootstrap placeholders). */
const INVARIANT_EXEMPT = new Set<string>(["custom"]);

/** Minimal shape the renderer/validator needs from every catalog row. */
interface RowLike {
  provider: string;
  codename: string;
  isDefault?: boolean;
  isDeprecated?: boolean;
  isSmartest?: boolean;
}

interface TableSpec<T extends RowLike> {
  table: string;
  /** Column list inside `INSERT INTO <table> (...)`, in tuple order. */
  columns: string;
  /** Positional value tuple for one row, without the surrounding parentheses. */
  tuple: (m: T) => string;
  /** `ON CONFLICT ...` block (no trailing semicolon: executed via client.unsafe). */
  onConflict: string;
  /** Whether this table has an is_smartest column (only `llms`). */
  hasSmartest: boolean;
  sections: ModelSection<T>[];
}

// Per-table specs (column order MUST match the column list)
const llmSpec: TableSpec<LlmInput> = {
  table: "llms",
  columns:
    "llm_provider, llm_codename, is_smartest, is_default, is_reasoning, is_deprecated, is_free, has_tools, sees_images, sees_videos, sees_youtube, is_uncensored, supports_structoutput, strict_role_alternation, supports_prefix_completion, llm_description, ja_description, input_price_per_million, output_price_per_million",
  tuple: (m) =>
    [
      str(m.provider),
      str(m.codename),
      bool(m.isSmartest),
      bool(m.isDefault),
      bool(m.isReasoning),
      bool(m.isDeprecated),
      bool(m.isFree),
      bool(m.hasTools),
      bool(m.seesImages),
      bool(m.seesVideos),
      bool(m.seesYoutube),
      bool(m.isUncensored),
      bool(m.supportsStructoutput),
      bool(m.strictRoleAlternation),
      bool(m.supportsPrefixCompletion),
      desc(m.desc),
      desc(m.ja),
      num(m.inputPricePerMillion),
      num(m.outputPricePerMillion),
    ].join(", "),
  // The trailing WHERE guard is the key protection for scoped OpenRouter registrations:
  // a row that a server/user has promoted to a scoped registration (is_scoped_registration = true)
  // is user-owned, not a curated catalog entry, so the per-boot reseed must leave it untouched.
  // Without this guard the reseed would reset is_scoped_registration = false and re-apply
  // is_deprecated, silently reverting a user's deprecated-model registration on every restart.
  // Curated (non-scoped, possibly NULL) rows still upsert normally and get normalized to false.
  onConflict: `ON CONFLICT (llm_provider, llm_codename) DO UPDATE SET
  llm_description = EXCLUDED.llm_description,
  ja_description = EXCLUDED.ja_description,
  is_smartest = EXCLUDED.is_smartest,
  is_default = EXCLUDED.is_default,
  is_reasoning = EXCLUDED.is_reasoning,
  is_scoped_registration = false,
  is_deprecated = EXCLUDED.is_deprecated,
  is_free = EXCLUDED.is_free,
  has_tools = EXCLUDED.has_tools,
  sees_images = EXCLUDED.sees_images,
  sees_videos = EXCLUDED.sees_videos,
  sees_youtube = EXCLUDED.sees_youtube,
  is_uncensored = EXCLUDED.is_uncensored,
  supports_structoutput = EXCLUDED.supports_structoutput,
  strict_role_alternation = EXCLUDED.strict_role_alternation,
  supports_prefix_completion = EXCLUDED.supports_prefix_completion,
  input_price_per_million = EXCLUDED.input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  updated_at = CURRENT_TIMESTAMP
  WHERE COALESCE(llms.is_scoped_registration, false) = false`,
  hasSmartest: true,
  sections: llmSections,
};

const imageSpec: TableSpec<ImageInput> = {
  table: "image_diffusion_models",
  columns: "provider, codename, is_default, is_deprecated, is_free, is_uncensored, model_description, ja_description",
  tuple: (m) =>
    [
      str(m.provider),
      str(m.codename),
      bool(m.isDefault),
      bool(m.isDeprecated),
      bool(m.isFree),
      bool(m.isUncensored),
      desc(m.desc),
      desc(m.ja),
    ].join(", "),
  // WHERE guard: preserve scoped OpenRouter image registrations across the per-boot reseed.
  // See the llmSpec onConflict note for the full rationale.
  onConflict: `ON CONFLICT (provider, codename) DO UPDATE SET
  model_description = EXCLUDED.model_description,
  ja_description = EXCLUDED.ja_description,
  is_default = EXCLUDED.is_default,
  is_deprecated = EXCLUDED.is_deprecated,
  is_free = EXCLUDED.is_free,
  is_uncensored = EXCLUDED.is_uncensored,
  is_scoped_registration = false,
  provider = EXCLUDED.provider,
  updated_at = CURRENT_TIMESTAMP
  WHERE COALESCE(image_diffusion_models.is_scoped_registration, false) = false`,
  hasSmartest: false,
  sections: imageSections,
};

const videoSpec: TableSpec<VideoInput> = {
  table: "video_generation_models",
  columns: "provider, codename, is_default, is_deprecated, is_free, model_description, ja_description",
  tuple: (m) =>
    [
      str(m.provider),
      str(m.codename),
      bool(m.isDefault),
      bool(m.isDeprecated),
      bool(m.isFree),
      desc(m.desc),
      desc(m.ja),
    ].join(", "),
  // WHERE guard: preserve scoped OpenRouter video registrations across the per-boot reseed.
  // See the llmSpec onConflict note for the full rationale.
  onConflict: `ON CONFLICT (provider, codename) DO UPDATE SET
  model_description = EXCLUDED.model_description,
  ja_description = EXCLUDED.ja_description,
  is_default = EXCLUDED.is_default,
  is_deprecated = EXCLUDED.is_deprecated,
  is_free = EXCLUDED.is_free,
  is_scoped_registration = false,
  provider = EXCLUDED.provider,
  updated_at = CURRENT_TIMESTAMP
  WHERE COALESCE(video_generation_models.is_scoped_registration, false) = false`,
  hasSmartest: false,
  sections: videoSections,
};

const embeddingSpec: TableSpec<EmbeddingInput> = {
  table: "embedding_models",
  columns: "provider, codename, model_family, is_default, is_deprecated, model_description, ja_description",
  tuple: (m) =>
    [
      str(m.provider),
      str(m.codename),
      str(m.family),
      bool(m.isDefault),
      bool(m.isDeprecated),
      desc(m.desc),
      desc(m.ja),
    ].join(", "),
  // WHERE guard: preserve scoped OpenRouter embedding registrations across the per-boot reseed.
  // See the llmSpec onConflict note for the full rationale.
  onConflict: `ON CONFLICT (provider, codename) DO UPDATE SET
  model_family = EXCLUDED.model_family,
  model_description = EXCLUDED.model_description,
  ja_description = EXCLUDED.ja_description,
  is_default = EXCLUDED.is_default,
  is_deprecated = EXCLUDED.is_deprecated,
  is_scoped_registration = false,
  provider = EXCLUDED.provider,
  updated_at = CURRENT_TIMESTAMP
  WHERE COALESCE(embedding_models.is_scoped_registration, false) = false`,
  hasSmartest: false,
  sections: embeddingSections,
};

function rowsOf<T extends RowLike>(spec: TableSpec<T>): T[] {
  return spec.sections.flatMap((s) => s.rows);
}

/** Collect every per-provider/uniqueness violation for one table. */
function validateSpec<T extends RowLike>(spec: TableSpec<T>, errors: string[]): void {
  const all = rowsOf(spec);

  const seen = new Set<string>();
  for (const r of all) {
    const key = `${r.provider}/${r.codename}`;
    if (seen.has(key)) errors.push(`${spec.table}: duplicate row ${key}`);
    seen.add(key);
  }

  const byProvider = new Map<string, T[]>();
  for (const r of all) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  for (const [provider, rows] of byProvider) {
    if (INVARIANT_EXEMPT.has(provider)) continue;

    const defaults = rows.filter((r) => r.isDefault);
    if (defaults.length !== 1) {
      errors.push(`${spec.table}/${provider}: expected exactly one is_default, found ${defaults.length}`);
    } else if (defaults[0].isDeprecated) {
      errors.push(`${spec.table}/${provider}: default model ${defaults[0].codename} is deprecated`);
    }

    if (spec.hasSmartest) {
      const smartest = rows.filter((r) => r.isSmartest);
      if (smartest.length < 1) {
        errors.push(`${spec.table}/${provider}: expected at least one is_smartest`);
      } else if (!smartest.some((r) => !r.isDeprecated)) {
        errors.push(`${spec.table}/${provider}: every is_smartest model is deprecated`);
      }
    }
  }
}

// Providers whose llms rows MUST carry a strict chat-completion flag. Kept in lockstep with the
// request-time safety net in src/providers/utils/strictChatCompat.ts (providerRequires*). Defined
// locally so the seed catalog stays independent of the provider runtime layer.
const REQUIRED_ALTERNATION_PROVIDERS = new Set<string>(["anthropic"]);
const REQUIRED_PREFIX_PROVIDERS = new Set<string>(["deepseek", "zai", "zaicoding"]);

/**
 * Enforce that every llms row whose provider requires a strict chat-completion normalization has
 * the corresponding flag set. Because the runtime resolves the flag from the active model's column
 * (D4), a single un-flagged model would silently emit an invalid body for that backend.
 *
 * Pure and exported so the invariant can be unit-tested with crafted rows.
 * @returns A list of violation messages (empty when valid).
 */
export function collectStrictChatFlagViolations(rows: LlmInput[]): string[] {
  const errors: string[] = [];
  for (const row of rows) {
    if (REQUIRED_ALTERNATION_PROVIDERS.has(row.provider) && !row.strictRoleAlternation) {
      errors.push(
        `llms/${row.provider}: model ${row.codename} must set strictRoleAlternation (required for this provider)`,
      );
    }
    if (REQUIRED_PREFIX_PROVIDERS.has(row.provider) && !row.supportsPrefixCompletion) {
      errors.push(
        `llms/${row.provider}: model ${row.codename} must set supportsPrefixCompletion (required for this provider)`,
      );
    }
  }
  return errors;
}

// Providers billed per-token by the live `/tool estimate cost` path. Every active, billable row of these
// providers must carry an explicit catalog price: the env-based price fallback has been removed, so an
// unpriced row makes resolveModelPricing (src/commands/tool/estimate/cost.ts) return null and the command
// reports "pricing unavailable". OpenRouter is intentionally absent, because it is priced live from the OpenRouter
// API cache, with any catalog price acting only as a cache-miss fallback. Its llms rows are still filled in at
// startup by syncOpenrouterCatalogPricing (src/init/loaders.ts), which SQL-computed cost surfaces read.
const METERED_FIRST_PARTY_PROVIDERS = new Set<string>([
  "google",
  "vertex",
  "vertexexpress",
  "anthropic",
  "deepseek",
  "zai",
  "zaicoding",
]);

// Active first-party rows that legitimately have no published price yet (the provider has not shipped one).
// Re-checked 2026-06-11. Remove a codename here once its official rate is filled into models.ts.
const PRICING_PENDING_CODENAMES = new Set<string>(["gemini-3.5-pro"]);

/**
 * Enforce that every billable first-party llms row carries explicit per-million input/output prices.
 * With the env price fallback gone, an unpriced active row would surface "pricing unavailable" in
 * `/tool estimate cost`, so this invariant catches the next added model that forgets its catalog price.
 *
 * Excluded: deprecated rows (may predate verified pricing), Gemma codenames (open model, no first-party
 * paid tier), isFree endpoint variants (not billed), and {@link PRICING_PENDING_CODENAMES} (provider has
 * not published a rate yet).
 *
 * Pure and exported so the invariant can be unit-tested with crafted rows.
 * @returns A list of violation messages (empty when valid).
 */
function collectMeteredPriceViolations(rows: LlmInput[]): string[] {
  const errors: string[] = [];
  for (const row of rows) {
    if (!METERED_FIRST_PARTY_PROVIDERS.has(row.provider)) continue;
    if (row.isDeprecated || row.isFree) continue;
    if (row.codename.includes("gemma")) continue;
    if (PRICING_PENDING_CODENAMES.has(row.codename)) continue;
    const hasInput = typeof row.inputPricePerMillion === "number";
    const hasOutput = typeof row.outputPricePerMillion === "number";
    if (!hasInput || !hasOutput) {
      errors.push(
        `llms/${row.provider}: model ${row.codename} must set inputPricePerMillion and outputPricePerMillion (billed first-party model)`,
      );
    }
  }
  return errors;
}

/**
 * Validate every model table against the per-provider invariants.
 * @returns A list of human-readable violation messages (empty when valid).
 */
export function validateModels(): string[] {
  const errors: string[] = [];
  validateSpec(llmSpec, errors);
  validateSpec(imageSpec, errors);
  validateSpec(videoSpec, errors);
  validateSpec(embeddingSpec, errors);
  errors.push(...collectStrictChatFlagViolations(rowsOf(llmSpec)));
  errors.push(...collectMeteredPriceViolations(rowsOf(llmSpec)));
  return errors;
}

function renderStatement<T extends RowLike>(spec: TableSpec<T>): string {
  const values = rowsOf(spec)
    .map((m) => `  (${spec.tuple(m)})`)
    .join(",\n");
  return `INSERT INTO ${spec.table} (${spec.columns})\nVALUES\n${values}\n${spec.onConflict}`;
}

/**
 * Build one `INSERT … ON CONFLICT` statement per model table from the catalog.
 * Exposed for tests / inspection; runtime seeding uses {@link seedModelsFromCatalog}.
 */
export function buildModelSeedStatements(): string[] {
  return [
    renderStatement(llmSpec),
    renderStatement(imageSpec),
    renderStatement(videoSpec),
    renderStatement(embeddingSpec),
  ];
}

/**
 * Seed all model tables from the typed catalog. Validates invariants first and
 * throws before touching the database if the catalog is malformed, then runs the
 * idempotent upsert for each table.
 */
export async function seedModelsFromCatalog(client: SQL): Promise<void> {
  const violations = validateModels();
  if (violations.length > 0) {
    throw new Error(`Model catalog invariant violations:\n  - ${violations.join("\n  - ")}`);
  }
  for (const statement of buildModelSeedStatements()) {
    await client.unsafe(statement);
  }
}
