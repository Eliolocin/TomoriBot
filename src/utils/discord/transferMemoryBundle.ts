import type { MemoryBucket, ParsedExportPayload } from "@/types/db/dataExport";

/**
 * The buckets of a parsed memory bundle, or null when the payload is not one.
 *
 * A v1 combined `server` or `personal` export carries its memories one level down, under `memories`, so it
 * returns null here rather than reaching into a shape the memory entry points refuse. Both the import command and
 * the routed continuations read buckets through this one function, because a bucket list derived two ways could
 * disagree about which parse results are importable.
 */
export function readMemoryBundleBuckets(payload: ParsedExportPayload): MemoryBucket[] | null {
  if (!payload || typeof payload !== "object" || !("buckets" in payload) || !Array.isArray(payload.buckets)) {
    return null;
  }
  return payload.buckets;
}
