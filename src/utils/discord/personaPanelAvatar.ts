import { AttachmentBuilder, type ChatInputCommandInteraction, type InteractionEditReplyOptions } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  isLocalPersonaAvatarPath,
  loadStoredPersonaAvatarBuffer,
  resolvePersonaAvatarPublicUrl,
} from "@/utils/storage/avatarStorage";

export interface PersonaPanelAvatarData {
  url: string | null;
  files: AttachmentBuilder[];
}

export type PersonaAvatarAsset = { type: "url"; url: string } | { type: "buffer"; buffer: Buffer };

export interface PersonaPanelAvatarDependencies {
  resolvePublicAvatarUrl(reference?: string | null): string | null;
  isLocalAvatarPath(reference?: string | null): boolean;
  loadStoredAvatarBuffer(reference: string): Promise<Buffer | null>;
}

const defaultDependencies: PersonaPanelAvatarDependencies = {
  resolvePublicAvatarUrl: resolvePersonaAvatarPublicUrl,
  isLocalAvatarPath: isLocalPersonaAvatarPath,
  loadStoredAvatarBuffer: loadStoredPersonaAvatarBuffer,
};

/** Resolves a stored alter avatar into the transport Discord can consume. */
export async function resolveAlterPersonaAvatarAsset(
  persona: TomoriState,
  dependencies: PersonaPanelAvatarDependencies = defaultDependencies,
): Promise<PersonaAvatarAsset | null> {
  const publicUrl = dependencies.resolvePublicAvatarUrl(persona.webhook_avatar_url);
  if (publicUrl) {
    return { type: "url", url: publicUrl };
  }

  const avatarReference = persona.webhook_avatar_url;
  if (!avatarReference || !dependencies.isLocalAvatarPath(avatarReference)) {
    return null;
  }

  const buffer = await dependencies.loadStoredAvatarBuffer(avatarReference);
  return buffer ? { type: "buffer", buffer } : null;
}

/**
 * Resolves one selected persona's thumbnail for a Components V2 panel.
 *
 * Public URLs are used directly. A self-hosted local avatar is attached to the ephemeral message
 * and addressed through `attachment://`, matching the established paginated persona picker. Main
 * personas prefer the bot's guild-specific avatar because they speak through the bot account.
 */
export async function resolvePersonaPanelAvatar(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  persona: TomoriState,
  dependencies: PersonaPanelAvatarDependencies = defaultDependencies,
): Promise<PersonaPanelAvatarData> {
  if (!persona.is_alter) {
    const avatarOptions = { size: 256, extension: "png", forceStatic: true } as const;
    return {
      url:
        interaction.guild?.members.me?.displayAvatarURL(avatarOptions) ??
        interaction.client.user?.displayAvatarURL(avatarOptions) ??
        resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url),
      files: [],
    };
  }

  const asset = await resolveAlterPersonaAvatarAsset(persona, dependencies);
  if (!asset) {
    return { url: null, files: [] };
  }

  if (asset.type === "url") {
    return { url: asset.url, files: [] };
  }

  const attachmentName = `persona_avatar_${persona.persona_id ?? "selected"}.png`;
  return {
    url: `attachment://${attachmentName}`,
    files: [new AttachmentBuilder(asset.buffer, { name: attachmentName })],
  };
}

/**
 * Replaces attachments on every repaint so a previously selected local avatar cannot remain on a
 * page that no longer references it.
 */
export function withPersonaPanelAvatar<T extends InteractionEditReplyOptions>(
  payload: T,
  avatar?: PersonaPanelAvatarData,
): T & Pick<InteractionEditReplyOptions, "attachments" | "files"> {
  return {
    ...payload,
    attachments: [],
    files: avatar?.files ?? [],
  };
}
