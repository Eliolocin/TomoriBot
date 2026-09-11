import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import { findZipEntryByBasename, getDeclaredUncompressedSize, resolveZipEntryFile } from "@/utils/zip/zipEntryGuards";

/**
 * These guards are shared by both persona archive readers, so they are pinned
 * directly: a regression here would silently loosen a zip-bomb defense that
 * only shows up as a missing or oversized entry much further downstream.
 */
describe("zip entry guards", () => {
  it("resolves a declared path exactly when it is present", async () => {
    const zip = new JSZip();
    zip.file("sprites/01-mad.png", Buffer.from("mad"));
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    const entry = resolveZipEntryFile(loaded, "sprites/01-mad.png");
    expect(entry).not.toBeNull();
    expect(await entry?.async("string")).toBe("mad");
  });

  it("falls back to a case-insensitive basename match", async () => {
    const zip = new JSZip();
    zip.file("sprites/01-mad.PNG", Buffer.from("mad"));
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    expect(resolveZipEntryFile(loaded, "sprites/01-mad.png")).not.toBeNull();
  });

  it("rejects a declared path that escapes the archive root", async () => {
    const zip = new JSZip();
    zip.file("01-mad.png", Buffer.from("mad"));
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    expect(resolveZipEntryFile(loaded, "../01-mad.png")).toBeNull();
    expect(resolveZipEntryFile(loaded, "/01-mad.png")).toBeNull();
    expect(resolveZipEntryFile(loaded, "sprites\\01-mad.png")).toBeNull();
  });

  it("returns null when no entry matches the basename", async () => {
    const zip = new JSZip();
    zip.file("sprites/01-mad.png", Buffer.from("mad"));
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    expect(resolveZipEntryFile(loaded, "sprites/02-sad.png")).toBeNull();
    expect(findZipEntryByBasename(loaded, undefined)).toBeNull();
  });

  it("ignores directory entries when matching a basename", async () => {
    const zip = new JSZip();
    zip.folder("card.json");
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    expect(findZipEntryByBasename(loaded, "card.json")).toBeNull();
  });

  it("reports the declared uncompressed size before decompression", async () => {
    const zip = new JSZip();
    zip.file("card.json", Buffer.alloc(4096, 7));
    const loaded = await JSZip.loadAsync((await zip.generateAsync({ type: "nodebuffer" })) as Buffer);

    const entry = findZipEntryByBasename(loaded, "card.json");
    expect(entry).not.toBeNull();
    if (!entry) {
      return;
    }
    expect(getDeclaredUncompressedSize(entry)).toBe(4096);
  });
});
