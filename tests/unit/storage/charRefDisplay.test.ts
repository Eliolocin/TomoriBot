import { describe, expect, it } from "bun:test";
import { resolveCharRefDisplayAsset, type CharRefStorageConfig } from "@/utils/storage/charrefStorage";

const storageConfig: CharRefStorageConfig = {
  bucket: "tomori-media",
  region: "ap-southeast-1",
  prefix: "charreferences",
  publicBaseUrl: "https://cdn.example.invalid/media",
};

describe("character-reference display resolver", () => {
  it.each([
    [
      "configured CDN",
      "https://cdn.example.invalid/media/charreferences/personas/55/asset.png?version=1",
      storageConfig,
    ],
    [
      "configured S3 origin",
      "https://tomori-media.s3.ap-southeast-1.amazonaws.com/charreferences/personas/55/asset.png",
      { ...storageConfig, publicBaseUrl: "https://tomori-media.s3.ap-southeast-1.amazonaws.com" },
    ],
  ])("passes through a trusted %s URL for its persona", async (_label, reference, config) => {
    const result = await resolveCharRefDisplayAsset(reference, 55, { storageConfig: config });

    expect(result).toEqual({ type: "url", url: reference });
  });

  it("loads a valid same-persona local reference as bytes", async () => {
    let loadedPath: string | undefined;
    const result = await resolveCharRefDisplayAsset("data\\charreferences\\personas\\55\\asset.png", 55, {
      loadLocalBuffer: async (absolutePath) => {
        loadedPath = absolutePath;
        return Buffer.from("png");
      },
    });

    expect(result).toEqual({ type: "buffer", buffer: Buffer.from("png") });
    expect(loadedPath).toContain("data");
    expect(loadedPath).toContain("charreferences");
    expect(loadedPath).toContain("personas");
    expect(loadedPath).toContain("55");
  });

  it.each([
    "https://cdn.example.invalid/media/charreferences/personas/56/asset.png",
    "https://cdn.example.invalid/media/charreferences/personas/55/",
    "https://cdn.example.invalid/media/charreferences/users/55/asset.png",
    "https://cdn.example.invalid/media/other/personas/55/asset.png",
    "https://other.example.invalid/media/charreferences/personas/55/asset.png",
    "https://tomori-media.s3.ap-southeast-1.amazonaws.com/charreferences/personas/55/asset.png",
    "https://cdn.example.invalid/media/charreferences/personas/55/%2e%2e/users/asset.png",
    "not-a-url",
    "data/charreferences/personas/56/asset.png",
    "data/charreferences/users/55/asset.png",
    "data/charreferences/personas/55/../../users/55/asset.png",
  ])("rejects an untrusted or wrong-owner reference without loading it: %s", async (reference) => {
    let loadAttempted = false;
    const result = await resolveCharRefDisplayAsset(reference, 55, {
      storageConfig,
      loadLocalBuffer: async () => {
        loadAttempted = true;
        return Buffer.from("should not load");
      },
    });

    expect(result).toBeNull();
    expect(loadAttempted).toBe(false);
  });

  it("returns no local asset when the stored file cannot be read", async () => {
    const result = await resolveCharRefDisplayAsset("data/charreferences/personas/55/missing.png", 55, {
      loadLocalBuffer: async () => null,
    });

    expect(result).toBeNull();
  });
});
