import type { SQL } from "bun";
import {
  EMPTY_PERSONA_NAMING_CONFIG,
  type PersonaNamingConfig,
  personaNamingConfigRowSchema,
  type UserPersonaNamingPreference,
  userPersonaNamingPreferenceSchema,
} from "@/types/personaNaming";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";

export interface UserPersonaNamingPair {
  userId: number;
  personaLineageId: number;
}

type UserPersonaNamingPreferencePatch = Partial<
  Pick<UserPersonaNamingPreference, "nickname_override" | "prefix_override" | "suffix_override">
>;

export interface UserInfoWriteBatch {
  global: Partial<{
    user_nickname: string | null;
    prefix_override: string | null;
    suffix_override: string | null;
    gender_identity: string | null;
    pronouns: string | null;
    orientation: string | null;
    addressing_style: "masculine" | "feminine" | "neutral" | null;
    timezone_offset: number | null;
  }>;
  persona?: {
    personaLineageId: number;
    patch: UserPersonaNamingPreferencePatch;
  };
}

export function userPersonaNamingPairKey(userId: number, personaLineageId: number): string {
  return `${userId}:${personaLineageId}`;
}

class UserNamingRepository {
  async applyUserInfoBatch(userId: number, batch: UserInfoWriteBatch): Promise<void> {
    await sql.begin(async (tx) => {
      const globalEntries = Object.entries(batch.global);
      if (globalEntries.length > 0) {
        const has = (field: keyof UserInfoWriteBatch["global"]): boolean => Object.hasOwn(batch.global, field);
        const updated = await tx`
          UPDATE user_personalization_configs
          SET
            user_nickname = CASE WHEN ${has("user_nickname")} THEN ${batch.global.user_nickname ?? null} ELSE user_nickname END,
            prefix_override = CASE WHEN ${has("prefix_override")} THEN ${batch.global.prefix_override ?? null} ELSE prefix_override END,
            suffix_override = CASE WHEN ${has("suffix_override")} THEN ${batch.global.suffix_override ?? null} ELSE suffix_override END,
            gender_identity = CASE WHEN ${has("gender_identity")} THEN ${batch.global.gender_identity ?? null} ELSE gender_identity END,
            pronouns = CASE WHEN ${has("pronouns")} THEN ${batch.global.pronouns ?? null} ELSE pronouns END,
            orientation = CASE WHEN ${has("orientation")} THEN ${batch.global.orientation ?? null} ELSE orientation END,
            addressing_style = CASE WHEN ${has("addressing_style")} THEN ${batch.global.addressing_style ?? null} ELSE addressing_style END,
            timezone_offset = CASE WHEN ${has("timezone_offset")} THEN ${batch.global.timezone_offset ?? null} ELSE timezone_offset END,
            updated_at = NOW()
          WHERE user_id = ${userId}
          RETURNING user_id
        `;
        if (updated.length === 0) throw new Error("Registered user is missing personalization settings");
      }

      if (batch.persona) {
        await this.savePreferenceInTransaction(tx, userId, batch.persona.personaLineageId, batch.persona.patch);
      }
    });
  }

  async loadPreferences(pairs: UserPersonaNamingPair[]): Promise<Map<string, UserPersonaNamingPreference>> {
    const uniquePairs = Array.from(
      new Map(pairs.map((pair) => [userPersonaNamingPairKey(pair.userId, pair.personaLineageId), pair])).values(),
    );
    if (uniquePairs.length === 0) return new Map();

    const userIds = uniquePairs.map((pair) => pair.userId);
    const lineageIds = uniquePairs.map((pair) => pair.personaLineageId);
    const rows = await sql`
      WITH requested_pairs (user_id, persona_lineage_id) AS (
        SELECT *
        FROM unnest(${sql.array(userIds, "int4")}, ${sql.array(lineageIds, "int8")})
      )
      SELECT
        upnp.user_id,
        upnp.persona_lineage_id,
        upnp.nickname_override,
        upnp.prefix_override,
        upnp.suffix_override,
        upnp.created_at,
        upnp.updated_at
      FROM user_persona_naming_preferences upnp
      JOIN requested_pairs requested
        ON requested.user_id = upnp.user_id
        AND requested.persona_lineage_id = upnp.persona_lineage_id
    `;

    const preferences = new Map<string, UserPersonaNamingPreference>();
    for (const row of rows) {
      const parsed = userPersonaNamingPreferenceSchema.safeParse(row);
      if (!parsed.success) {
        log.error("Failed to validate a user persona naming preference", parsed.error.flatten());
        continue;
      }
      preferences.set(userPersonaNamingPairKey(parsed.data.user_id, parsed.data.persona_lineage_id), parsed.data);
    }
    return preferences;
  }

