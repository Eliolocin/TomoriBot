import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { PersonaSpriteRow } from "@/types/db/schema";
import { getPersonaSpriteCacheEntry, setPersonaSpriteCache } from "@/utils/cache/personaSpriteCacheStore";
import { personaSpriteRepository } from "@/utils/db/repositories";
import * as avatarStorage from "@/utils/storage/avatarStorage";
import {
  cleanupMainPersonaSpritesAfterImport,
  snapshotMainPersonaSprites,
} from "@/utils/persona/mainImportSpriteCleanup";

const SPRITE: PersonaSpriteRow = {
  sprite_id: 1,
  persona_id: 5,
  sprite_name: "Old",
  sprite_key: "old",
  avatar_url: "data/avatars/servers/server/personas/5/sprites/old.png",
  usage_instructions: "",
  is_identity: false,
};

const POINTER_SPRITE: PersonaSpriteRow = {
  ...SPRITE,
  sprite_id: 2,
  sprite_key: "pointer",
  avatar_url: "data/avatars/presets/100/en-US/sprites/pointer.png",
};

const restoreSpies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of restoreSpies.splice(0)) spy.mockRestore();
});

function spyOnSpriteRepository<K extends keyof typeof personaSpriteRepository>(method: K) {
  const spy = spyOn(personaSpriteRepository, method);
  restoreSpies.push(spy);
  return spy;
}

function spyOnStorageDelete() {
  const spy = spyOn(avatarStorage, "deletePersonaSpriteFromStorage");
  restoreSpies.push(spy);
  return spy;
}

describe("main persona import sprite cleanup", () => {
  it("clears rows and deletes the snapshot returned by a materialized import", async () => {
    const listSpy = spyOnSpriteRepository("listForPersona").mockResolvedValue([SPRITE]);
    const deleteSpy = spyOnSpriteRepository("deleteAllForPersona").mockResolvedValue([SPRITE]);
    const storageSpy = spyOnStorageDelete().mockResolvedValue(true);

    const snapshot = await snapshotMainPersonaSprites(SPRITE.persona_id);
    const failedCount = await cleanupMainPersonaSpritesAfterImport({
      personaId: SPRITE.persona_id,
      serverDiscId: "server",
      importedAsPointer: false,
      spritesBeforeImport: snapshot,
    });

    expect(listSpy).toHaveBeenCalledWith(SPRITE.persona_id);
    expect(deleteSpy).toHaveBeenCalledWith(SPRITE.persona_id);
    expect(storageSpy).toHaveBeenCalledWith(SPRITE.avatar_url);
    expect(failedCount).toBe(0);
  });

  it("uses the pre-import snapshot for a materialized-to-pointer import", async () => {
    const deleteSpy = spyOnSpriteRepository("deleteAllForPersona").mockResolvedValue([]);
    const storageSpy = spyOnStorageDelete().mockResolvedValue(true);

    await cleanupMainPersonaSpritesAfterImport({
      personaId: POINTER_SPRITE.persona_id,
      serverDiscId: "server",
      importedAsPointer: true,
      spritesBeforeImport: [SPRITE, POINTER_SPRITE],
    });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(storageSpy).toHaveBeenCalledWith(SPRITE.avatar_url);
    expect(storageSpy).not.toHaveBeenCalledWith(POINTER_SPRITE.avatar_url);
  });

  it("propagates a snapshot read failure before cleanup can proceed", async () => {
    const readError = new Error("sprite snapshot unavailable");
    const listSpy = spyOnSpriteRepository("listForPersona").mockRejectedValue(readError);

    await expect(snapshotMainPersonaSprites(SPRITE.persona_id)).rejects.toBe(readError);
    expect(listSpy).toHaveBeenCalledWith(SPRITE.persona_id);
  });

  it("propagates a materialized row deletion failure instead of reporting cleanup success", async () => {
    const deleteError = new Error("sprite delete unavailable");
    const deleteSpy = spyOnSpriteRepository("deleteAllForPersona").mockRejectedValue(deleteError);
    const storageSpy = spyOnStorageDelete();

    await expect(
      cleanupMainPersonaSpritesAfterImport({
        personaId: SPRITE.persona_id,
        serverDiscId: "server",
        importedAsPointer: false,
        spritesBeforeImport: [SPRITE],
      }),
    ).rejects.toBe(deleteError);

    expect(deleteSpy).toHaveBeenCalledWith(SPRITE.persona_id);
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it("reports best-effort storage failures after a successful pointer row reset", async () => {
    setPersonaSpriteCache(SPRITE.persona_id, [SPRITE]);
    const storageSpy = spyOnStorageDelete().mockResolvedValue(false);

    const failedCount = await cleanupMainPersonaSpritesAfterImport({
      personaId: SPRITE.persona_id,
      serverDiscId: "server",
      importedAsPointer: true,
      spritesBeforeImport: [SPRITE],
    });

    expect(storageSpy).toHaveBeenCalledWith(SPRITE.avatar_url);
    expect(failedCount).toBe(1);
    expect(getPersonaSpriteCacheEntry(SPRITE.persona_id)).toBeUndefined();
  });
});
