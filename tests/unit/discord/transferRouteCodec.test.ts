import { beforeAll, describe, expect, it } from "bun:test";
import {
  TRANSFER_ROUTE_CODECS,
  buildTransferRouteId,
  parseTransferPanelRoute,
  type TransferPanelRoute,
} from "@/utils/discord/transferCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("transfer route catalog and codecs", () => {
  it("keeps every action wire token unique", () => {
    const seen = new Map<string, string>();
    for (const [action, codec] of Object.entries(TRANSFER_ROUTE_CODECS)) {
      const existing = seen.get(codec.wireToken);
      if (existing) {
        throw new Error(`Duplicate wire token "${codec.wireToken}" found in actions "${existing}" and "${action}"`);
      }
      seen.set(codec.wireToken, action);
    }
    expect(seen.size).toBe(Object.keys(TRANSFER_ROUTE_CODECS).length);
  });

  const testRoutes: TransferPanelRoute[] = [
    { action: "config-continue", locale: "en-US", nonce: "nonce-1234" },
    { action: "config-apply", locale: "en-US", nonce: "nonce-2345" },
    { action: "memory-strategy", locale: "en-US", nonce: "nonce-3456", strategy: "merge" },
    { action: "memory-strategy", locale: "en-US", nonce: "nonce-4567", strategy: "replace" },
    { action: "memory-bucket-select", locale: "en-US", nonce: "nonce-5678", bucketPage: 0 },
    {
      action: "memory-bucket-select",
      locale: "en-US",
      nonce: "nonce-6789",
      bucketPage: 9007199254740991,
    },
    { action: "memory-bucket-page", locale: "en-US", nonce: "nonce-abcd", bucketPage: 0 },
    {
      action: "memory-bucket-page",
      locale: "en-US",
      nonce: "nonce-bcde",
      bucketPage: 9007199254740991,
    },
    { action: "memory-map", locale: "en-US", nonce: "nonce-cdef", bucketIndex: 0, destPage: 0 },
    {
      action: "memory-map",
      locale: "en-US",
      nonce: "nonce-def0",
      bucketIndex: 9007199254740991,
      destPage: 9007199254740991,
    },
    { action: "memory-map-page", locale: "en-US", nonce: "nonce-ef01", bucketIndex: 0, destPage: 0 },
    {
      action: "memory-map-page",
      locale: "en-US",
      nonce: "nonce-f012",
      bucketIndex: 9007199254740991,
      destPage: 9007199254740991,
    },
    { action: "memory-confirm", locale: "en-US", nonce: "nonce-0123" },
    { action: "memory-replace-confirm", locale: "en-US", nonce: "nonce-0abc" },
    { action: "cancel", locale: "en-US", nonce: "nonce-123a" },
  ];

  it("round-trips every action and preserves zero values", () => {
    for (const route of testRoutes) {
      const customId = buildTransferRouteId(route);
      const parsed = parseInteractionRoute(customId);
      expect(parseTransferPanelRoute(parsed)).toEqual(route);
    }
  });

  it("keeps generated IDs within Discord's custom ID limit", () => {
    for (const route of testRoutes) {
      expect(buildTransferRouteId(route).length).toBeLessThanOrEqual(100);
    }

    const maxLengthRoute: TransferPanelRoute = {
      action: "memory-map-page",
      locale: "en-US",
      nonce: "12345678901234567890123456789012",
      bucketIndex: 9007199254740991,
      destPage: 9007199254740991,
    };
    expect([maxLengthRoute.bucketIndex, maxLengthRoute.destPage]).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
    expect(buildTransferRouteId(maxLengthRoute).length).toBeLessThanOrEqual(100);

    // The ceiling has to be measured against the longest wire token carrying the longest nonce, not only against
    // the action with the most fields, so both worst cases are named here.
    expect(TRANSFER_ROUTE_CODECS["memory-replace-confirm"].wireToken.length).toBe(
      Math.max(...Object.values(TRANSFER_ROUTE_CODECS).map((codec) => codec.wireToken.length)),
    );
    expect(
      buildTransferRouteId({
        action: "memory-replace-confirm",
        locale: "en-US",
        nonce: "12345678901234567890123456789012",
      }).length,
    ).toBeLessThanOrEqual(100);
  });

  it("rejects forged and malformed route values", () => {
    const malformedIds = [
      "other:v1:cancel:en-US:nonce-1234",
      "transfer:v2:cancel:en-US:nonce-1234",
      "transfer:v1:unknown:en-US:nonce-1234",
      "transfer:v1:cancel:fr:nonce-1234",
      "transfer:v1:memory-strategy:en-US:nonce-1234:x",
      "transfer:v1:mbsel:en-US:nonce-1234:-1",
      "transfer:v1:mbpage:en-US:nonce-1234:not-a-number",
      "transfer:v1:memory-map:en-US:nonce-1234:0:-1",
      "transfer:v1:memory-map-page:en-US:nonce-1234:0:not-a-number",
      "transfer:v1:memory-map:en-US:nonce-1234:-1:0",
      "transfer:v1:memory-map:en-US:nonce-1234:not-a-number:0",
      "transfer:v1:memory-map:en-US:nonce-1234::0",
      "transfer:v1:memory-map:en-US:nonce-1234:1.5:0",
      "transfer:v1:cancel:en-US:short",
    ];

    for (const customId of malformedIds) {
      const parsed = parseInteractionRoute(customId);
      expect(parsed === null ? null : parseTransferPanelRoute(parsed)).toBeNull();
    }
  });
});