  async savePreference(
    userId: number,
    personaLineageId: number,
    patch: UserPersonaNamingPreferencePatch,
  ): Promise<UserPersonaNamingPreference | null> {
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(personaLineageId) || personaLineageId < 0) {
      return null;
    }

    try {
      return await sql.begin((tx) => this.savePreferenceInTransaction(tx, userId, personaLineageId, patch));
    } catch (error) {
      log.error("Failed to save a user persona naming preference", error);
      return null;
    }
  }

  private async savePreferenceInTransaction(
    client: SQL,
    userId: number,
    personaLineageId: number,
    patch: UserPersonaNamingPreferencePatch,
  ): Promise<UserPersonaNamingPreference | null> {
    const [existing] = await client`
          SELECT nickname_override, prefix_override, suffix_override
          FROM user_persona_naming_preferences
          WHERE user_id = ${userId}
            AND persona_lineage_id = ${personaLineageId}
          FOR UPDATE
        `;
    const next = {
      nickname_override:
        patch.nickname_override !== undefined ? patch.nickname_override : (existing?.nickname_override ?? null),
      prefix_override:
        patch.prefix_override !== undefined ? patch.prefix_override : (existing?.prefix_override ?? null),
      suffix_override:
        patch.suffix_override !== undefined ? patch.suffix_override : (existing?.suffix_override ?? null),
    };

    if (next.nickname_override === null && next.prefix_override === null && next.suffix_override === null) {
      await client`
            DELETE FROM user_persona_naming_preferences
            WHERE user_id = ${userId}
              AND persona_lineage_id = ${personaLineageId}
          `;
      return null;
    }

    const [saved] = await client`
          INSERT INTO user_persona_naming_preferences (
            user_id, persona_lineage_id, nickname_override, prefix_override, suffix_override
          ) VALUES (
            ${userId}, ${personaLineageId}, ${next.nickname_override}, ${next.prefix_override}, ${next.suffix_override}
          )
          ON CONFLICT (user_id, persona_lineage_id) DO UPDATE SET
            nickname_override = EXCLUDED.nickname_override,
            prefix_override = EXCLUDED.prefix_override,
            suffix_override = EXCLUDED.suffix_override,
            updated_at = NOW()
          RETURNING *
        `;
    return userPersonaNamingPreferenceSchema.parse(saved);
  }

  async loadPersonaConfigs(personaIds: number[]): Promise<Map<number, PersonaNamingConfig>> {
    const uniquePersonaIds = Array.from(new Set(personaIds));
    if (uniquePersonaIds.length === 0) return new Map();

    const rows = await sql`
      SELECT persona_id, prefixes, suffixes, address_terms, created_at, updated_at
      FROM persona_naming_configs
      WHERE persona_id = ANY(${sql.array(uniquePersonaIds, "int4")})
    `;
    const configs = new Map<number, PersonaNamingConfig>();
    for (const row of rows) {
      const parsed = personaNamingConfigRowSchema.safeParse(row);
      if (!parsed.success) {
        log.error("Failed to validate a persona naming config", parsed.error.flatten());
        continue;
      }
      configs.set(parsed.data.persona_id, {
        prefixes: parsed.data.prefixes,
        suffixes: parsed.data.suffixes,
        addressTerms: parsed.data.address_terms,
      });
    }
    for (const personaId of uniquePersonaIds) {
      if (!configs.has(personaId)) configs.set(personaId, EMPTY_PERSONA_NAMING_CONFIG);
    }
    return configs;
  }

  async savePersonaConfig(personaId: number, config: PersonaNamingConfig, client: SQL = sql): Promise<void> {
    await client`
      INSERT INTO persona_naming_configs (persona_id, prefixes, suffixes, address_terms)
      VALUES (
        ${personaId}, ${JSON.stringify(config.prefixes)}::JSONB, ${JSON.stringify(config.suffixes)}::JSONB,
        ${JSON.stringify(config.addressTerms)}::JSONB
      )
      ON CONFLICT (persona_id) DO UPDATE SET
        prefixes = EXCLUDED.prefixes,
        suffixes = EXCLUDED.suffixes,
        address_terms = EXCLUDED.address_terms,
        updated_at = NOW()
    `;
  }
}

export const userNamingRepository = new UserNamingRepository();
