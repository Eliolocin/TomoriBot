import { describe, expect, it } from "bun:test";
import { AttachmentBuilder, type ChatInputCommandInteraction, type InteractionEditReplyOptions } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import {
  resolveAlterPersonaAvatarAsset,
  resolvePersonaPanelAvatar,
  withPersonaPanelAvatar,
} from "@/utils/discord/personaPanelAvatar";

const localDependencies = {
  resolvePublicAvatarUrl: () => null,
  isLocalAvatarPath: () => true,
  loadStoredAvatarBuffer: async () => Buffer.from("avatar"),
};

function makeAlter(): TomoriState {
  return {
    persona_id: 42,
    persona_lineage_id: 420,
    persona_nickname: "Sparrow",
    is_alter: true,
    webhook_avatar_url: "data/avatars/servers/test/personas/42/avatar.png",
  } as unknown as TomoriState;
}

describe("persona panel avatars", () => {
  it("resolves a local alter avatar as a reusable buffer asset", async () => {
    const asset = await resolveAlterPersonaAvatarAsset(makeAlter(), localDependencies);

    expect(asset?.type).toBe("buffer");
    if (asset?.type === "buffer") {
      expect(asset.buffer.toString()).toBe("avatar");
    }
  });

  it("attaches a local alter avatar and returns its attachment URL", async () => {
    const avatar = await resolvePersonaPanelAvatar({} as ChatInputCommandInteraction, makeAlter(), localDependencies);

    expect(avatar.url).toBe("attachment://persona_avatar_42.png");
    expect(avatar.files).toHaveLength(1);
    expect(avatar.files[0]?.name).toBe("persona_avatar_42.png");
  });

  it("clears old attachments and includes the selected avatar file", () => {
    const payload: InteractionEditReplyOptions = { content: "panel" };
    const avatarFile = new AttachmentBuilder(Buffer.from("avatar"), { name: "persona_avatar_42.png" });
    const result = withPersonaPanelAvatar(payload, {
      url: "attachment://persona_avatar_42.png",
      files: [avatarFile],
    });

    expect(result.attachments).toEqual([]);
    expect(result.files).toEqual([avatarFile]);
  });
});
