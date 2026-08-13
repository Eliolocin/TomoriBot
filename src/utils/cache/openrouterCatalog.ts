/**
 * Shared refresh machinery for OpenRouter's catalog endpoints.
 *
 * OpenRouter publishes four sibling catalogs (text, embedding, image, video) that each
 * list only their own modality, so a model absent from one says nothing about the others.
 * Every catalog needs the same refresh discipline, which this module centralizes.
 */

import { log } from "@/utils/misc/logger";
import { buildOpenRouterAttributionHeaders } from "@/utils/provider/openrouterAttribution";

const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function readIntEnv(name: string, fallbackMs: number, minimum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallbackMs;
}

/**
 * Floor on the gap between refresh *attempts*, shared by every catalog.
 *
 * The gate counts attempts rather than successes so a persistently failing endpoint cannot
 * be turned into a request amplifier: a miss costs one upstream fetch per window regardless
 * of how the previous attempt ended, process-wide. That bound is the only thing standing
 * between a permanently invalid codename on the chat path and a fetch per turn, so the
 * window stays short rather than absent. Zero disables it.
 */
export function getOpenRouterCatalogMinRefreshIntervalMs(): number {
  return readIntEnv("OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS", DEFAULT_MIN_REFRESH_INTERVAL_MS, 0);
}

/** Age past which a catalog is considered stale and eligible for a background refresh. */
export function getOpenRouterCatalogTtlMs(): number {
  return readIntEnv("OPENROUTER_CATALOG_TTL_MS", DEFAULT_TTL_MS, 1);
}

/** Codenames reach us from Discord input and from the database, neither of which enforces case. */
export function normalizeOpenRouterCodename(codename: string): string {
  return codename.trim().toLowerCase();
}

export interface OpenRouterCatalogSource<TEntry> {
  /** Human-readable catalog name used in log lines. */
  label: string;
  url: string;
  /** Throws when the payload is malformed, which is treated as a failed refresh. */
  parse(payload: unknown): TEntry[];
  keyOf(entry: TEntry): string;
}

export interface OpenRouterCatalogStatus {
  ready: boolean;
  size: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  stale: boolean;
}

export interface OpenRouterCatalog<TEntry> {
  initialize(): Promise<void>;
  /** Resolves true when the in-memory map holds a usable catalog, refreshed or not. */
  refresh(options?: { force?: boolean }): Promise<boolean>;
  refreshIfStale(): Promise<boolean>;
  /** Synchronous lookup against whatever is already cached; never triggers a fetch. */
  get(codename: string): TEntry | undefined;
  /** Lookup that refreshes once, subject to the cooldown, when the codename is unknown. */
  getOrFetch(codename: string): Promise<TEntry | undefined>;
  isReady(): boolean;
  size(): number;
  getStatus(): OpenRouterCatalogStatus;
  /** Test seam: drops cached entries and timing state. */
  reset(): void;
}

export function createOpenRouterCatalog<TEntry>(source: OpenRouterCatalogSource<TEntry>): OpenRouterCatalog<TEntry> {
  let entries = new Map<string, TEntry>();
  let ready = false;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let inFlight: Promise<boolean> | null = null;

  async function fetchCatalog(): Promise<Map<string, TEntry>> {
    const response = await fetch(source.url, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...buildOpenRouterAttributionHeaders(),
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter ${source.label} catalog returned ${response.status}: ${response.statusText}`);
    }

    const parsed = source.parse(await response.json());
    const next = new Map<string, TEntry>();
    for (const entry of parsed) {
      const key = normalizeOpenRouterCodename(source.keyOf(entry));
      if (key.length > 0) {
        next.set(key, entry);
      }
    }

    if (next.size === 0) {
      throw new Error(`OpenRouter ${source.label} catalog returned no usable models`);
    }

    return next;
  }

  async function runRefresh(): Promise<boolean> {
    lastAttemptAt = Date.now();
    try {
      const next = await fetchCatalog();

      // Swapping a fully built map is what makes a mid-life refresh safe: readers either
      // see the whole old catalog or the whole new one, and a failed fetch below leaves
      // a working catalog untouched rather than emptying it.
      entries = next;
      ready = true;
      lastSuccessAt = Date.now();
      log.success(`OpenRouter ${source.label} catalog refreshed: ${entries.size} models`);
      return true;
    } catch (error) {
      log.warn(
        `Failed to refresh OpenRouter ${source.label} catalog (non-critical); keeping ${entries.size} cached models`,
        error as Error,
      );
      return ready;
    } finally {
      inFlight = null;
    }
  }

  function isStale(): boolean {
    if (!ready || lastSuccessAt === null) {
      return true;
    }
    return Date.now() - lastSuccessAt >= getOpenRouterCatalogTtlMs();
  }

  function refresh(options?: { force?: boolean }): Promise<boolean> {
    if (inFlight) {
      return inFlight;
    }

    if (!options?.force && lastAttemptAt !== null) {
      const elapsed = Date.now() - lastAttemptAt;
      if (elapsed < getOpenRouterCatalogMinRefreshIntervalMs()) {
        return Promise.resolve(ready);
      }
    }

    inFlight = runRefresh();
    return inFlight;
  }

  return {
    async initialize(): Promise<void> {
      await refresh({ force: true });
    },
    refresh,
    refreshIfStale(): Promise<boolean> {
      return isStale() ? refresh() : Promise.resolve(ready);
    },
    get(codename: string): TEntry | undefined {
      return entries.get(normalizeOpenRouterCodename(codename));
    },
    async getOrFetch(codename: string): Promise<TEntry | undefined> {
      const key = normalizeOpenRouterCodename(codename);
      const cached = entries.get(key);
      if (cached) {
        return cached;
      }

      // A miss is the only signal we get that the boot-time snapshot predates a model,
      // and an unready catalog means boot never completed, so both must be able to reach
      // the network. Returning early on `!ready` is what used to strand the whole feature
      // until a restart.
      await refresh();
      return entries.get(key);
    },
    isReady(): boolean {
      return ready;
    },
    size(): number {
      return entries.size;
    },
    getStatus(): OpenRouterCatalogStatus {
      return {
        ready,
        size: entries.size,
        lastSuccessAt,
        lastAttemptAt,
        stale: isStale(),
      };
    },
    reset(): void {
      entries = new Map();
      ready = false;
      lastAttemptAt = null;
      lastSuccessAt = null;
      inFlight = null;
    },
  };
}

/** Shape shared by the embedding and image catalogs, which we consult only for existence. */
export interface OpenRouterCatalogModelEntry {
  id: string;
  name: string | null;
  description: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseOpenRouterCatalogModelList(label: string, payload: unknown): OpenRouterCatalogModelEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`Unexpected OpenRouter ${label} catalog response: missing data array`);
  }

  const models: OpenRouterCatalogModelEntry[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
      continue;
    }

    models.push({
      id: normalizeOpenRouterCodename(entry.id),
      name: readOptionalString(entry.name),
      description: readOptionalString(entry.description),
    });
  }

  return models;
}
