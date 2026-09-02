import { describe, expect, it, spyOn } from "bun:test";
import * as charRefStorage from "@/utils/storage/charrefStorage";
import { replaceStoredCharReference } from "@/utils/storage/charRefOperations";

function fakeStorage(uploadedRef: string | null) {
  const uploaded: Array<{ entityType: string; entityId: string | number; buffer: Buffer }> = [];
  const deleted: string[] = [];
  const uploadSpy = spyOn(charRefStorage, "uploadCharRef").mockImplementation(async (options) => {
    uploaded.push(options);
    return uploadedRef;
  });
  const deleteSpy = spyOn(charRefStorage, "deleteCharRef").mockImplementation(async (ref) => {
    deleted.push(ref);
    return true;
  });

  return {
    uploaded,
    deleted,
    restore: () => {
      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    },
  };
}

describe("shared character-reference replacement", () => {
  it("preserves each target entity shape and replaces the old asset after persistence", async () => {
    for (const target of [
      { entityType: "users" as const, entityId: "123456789012345678" as string | number },
      { entityType: "personas" as const, entityId: 55 as string | number },
    ]) {
      const storage = fakeStorage("new-reference.png");
      let persisted: string | null | undefined;
      let callbackCount = 0;
      const success = await replaceStoredCharReference({
        ...target,
        previousRef: "old-reference.png",
        nextBuffer: Buffer.from("png"),
        persistNextRef: async (nextRef) => {
          persisted = nextRef;
          return true;
        },
        onPersistSuccess: () => {
          callbackCount += 1;
        },
      });

      expect(success).toBe(true);
      expect(storage.uploaded[0]).toMatchObject({ entityType: target.entityType, entityId: target.entityId });
      expect(persisted).toBe("new-reference.png");
      expect(callbackCount).toBe(1);
      expect(storage.deleted).toEqual(["old-reference.png"]);
      storage.restore();
    }
  });

  it("leaves persistence and deletion untouched when upload fails", async () => {
    const storage = fakeStorage(null);
    let persistCalled = false;
    const success = await replaceStoredCharReference({
      entityType: "personas",
      entityId: 55,
      previousRef: "old-reference.png",
      nextBuffer: Buffer.from("png"),
      persistNextRef: async () => {
        persistCalled = true;
        return true;
      },
      onPersistSuccess: () => undefined,
    });

    expect(success).toBe(false);
    expect(persistCalled).toBe(false);
    expect(storage.deleted).toEqual([]);
    storage.restore();
  });

  it("deletes only the newly uploaded asset when persistence fails", async () => {
    const storage = fakeStorage("new-reference.png");
    let successCallbackCalled = false;
    const success = await replaceStoredCharReference({
      entityType: "users",
      entityId: "123456789012345678",
      previousRef: "old-reference.png",
      nextBuffer: Buffer.from("png"),
      persistNextRef: async () => false,
      onPersistSuccess: () => {
        successCallbackCalled = true;
      },
    });

    expect(success).toBe(false);
    expect(storage.deleted).toEqual(["new-reference.png"]);
    expect(successCallbackCalled).toBe(false);
    storage.restore();
  });

  it("clears without uploading and deletes an existing previous asset", async () => {
    const storage = fakeStorage("unused-reference.png");
    let persisted: string | null | undefined;
    const success = await replaceStoredCharReference({
      entityType: "users",
      entityId: "123456789012345678",
      previousRef: "old-reference.png",
      nextBuffer: null,
      persistNextRef: async (nextRef) => {
        persisted = nextRef;
        return true;
      },
      onPersistSuccess: () => undefined,
    });

    expect(success).toBe(true);
    expect(storage.uploaded).toEqual([]);
    expect(persisted).toBeNull();
    expect(storage.deleted).toEqual(["old-reference.png"]);
    storage.restore();
  });

  it("does not delete when the stored reference is unchanged or absent", async () => {
    const unchangedStorage = fakeStorage("same-reference.png");
    const unchanged = await replaceStoredCharReference({
      entityType: "personas",
      entityId: 55,
      previousRef: "same-reference.png",
      nextBuffer: Buffer.from("png"),
      persistNextRef: async () => true,
      onPersistSuccess: () => undefined,
    });
    expect(unchanged).toBe(true);
    expect(unchangedStorage.deleted).toEqual([]);
    unchangedStorage.restore();

    const absentStorage = fakeStorage("new-reference.png");
    const withoutPrevious = await replaceStoredCharReference({
      entityType: "personas",
      entityId: 55,
      previousRef: null,
      nextBuffer: Buffer.from("png"),
      persistNextRef: async () => true,
      onPersistSuccess: () => undefined,
    });
    expect(withoutPrevious).toBe(true);
    expect(absentStorage.deleted).toEqual([]);
    absentStorage.restore();
  });
});
