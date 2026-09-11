/**
 * Shared guards for reading untrusted zip archives.
 *
 * Both persona zip readers (`spriteArchive`, `charxArchive`) accept an archive
 * from an arbitrary Discord attachment, so both need the same two defenses:
 * resolve a declared path without letting a malformed one mis-resolve, and
 * learn an entry's uncompressed size before paying to decompress it.
 *
 * Only the pure, buffer-free parts live here. Each reader keeps its own
 * extraction loop because its budget accounting and failure taxonomy differ.
 */

import type JSZip from "jszip";

/**
 * Resolves a declared archive path to its zip entry, tolerating case
 * differences and a folder prefix some archivers add. Path-traversal-style
 * references are rejected defensively: nothing is ever written to disk, but a
 * malformed path should fail cleanly rather than mis-resolve.
 */
export function resolveZipEntryFile(zip: JSZip, declaredPath: string): JSZip.JSZipObject | null {
  if (declaredPath.includes("..") || declaredPath.startsWith("/") || declaredPath.includes("\\")) {
    return null;
  }

  const direct = zip.file(declaredPath);
  if (direct && !direct.dir) {
    return direct;
  }

  return findZipEntryByBasename(zip, declaredPath.split("/").pop());
}

/** Finds any non-directory entry whose basename matches, ignoring casing. */
export function findZipEntryByBasename(zip: JSZip, basename: string | undefined): JSZip.JSZipObject | null {
  if (!basename) {
    return null;
  }

  const lowerTarget = basename.toLowerCase();
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) {
      continue;
    }
    if (name.split("/").pop()?.toLowerCase() === lowerTarget) {
      return file;
    }
  }
  return null;
}

/**
 * Reads JSZip's declared uncompressed size for an entry without decompressing.
 * This is an internal JSZip field, so it is accessed defensively and returns
 * null when unavailable (callers then fall back to a post-read size check).
 */
export function getDeclaredUncompressedSize(file: JSZip.JSZipObject): number | null {
  const internal = file as unknown as {
    _data?: { uncompressedSize?: number };
  };
  const size = internal._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}
