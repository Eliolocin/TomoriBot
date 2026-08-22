/**
 * WhitelistRepository: manages channel, persona-channel, and role whitelist tables.
 *
 * Consolidates channelWhitelist.ts, personaWhitelist.ts, and roleWhitelist.ts.
 * Also provides the pure functional helpers isPersonaAllowedByWhitelistStatus and
 * filterPersonasByWhitelist which have callers outside the repository layer.
 */
import { sql } from "@/utils/db/client";
import type {
  ChannelPersonaWhitelistRow,
  ChannelWhitelistRow,
  CooldownType,
  RoleWhitelistRow,
} from "@/types/db/schema";
import type { WhitelistCheckResult } from "@/types/misc/channelWhitelist";
import { log } from "@/utils/misc/logger";

type PersonaWhitelistStatus = Pick<
  WhitelistCheckResult,
  "hasActivePersonaWhitelist" | "restrictedPersonaIds" | "whitelistedPersonaIds"
>;

export type WhitelistChannelsReadResult =
  | { status: "fresh"; channels: ChannelWhitelistRow[] }
  | { status: "unavailable"; channels: [] };

export type WhitelistPersonasReadResult =
  | { status: "fresh"; personas: ChannelPersonaWhitelistRow[] }
  | { status: "unavailable"; personas: [] };

export type WhitelistRolesReadResult =
  | { status: "fresh"; roles: RoleWhitelistRow[] }
  | { status: "unavailable"; roles: [] };

class WhitelistRepository {
  private normalizeTomoriIds(rows: Array<{ persona_id: number | string | bigint }>): number[] {
    return rows
      .map((row) => {
        if (typeof row.persona_id === "bigint") return Number(row.persona_id);
        if (typeof row.persona_id === "string") return Number.parseInt(row.persona_id, 10);
        return row.persona_id;
      })
      .filter((personaId): personaId is number => Number.isInteger(personaId) && personaId > 0);
  }

