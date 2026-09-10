import type { PermissionResolvable } from "discord.js";

/**
 * One workspace authorization rule for the whole transfer surface.
 *
 * The command leaves and the routed continuations must agree, because a drift between them is invisible: one side
 * would authorize what the other refuses, and only the permissive half reaches a user. The rule reads `guildId`
 * rather than `guild`, and the workspace key does too: `guild` is a client-cache lookup that returns null for an
 * uncached guild, so a guard reading `guild` would fall through to its DM branch while the key still named the real
 * guild's workspace. `memberPermissions` is payload-derived, so it stays available exactly when `guildId` does.
 */
export interface TransferWorkspaceSubject {
  guildId: string | null;
  memberPermissions: { has(permission: PermissionResolvable): boolean } | null;
}

export interface TransferActorSubject extends TransferWorkspaceSubject {
  user: { id: string };
}

/** A DM has no guild to protect and its workspace key is the invoking account, so reaching it is the proof. */
export function isWorkspaceTransferAuthorized(interaction: TransferWorkspaceSubject): boolean {
  if (!interaction.guildId) return true;
  return interaction.memberPermissions?.has("ManageGuild") ?? false;
}

/**
 * The workspace every transfer operation is keyed on. This is the pairing that matters: the guard and the key must
 * read the same property, or an uncached guild authorizes one workspace and addresses another.
 */
export function resolveWorkspaceTransferKey(interaction: TransferActorSubject): string {
  return interaction.guildId ?? interaction.user.id;
}
