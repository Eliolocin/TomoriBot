import type { PersonaUserBlockRow, PersonaUserBlockType } from "@/types/db/schema";
import { personaUserBlockSchema } from "@/types/db/schema";
import { DatabaseUnavailableError } from "@/types/errors";
import { sql, withTransientDbRetry } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";

export type PersonaUserBlockWithPersona = PersonaUserBlockRow & {
  persona_name: string;
};

export type PersonaUserBlockKey = {
  personaId: number;
  userDiscId: string;
};

function parsePersonaUserBlockRows(rows: unknown[]): PersonaUserBlockRow[] {
  const parsedRows: PersonaUserBlockRow[] = [];
  for (const row of rows) {
    const parsed = personaUserBlockSchema.safeParse(row);
    if (!parsed.success) {
      log.warn("Skipping invalid persona_user_blocks row", parsed.error.flatten());
      continue;
    }
    parsedRows.push(parsed.data);
  }
  return parsedRows;
}

class PersonaUserBlockRepository {
  async loadActiveBlocksForPersona(serverId: number, personaId: number): Promise<PersonaUserBlockRow[]> {
    try {
      const rows = await sql`
        SELECT server_id, persona_id, user_disc_id, block_type, reason, expires_at, created_at, updated_at
        FROM persona_user_blocks
        WHERE server_id = ${serverId}
          AND persona_id = ${personaId}
          AND expires_at > NOW()
        ORDER BY expires_at ASC
      `;
      return parsePersonaUserBlockRows(rows as unknown[]);
    } catch (error) {
      log.error(`Error loading persona user blocks for persona ${personaId}:`, error);
      return [];
    }
  }

  async loadActiveBlocksForUser(serverId: number, userDiscId: string): Promise<PersonaUserBlockRow[]> {
    try {
      const rows = await withTransientDbRetry(
        async () =>
          await sql`
          SELECT server_id, persona_id, user_disc_id, block_type, reason, expires_at, created_at, updated_at
          FROM persona_user_blocks
          WHERE server_id = ${serverId}
            AND user_disc_id = ${userDiscId}
            AND expires_at > NOW()
          ORDER BY expires_at ASC
        `,
        "load active persona user blocks",
      );
      return parsePersonaUserBlockRows(rows as unknown[]);
    } catch (error) {
      // An empty list is indistinguishable from "no blocks apply", so returning it here lifted
      // every persona-level block for the duration of a pool cascade. Fail closed instead.
      log.error(`Error loading persona user blocks for user ${userDiscId} in server ${serverId}:`, error);
      throw new DatabaseUnavailableError(`Failed to read persona blocks for user ${userDiscId}`);
    }
  }

  async loadActiveBlocksForServer(serverId: number): Promise<PersonaUserBlockWithPersona[]> {
    try {
      const rows = await sql`
        SELECT
          pub.server_id,
          pub.persona_id,
          pub.user_disc_id,
          pub.block_type,
          pub.reason,
          pub.expires_at,
          pub.created_at,
          pub.updated_at,
          p.persona_nickname AS persona_name
        FROM persona_user_blocks pub
        JOIN personas p ON p.persona_id = pub.persona_id
        WHERE pub.server_id = ${serverId}
          AND pub.expires_at > NOW()
        ORDER BY p.persona_nickname ASC, pub.user_disc_id ASC
      `;

      const parsedRows: PersonaUserBlockWithPersona[] = [];
      for (const row of rows as unknown[]) {
        const candidate = row as Record<string, unknown>;
        const parsed = personaUserBlockSchema.safeParse(candidate);
        if (!parsed.success) {
          log.warn("Skipping invalid persona_user_blocks server row", parsed.error.flatten());
          continue;
        }
        parsedRows.push({
          ...parsed.data,
          persona_name: typeof candidate.persona_name === "string" ? candidate.persona_name : "Unknown Persona",
        });
      }
      return parsedRows;
    } catch (error) {
      log.error(`Error loading persona user blocks for server ${serverId}:`, error);
      return [];
    }
  }

  async upsertBlock(params: {
    serverId: number;
    personaId: number;
    userDiscId: string;
    blockType: PersonaUserBlockType;
    reason: string;
    expiresAt: Date;
  }): Promise<PersonaUserBlockRow | null> {
    try {
      const [row] = await sql`
        INSERT INTO persona_user_blocks (
          server_id,
          persona_id,
          user_disc_id,
          block_type,
          reason,
          expires_at
        ) VALUES (
          ${params.serverId},
          ${params.personaId},
          ${params.userDiscId},
          ${params.blockType},
          ${params.reason},
          ${params.expiresAt}
        )
        ON CONFLICT (server_id, persona_id, user_disc_id) DO UPDATE SET
          block_type = EXCLUDED.block_type,
          reason = EXCLUDED.reason,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
        RETURNING server_id, persona_id, user_disc_id, block_type, reason, expires_at, created_at, updated_at
      `;

      const parsed = personaUserBlockSchema.safeParse(row);
      if (!parsed.success) {
        log.error("Failed to validate upserted persona user block:", parsed.error.flatten());
        return null;
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error upserting persona user block for user ${params.userDiscId}:`, error);
      return null;
    }
  }

  async removeActiveBlock(
    serverId: number,
    personaId: number,
    userDiscId: string,
  ): Promise<PersonaUserBlockRow | null> {
    try {
      const [row] = await sql`
        DELETE FROM persona_user_blocks
        WHERE server_id = ${serverId}
          AND persona_id = ${personaId}
          AND user_disc_id = ${userDiscId}
          AND expires_at > NOW()
        RETURNING server_id, persona_id, user_disc_id, block_type, reason, expires_at, created_at, updated_at
      `;

      if (!row) return null;
      const parsed = personaUserBlockSchema.safeParse(row);
      if (!parsed.success) {
        log.error("Failed to validate removed persona user block:", parsed.error.flatten());
        return null;
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error removing persona user block for user ${userDiscId}:`, error);
      return null;
    }
  }

  async removeBlocksByKeys(serverId: number, keys: PersonaUserBlockKey[]): Promise<PersonaUserBlockRow[]> {
    const removedRows: PersonaUserBlockRow[] = [];

    for (const key of keys) {
      const removed = await this.removeActiveBlock(serverId, key.personaId, key.userDiscId);
      if (removed) {
        removedRows.push(removed);
      }
    }

    return removedRows;
  }
}

export const personaUserBlockRepository = new PersonaUserBlockRepository();