  /**
   * Check whitelist status (channel + role + persona metadata) and get channel cooldown settings.
   *
   * @param memberRoleDiscIds  - Optional role IDs for the triggering member
   * @param parentChannelDiscId - Optional parent channel for thread inheritance
   * @returns WhitelistCheckResult with status and settings
   */
  async checkChannelWhitelist(
    serverDiscId: string,
    channelDiscId: string,
    memberRoleDiscIds?: string[],
    parentChannelDiscId?: string,
  ): Promise<WhitelistCheckResult> {
    const fallbackResult: WhitelistCheckResult = {
      hasActiveWhitelist: false,
      hasActiveChannelWhitelist: false,
      isChannelWhitelisted: false,
      hasActiveRoleWhitelist: false,
      isRoleWhitelisted: false,
      hasActivePersonaWhitelist: false,
      isTriggerAllowed: true,
      hasChannelCooldownOverride: false,
    };

    try {
      // Resolve server DB ID
      const [serverRow] = await sql`SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId}`;
      if (!serverRow) return fallbackResult;

      const serverId = serverRow.server_id as number;

      const [countRow] = await sql`SELECT COUNT(*) as count FROM channel_whitelist WHERE server_id = ${serverId}`;
      const hasActiveChannelWhitelist = Number.parseInt(countRow?.count as string, 10) > 0;

      // Check if the specific channel is whitelisted (thread falls back to parent)
      const [channelRow] = hasActiveChannelWhitelist
        ? await sql<Array<{ cooldown_type: CooldownType | null; cooldown_length: number | null }>>`
            SELECT cooldown_type, cooldown_length
            FROM channel_whitelist
            WHERE server_id = ${serverId} AND channel_disc_id = ${channelDiscId}
          `
        : [null];

      let [parentChannelRow] = [null as { cooldown_type: CooldownType | null; cooldown_length: number | null } | null];
      if (!channelRow && parentChannelDiscId && hasActiveChannelWhitelist) {
        [parentChannelRow] = await sql<Array<{ cooldown_type: CooldownType | null; cooldown_length: number | null }>>`
          SELECT cooldown_type, cooldown_length
          FROM channel_whitelist
          WHERE server_id = ${serverId} AND channel_disc_id = ${parentChannelDiscId}
        `;
      }

      const isChannelWhitelisted = Boolean(channelRow || parentChannelRow);
      const effectiveChannelRow = channelRow || parentChannelRow;
      const hasChannelCooldownOverride =
        isChannelWhitelisted &&
        effectiveChannelRow?.cooldown_type !== null &&
        effectiveChannelRow?.cooldown_length !== null;

      if (
        isChannelWhitelisted &&
        !hasChannelCooldownOverride &&
        !(effectiveChannelRow?.cooldown_type === null && effectiveChannelRow?.cooldown_length === null)
      ) {
        log.warn("Channel whitelist row has partial cooldown override; falling back to global cooldown", {
          metadata: {
            serverDiscId,
            channelDiscId,
            parentChannelDiscId,
            cooldownType: effectiveChannelRow?.cooldown_type ?? null,
            cooldownLength: effectiveChannelRow?.cooldown_length ?? null,
          },
        });
      }

      const [roleRows, restrictedPersonaRows] = await Promise.all([
        sql<Array<{ role_disc_id: string }>>`
          SELECT role_disc_id FROM role_whitelist WHERE server_id = ${serverId}
        `,
        sql<Array<{ persona_id: number | string | bigint }>>`
          SELECT DISTINCT persona_id
          FROM channel_persona_whitelist
          WHERE server_id = ${serverId}
          ORDER BY persona_id ASC
        `,
      ]);
      const hasActiveRoleWhitelist = roleRows.length > 0;

      // Role whitelist check (fail-open when role data is unavailable)
      let isRoleWhitelisted = false;
      if (hasActiveRoleWhitelist) {
        if (memberRoleDiscIds === undefined) {
          isRoleWhitelisted = true;
        } else if (memberRoleDiscIds.length > 0) {
          const memberRoles = new Set(memberRoleDiscIds);
          isRoleWhitelisted = roleRows.some((row) => memberRoles.has(row.role_disc_id));
        }
      }

      // Persona-channel whitelist (threads inherit from parent)
      const restrictedPersonaIds = this.normalizeTomoriIds(restrictedPersonaRows);
      const hasActivePersonaWhitelist = restrictedPersonaIds.length > 0;

      let allowedRestrictedPersonaRows = await sql<Array<{ persona_id: number | string | bigint }>>`
        SELECT persona_id
        FROM channel_persona_whitelist
        WHERE server_id = ${serverId} AND channel_disc_id = ${channelDiscId}
        ORDER BY created_at ASC, persona_id ASC
      `;

      if (parentChannelDiscId) {
        const parentRows = await sql<Array<{ persona_id: number | string | bigint }>>`
          SELECT persona_id
          FROM channel_persona_whitelist
          WHERE server_id = ${serverId} AND channel_disc_id = ${parentChannelDiscId}
          ORDER BY created_at ASC, persona_id ASC
        `;
        allowedRestrictedPersonaRows = [...allowedRestrictedPersonaRows, ...parentRows];
      }

      const whitelistedPersonaIds = [...new Set(this.normalizeTomoriIds(allowedRestrictedPersonaRows))];

      const isChannelAllowed = !hasActiveChannelWhitelist || isChannelWhitelisted;
      const isRoleAllowed = !hasActiveRoleWhitelist || isRoleWhitelisted;
      const isTriggerAllowed = isChannelAllowed && isRoleAllowed;
      const hasActiveWhitelist = hasActiveChannelWhitelist || hasActiveRoleWhitelist || hasActivePersonaWhitelist;

      let blockReason: WhitelistCheckResult["blockReason"];
      if (!isTriggerAllowed) {
        const blockedByChannel = hasActiveChannelWhitelist && !isChannelWhitelisted;
        const blockedByRole = hasActiveRoleWhitelist && !isRoleWhitelisted;
        blockReason = blockedByChannel && blockedByRole ? "channel_and_role" : blockedByRole ? "role" : "channel";
      }

      return {
        hasActiveWhitelist,
        hasActiveChannelWhitelist,
        isChannelWhitelisted,
        hasActiveRoleWhitelist,
        isRoleWhitelisted,
        hasActivePersonaWhitelist,
        restrictedPersonaIds: hasActivePersonaWhitelist ? restrictedPersonaIds : undefined,
        whitelistedPersonaIds: hasActivePersonaWhitelist ? whitelistedPersonaIds : undefined,
        isTriggerAllowed,
        blockReason,
        hasChannelCooldownOverride,
        channelCooldownType: hasChannelCooldownOverride
          ? (effectiveChannelRow?.cooldown_type as CooldownType)
          : undefined,
        channelCooldownLength: hasChannelCooldownOverride
          ? (effectiveChannelRow?.cooldown_length as number)
          : undefined,
      };
    } catch (error) {
      log.warn("Failed to check channel whitelist, failing open", {
        errorType: "ChannelWhitelistCheckError",
        metadata: { serverDiscId, channelDiscId, memberRoleDiscIds, error },
      });
      return fallbackResult;
    }
  }

