import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { stubLogMembers } from "../../helpers/mockSurface";
import { createOpenRouterCatalog, parseOpenRouterCatalogModelList } from "@/utils/cache/openrouterCatalog";

stubLogMembers({ info: () => undefined, warn: () => undefined, success: () => undefined, error: () => undefined });

interface TestEntry {
  id: string;
}

function jsonResponse(ids: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: "Service Unavailable",
    json: async () => ({}),
  } as unknown as Response;
}

function makeCatalog() {
  return createOpenRouterCatalog<TestEntry>({
    label: "test",
    url: "https://openrouter.test/api/v1/models",
    parse: (payload) => parseOpenRouterCatalogModelList("test", payload).map((entry) => ({ id: entry.id })),
    keyOf: (entry) => entry.id,
  });
}

const originalMinInterval = process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS;
const originalTtl = process.env.OPENROUTER_CATALOG_TTL_MS;

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mock(async () => jsonResponse(["vendor/first"])));
});

afterEach(() => {
  fetchSpy.mockRestore();
  process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = originalMinInterval;
  process.env.OPENROUTER_CATALOG_TTL_MS = originalTtl;
});

describe("OpenRouter catalog refresh", () => {
  it("finds a model published after the initial load", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    const catalog = makeCatalog();
    await catalog.initialize();

    expect(await catalog.getOrFetch("vendor/published-later")).toBeUndefined();

    fetchSpy.mockImplementation(mock(async () => jsonResponse(["vendor/first", "vendor/published-later"])));

    expect(await catalog.getOrFetch("vendor/published-later")).toEqual({ id: "vendor/published-later" });
  });

  it("reaches the network after a failed startup fetch instead of staying closed", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    fetchSpy.mockImplementation(mock(async () => errorResponse(503)));

    const catalog = makeCatalog();
    await catalog.initialize();
    expect(catalog.isReady()).toBe(false);

    fetchSpy.mockImplementation(mock(async () => jsonResponse(["vendor/first"])));

    expect(await catalog.getOrFetch("vendor/first")).toEqual({ id: "vendor/first" });
    expect(catalog.isReady()).toBe(true);
  });

  it("keeps the cached catalog when a refresh fails", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    const catalog = makeCatalog();
    await catalog.initialize();

    fetchSpy.mockImplementation(mock(async () => errorResponse(503)));
    await catalog.getOrFetch("vendor/missing");

    expect(catalog.isReady()).toBe(true);
    expect(catalog.get("vendor/first")).toEqual({ id: "vendor/first" });
  });

  it("treats an empty catalog as a failed refresh", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    const catalog = makeCatalog();
    await catalog.initialize();

    fetchSpy.mockImplementation(mock(async () => jsonResponse([])));
    await catalog.getOrFetch("vendor/missing");

    expect(catalog.size()).toBe(1);
    expect(catalog.get("vendor/first")).toEqual({ id: "vendor/first" });
  });

  it("rate-limits repeated misses to one fetch per cooldown window", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "600000";
    const catalog = makeCatalog();
    await catalog.initialize();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await catalog.getOrFetch("vendor/typo");
    await catalog.getOrFetch("vendor/typo");
    await catalog.getOrFetch("vendor/another-typo");

    // The startup fetch opens the window, so misses inside it reuse that catalog rather
    // than re-fetching a snapshot taken moments ago.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cooldown for a fresh lookup", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "600000";
    const catalog = makeCatalog();
    await catalog.initialize();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockImplementation(mock(async () => jsonResponse(["vendor/first", "vendor/published-later"])));

    expect(await catalog.getOrFetch("vendor/published-later")).toBeUndefined();
    expect(await catalog.getOrFetch("vendor/published-later", { fresh: true })).toEqual({
      id: "vendor/published-later",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refreshes on a fresh lookup even when the codename is already cached", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "600000";
    const catalog = makeCatalog();
    await catalog.initialize();

    expect(await catalog.getOrFetch("vendor/first", { fresh: true })).toEqual({ id: "vendor/first" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent misses into a single fetch", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    const catalog = makeCatalog();

    await Promise.all([
      catalog.getOrFetch("vendor/first"),
      catalog.getOrFetch("vendor/first"),
      catalog.getOrFetch("vendor/first"),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes only once the TTL has elapsed", async () => {
    process.env.OPENROUTER_CATALOG_REFRESH_MIN_INTERVAL_MS = "0";
    process.env.OPENROUTER_CATALOG_TTL_MS = "3600000";
    const catalog = makeCatalog();
    await catalog.initialize();

    await catalog.refreshIfStale();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    process.env.OPENROUTER_CATALOG_TTL_MS = "1";
    await Bun.sleep(2);
    await catalog.refreshIfStale();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("matches codenames case-insensitively", async () => {
    const catalog = makeCatalog();
    fetchSpy.mockImplementation(mock(async () => jsonResponse(["Vendor/Mixed-Case"])));
    await catalog.initialize();

    expect(catalog.get("  vendor/MIXED-case ")).toEqual({ id: "vendor/mixed-case" });
  });
});

describe("OpenRouter catalog payload parsing", () => {
  it("skips entries without a usable id", () => {
    expect(
      parseOpenRouterCatalogModelList("embedding", {
        data: [{ id: " Vendor/Embed-1 ", name: "Embed One", description: " " }, { id: "" }, { name: "no id" }],
      }),
    ).toEqual([{ id: "vendor/embed-1", name: "Embed One", description: null }]);
  });

  it("rejects responses without a data array", () => {
    expect(() => parseOpenRouterCatalogModelList("image", { error: "unavailable" })).toThrow("missing data array");
  });
});
