import { describe, expect, it } from "bun:test";
import type { GlobalDiscordState, RawDiscordWebSocketPacket, RawDiscordShard } from "@/types/discord/rawApiTypes";
import {
  initializeRawModalInterception,
  takeRawModalCheckboxGroupValues,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";

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

  it("transforms a nonce-bounded Checkbox Group submission and consumes its intercepted array values once", () => {
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
          id: "modal-submit-2",
          type: 5,
          data: {
            custom_id: "moderation:v1:member-access-submit:en-US:abcd1234",
            components: [
              {
                type: 18,
                component: {
                  type: 22,
                  custom_id: "memberaccess_checkbox_abcd1234",
                  values: ["servermemories", "sampledialogues"],
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
              type: 22,
              custom_id: "memberaccess_checkbox_abcd1234",
              values: ["servermemories", "sampledialogues"],
            },
          ],
        },
      ]);
      expect(takeRawModalCheckboxGroupValues("modal-submit-2", "memberaccess_checkbox_abcd1234")).toEqual([
        "servermemories",
        "sampledialogues",
      ]);
      expect(takeRawModalCheckboxGroupValues("modal-submit-2", "memberaccess_checkbox_abcd1234")).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });

  it("distinguishes an explicit empty array from missing checkbox group transport", () => {
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
          id: "modal-submit-empty",
          type: 5,
          data: {
            custom_id: "moderation:v1:member-access-submit:en-US:empty123",
            components: [
              {
                type: 18,
                component: {
                  type: 22,
                  custom_id: "memberaccess_checkbox_empty123",
                  values: [],
                },
              },
            ],
          },
        },
      };
      client.ws.handlePacket(packet, { id: 0 });

      expect(takeRawModalCheckboxGroupValues("modal-submit-empty", "memberaccess_checkbox_empty123")).toEqual([]);
      expect(takeRawModalCheckboxGroupValues("modal-submit-empty", "memberaccess_checkbox_empty123")).toBeUndefined();

      expect(
        takeRawModalCheckboxGroupValues("non-existent-interaction", "memberaccess_checkbox_empty123"),
      ).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });

  it("transforms a nonce-bounded User Select submission and consumes its intercepted value once", () => {
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
          id: "modal-submit-user-select",
          type: 5,
          data: {
            custom_id: "moderation:v1:user-blacklist-add-submit:en-US:user1234",
            components: [
              {
                type: 18,
                component: {
                  type: 5,
                  custom_id: "userblacklist_add_user_user1234",
                  values: ["123456789012345678"],
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
              type: 5,
              custom_id: "userblacklist_add_user_user1234",
              values: ["123456789012345678"],
            },
          ],
        },
      ]);
      expect(takeRawModalSelectValue("modal-submit-user-select", "userblacklist_add_user_user1234")).toBe(
        "123456789012345678",
      );
      expect(takeRawModalSelectValue("modal-submit-user-select", "userblacklist_add_user_user1234")).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });

  it("transforms a nonce-bounded Channel Select submission and consumes its intercepted value once", () => {
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
          id: "modal-submit-channel-select",
          type: 5,
          data: {
            custom_id: "moderation:v1:whitelist-channel-add-submit:en-US:chan1234",
            components: [
              {
                type: 18,
                component: {
                  type: 8,
                  custom_id: "whitelist_channel_add_channel_chan1234",
                  channel_types: [0],
                  values: ["987654321098765432"],
                },
              },
              {
                type: 18,
                component: {
                  type: 3,
                  custom_id: "whitelist_channel_add_type_chan1234",
                  values: ["2"],
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
              type: 8,
              custom_id: "whitelist_channel_add_channel_chan1234",
              channel_types: [0],
              values: ["987654321098765432"],
            },
          ],
        },
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "whitelist_channel_add_type_chan1234",
              values: ["2"],
            },
          ],
        },
      ]);
      expect(takeRawModalSelectValue("modal-submit-channel-select", "whitelist_channel_add_channel_chan1234")).toBe(
        "987654321098765432",
      );
      expect(
        takeRawModalSelectValue("modal-submit-channel-select", "whitelist_channel_add_channel_chan1234"),
      ).toBeUndefined();
      expect(takeRawModalSelectValue("modal-submit-channel-select", "whitelist_channel_add_type_chan1234")).toBe("2");
      expect(
        takeRawModalSelectValue("modal-submit-channel-select", "whitelist_channel_add_type_chan1234"),
      ).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });

  it("transforms a nonce-bounded Role Select submission and consumes its intercepted value once", () => {
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
          id: "modal-submit-role-select",
          type: 5,
          data: {
            custom_id: "moderation:v1:whitelist-role-add-submit:en-US:role1234",
            components: [
              {
                type: 18,
                component: {
                  type: 6,
                  custom_id: "whitelist_role_add_role_role1234",
                  values: ["876543210987654321"],
                },
              },
            ],
          },
        },
      };
      client.ws.handlePacket(packet, { id: 0 });

      expect(received[0]?.d?.data?.components).toEqual([
        {
          type: 1,
          components: [
            {
              type: 6,
              custom_id: "whitelist_role_add_role_role1234",
              values: ["876543210987654321"],
            },
          ],
        },
      ]);
      expect(takeRawModalSelectValue("modal-submit-role-select", "whitelist_role_add_role_role1234")).toBe(
        "876543210987654321",
      );
      expect(takeRawModalSelectValue("modal-submit-role-select", "whitelist_role_add_role_role1234")).toBeUndefined();
    } finally {
      if (previousPatchState === undefined) delete globalState.__webSocketPatched;
      else globalState.__webSocketPatched = previousPatchState;
    }
  });
});