  /**
   * Add or update a channel in the whitelist with optional cooldown override settings.
   *
   * @param cooldownType  - Cooldown type override, or null to inherit global
   * @param cooldownLength - Cooldown length override in seconds, or null to inherit global
   */
  async upsertChannelWhitelist(
    serverId: number,
    channelDiscId: string,
    cooldownType: CooldownType | null,
    cooldownLength: number | null,
  ): Promise<ChannelWhitelistRow> {
    const [result] = await sql`
      INSERT INTO channel_whitelist (server_id, channel_disc_id, cooldown_type, cooldown_length)
      VALUES (${serverId}, ${channelDiscId}, ${cooldownType}, ${cooldownLength})
      ON CONFLICT (server_id, channel_disc_id)
      DO UPDATE SET
        cooldown_type = EXCLUDED.cooldown_type,
        cooldown_length = EXCLUDED.cooldown_length,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    if (!result) throw new Error("Failed to upsert channel whitelist");
    return result as ChannelWhitelistRow;
  }

  /**
   * Returns one channel whitelist row for exact settings comparisons.
   *
   */
  async getChannelWhitelist(serverId: number, channelDiscId: string): Promise<ChannelWhitelistRow | null> {
    const [result] = await sql`
      SELECT *
      FROM channel_whitelist
      WHERE server_id = ${serverId}
        AND channel_disc_id = ${channelDiscId}
      LIMIT 1
    `;

    return (result as ChannelWhitelistRow | undefined) ?? null;
  }

  /**
   *
   * @returns True if a row was deleted, false if not found
   */
  async removeChannelWhitelist(serverId: number, channelDiscId: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM channel_whitelist WHERE server_id = ${serverId} AND channel_disc_id = ${channelDiscId}
    `;
    return result.count > 0;
  }

  /**
   * Get all whitelisted channels for a server, ordered by creation time.
   */
  async getAllWhitelistChannels(serverId: number): Promise<ChannelWhitelistRow[]> {
    const result = await sql`
      SELECT * FROM channel_whitelist WHERE server_id = ${serverId} ORDER BY created_at ASC
    `;
    return result as ChannelWhitelistRow[];
  }

  /**
   * Get all whitelisted channels for a server with read status provenance.
   */
  async getAllWhitelistChannelsResult(serverId: number): Promise<WhitelistChannelsReadResult> {
    try {
      const channels = await this.getAllWhitelistChannels(serverId);
      return { status: "fresh", channels };
    } catch (error) {
      log.error(`Error loading whitelist channels for server ${serverId}:`, error);
      return { status: "unavailable", channels: [] };
    }
  }

  /**
   * Passing an empty array clears the persona-specific channel restriction.
   *
   * @param channelDiscIds - Discord channel snowflakes to allow for this persona
   */
  async replacePersonaWhitelistChannels(serverId: number, personaId: number, channelDiscIds: string[]): Promise<void> {
    const uniqueChannelDiscIds = [...new Set(channelDiscIds)];

    await sql.transaction(async (tx) => {
      await tx`
        DELETE FROM channel_persona_whitelist WHERE server_id = ${serverId} AND persona_id = ${personaId}
      `;

      for (const channelDiscId of uniqueChannelDiscIds) {
        await tx`
          INSERT INTO channel_persona_whitelist (server_id, channel_disc_id, persona_id)
          VALUES (${serverId}, ${channelDiscId}, ${personaId})
        `;
      }
    });
  }

  /**
   *
   * @returns True if an entry was deleted, false if not found
   */
  async removeChannelPersonaWhitelist(serverId: number, channelDiscId: string, personaId: number): Promise<boolean> {
    const result = await sql`
      DELETE FROM channel_persona_whitelist
      WHERE server_id = ${serverId} AND channel_disc_id = ${channelDiscId} AND persona_id = ${personaId}
    `;
    return result.count > 0;
  }

  /**
   *
   * @returns Array of ChannelPersonaWhitelistRow ordered by channel then creation time
   */
  async getPersonaWhitelistChannels(serverId: number, personaId: number): Promise<ChannelPersonaWhitelistRow[]> {
    const result = await sql`
      SELECT *
      FROM channel_persona_whitelist
      WHERE server_id = ${serverId} AND persona_id = ${personaId}
      ORDER BY channel_disc_id ASC, created_at ASC
    `;
    return result as ChannelPersonaWhitelistRow[];
  }

