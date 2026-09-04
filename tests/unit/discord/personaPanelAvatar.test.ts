import { describe, expect, it } from "bun:test";
import { AttachmentBuilder, type ChatInputCommandInteraction, type InteractionEditReplyOptions } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import {
  resolveAlterPersonaAvatarAsset,
  resolvePersonaPanelAvatar,
  resolvePersonaPanelAvatarReference,
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

  it("attaches a local sprite reference with its caller-provided name", async () => {
    const avatar = await resolvePersonaPanelAvatarReference(
      "data/avatars/servers/test/personas/42/sprites/happy.png",
      "persona_sprite_42_7.png",
      localDependencies,
    );

    expect(avatar.url).toBe("attachment://persona_sprite_42_7.png");
    expect(avatar.files[0]?.name).toBe("persona_sprite_42_7.png");
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

  it("includes persona and sprite files in the same repaint", () => {
    const personaFile = new AttachmentBuilder(Buffer.from("persona"), { name: "persona.png" });
    const spriteFile = new AttachmentBuilder(Buffer.from("sprite"), { name: "sprite.png" });
    const result = withPersonaPanelAvatar({ content: "panel" }, [
      { url: "attachment://persona.png", files: [personaFile] },
      { url: "attachment://sprite.png", files: [spriteFile] },
    ]);

    expect(result.files).toEqual([personaFile, spriteFile]);
  });
});
