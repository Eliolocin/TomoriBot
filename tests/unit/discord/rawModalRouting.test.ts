import { describe, expect, it } from "bun:test";
import type { GlobalDiscordState, RawDiscordWebSocketPacket, RawDiscordShard } from "@/types/discord/rawApiTypes";
import { initializeRawModalInterception, takeRawModalSelectValue } from "@/utils/discord/ui/modals";

describe("routed raw modal gateway support", () => {
  it("transforms a nonce-bounded Radio Group submission and consumes its intercepted value once", () => {
    const globalState = globalThis as GlobalDiscordState;
    const previousPatchState = globalState.__webSocketPatched;
    delete globalState.__webSocketPatched;

    try {
      const received: RawDiscordWebSocketPacket[] = [];
      const client = {
        ws: {
          handlePacket: (packet: RawDiscordWebSocketPacket, _shard: RawDiscordShard) => {
            received.push(structuredClone(packet));
          },
        },
      };
      initializeRawModalInterception(client);

      const packet: RawDiscordWebSocketPacket = {
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "modal-submit-1",
          type: 5,
          data: {
            custom_id: "mcps:v1:add-submit:en-US:12345678",
            components: [
              {
                type: 18,
                component: {
                  type: 21,
                  custom_id: "server-type_12345678",
                  value: "web_search",
                },
              },
            ],
          },
        },
      };
      client.ws.handlePacket(packet, { id: 0 });

      expect(received).toHaveLength(1);
      expect(received[0]?.d?.data?.components).toEqual([
        {
          type: 1,
          components: [
            {
              type: 21,
              custom_id: "server-type_12345678",
              value: "web_search",
            },
          ],
        },
      ]);
      expect(takeRawModalSelectValue("modal-submit-1", "server-type_12345678")).toBe("web_search");
      expect(takeRawModalSelectValue("modal-submit-1", "server-type_12345678")).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });
});
