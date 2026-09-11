import type { StructuredContextItem } from "@/types/misc/context";
import { log } from "@/utils/misc/logger";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";

/**
 * Side channel for enhanced-context payloads that are too heavy to travel inside
 * `ToolResult.data`.
 *
 * A tool stashes the item, puts the returned key in `data.pending_context_key`, and the
 * tool loop swaps it back in when it handles the `context_restart_*` signal. Passing the
 * item through `ToolResult.data` instead would pin it in `ToolRegistry.executionHistory`,
 * which retains the last 1000 results for the process lifetime: a megabyte of base64
 * image per avatar peek would never be reclaimed.
 */

const STASH_TTL_MS = parseIntegerEnvFlag(process.env.ENHANCED_CONTEXT_STASH_TTL_MS, 300000, 1000);
const STASH_MAX_ENTRIES = parseIntegerEnvFlag(process.env.ENHANCED_CONTEXT_STASH_MAX_ENTRIES, 16, 1);

interface StashedEntry {
  item: StructuredContextItem;
  storedAt: number;
}

const stash = new Map<string, StashedEntry>();

/**
 * Stores an item for the tool loop to pick up on the next enhanced-context restart.
 * @returns Opaque key to return as `pending_context_key` in the tool's result data
 */
export function stashEnhancedContextItem(item: StructuredContextItem): string {
  const now = Date.now();
  evictStaleEntries(now);

  // An entry is normally consumed milliseconds later by the same turn's restart, so anything
  // still here is from a turn that aborted before the loop could drain it.
  while (stash.size >= STASH_MAX_ENTRIES) {
    const oldestKey: string | undefined = stash.keys().next().value;
    if (oldestKey === undefined) break;
    stash.delete(oldestKey);
    log.warn(
      `Enhanced-context stash reached ${STASH_MAX_ENTRIES} entries; dropped the oldest undrained payload to bound memory.`,
    );
  }

  const key = crypto.randomUUID();
  stash.set(key, { item, storedAt: now });
  return key;
}

/** Removes the item on retrieval so a later restart cannot replay stale media. */
export function takeEnhancedContextItem(key: string): StructuredContextItem | undefined {
  const entry = stash.get(key);
  if (!entry) return undefined;
  stash.delete(key);
  return entry.item;
}

function evictStaleEntries(now: number): void {
  for (const [key, entry] of stash) {
    if (now - entry.storedAt > STASH_TTL_MS) {
      stash.delete(key);
    }
  }
}
