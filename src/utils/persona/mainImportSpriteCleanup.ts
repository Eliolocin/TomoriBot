import type { PersonaSpriteRow } from "@/types/db/schema";
import { invalidatePersonaSpriteCache } from "@/utils/cache/personaSpriteCacheStore";
import { personaSpriteRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";
import { deletePersonaSpriteFromStorage, isSharedPresetAssetReference } from "@/utils/storage/avatarStorage";

export async function snapshotMainPersonaSprites(personaId: number): Promise<PersonaSpriteRow[]> {
  return await personaSpriteRepository.listForPersona(personaId);
}

export async function cleanupMainPersonaSpritesAfterImport(params: {
  personaId: number;
  serverDiscId: string;
  importedAsPointer: boolean;
  spritesBeforeImport: PersonaSpriteRow[];
}): Promise<number> {
  // Pointer imports delete persona-owned rows inside the import transaction, so their storage
  // cleanup must use the snapshot captured before that transaction.
  const spritesToDeleteFromStorage = params.importedAsPointer
    ? params.spritesBeforeImport
    : await personaSpriteRepository.deleteAllForPersona(params.personaId);

  // The pointer transaction already performed the sprite-row write. Invalidate only after that
  // transaction has reported success, while materialized imports invalidate in the repository
  // immediately after their DELETE succeeds.
  if (params.importedAsPointer) {
    invalidatePersonaSpriteCache(params.personaId);
  }

  const deletableSprites = spritesToDeleteFromStorage.filter(
    (sprite) => !isSharedPresetAssetReference(sprite.avatar_url),
  );
  const storageDeleteResults = await Promise.all(
    deletableSprites.map((sprite) => deletePersonaSpriteFromStorage(sprite.avatar_url)),
  );
  const failedStorageDeletes = storageDeleteResults.filter((deleted) => !deleted).length;
  if (failedStorageDeletes > 0) {
    const storageCleanupError = new Error(
      `${failedStorageDeletes} of ${deletableSprites.length} persona sprite files could not be deleted`,
    );
    log.warn(
      `Main persona import completed with partial sprite storage cleanup for ${params.personaId}`,
      storageCleanupError,
      {
        errorType: "PersonaImportSpriteStorageCleanupWarning",
        metadata: {
          personaId: params.personaId,
          serverDiscId: params.serverDiscId,
          failedCount: failedStorageDeletes,
          attemptedCount: deletableSprites.length,
        },
      },
    );
  }

  return failedStorageDeletes;
}
