import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Webhook } from "discord.js";
import { clearWebhookCache, runWithWebhookIdentity } from "@/utils/discord/webhook/webhookCore";

function makeWebhook(edit: Webhook["edit"]): Webhook {
  return {
    id: "webhook_1",
    channelId: "channel_1",
    avatar: null,
    edit,
  } as unknown as Webhook;
}

describe("runWithWebhookIdentity", () => {
  beforeEach(() => clearWebhookCache());

  it("applies a local avatar to the shared webhook before a raw REST operation", async () => {
    const events: string[] = [];
    const edit = mock(async () => {
      events.push("avatar");
      return {} as Webhook;
    });
    const webhook = makeWebhook(edit as Webhook["edit"]);

    await runWithWebhookIdentity(
      webhook,
      { username: "Sparrow", avatarDataUri: "data:image/png;base64,AAAA" },
      async () => {
        events.push("send");
      },
    );

    expect(events).toEqual(["avatar", "send"]);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("leaves public per-message avatar URLs off the shared webhook", async () => {
    const edit = mock(async () => ({}) as Webhook);
    const webhook = makeWebhook(edit as Webhook["edit"]);

    await runWithWebhookIdentity(
      webhook,
      { username: "Sparrow", avatarUrl: "https://example.invalid/avatar.png" },
      async () => undefined,
    );

    expect(edit).not.toHaveBeenCalled();
  });
});