  /**
   * Get all persona whitelist entries for a server.
   *
   * @returns Array of ChannelPersonaWhitelistRow ordered by persona then channel
   */
  async getAllWhitelistPersonas(serverId: number): Promise<ChannelPersonaWhitelistRow[]> {
    const result = await sql`
      SELECT *
      FROM channel_persona_whitelist
      WHERE server_id = ${serverId}
      ORDER BY persona_id ASC, channel_disc_id ASC, created_at ASC
    `;
    return result as ChannelPersonaWhitelistRow[];
  }

  /**
   * Get all persona whitelist entries for a server with read status provenance.
   */
  async getAllWhitelistPersonasResult(serverId: number): Promise<WhitelistPersonasReadResult> {
    try {
      const personas = await this.getAllWhitelistPersonas(serverId);
      return { status: "fresh", personas };
    } catch (error) {
      log.error(`Error loading whitelist personas for server ${serverId}:`, error);
      return { status: "unavailable", personas: [] };
    }
  }

  /**
   * Check whether a persona is allowed by the effective persona-channel whitelist.
   * Restricted personas are allowed only in their configured channels; unrestricted personas are always allowed.
   *
   * @returns True if this persona may respond in the current channel
   */
  isPersonaAllowedByWhitelistStatus(
    whitelistStatus: PersonaWhitelistStatus | null | undefined,
    personaId: number | null | undefined,
  ): boolean {
    if (!whitelistStatus?.hasActivePersonaWhitelist) return true;
    if (!Number.isInteger(personaId) || !personaId) return false;
    if (!(whitelistStatus.restrictedPersonaIds?.includes(personaId) ?? false)) return true;
    return whitelistStatus.whitelistedPersonaIds?.includes(personaId) ?? false;
  }

  /**
   * Filter a persona list down to only entries allowed by the effective persona-channel whitelist.
   * Returns the original list unchanged when no persona whitelist is active.
   *
   * @returns Filtered array of allowed personas
   */
  filterPersonasByWhitelist<T extends { persona_id?: number | null | undefined }>(
    personas: readonly T[],
    whitelistStatus: PersonaWhitelistStatus | null | undefined,
  ): T[] {
    if (!whitelistStatus?.hasActivePersonaWhitelist) return [...personas];
    return personas.filter((persona) => this.isPersonaAllowedByWhitelistStatus(whitelistStatus, persona.persona_id));
  }

  /**
   * Add a role to the whitelist for a server.
   *
   */
  async upsertRoleWhitelist(serverId: number, roleDiscId: string): Promise<RoleWhitelistRow> {
    const [result] = await sql`
      INSERT INTO role_whitelist (server_id, role_disc_id)
      VALUES (${serverId}, ${roleDiscId})
      ON CONFLICT (server_id, role_disc_id)
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    if (!result) throw new Error("Failed to upsert role whitelist");
    return result as RoleWhitelistRow;
  }

  /**
   *
   * @returns True if a row was deleted, false if not found
   */
  async removeRoleWhitelist(serverId: number, roleDiscId: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM role_whitelist WHERE server_id = ${serverId} AND role_disc_id = ${roleDiscId}
    `;
    return result.count > 0;
  }

  /**
   * Get all whitelisted roles for a server.
   *
   * @returns Array of RoleWhitelistRow ordered by creation time
   */
  async getAllWhitelistRoles(serverId: number): Promise<RoleWhitelistRow[]> {
    const result = await sql`
      SELECT * FROM role_whitelist WHERE server_id = ${serverId} ORDER BY created_at ASC
    `;
    return result as RoleWhitelistRow[];
  }

  /**
   * Get all whitelisted roles for a server with read status provenance.
   */
  async getAllWhitelistRolesResult(serverId: number): Promise<WhitelistRolesReadResult> {
    try {
      const roles = await this.getAllWhitelistRoles(serverId);
      return { status: "fresh", roles };
    } catch (error) {
      log.error(`Error loading whitelist roles for server ${serverId}:`, error);
      return { status: "unavailable", roles: [] };
    }
  }

  /**
   * Check whether a specific role is currently whitelisted.
   *
   * @returns True if the role is whitelisted
   */
  async isRoleWhitelisted(serverId: number, roleDiscId: string): Promise<boolean> {
    const [row] = await sql`
      SELECT 1 FROM role_whitelist WHERE server_id = ${serverId} AND role_disc_id = ${roleDiscId} LIMIT 1
    `;
    return Boolean(row);
  }
}

/** Singleton instance: import this in callers. */
export const whitelistRepository = new WhitelistRepository();
