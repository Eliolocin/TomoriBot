import {
  customEndpointConnectionSchema,
  customEndpointSchema,
  diffusionModelSchema,
  embeddingModelSchema,
  llmSchema,
  openRouterEmbeddingModelRegistrationSchema,
  openRouterImageModelRegistrationSchema,
  openRouterModelRegistrationSchema,
  openRouterVideoModelRegistrationSchema,
  savedProviderConfigSchema,
  userSavedProviderConfigSchema,
  videoGenerationModelSchema,
  type CustomEndpointApiStyle,
  type CustomEndpointCapability,
  type CustomEndpointConnectionRow,
  type CustomEndpointRow,
  type DiffusionModelRow,
  type EmbeddingModelRow,
  type LlmRow,
  type OpenRouterEmbeddingModelRegistrationRow,
  type OpenRouterImageModelRegistrationRow,
  type OpenRouterModelRegistrationRow,
  type OpenRouterVideoModelRegistrationRow,
  type SavedProviderConfigRow,
  type SavedProviderConfigUpsert,
  type UserSavedProviderConfigRow,
  type UserSavedProviderConfigUpsert,
  type VideoGenerationModelRow,
} from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { DatabaseUnavailableError } from "@/types/errors";
import { sql, withTransientDbRetry } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import { buildCustomProviderName, rememberCustomProviderLabel } from "@/utils/provider/customProviderUtils";
import type { OpenRouterModelScope } from "./LlmModelRepository";
import type { IRepository } from "./IRepository";

/** Export shape for server-scoped provider configuration. */
type LlmProviderExportShape = {
  savedProviderConfigs: SavedProviderConfigRow[];
};

type LlmProviderCacheOptions = {
  serverDiscId?: string;
};

type ChannelLlmCacheOptions = LlmProviderCacheOptions & {
  channelDiscId?: string;
};

export type SavedProviderConfigsReadResult =
  | { status: "fresh"; configs: SavedProviderConfigRow[] }
  | { status: "unavailable"; configs: [] };

type UserSavedProviderConfigsReadResult =
  | { status: "fresh"; configs: UserSavedProviderConfigRow[] }
  | { status: "unavailable"; configs: [] };

export type CustomEndpointConnectionsReadResult =
  | { status: "fresh"; connections: CustomEndpointConnectionRow[]; endpoints: CustomEndpointRow[] }
  | { status: "unavailable"; connections: []; endpoints: [] };

/**
 * LlmProviderRepository: saved provider configs, custom endpoints, and scoped model registrations.
 *
 * Owns tables: saved_provider_configs, user_saved_provider_configs, custom_endpoint_connections,
 * custom_endpoints, scoped_model_registrations, scoped_model_registrations,
 * scoped_model_registrations, scoped_model_registrations.
 */
class LlmProviderRepository implements IRepository<LlmProviderExportShape> {
  private hydrateCustomEndpointRow(row: unknown): CustomEndpointRow | null {
    const parsed = customEndpointSchema.safeParse(row);
    if (!parsed.success) return null;

    rememberCustomProviderLabel(buildCustomProviderName(parsed.data.connection_id), parsed.data.label);
    return parsed.data;
  }

  private hydrateCustomEndpointRows(rows: readonly unknown[]): CustomEndpointRow[] {
    return rows.flatMap((row) => {
      const endpoint = this.hydrateCustomEndpointRow(row);
      return endpoint ? [endpoint] : [];
    });
  }

  private async hydrateCustomProviderLabelsForOwner(owner: { serverId?: number; userId?: number }): Promise<void> {
    try {
      const rows =
        owner.serverId !== undefined
          ? await sql<unknown[]>`
              SELECT connection_id, label
              FROM custom_endpoint_connections
              WHERE server_id = ${owner.serverId} AND user_id IS NULL
            `
          : owner.userId !== undefined
            ? await sql<unknown[]>`
                SELECT connection_id, label
                FROM custom_endpoint_connections
                WHERE user_id = ${owner.userId} AND server_id IS NULL
              `
            : [];

      for (const row of rows) {
        const connectionId = (row as { connection_id?: unknown }).connection_id;
        const label = (row as { label?: unknown }).label;
        if (typeof connectionId === "number" && typeof label === "string") {
          rememberCustomProviderLabel(buildCustomProviderName(connectionId), label);
        }
      }
    } catch (error) {
      log.warn("Unable to hydrate custom provider labels for saved provider configs:", error);
    }
  }

  private async scopedLlmRows(
    scope: OpenRouterModelScope,
    includeDeprecated: boolean,
    provider = "openrouter",
  ): Promise<unknown[]> {
    if (scope.kind === "server") {
      return includeDeprecated
        ? await sql`
            SELECT l.*
            FROM llms l
            WHERE l.llm_provider = ${provider}
              AND (
                COALESCE(l.is_scoped_registration, false) = false
                OR (
                  COALESCE(l.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations omr
                    WHERE omr.llm_id = l.llm_id
                      AND omr.server_id = ${scope.ownerId}
                      AND omr.user_id IS NULL
                  )
                )
              )
            ORDER BY l.is_scoped_registration ASC NULLS FIRST, l.llm_id ASC
          `
        : await sql`
            SELECT l.*
            FROM llms l
            WHERE l.llm_provider = ${provider}
              AND l.is_deprecated = false
              AND (
                COALESCE(l.is_scoped_registration, false) = false
                OR (
                  COALESCE(l.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations omr
                    WHERE omr.llm_id = l.llm_id
                      AND omr.server_id = ${scope.ownerId}
                      AND omr.user_id IS NULL
                  )
                )
              )
            ORDER BY l.is_scoped_registration ASC NULLS FIRST, l.llm_id ASC
          `;
    }

    return includeDeprecated
      ? await sql`
          SELECT l.*
          FROM llms l
          WHERE l.llm_provider = ${provider}
            AND (
              COALESCE(l.is_scoped_registration, false) = false
              OR (
                COALESCE(l.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations omr
                  WHERE omr.llm_id = l.llm_id
                    AND omr.user_id = ${scope.ownerId}
                    AND omr.server_id IS NULL
                )
              )
            )
          ORDER BY l.is_scoped_registration ASC NULLS FIRST, l.llm_id ASC
        `
      : await sql`
          SELECT l.*
          FROM llms l
          WHERE l.llm_provider = ${provider}
            AND l.is_deprecated = false
            AND (
              COALESCE(l.is_scoped_registration, false) = false
              OR (
                COALESCE(l.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations omr
                  WHERE omr.llm_id = l.llm_id
                    AND omr.user_id = ${scope.ownerId}
                    AND omr.server_id IS NULL
                )
              )
            )
          ORDER BY l.is_scoped_registration ASC NULLS FIRST, l.llm_id ASC
        `;
  }

  private async scopedEmbeddingModelRows(
    scope: OpenRouterModelScope,
    includeDeprecated: boolean,
    provider = "openrouter",
  ): Promise<unknown[]> {
    if (scope.kind === "server") {
      return includeDeprecated
        ? await sql`
            SELECT em.*
            FROM embedding_models em
            WHERE em.provider = ${provider}
              AND (
                COALESCE(em.is_scoped_registration, false) = false
                OR (
                  COALESCE(em.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations oemr
                    WHERE oemr.embedding_model_id = em.embedding_model_id
                      AND oemr.server_id = ${scope.ownerId}
                      AND oemr.user_id IS NULL
                  )
                )
              )
            ORDER BY em.is_scoped_registration ASC NULLS FIRST, em.embedding_model_id ASC
          `
        : await sql`
            SELECT em.*
            FROM embedding_models em
            WHERE em.provider = ${provider}
              AND em.is_deprecated = false
              AND (
                COALESCE(em.is_scoped_registration, false) = false
                OR (
                  COALESCE(em.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations oemr
                    WHERE oemr.embedding_model_id = em.embedding_model_id
                      AND oemr.server_id = ${scope.ownerId}
                      AND oemr.user_id IS NULL
                  )
                )
              )
            ORDER BY em.is_scoped_registration ASC NULLS FIRST, em.embedding_model_id ASC
          `;
    }

    return includeDeprecated
      ? await sql`
          SELECT em.*
          FROM embedding_models em
          WHERE em.provider = ${provider}
            AND (
              COALESCE(em.is_scoped_registration, false) = false
              OR (
                COALESCE(em.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations oemr
                  WHERE oemr.embedding_model_id = em.embedding_model_id
                    AND oemr.user_id = ${scope.ownerId}
                    AND oemr.server_id IS NULL
                )
              )
            )
          ORDER BY em.is_scoped_registration ASC NULLS FIRST, em.embedding_model_id ASC
        `
      : await sql`
          SELECT em.*
          FROM embedding_models em
          WHERE em.provider = ${provider}
            AND em.is_deprecated = false
            AND (
              COALESCE(em.is_scoped_registration, false) = false
              OR (
                COALESCE(em.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations oemr
                  WHERE oemr.embedding_model_id = em.embedding_model_id
                    AND oemr.user_id = ${scope.ownerId}
                    AND oemr.server_id IS NULL
                )
              )
            )
          ORDER BY em.is_scoped_registration ASC NULLS FIRST, em.embedding_model_id ASC
        `;
  }

  private async scopedDiffusionModelRows(
    scope: OpenRouterModelScope,
    includeDeprecated: boolean,
    provider = "openrouter",
  ): Promise<unknown[]> {
    if (scope.kind === "server") {
      return includeDeprecated
        ? await sql`
            SELECT dm.*
            FROM image_diffusion_models dm
            WHERE dm.provider = ${provider}
              AND (
                COALESCE(dm.is_scoped_registration, false) = false
                OR (
                  COALESCE(dm.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations oimr
                    WHERE oimr.diffusion_model_id = dm.diffusion_model_id
                      AND oimr.server_id = ${scope.ownerId}
                      AND oimr.user_id IS NULL
                  )
                )
              )
            ORDER BY dm.is_scoped_registration ASC NULLS FIRST, dm.diffusion_model_id ASC
          `
        : await sql`
            SELECT dm.*
            FROM image_diffusion_models dm
            WHERE dm.provider = ${provider}
              AND dm.is_deprecated = false
              AND (
                COALESCE(dm.is_scoped_registration, false) = false
                OR (
                  COALESCE(dm.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations oimr
                    WHERE oimr.diffusion_model_id = dm.diffusion_model_id
                      AND oimr.server_id = ${scope.ownerId}
                      AND oimr.user_id IS NULL
                  )
                )
              )
            ORDER BY dm.is_scoped_registration ASC NULLS FIRST, dm.diffusion_model_id ASC
          `;
    }

    return includeDeprecated
      ? await sql`
          SELECT dm.*
          FROM image_diffusion_models dm
          WHERE dm.provider = ${provider}
            AND (
              COALESCE(dm.is_scoped_registration, false) = false
              OR (
                COALESCE(dm.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations oimr
                  WHERE oimr.diffusion_model_id = dm.diffusion_model_id
                    AND oimr.user_id = ${scope.ownerId}
                    AND oimr.server_id IS NULL
                )
              )
            )
          ORDER BY dm.is_scoped_registration ASC NULLS FIRST, dm.diffusion_model_id ASC
        `
      : await sql`
          SELECT dm.*
          FROM image_diffusion_models dm
          WHERE dm.provider = ${provider}
            AND dm.is_deprecated = false
            AND (
              COALESCE(dm.is_scoped_registration, false) = false
              OR (
                COALESCE(dm.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations oimr
                  WHERE oimr.diffusion_model_id = dm.diffusion_model_id
                    AND oimr.user_id = ${scope.ownerId}
                    AND oimr.server_id IS NULL
                )
              )
            )
          ORDER BY dm.is_scoped_registration ASC NULLS FIRST, dm.diffusion_model_id ASC
        `;
  }

  private async scopedVideoModelRows(
    scope: OpenRouterModelScope,
    includeDeprecated: boolean,
    provider = "openrouter",
  ): Promise<unknown[]> {
    if (scope.kind === "server") {
      return includeDeprecated
        ? await sql`
            SELECT vm.*
            FROM video_generation_models vm
            WHERE vm.provider = ${provider}
              AND (
                COALESCE(vm.is_scoped_registration, false) = false
                OR (
                  COALESCE(vm.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations ovmr
                    WHERE ovmr.video_model_id = vm.video_model_id
                      AND ovmr.server_id = ${scope.ownerId}
                      AND ovmr.user_id IS NULL
                  )
                )
              )
            ORDER BY vm.is_scoped_registration ASC NULLS FIRST, vm.video_model_id ASC
          `
        : await sql`
            SELECT vm.*
            FROM video_generation_models vm
            WHERE vm.provider = ${provider}
              AND vm.is_deprecated = false
              AND (
                COALESCE(vm.is_scoped_registration, false) = false
                OR (
                  COALESCE(vm.is_scoped_registration, false) = true
                  AND EXISTS (
                    SELECT 1
                    FROM scoped_model_registrations ovmr
                    WHERE ovmr.video_model_id = vm.video_model_id
                      AND ovmr.server_id = ${scope.ownerId}
                      AND ovmr.user_id IS NULL
                  )
                )
              )
            ORDER BY vm.is_scoped_registration ASC NULLS FIRST, vm.video_model_id ASC
          `;
    }

    return includeDeprecated
      ? await sql`
          SELECT vm.*
          FROM video_generation_models vm
          WHERE vm.provider = ${provider}
            AND (
              COALESCE(vm.is_scoped_registration, false) = false
              OR (
                COALESCE(vm.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations ovmr
                  WHERE ovmr.video_model_id = vm.video_model_id
                    AND ovmr.user_id = ${scope.ownerId}
                    AND ovmr.server_id IS NULL
                )
              )
            )
          ORDER BY vm.is_scoped_registration ASC NULLS FIRST, vm.video_model_id ASC
        `
      : await sql`
          SELECT vm.*
          FROM video_generation_models vm
          WHERE vm.provider = ${provider}
            AND vm.is_deprecated = false
            AND (
              COALESCE(vm.is_scoped_registration, false) = false
              OR (
                COALESCE(vm.is_scoped_registration, false) = true
                AND EXISTS (
                  SELECT 1
                  FROM scoped_model_registrations ovmr
                  WHERE ovmr.video_model_id = vm.video_model_id
                    AND ovmr.user_id = ${scope.ownerId}
                    AND ovmr.server_id IS NULL
                )
              )
            )
          ORDER BY vm.is_scoped_registration ASC NULLS FIRST, vm.video_model_id ASC
        `;
  }

  private toPostgresTextArrayLiteral(values: readonly string[] | null | undefined): string {
    return `{${(values ?? []).map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  }

  /**
   * Returns all saved provider configs for a server.
   *
   * @param serverId - Internal server DB ID
   */
  async loadSavedProviderConfigs(serverId: number): Promise<SavedProviderConfigRow[]> {
    const result = await this.loadSavedProviderConfigsResult(serverId);
    if (result.status === "unavailable") {
      throw new DatabaseUnavailableError(`Failed to read saved provider configs for server ${serverId}`);
    }
    return result.configs;
  }

  /**
   * Loads saved server provider rows without presenting a failed database read as an empty collection.
   */
  async loadSavedProviderConfigsResult(serverId: number): Promise<SavedProviderConfigsReadResult> {
    try {
      const rows = await withTransientDbRetry(
        async () =>
          await sql`
          SELECT * FROM saved_provider_configs
          WHERE server_id = ${serverId}
          ORDER BY provider ASC
        `,
        "load saved provider configs",
      );

      if (!rows || rows.length === 0) return { status: "fresh", configs: [] };

      const validated: SavedProviderConfigRow[] = [];
      for (const row of rows) {
        const parsed = savedProviderConfigSchema.safeParse(row);
        if (parsed.success) {
          validated.push(parsed.data);
        } else {
          log.warn(
            `Invalid saved provider config row for server ${serverId}, provider ${row.provider}: ${parsed.error.message}`,
          );
        }
      }
      await this.hydrateCustomProviderLabelsForOwner({ serverId });
      return { status: "fresh", configs: validated };
    } catch (error) {
      log.error(`Error loading saved provider configs for server ${serverId}:`, error);
      return { status: "unavailable", configs: [] };
    }
  }

  /**
   * Returns the saved provider config for a server + provider pair, or null.
   *
   * @param serverId - Internal server DB ID
   */
  async loadSavedProviderConfig(serverId: number, provider: string): Promise<SavedProviderConfigRow | null> {
    try {
      const rows = await withTransientDbRetry(
        async () =>
          await sql`
          SELECT * FROM saved_provider_configs
          WHERE server_id = ${serverId}
            AND provider = ${provider.toLowerCase()}
          LIMIT 1
        `,
        "load saved provider config",
      );

      if (!rows || rows.length === 0) return null;

      const parsed = savedProviderConfigSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(`Invalid saved provider config for server ${serverId}, provider ${provider}: ${parsed.error.message}`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      // `null` here is read downstream as "no row", which becomes CredentialUnavailableError
      // with reason `no_saved_config` and renders an "API Key Missing" embed telling an admin
      // to run /config setup during a transient blip. The caller has to be able to tell the
      // two apart, so an unreadable database must not answer with the absence sentinel.
      log.error(`Error loading saved provider config for server ${serverId}, provider ${provider}:`, error);
      throw new DatabaseUnavailableError(`Failed to read the saved provider config for server ${serverId}`);
    }
  }

  /**
   * Returns all saved personal provider configs for a user.
   *
   * @param userId - Internal user DB ID
   */
  async loadUserSavedProviderConfigs(userId: number): Promise<UserSavedProviderConfigRow[]> {
    const result = await this.loadUserSavedProviderConfigsResult(userId);
    if (result.status === "unavailable") {
      throw new DatabaseUnavailableError(`Failed to read saved provider configs for user ${userId}`);
    }
    return result.configs;
  }

  async loadUserSavedProviderConfigsResult(userId: number): Promise<UserSavedProviderConfigsReadResult> {
    try {
      const rows = await withTransientDbRetry(
        async () =>
          await sql`
          SELECT * FROM user_saved_provider_configs
          WHERE user_id = ${userId}
          ORDER BY provider ASC
        `,
        "load user saved provider configs",
      );

      if (!rows || rows.length === 0) return { status: "fresh", configs: [] };

      const validated: UserSavedProviderConfigRow[] = [];
      for (const row of rows) {
        const parsed = userSavedProviderConfigSchema.safeParse(row);
        if (parsed.success) {
          validated.push(parsed.data);
        } else {
          log.warn(
            `Invalid user saved provider config row for user ${userId}, provider ${row.provider}: ${parsed.error.message}`,
          );
        }
      }
      await this.hydrateCustomProviderLabelsForOwner({ userId });
      return { status: "fresh", configs: validated };
    } catch (error) {
      log.error(`Error loading user saved provider configs for user ${userId}:`, error);
      return { status: "unavailable", configs: [] };
    }
  }

  /**
   * Returns the saved personal provider config for a user + provider pair, or null.
   *
   * @param userId   - Internal user DB ID
   */
  async loadUserSavedProviderConfig(userId: number, provider: string): Promise<UserSavedProviderConfigRow | null> {
    try {
      const rows = await withTransientDbRetry(
        async () =>
          await sql`
          SELECT * FROM user_saved_provider_configs
          WHERE user_id = ${userId}
            AND provider = ${provider.toLowerCase()}
          LIMIT 1
        `,
        "load user saved provider config",
      );

      if (!rows || rows.length === 0) return null;

      const parsed = userSavedProviderConfigSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(
          `Invalid user saved provider config for user ${userId}, provider ${provider}: ${parsed.error.message}`,
        );
        return null;
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading user saved provider config for user ${userId}, provider ${provider}:`, error);
      throw new DatabaseUnavailableError(`Failed to read the saved provider config for user ${userId}`);
    }
  }

  /**
   * Returns custom endpoints configured for a server.
   *
   * @param serverId - Internal server DB ID
   */
  async loadCustomEndpointsForServer(serverId: number): Promise<CustomEndpointRow[]> {
    return (await this.loadCustomEndpointConnectionsForServerResult(serverId)).endpoints;
  }

  /**
   * Loads connection entities and their optional model rows together, including zero-model connections.
   */
  async loadCustomEndpointConnectionsForServerResult(serverId: number): Promise<CustomEndpointConnectionsReadResult> {
    try {
      const [connectionRows, endpointRows] = await Promise.all([
        sql<unknown[]>`
          SELECT connection_id, server_id, user_id, label, capability, api_style,
                 endpoint_url, requires_auth, created_at, updated_at
          FROM custom_endpoint_connections
          WHERE server_id = ${serverId}
            AND user_id IS NULL
          ORDER BY created_at ASC, connection_id ASC
        `,
        sql<unknown[]>`
        SELECT
          ce.custom_endpoint_id,
          ce.connection_id,
          cec.server_id,
          cec.user_id,
          cec.label,
          cec.capability,
          cec.api_style,
          cec.endpoint_url,
          ce.model_name,
          ce.model_ref_id,
          ce.num_ctx,
          cec.requires_auth,
          ce.extra_config,
          ce.has_tools,
          ce.sees_images,
          ce.sees_videos,
          ce.supports_structoutput,
          ce.strict_role_alternation,
          ce.supports_prefix_completion,
          ce.is_default,
          ce.created_at,
          ce.updated_at
        FROM custom_endpoints ce
        JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
        WHERE cec.server_id = ${serverId}
          AND cec.user_id IS NULL
        ORDER BY cec.label ASC, cec.capability ASC, ce.model_name ASC NULLS FIRST, ce.custom_endpoint_id ASC
        `,
      ]);

      const connections: CustomEndpointConnectionRow[] = [];
      for (const row of connectionRows) {
        const parsed = customEndpointConnectionSchema.safeParse(row);
        if (parsed.success) {
          rememberCustomProviderLabel(buildCustomProviderName(parsed.data.connection_id), parsed.data.label);
          connections.push(parsed.data);
        } else {
          log.warn(`Invalid custom endpoint connection row for server ${serverId}: ${parsed.error.message}`);
        }
      }

      return { status: "fresh", connections, endpoints: this.hydrateCustomEndpointRows(endpointRows) };
    } catch (error) {
      log.error(`Error loading custom endpoint connections for server ${serverId}:`, error);
      return { status: "unavailable", connections: [], endpoints: [] };
    }
  }

  /**
   * Returns custom endpoints configured for a user.
   *
   * @param userId - Internal user DB ID
   */
  async loadCustomEndpointsForUser(userId: number): Promise<CustomEndpointRow[]> {
    return (await this.loadCustomEndpointConnectionsForUserResult(userId)).endpoints;
  }

  /** Loads user-owned connections and their optional model rows, including zero-model connections. */
  async loadCustomEndpointConnectionsForUserResult(userId: number): Promise<CustomEndpointConnectionsReadResult> {
    try {
      const [connectionRows, endpointRows] = await Promise.all([
        sql<unknown[]>`
          SELECT connection_id, server_id, user_id, label, capability, api_style,
                 endpoint_url, requires_auth, created_at, updated_at
          FROM custom_endpoint_connections
          WHERE user_id = ${userId}
            AND server_id IS NULL
          ORDER BY created_at ASC, connection_id ASC
        `,
        sql<unknown[]>`
        SELECT
          ce.custom_endpoint_id,
          ce.connection_id,
          cec.server_id,
          cec.user_id,
          cec.label,
          cec.capability,
          cec.api_style,
          cec.endpoint_url,
          ce.model_name,
          ce.model_ref_id,
          ce.num_ctx,
          cec.requires_auth,
          ce.extra_config,
          ce.has_tools,
          ce.sees_images,
          ce.sees_videos,
          ce.supports_structoutput,
          ce.strict_role_alternation,
          ce.supports_prefix_completion,
          ce.is_default,
          ce.created_at,
          ce.updated_at
        FROM custom_endpoints ce
        JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
        WHERE cec.user_id = ${userId}
          AND cec.server_id IS NULL
        ORDER BY cec.label ASC, cec.capability ASC, ce.model_name ASC NULLS FIRST, ce.custom_endpoint_id ASC
        `,
      ]);

      const connections: CustomEndpointConnectionRow[] = [];
      for (const row of connectionRows) {
        const parsed = customEndpointConnectionSchema.safeParse(row);
        if (parsed.success) {
          rememberCustomProviderLabel(buildCustomProviderName(parsed.data.connection_id), parsed.data.label);
          connections.push(parsed.data);
        } else {
          log.warn(`Invalid custom endpoint connection row for user ${userId}: ${parsed.error.message}`);
        }
      }
      return { status: "fresh", connections, endpoints: this.hydrateCustomEndpointRows(endpointRows) };
    } catch (error) {
      log.error(`Error loading custom endpoint connections for user ${userId}:`, error);
      return { status: "unavailable", connections: [], endpoints: [] };
    }
  }

  /**
   * Returns custom endpoints by their internal IDs, preserving input order.
   *
   * @param ids - Array of internal custom endpoint IDs
   */
  async loadCustomEndpointsByIds(ids: number[]): Promise<CustomEndpointRow[]> {
    if (ids.length === 0) return [];

    try {
      // Avoid ANY($1) array binding, because Bun SQL can intermittently fail on
      // integer-array parameters with protocol error 08P01.
      const distinctIds = Array.from(new Set(ids));
      const placeholders = distinctIds.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await sql.unsafe(
        `SELECT
          ce.custom_endpoint_id,
          ce.connection_id,
          cec.server_id,
          cec.user_id,
          cec.label,
          cec.capability,
          cec.api_style,
          cec.endpoint_url,
          ce.model_name,
          ce.model_ref_id,
          ce.num_ctx,
          cec.requires_auth,
          ce.extra_config,
          ce.has_tools,
          ce.sees_images,
          ce.sees_videos,
          ce.supports_structoutput,
          ce.strict_role_alternation,
          ce.supports_prefix_completion,
          ce.is_default,
          ce.created_at,
          ce.updated_at
        FROM custom_endpoints ce
        JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
        WHERE ce.custom_endpoint_id IN (${placeholders})`,
        distinctIds,
      );

      const rowMap = new Map<number, CustomEndpointRow>();
      for (const row of rows) {
        const parsed = customEndpointSchema.safeParse(row);
        if (parsed.success && parsed.data.custom_endpoint_id !== undefined) {
          rememberCustomProviderLabel(buildCustomProviderName(parsed.data.connection_id), parsed.data.label);
          rowMap.set(parsed.data.custom_endpoint_id, parsed.data);
        } else if (!parsed.success) {
          log.warn(
            `Invalid custom endpoint row for id ${(row as Record<string, unknown>).custom_endpoint_id}:`,
            parsed.error.flatten(),
          );
        }
      }

      return ids.flatMap((id) => {
        const ep = rowMap.get(id);
        return ep ? [ep] : [];
      });
    } catch (error) {
      log.error(`Error loading custom endpoints by ids [${ids.join(", ")}]:`, error);
      return [];
    }
  }

  /**
   * Returns a specific custom endpoint by lookup parameters.
   *
   * @param params - Lookup parameters including scope (serverId or userId), label, and capability
   */
  async loadCustomEndpoint(params: {
    serverId?: number | null;
    userId?: number | null;
    label: string;
    capability: CustomEndpointCapability;
  }): Promise<CustomEndpointRow | null> {
    const { serverId = null, userId = null, label, capability } = params;

    try {
      const rows =
        serverId !== null
          ? await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE cec.server_id = ${serverId}
                AND cec.user_id IS NULL
                AND cec.label = ${label}
                AND cec.capability = ${capability}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `
          : await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE cec.user_id = ${userId}
                AND cec.server_id IS NULL
                AND cec.label = ${label}
                AND cec.capability = ${capability}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `;

      if (!rows.length) return null;

      const parsed = customEndpointSchema.safeParse(rows[0]);
      if (!parsed.success) {
        const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
        log.warn(
          `Invalid custom endpoint row for ${owner}, label ${label}, capability ${capability}: ${parsed.error.message}`,
        );
        return null;
      }

      const endpoint = this.hydrateCustomEndpointRow(rows[0]);
      return endpoint;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(`Error loading custom endpoint for ${owner}, label ${label}, capability ${capability}:`, error);
      return null;
    }
  }

  /**
   * Returns the custom endpoint that owns a specific synthetic model row.
   *
   * Used at runtime to resolve the currently-active model back to its exact endpoint when several
   * models share a label+capability. Matching is by (owner, capability, model_ref_id): the
   * model_ref_id uniquely identifies the synthetic model, so label is not required.
   *
   * @param params - Scope (serverId or userId), capability, and the synthetic model's id
   */
  async loadCustomEndpointByModelRef(params: {
    serverId?: number | null;
    userId?: number | null;
    capability: CustomEndpointCapability;
    modelRefId: number;
  }): Promise<CustomEndpointRow | null> {
    const { serverId = null, userId = null, capability, modelRefId } = params;

    try {
      const rows =
        serverId !== null
          ? await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE cec.server_id = ${serverId}
                AND cec.user_id IS NULL
                AND cec.capability = ${capability}
                AND ce.model_ref_id = ${modelRefId}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `
          : await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE cec.user_id = ${userId}
                AND cec.server_id IS NULL
                AND cec.capability = ${capability}
                AND ce.model_ref_id = ${modelRefId}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `;

      if (!rows.length) return null;

      const parsed = customEndpointSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(`Invalid custom endpoint row for model_ref_id ${modelRefId}/${capability}: ${parsed.error.message}`);
        return null;
      }

      const endpoint = this.hydrateCustomEndpointRow(rows[0]);
      return endpoint;
    } catch (error) {
      log.error(`Error loading custom endpoint by model_ref_id ${modelRefId}/${capability}:`, error);
      return null;
    }
  }

  /** Returns a custom endpoint connection by its primary key ID. */
  async loadCustomEndpointConnectionById(connectionId: number): Promise<CustomEndpointConnectionRow | null> {
    try {
      const rows = await sql`
        SELECT * FROM custom_endpoint_connections
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `;
      if (!rows.length) return null;
      const parsed = customEndpointConnectionSchema.safeParse(rows[0]);
      if (parsed.success) {
        rememberCustomProviderLabel(buildCustomProviderName(parsed.data.connection_id), parsed.data.label);
      }
      return parsed.success ? parsed.data : null;
    } catch (error) {
      log.error(`Error loading custom endpoint connection by id ${connectionId}:`, error);
      return null;
    }
  }

  /** Returns all endpoints belonging to a specific connection. */
  async loadCustomEndpointsByConnectionId(connectionId: number): Promise<CustomEndpointRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT
          ce.custom_endpoint_id,
          ce.connection_id,
          cec.server_id,
          cec.user_id,
          cec.label,
          cec.capability,
          cec.api_style,
          cec.endpoint_url,
          ce.model_name,
          ce.model_ref_id,
          ce.num_ctx,
          cec.requires_auth,
          ce.extra_config,
          ce.has_tools,
          ce.sees_images,
          ce.sees_videos,
          ce.supports_structoutput,
          ce.strict_role_alternation,
          ce.supports_prefix_completion,
          ce.is_default,
          ce.created_at,
          ce.updated_at
        FROM custom_endpoints ce
        JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
        WHERE ce.connection_id = ${connectionId}
        ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
      `;
      return this.hydrateCustomEndpointRows(rows);
    } catch (error) {
      log.error(`Error loading custom endpoints by connection_id ${connectionId}:`, error);
      return [];
    }
  }

  /**
   * Returns a custom endpoint for a connection, optionally matching a specific synthetic model ID.
   */
  async loadCustomEndpointByConnection(
    connectionId: number,
    capability: CustomEndpointCapability,
    modelRefId?: number | null,
  ): Promise<CustomEndpointRow | null> {
    try {
      const rows =
        modelRefId != null
          ? await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE ce.connection_id = ${connectionId}
                AND cec.capability = ${capability}
                AND ce.model_ref_id = ${modelRefId}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `
          : await sql`
              SELECT
                ce.custom_endpoint_id,
                ce.connection_id,
                cec.server_id,
                cec.user_id,
                cec.label,
                cec.capability,
                cec.api_style,
                cec.endpoint_url,
                ce.model_name,
                ce.model_ref_id,
                ce.num_ctx,
                cec.requires_auth,
                ce.extra_config,
                ce.has_tools,
                ce.sees_images,
                ce.sees_videos,
                ce.supports_structoutput,
                ce.strict_role_alternation,
                ce.supports_prefix_completion,
                ce.is_default,
                ce.created_at,
                ce.updated_at
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE ce.connection_id = ${connectionId}
                AND cec.capability = ${capability}
              ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
              LIMIT 1
            `;
      if (!rows.length) return null;
      return this.hydrateCustomEndpointRow(rows[0]);
    } catch (error) {
      log.error(`Error loading custom endpoint by connection ${connectionId}:`, error);
      return null;
    }
  }

  /** Deletes a custom endpoint connection and cascades to its models. */
  async deleteCustomEndpointConnectionById(connectionId: number): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM custom_endpoint_connections
        WHERE connection_id = ${connectionId}
      `;
      return result.count > 0;
    } catch (error) {
      log.error(`Error deleting custom endpoint connection ${connectionId}:`, error);
      return false;
    }
  }

  /** Reuses the connection identity needed by model rows and saved provider snapshots. */
  async upsertCustomEndpointConnection(params: {
    serverId?: number | null;
    userId?: number | null;
    label: string;
    capability: CustomEndpointCapability;
    apiStyle: CustomEndpointApiStyle;
    endpointUrl: string;
    requiresAuth: boolean;
  }): Promise<number | null> {
    const { serverId = null, userId = null, label, capability, apiStyle, endpointUrl, requiresAuth } = params;
    try {
      const rows =
        serverId !== null
          ? await sql<[{ connection_id: number }]>`
              INSERT INTO custom_endpoint_connections (
                server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
              ) VALUES (
                ${serverId}, NULL, ${label}, ${capability}, ${apiStyle}, ${endpointUrl}, ${requiresAuth}
              )
              ON CONFLICT (server_id, label, capability) WHERE user_id IS NULL
              DO UPDATE SET
                api_style = EXCLUDED.api_style,
                endpoint_url = EXCLUDED.endpoint_url,
                requires_auth = custom_endpoint_connections.requires_auth OR EXCLUDED.requires_auth,
                updated_at = CURRENT_TIMESTAMP
              RETURNING connection_id
            `
          : await sql<[{ connection_id: number }]>`
              INSERT INTO custom_endpoint_connections (
                server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
              ) VALUES (
                NULL, ${userId}, ${label}, ${capability}, ${apiStyle}, ${endpointUrl}, ${requiresAuth}
              )
              ON CONFLICT (user_id, label, capability) WHERE server_id IS NULL
              DO UPDATE SET
                api_style = EXCLUDED.api_style,
                endpoint_url = EXCLUDED.endpoint_url,
                requires_auth = custom_endpoint_connections.requires_auth OR EXCLUDED.requires_auth,
                updated_at = CURRENT_TIMESTAMP
              RETURNING connection_id
            `;
      return rows[0]?.connection_id ?? null;
    } catch (error) {
      log.error(`Error upserting custom endpoint connection for ${label}/${capability}:`, error);
      return null;
    }
  }

  /** Updates one server-owned endpoint group and its credential snapshots atomically. */
  async updateServerCustomEndpointConnectionGroup(params: {
    serverId: number;
    connectionIds: number[];
    label?: string;
    endpointUrl?: string;
    encryptedApiKey?: Buffer;
    keyVersion?: number;
  }): Promise<boolean> {
    if (params.connectionIds.length === 0) return false;
    try {
      return await sql.begin(async (tx) => {
        const owned = await tx<Array<{ connection_id: number }>>`
          SELECT connection_id
          FROM custom_endpoint_connections
          WHERE server_id = ${params.serverId}
            AND user_id IS NULL
            AND connection_id = ANY(${sql.array(params.connectionIds, "int4")})
          FOR UPDATE
        `;
        if (owned.length !== params.connectionIds.length) return false;

        await tx`
          UPDATE custom_endpoint_connections
          SET
            label = COALESCE(${params.label ?? null}, label),
            endpoint_url = COALESCE(${params.endpointUrl ?? null}, endpoint_url),
            requires_auth = CASE WHEN ${params.encryptedApiKey ?? null}::bytea IS NULL THEN requires_auth ELSE true END,
            updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ANY(${sql.array(params.connectionIds, "int4")})
        `;

        if (params.encryptedApiKey) {
          const providerKeys = params.connectionIds.map((connectionId) => `custom:${connectionId}`);
          const updated = await tx`
            UPDATE saved_provider_configs
            SET
              api_key = ${params.encryptedApiKey},
              key_version = ${params.keyVersion ?? 1},
              updated_at = CURRENT_TIMESTAMP
            WHERE server_id = ${params.serverId}
              AND provider = ANY(${sql.array(providerKeys, "text")})
          `;
          if (updated.count !== providerKeys.length) {
            throw new Error("Endpoint credential snapshot count changed during group edit");
          }
        }
        return true;
      });
    } catch (error) {
      log.error(`Error updating custom endpoint group for server ${params.serverId}:`, error);
      return false;
    }
  }

  /** Updates one user-owned endpoint group and its credential snapshots atomically. */
  async updateUserCustomEndpointConnectionGroup(params: {
    userId: number;
    connectionIds: number[];
    label?: string;
    endpointUrl?: string;
    encryptedApiKey?: Buffer;
    keyVersion?: number;
  }): Promise<boolean> {
    if (params.connectionIds.length === 0) return false;
    try {
      return await sql.begin(async (tx) => {
        const owned = await tx<Array<{ connection_id: number }>>`
          SELECT connection_id
          FROM custom_endpoint_connections
          WHERE user_id = ${params.userId}
            AND server_id IS NULL
            AND connection_id = ANY(${sql.array(params.connectionIds, "int4")})
          FOR UPDATE
        `;
        if (owned.length !== params.connectionIds.length) return false;

        await tx`
          UPDATE custom_endpoint_connections
          SET
            label = COALESCE(${params.label ?? null}, label),
            endpoint_url = COALESCE(${params.endpointUrl ?? null}, endpoint_url),
            requires_auth = CASE WHEN ${params.encryptedApiKey ?? null}::bytea IS NULL THEN requires_auth ELSE true END,
            updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ANY(${sql.array(params.connectionIds, "int4")})
        `;

        if (params.encryptedApiKey) {
          const providerKeys = params.connectionIds.map((connectionId) => `custom:${connectionId}`);
          const updated = await tx`
            UPDATE user_saved_provider_configs
            SET
              api_key = ${params.encryptedApiKey},
              key_version = ${params.keyVersion ?? 1},
              updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ${params.userId}
              AND provider = ANY(${sql.array(providerKeys, "text")})
          `;
          if (updated.count !== providerKeys.length) {
            throw new Error("Personal endpoint credential snapshot count changed during group edit");
          }
        }
        return true;
      });
    } catch (error) {
      log.error(`Error updating custom endpoint group for user ${params.userId}:`, error);
      return false;
    }
  }

  /** Deletes a server provider snapshot, its rotation pool, and its scope-local model registrations atomically. */
  async deleteServerProviderRegistration(serverId: number, provider: string): Promise<boolean> {
    const normalizedProvider = provider.toLowerCase();
    try {
      return await sql.begin(async (tx) => {
        const deleted = await tx`
          DELETE FROM saved_provider_configs
          WHERE server_id = ${serverId} AND provider = ${normalizedProvider}
        `;
        if (deleted.count === 0) return false;

        await tx`
          DELETE FROM api_key_rotation
          WHERE server_id = ${serverId} AND provider = ${normalizedProvider}
        `;
        await tx`
          DELETE FROM scoped_model_registrations registration
          WHERE registration.server_id = ${serverId}
            AND (
              EXISTS (
                SELECT 1 FROM llms model
                WHERE model.llm_id = registration.llm_id AND model.llm_provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM embedding_models model
                WHERE model.embedding_model_id = registration.embedding_model_id
                  AND model.provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM image_diffusion_models model
                WHERE model.diffusion_model_id = registration.diffusion_model_id
                  AND model.provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM video_generation_models model
                WHERE model.video_model_id = registration.video_model_id
                  AND model.provider = ${normalizedProvider}
              )
            )
        `;
        return true;
      });
    } catch (error) {
      log.error(`Error deleting server provider registration ${provider}:`, error);
      return false;
    }
  }

  /** Deletes a personal provider snapshot and its scope-local model registrations atomically. */
  async deleteUserProviderRegistration(userId: number, provider: string): Promise<boolean> {
    const normalizedProvider = provider.toLowerCase();
    try {
      return await sql.begin(async (tx) => {
        const deleted = await tx`
          DELETE FROM user_saved_provider_configs
          WHERE user_id = ${userId} AND provider = ${normalizedProvider}
        `;
        if (deleted.count === 0) return false;

        await tx`
          DELETE FROM scoped_model_registrations registration
          WHERE registration.user_id = ${userId}
            AND (
              EXISTS (
                SELECT 1 FROM llms model
                WHERE model.llm_id = registration.llm_id AND model.llm_provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM embedding_models model
                WHERE model.embedding_model_id = registration.embedding_model_id
                  AND model.provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM image_diffusion_models model
                WHERE model.diffusion_model_id = registration.diffusion_model_id
                  AND model.provider = ${normalizedProvider}
              )
              OR EXISTS (
                SELECT 1 FROM video_generation_models model
                WHERE model.video_model_id = registration.video_model_id
                  AND model.provider = ${normalizedProvider}
              )
            )
        `;
        return true;
      });
    } catch (error) {
      log.error(`Error deleting personal provider registration ${provider}:`, error);
      return false;
    }
  }

  /** Deletes server-owned endpoint connections, snapshots, and synthetic models as one durable entity group. */
  async deleteServerCustomEndpointConnectionGroup(serverId: number, connectionIds: number[]): Promise<boolean> {
    const uniqueIds = [...new Set(connectionIds)];
    if (uniqueIds.length === 0) return false;
    try {
      return await sql.begin(async (tx) => {
        const owned = await tx<Array<{ connection_id: number }>>`
          SELECT connection_id
          FROM custom_endpoint_connections
          WHERE server_id = ${serverId}
            AND user_id IS NULL
            AND connection_id = ANY(${sql.array(uniqueIds, "int4")})
          FOR UPDATE
        `;
        if (owned.length !== uniqueIds.length) return false;

        const providerKeys = uniqueIds.map((connectionId) => `custom:${connectionId}`);
        await tx`
          DELETE FROM saved_provider_configs
          WHERE server_id = ${serverId}
            AND provider = ANY(${sql.array(providerKeys, "text")})
        `;
        await tx`
          DELETE FROM custom_endpoint_connections
          WHERE connection_id = ANY(${sql.array(uniqueIds, "int4")})
        `;
        await tx`DELETE FROM llms WHERE llm_provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM embedding_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM image_diffusion_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM video_generation_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        return true;
      });
    } catch (error) {
      log.error(`Error deleting server endpoint connection group ${connectionIds.join(",")}:`, error);
      return false;
    }
  }

  /** Deletes user-owned endpoint connections, snapshots, and synthetic models as one durable entity group. */
  async deleteUserCustomEndpointConnectionGroup(userId: number, connectionIds: number[]): Promise<boolean> {
    const uniqueIds = [...new Set(connectionIds)];
    if (uniqueIds.length === 0) return false;
    try {
      return await sql.begin(async (tx) => {
        const owned = await tx<Array<{ connection_id: number }>>`
          SELECT connection_id
          FROM custom_endpoint_connections
          WHERE user_id = ${userId}
            AND server_id IS NULL
            AND connection_id = ANY(${sql.array(uniqueIds, "int4")})
          FOR UPDATE
        `;
        if (owned.length !== uniqueIds.length) return false;

        const providerKeys = uniqueIds.map((connectionId) => `custom:${connectionId}`);
        await tx`
          DELETE FROM user_saved_provider_configs
          WHERE user_id = ${userId}
            AND provider = ANY(${sql.array(providerKeys, "text")})
        `;
        await tx`
          DELETE FROM custom_endpoint_connections
          WHERE connection_id = ANY(${sql.array(uniqueIds, "int4")})
        `;
        await tx`DELETE FROM llms WHERE llm_provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM embedding_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM image_diffusion_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        await tx`DELETE FROM video_generation_models WHERE provider = ANY(${sql.array(providerKeys, "text")})`;
        return true;
      });
    } catch (error) {
      log.error(`Error deleting personal endpoint connection group ${connectionIds.join(",")}:`, error);
      return false;
    }
  }

  /** Returns LLM registrations for a server. @param serverId - Internal server DB ID */
  async loadOpenRouterModelRegistrationsForServer(serverId: number): Promise<OpenRouterModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE server_id = ${serverId} AND user_id IS NULL
        ORDER BY llm_id ASC
      `;
      return rows
        .map((row) => openRouterModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter model registrations for server ${serverId}:`, error);
      return [];
    }
  }

  /** Returns LLM registrations for a user. @param userId - Internal user DB ID */
  async loadOpenRouterModelRegistrationsForUser(userId: number): Promise<OpenRouterModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE user_id = ${userId} AND server_id IS NULL
        ORDER BY llm_id ASC
      `;
      return rows
        .map((row) => openRouterModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter model registrations for user ${userId}:`, error);
      return [];
    }
  }

  /** Returns embedding registrations for a server. @param serverId - Internal server DB ID */
  async loadOpenRouterEmbeddingModelRegistrationsForServer(
    serverId: number,
  ): Promise<OpenRouterEmbeddingModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE server_id = ${serverId} AND user_id IS NULL
        ORDER BY embedding_model_id ASC
      `;
      return rows
        .map((row) => openRouterEmbeddingModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter embedding model registrations for server ${serverId}:`, error);
      return [];
    }
  }

  /** Returns embedding registrations for a user. @param userId - Internal user DB ID */
  async loadOpenRouterEmbeddingModelRegistrationsForUser(
    userId: number,
  ): Promise<OpenRouterEmbeddingModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE user_id = ${userId} AND server_id IS NULL
        ORDER BY embedding_model_id ASC
      `;
      return rows
        .map((row) => openRouterEmbeddingModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter embedding model registrations for user ${userId}:`, error);
      return [];
    }
  }

  /** Returns image model registrations for a server. @param serverId - Internal server DB ID */
  async loadOpenRouterImageModelRegistrationsForServer(
    serverId: number,
  ): Promise<OpenRouterImageModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE server_id = ${serverId} AND user_id IS NULL
        ORDER BY diffusion_model_id ASC
      `;
      return rows
        .map((row) => openRouterImageModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter image model registrations for server ${serverId}:`, error);
      return [];
    }
  }

  /** Returns image model registrations for a user. @param userId - Internal user DB ID */
  async loadOpenRouterImageModelRegistrationsForUser(userId: number): Promise<OpenRouterImageModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE user_id = ${userId} AND server_id IS NULL
        ORDER BY diffusion_model_id ASC
      `;
      return rows
        .map((row) => openRouterImageModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter image model registrations for user ${userId}:`, error);
      return [];
    }
  }

  /** Returns video model registrations for a server. @param serverId - Internal server DB ID */
  async loadOpenRouterVideoModelRegistrationsForServer(
    serverId: number,
  ): Promise<OpenRouterVideoModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE server_id = ${serverId} AND user_id IS NULL
        ORDER BY video_model_id ASC
      `;
      return rows
        .map((row) => openRouterVideoModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter video model registrations for server ${serverId}:`, error);
      return [];
    }
  }

  /** Returns video model registrations for a user. @param userId - Internal user DB ID */
  async loadOpenRouterVideoModelRegistrationsForUser(userId: number): Promise<OpenRouterVideoModelRegistrationRow[]> {
    try {
      const rows = await sql<unknown[]>`
        SELECT * FROM scoped_model_registrations
        WHERE user_id = ${userId} AND server_id IS NULL
        ORDER BY video_model_id ASC
      `;
      return rows
        .map((row) => openRouterVideoModelRegistrationSchema.safeParse(row))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    } catch (error) {
      log.error(`Error loading OpenRouter video model registrations for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Returns LLMs visible for a given scope (server or personal), filtered by registration.
   *
   * @param scope             - {kind: "server"|"personal", ownerId: number}
   * @param includeDeprecated - Include deprecated models
   */
  async loadScopedOpenRouterModels(
    scope: OpenRouterModelScope,
    includeDeprecated = false,
    provider = "openrouter",
  ): Promise<LlmRow[]> {
    try {
      const rows = await this.scopedLlmRows(scope, includeDeprecated, provider);
      const parsed = llmSchema.array().safeParse(rows);
      if (!parsed.success) {
        log.error(
          `Failed to validate scoped ${provider} model data for ${scope.kind} ${scope.ownerId}:`,
          parsed.error.flatten(),
        );
        return [];
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading scoped ${provider} models for ${scope.kind} ${scope.ownerId}:`, error);
      return [];
    }
  }

  /**
   * Returns embedding models visible for a given scope.
   *
   * @param scope             - {kind: "server"|"personal", ownerId: number}
   * @param includeDeprecated - Include deprecated models
   */
  async loadScopedOpenRouterEmbeddingModels(
    scope: OpenRouterModelScope,
    includeDeprecated = false,
    provider = "openrouter",
  ): Promise<EmbeddingModelRow[]> {
    try {
      const rows = await this.scopedEmbeddingModelRows(scope, includeDeprecated, provider);
      const parsed = embeddingModelSchema.array().safeParse(rows);
      if (!parsed.success) {
        log.error(
          `Failed to validate scoped ${provider} embedding model data for ${scope.kind} ${scope.ownerId}:`,
          parsed.error.flatten(),
        );
        return [];
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading scoped ${provider} embedding models for ${scope.kind} ${scope.ownerId}:`, error);
      return [];
    }
  }

  /**
   * Returns diffusion models visible for a given scope.
   *
   * @param scope             - {kind: "server"|"personal", ownerId: number}
   * @param includeDeprecated - Include deprecated models
   */
  async loadScopedOpenRouterDiffusionModels(
    scope: OpenRouterModelScope,
    includeDeprecated = false,
    provider = "openrouter",
  ): Promise<DiffusionModelRow[]> {
    try {
      const rows = await this.scopedDiffusionModelRows(scope, includeDeprecated, provider);
      const parsed = diffusionModelSchema.array().safeParse(rows);
      if (!parsed.success) {
        log.error(
          `Failed to validate scoped ${provider} diffusion model data for ${scope.kind} ${scope.ownerId}:`,
          parsed.error.flatten(),
        );
        return [];
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading scoped ${provider} diffusion models for ${scope.kind} ${scope.ownerId}:`, error);
      return [];
    }
  }

  /**
   * Returns video generation models visible for a given scope.
   *
   * @param scope             - {kind: "server"|"personal", ownerId: number}
   * @param includeDeprecated - Include deprecated models
   */
  async loadScopedOpenRouterVideoGenerationModels(
    scope: OpenRouterModelScope,
    includeDeprecated = false,
    provider = "openrouter",
  ): Promise<VideoGenerationModelRow[]> {
    try {
      const rows = await this.scopedVideoModelRows(scope, includeDeprecated, provider);
      const parsed = videoGenerationModelSchema.array().safeParse(rows);
      if (!parsed.success) {
        log.error(
          `Failed to validate scoped ${provider} video model data for ${scope.kind} ${scope.ownerId}:`,
          parsed.error.flatten(),
        );
        return [];
      }
      return parsed.data;
    } catch (error) {
      log.error(`Error loading scoped ${provider} video models for ${scope.kind} ${scope.ownerId}:`, error);
      return [];
    }
  }

  /**
   *
   * @param serverId - Internal server DB ID
   * @param config   - Provider config fields to save
   * @param options  - Optional cache invalidation options
   */
  async upsertSavedProviderConfig(
    serverId: number,
    config: SavedProviderConfigUpsert,
    options: LlmProviderCacheOptions = {},
  ): Promise<boolean> {
    try {
      const provider = config.provider.toLowerCase();
      const fallbackModelRefsJson = JSON.stringify(config.fallback_model_refs ?? []);
      const logitBiasesJson = JSON.stringify(config.llm_logit_biases ?? []);
      const disabledParamsLiteral = this.toPostgresTextArrayLiteral(config.llm_disabled_params);

      const rows = await sql`
        INSERT INTO saved_provider_configs (
          server_id, provider, api_key, key_version,
          llm_id, diffusion_model_id, embedding_model_id,
          video_model_id,
          nai_diffusion_model_id, vision_llm_id, nai_preset_name,
          thinking_level, fallback_model_refs,
          llm_temperature, llm_top_p, llm_top_k,
          llm_frequency_penalty, llm_presence_penalty, llm_min_p,
          llm_max_output_tokens,
          llm_logit_biases, llm_disabled_params
        ) VALUES (
          ${serverId}, ${provider}, ${config.api_key}, ${config.key_version},
          ${config.llm_id}, ${config.diffusion_model_id}, ${config.embedding_model_id},
          ${config.video_model_id ?? null},
          ${config.nai_diffusion_model_id}, ${config.vision_llm_id ?? null}, ${config.nai_preset_name},
          ${config.thinking_level}, ${fallbackModelRefsJson}::jsonb,
          ${config.llm_temperature ?? null}, ${config.llm_top_p ?? null}, ${config.llm_top_k ?? null},
          ${config.llm_frequency_penalty ?? null}, ${config.llm_presence_penalty ?? null}, ${config.llm_min_p ?? null},
          ${config.llm_max_output_tokens ?? null},
          ${logitBiasesJson}::jsonb, ${disabledParamsLiteral}::text[]
        )
        ON CONFLICT (server_id, provider) DO UPDATE SET
          api_key = EXCLUDED.api_key,
          key_version = EXCLUDED.key_version,
          llm_id = EXCLUDED.llm_id,
          diffusion_model_id = EXCLUDED.diffusion_model_id,
          embedding_model_id = EXCLUDED.embedding_model_id,
          video_model_id = EXCLUDED.video_model_id,
          nai_diffusion_model_id = EXCLUDED.nai_diffusion_model_id,
          vision_llm_id = EXCLUDED.vision_llm_id,
          nai_preset_name = EXCLUDED.nai_preset_name,
          thinking_level = EXCLUDED.thinking_level,
          fallback_model_refs = EXCLUDED.fallback_model_refs,
          llm_temperature = EXCLUDED.llm_temperature,
          llm_top_p = EXCLUDED.llm_top_p,
          llm_top_k = EXCLUDED.llm_top_k,
          llm_frequency_penalty = EXCLUDED.llm_frequency_penalty,
          llm_presence_penalty = EXCLUDED.llm_presence_penalty,
          llm_min_p = EXCLUDED.llm_min_p,
          llm_max_output_tokens = EXCLUDED.llm_max_output_tokens,
          llm_logit_biases = EXCLUDED.llm_logit_biases,
          llm_disabled_params = EXCLUDED.llm_disabled_params
        RETURNING *
      `;

      if (rows.length > 0) {
        const parsed = savedProviderConfigSchema.safeParse(rows[0]);
        if (!parsed.success) {
          log.warn(
            `Upserted saved provider config failed validation for server ${serverId}, provider ${provider}: ${parsed.error.message}`,
          );
          return false;
        }
      }

      log.info(`Upserted saved provider config for server ${serverId}, provider ${provider}`);
      if (options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      return true;
    } catch (error) {
      log.error(`Error upserting saved provider config for server ${serverId}, provider ${config.provider}:`, error);
      return false;
    }
  }

  /**
   * Deletes a saved provider config for a server + provider pair.
   *
   * @param serverId - Internal server DB ID
   * @param options  - Optional cache invalidation options
   */
  async deleteSavedProviderConfig(
    serverId: number,
    provider: string,
    options: LlmProviderCacheOptions = {},
  ): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM saved_provider_configs
        WHERE server_id = ${serverId}
          AND provider = ${provider.toLowerCase()}
      `;

      const deleted = result.count > 0;
      if (deleted) {
        log.info(`Deleted saved provider config for server ${serverId}, provider ${provider}`);
        if (options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      }
      return deleted;
    } catch (error) {
      log.error(`Error deleting saved provider config for server ${serverId}, provider ${provider}:`, error);
      return false;
    }
  }

  /**
   *
   * @param userId - Internal user DB ID
   * @param config - Personal provider config fields to save
   */
  async upsertUserSavedProviderConfig(userId: number, config: UserSavedProviderConfigUpsert): Promise<boolean> {
    try {
      const provider = config.provider.toLowerCase();
      const enabledCapabilitiesLiteral = this.toPostgresTextArrayLiteral(config.enabled_capabilities);
      const assignedCapabilitiesLiteral = this.toPostgresTextArrayLiteral(config.assigned_capabilities);
      const fallbackModelRefsJson = JSON.stringify(config.fallback_model_refs ?? []);
      const logitBiasesJson = JSON.stringify(config.llm_logit_biases ?? []);
      const disabledParamsLiteral = this.toPostgresTextArrayLiteral(config.llm_disabled_params);

      const rows = await sql`
        INSERT INTO user_saved_provider_configs (
          user_id, provider, api_key, key_version,
          llm_id, diffusion_model_id, embedding_model_id,
          video_model_id,
          nai_diffusion_model_id, vision_llm_id, nai_preset_name,
          thinking_level, model_randomizer_enabled, enabled_capabilities, assigned_capabilities, fallback_model_refs,
          llm_temperature, llm_top_p, llm_top_k,
          llm_frequency_penalty, llm_presence_penalty, llm_min_p,
          llm_max_output_tokens,
          llm_logit_biases, llm_disabled_params
        ) VALUES (
          ${userId}, ${provider}, ${config.api_key}, ${config.key_version},
          ${config.llm_id}, ${config.diffusion_model_id}, ${config.embedding_model_id},
          ${config.video_model_id ?? null},
          ${config.nai_diffusion_model_id}, ${config.vision_llm_id ?? null}, ${config.nai_preset_name},
          ${config.thinking_level}, ${config.model_randomizer_enabled ?? false}, ${enabledCapabilitiesLiteral}::text[], ${assignedCapabilitiesLiteral}::text[],
          ${fallbackModelRefsJson}::jsonb,
          ${config.llm_temperature ?? null}, ${config.llm_top_p ?? null}, ${config.llm_top_k ?? null},
          ${config.llm_frequency_penalty ?? null}, ${config.llm_presence_penalty ?? null}, ${config.llm_min_p ?? null},
          ${config.llm_max_output_tokens ?? null},
          ${logitBiasesJson}::jsonb, ${disabledParamsLiteral}::text[]
        )
        ON CONFLICT (user_id, provider) DO UPDATE SET
          api_key = EXCLUDED.api_key,
          key_version = EXCLUDED.key_version,
          llm_id = EXCLUDED.llm_id,
          diffusion_model_id = EXCLUDED.diffusion_model_id,
          embedding_model_id = EXCLUDED.embedding_model_id,
          video_model_id = EXCLUDED.video_model_id,
          nai_diffusion_model_id = EXCLUDED.nai_diffusion_model_id,
          vision_llm_id = EXCLUDED.vision_llm_id,
          nai_preset_name = EXCLUDED.nai_preset_name,
          thinking_level = EXCLUDED.thinking_level,
          enabled_capabilities = EXCLUDED.enabled_capabilities,
          assigned_capabilities = EXCLUDED.assigned_capabilities,
          fallback_model_refs = EXCLUDED.fallback_model_refs,
          llm_temperature = EXCLUDED.llm_temperature,
          llm_top_p = EXCLUDED.llm_top_p,
          llm_top_k = EXCLUDED.llm_top_k,
          llm_frequency_penalty = EXCLUDED.llm_frequency_penalty,
          llm_presence_penalty = EXCLUDED.llm_presence_penalty,
          llm_min_p = EXCLUDED.llm_min_p,
          llm_max_output_tokens = EXCLUDED.llm_max_output_tokens,
          llm_logit_biases = EXCLUDED.llm_logit_biases,
          llm_disabled_params = EXCLUDED.llm_disabled_params
        RETURNING *
      `;

      if (rows.length > 0) {
        const parsed = userSavedProviderConfigSchema.safeParse(rows[0]);
        if (!parsed.success) {
          log.warn(
            `Upserted user saved provider config failed validation for user ${userId}, provider ${provider}: ${parsed.error.message}`,
          );
          return false;
        }
      }

      log.info(`Upserted user saved provider config for user ${userId}, provider ${provider}`);
      return true;
    } catch (error) {
      log.error(`Error upserting user saved provider config for user ${userId}, provider ${config.provider}:`, error);
      return false;
    }
  }

  /**
   * Updates the personal text model randomizer preference for a user and provider pair.
   * Scoped on both user ID and provider to isolate writes across users and sibling providers.
   */
  async updatePersonalModelRandomizer(userId: number, provider: string, enabled: boolean): Promise<boolean> {
    try {
      const result = await sql`
        UPDATE user_saved_provider_configs
        SET model_randomizer_enabled = ${enabled}, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${userId}
          AND provider = ${provider.toLowerCase()}
      `;

      return result.count > 0;
    } catch (error) {
      log.error(`Error updating personal model randomizer for user ${userId}, provider ${provider}:`, error);
      return false;
    }
  }

  /**
   * Deletes a personal saved provider config for a user + provider pair.
   *
   * @param userId   - Internal user DB ID
   */
  async deleteUserSavedProviderConfig(userId: number, provider: string): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM user_saved_provider_configs
        WHERE user_id = ${userId}
          AND provider = ${provider.toLowerCase()}
      `;

      const deleted = result.count > 0;
      if (deleted) {
        log.info(`Deleted user saved provider config for user ${userId}, provider ${provider}`);
      }
      return deleted;
    } catch (error) {
      log.error(`Error deleting user saved provider config for user ${userId}, provider ${provider}:`, error);
      return false;
    }
  }

  /**
   *
   * @param params  - Endpoint configuration
   * @param options - Optional cache invalidation options
   */
  async upsertCustomEndpoint(
    params: {
      serverId?: number | null;
      userId?: number | null;
      label: string;
      capability: CustomEndpointCapability;
      apiStyle: CustomEndpointApiStyle;
      endpointUrl: string;
      modelName?: string | null;
      modelRefId?: number | null;
      numCtx?: number | null;
      requiresAuth: boolean;
      extraConfig?: Record<string, unknown>;
      hasTools?: boolean;
      seesImages?: boolean;
      seesVideos?: boolean;
      supportsStructOutput?: boolean;
      strictRoleAlternation?: boolean;
      supportsPrefixCompletion?: boolean;
      isDefault?: boolean;
      // When set, update that exact row (edit path) instead of inserting. This lets an edit change
      // model_name without colliding with sibling models under the same label+capability.
      customEndpointId?: number | null;
    },
    options: LlmProviderCacheOptions = {},
  ): Promise<CustomEndpointRow | null> {
    const {
      serverId = null,
      userId = null,
      label,
      capability,
      apiStyle,
      endpointUrl,
      modelName = null,
      modelRefId = null,
      numCtx = null,
      requiresAuth,
      extraConfig = {},
      hasTools = false,
      seesImages = false,
      seesVideos = false,
      supportsStructOutput = false,
      strictRoleAlternation = false,
      supportsPrefixCompletion = false,
      isDefault = true,
      customEndpointId = null,
    } = params;

    try {
      let resolvedCustomEndpointId: number | null = customEndpointId;

      if (customEndpointId !== null) {
        resolvedCustomEndpointId = await sql.begin(async (tx) => {
          const existingRows = await tx<[{ connection_id: number }]>`
            SELECT connection_id FROM custom_endpoints WHERE custom_endpoint_id = ${customEndpointId} LIMIT 1
          `;
          if (!existingRows.length) return null;
          const connectionId = existingRows[0].connection_id;

          await tx`
            UPDATE custom_endpoint_connections
            SET
              label = ${label},
              capability = ${capability},
              api_style = ${apiStyle},
              endpoint_url = ${endpointUrl},
              requires_auth = ${requiresAuth},
              updated_at = CURRENT_TIMESTAMP
            WHERE connection_id = ${connectionId}
          `;

          const updatedRows = await tx<[{ custom_endpoint_id: number }]>`
            UPDATE custom_endpoints
            SET
              model_name = ${modelName},
              model_ref_id = ${modelRefId},
              num_ctx = ${numCtx},
              extra_config = ${extraConfig},
              has_tools = ${hasTools},
              sees_images = ${seesImages},
              sees_videos = ${seesVideos},
              supports_structoutput = ${supportsStructOutput},
              strict_role_alternation = ${strictRoleAlternation},
              supports_prefix_completion = ${supportsPrefixCompletion},
              is_default = ${isDefault},
              updated_at = CURRENT_TIMESTAMP
            WHERE custom_endpoint_id = ${customEndpointId}
            RETURNING custom_endpoint_id
          `;
          if (!updatedRows.length) {
            throw new Error(`Custom endpoint ${customEndpointId} not found during update`);
          }

          return customEndpointId;
        });
      } else if (serverId !== null) {
        resolvedCustomEndpointId = await sql.begin(async (tx) => {
          const [connRow] = await tx<[{ connection_id: number }]>`
            INSERT INTO custom_endpoint_connections (
              server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
            ) VALUES (
              ${serverId}, NULL, ${label}, ${capability}, ${apiStyle}, ${endpointUrl}, ${requiresAuth}
            )
            ON CONFLICT (server_id, label, capability) WHERE user_id IS NULL
            DO UPDATE SET
              api_style = EXCLUDED.api_style,
              endpoint_url = EXCLUDED.endpoint_url,
              requires_auth = custom_endpoint_connections.requires_auth OR EXCLUDED.requires_auth,
              updated_at = CURRENT_TIMESTAMP
            RETURNING connection_id
          `;
          if (!connRow) return null;
          const connectionId = connRow.connection_id;

          const [epRow] = await tx<[{ custom_endpoint_id: number }]>`
            INSERT INTO custom_endpoints (
              connection_id, model_name, model_ref_id, num_ctx,
              extra_config, has_tools, sees_images, sees_videos,
              supports_structoutput, strict_role_alternation, supports_prefix_completion, is_default
            ) VALUES (
              ${connectionId}, ${modelName}, ${modelRefId}, ${numCtx},
              ${extraConfig}, ${hasTools}, ${seesImages}, ${seesVideos},
              ${supportsStructOutput}, ${strictRoleAlternation}, ${supportsPrefixCompletion}, ${isDefault}
            )
            ON CONFLICT (connection_id, COALESCE(model_name, ''))
            DO UPDATE SET
              model_ref_id = EXCLUDED.model_ref_id,
              num_ctx = EXCLUDED.num_ctx,
              extra_config = EXCLUDED.extra_config,
              has_tools = EXCLUDED.has_tools,
              sees_images = EXCLUDED.sees_images,
              sees_videos = EXCLUDED.sees_videos,
              supports_structoutput = EXCLUDED.supports_structoutput,
              strict_role_alternation = EXCLUDED.strict_role_alternation,
              supports_prefix_completion = EXCLUDED.supports_prefix_completion,
              is_default = EXCLUDED.is_default,
              updated_at = CURRENT_TIMESTAMP
            RETURNING custom_endpoint_id
          `;
          if (!epRow) return null;
          return epRow.custom_endpoint_id;
        });
      } else if (userId !== null) {
        resolvedCustomEndpointId = await sql.begin(async (tx) => {
          const [connRow] = await tx<[{ connection_id: number }]>`
            INSERT INTO custom_endpoint_connections (
              server_id, user_id, label, capability, api_style, endpoint_url, requires_auth
            ) VALUES (
              NULL, ${userId}, ${label}, ${capability}, ${apiStyle}, ${endpointUrl}, ${requiresAuth}
            )
            ON CONFLICT (user_id, label, capability) WHERE server_id IS NULL
            DO UPDATE SET
              api_style = EXCLUDED.api_style,
              endpoint_url = EXCLUDED.endpoint_url,
              requires_auth = custom_endpoint_connections.requires_auth OR EXCLUDED.requires_auth,
              updated_at = CURRENT_TIMESTAMP
            RETURNING connection_id
          `;
          if (!connRow) return null;
          const connectionId = connRow.connection_id;

          const [epRow] = await tx<[{ custom_endpoint_id: number }]>`
            INSERT INTO custom_endpoints (
              connection_id, model_name, model_ref_id, num_ctx,
              extra_config, has_tools, sees_images, sees_videos,
              supports_structoutput, strict_role_alternation, supports_prefix_completion, is_default
            ) VALUES (
              ${connectionId}, ${modelName}, ${modelRefId}, ${numCtx},
              ${extraConfig}, ${hasTools}, ${seesImages}, ${seesVideos},
              ${supportsStructOutput}, ${strictRoleAlternation}, ${supportsPrefixCompletion}, ${isDefault}
            )
            ON CONFLICT (connection_id, COALESCE(model_name, ''))
            DO UPDATE SET
              model_ref_id = EXCLUDED.model_ref_id,
              num_ctx = EXCLUDED.num_ctx,
              extra_config = EXCLUDED.extra_config,
              has_tools = EXCLUDED.has_tools,
              sees_images = EXCLUDED.sees_images,
              sees_videos = EXCLUDED.sees_videos,
              supports_structoutput = EXCLUDED.supports_structoutput,
              strict_role_alternation = EXCLUDED.strict_role_alternation,
              supports_prefix_completion = EXCLUDED.supports_prefix_completion,
              is_default = EXCLUDED.is_default,
              updated_at = CURRENT_TIMESTAMP
            RETURNING custom_endpoint_id
          `;
          if (!epRow) return null;
          return epRow.custom_endpoint_id;
        });
      } else {
        return null;
      }

      if (resolvedCustomEndpointId === null) return null;

      const hydrated = await this.loadCustomEndpointsByIds([resolvedCustomEndpointId]);
      if (!hydrated.length) return null;

      if (serverId !== null && options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      return hydrated[0];
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(`Error upserting custom endpoint ${label}/${capability} for ${owner}:`, error);
      return null;
    }
  }

  /**
   * Deletes a custom endpoint for a server or user.
   *
   * @param params  - Endpoint lookup parameters
   * @param options - Optional cache invalidation options
   */
  async deleteCustomEndpoint(
    params: {
      serverId?: number | null;
      userId?: number | null;
      label: string;
      capability: CustomEndpointCapability;
    },
    options: ChannelLlmCacheOptions = {},
  ): Promise<boolean> {
    const { serverId = null, userId = null, label, capability } = params;

    try {
      const result =
        serverId !== null
          ? await sql`
              DELETE FROM custom_endpoint_connections
              WHERE server_id = ${serverId}
                AND user_id IS NULL
                AND label = ${label}
                AND capability = ${capability}
            `
          : await sql`
              DELETE FROM custom_endpoint_connections
              WHERE user_id = ${userId}
                AND server_id IS NULL
                AND label = ${label}
                AND capability = ${capability}
            `;

      const ok = result.count > 0;
      if (ok && serverId !== null) {
        const { invalidateAllChannelLlmCacheForServer, invalidateChannelLlmCache } = await import(
          "@/utils/cache/channelLlmCacheStore"
        );
        if (options.channelDiscId) {
          invalidateChannelLlmCache(serverId, options.channelDiscId);
        } else {
          invalidateAllChannelLlmCacheForServer(serverId);
        }
        if (options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      }
      return ok;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(`Error deleting custom endpoint ${label}/${capability} for ${owner}:`, error);
      return false;
    }
  }

  /**
   * Deletes a single custom endpoint row by its primary key.
   *
   * Used when removing one model from a label+capability that may hold several. Caller supplies the
   * owning serverId (when server-scoped) so the appropriate caches are invalidated.
   *
   * @param customEndpointId - Primary key of the endpoint row to delete
   * @param options          - Cache invalidation options; serverId triggers channel/tomori cache busts
   */
  async deleteCustomEndpointById(
    customEndpointId: number,
    options: ChannelLlmCacheOptions & { serverId?: number | null } = {},
  ): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM custom_endpoints
        WHERE custom_endpoint_id = ${customEndpointId}
      `;

      const ok = result.count > 0;
      const serverId = options.serverId ?? null;
      if (ok && serverId !== null) {
        const { invalidateAllChannelLlmCacheForServer, invalidateChannelLlmCache } = await import(
          "@/utils/cache/channelLlmCacheStore"
        );
        if (options.channelDiscId) {
          invalidateChannelLlmCache(serverId, options.channelDiscId);
        } else {
          invalidateAllChannelLlmCacheForServer(serverId);
        }
        if (options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      }
      return ok;
    } catch (error) {
      log.error(`Error deleting custom endpoint by id ${customEndpointId}:`, error);
      return false;
    }
  }

  async setDefaultCustomEndpoint(
    params: {
      serverId?: number | null;
      userId?: number | null;
      capability: CustomEndpointCapability;
      customEndpointId: number;
      clearScope?: "label" | "capability";
    },
    options: LlmProviderCacheOptions = {},
  ): Promise<boolean> {
    const { serverId = null, userId = null, clearScope = "label" } = params;

    try {
      const selectedRows =
        serverId !== null
          ? await sql<[{ custom_endpoint_id: number; label: string }]>`
              SELECT ce.custom_endpoint_id, cec.label
              FROM custom_endpoints ce
              JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
              WHERE ce.custom_endpoint_id = ${params.customEndpointId}
                AND cec.server_id = ${serverId}
                AND cec.user_id IS NULL
                AND cec.capability = ${params.capability}
              LIMIT 1
            `
          : userId !== null
            ? await sql<[{ custom_endpoint_id: number; label: string }]>`
                SELECT ce.custom_endpoint_id, cec.label
                FROM custom_endpoints ce
                JOIN custom_endpoint_connections cec ON ce.connection_id = cec.connection_id
                WHERE ce.custom_endpoint_id = ${params.customEndpointId}
                  AND cec.user_id = ${userId}
                  AND cec.server_id IS NULL
                  AND cec.capability = ${params.capability}
                LIMIT 1
              `
            : [];

      const selectedEndpoint = selectedRows[0];
      if (!selectedEndpoint) {
        return false;
      }

      if (serverId !== null) {
        if (clearScope === "capability") {
          await sql`
            UPDATE custom_endpoints ce
            SET is_default = false,
                updated_at = CURRENT_TIMESTAMP
            FROM custom_endpoint_connections cec
            WHERE ce.connection_id = cec.connection_id
              AND cec.server_id = ${serverId}
              AND cec.user_id IS NULL
              AND cec.capability = ${params.capability}
              AND ce.custom_endpoint_id <> ${params.customEndpointId}
              AND ce.is_default = true
          `;
        } else {
          await sql`
            UPDATE custom_endpoints ce
            SET is_default = false,
                updated_at = CURRENT_TIMESTAMP
            FROM custom_endpoint_connections cec
            WHERE ce.connection_id = cec.connection_id
              AND cec.server_id = ${serverId}
              AND cec.user_id IS NULL
              AND cec.label = ${selectedEndpoint.label}
              AND cec.capability = ${params.capability}
              AND ce.custom_endpoint_id <> ${params.customEndpointId}
              AND ce.is_default = true
          `;
        }
      } else if (userId !== null) {
        if (clearScope === "capability") {
          await sql`
            UPDATE custom_endpoints ce
            SET is_default = false,
                updated_at = CURRENT_TIMESTAMP
            FROM custom_endpoint_connections cec
            WHERE ce.connection_id = cec.connection_id
              AND cec.user_id = ${userId}
              AND cec.server_id IS NULL
              AND cec.capability = ${params.capability}
              AND ce.custom_endpoint_id <> ${params.customEndpointId}
              AND ce.is_default = true
          `;
        } else {
          await sql`
            UPDATE custom_endpoints ce
            SET is_default = false,
                updated_at = CURRENT_TIMESTAMP
            FROM custom_endpoint_connections cec
            WHERE ce.connection_id = cec.connection_id
              AND cec.user_id = ${userId}
              AND cec.server_id IS NULL
              AND cec.label = ${selectedEndpoint.label}
              AND cec.capability = ${params.capability}
              AND ce.custom_endpoint_id <> ${params.customEndpointId}
              AND ce.is_default = true
          `;
        }
      }

      const result =
        serverId !== null
          ? await sql`
              UPDATE custom_endpoints ce
              SET is_default = true,
                  updated_at = CURRENT_TIMESTAMP
              FROM custom_endpoint_connections cec
              WHERE ce.connection_id = cec.connection_id
                AND ce.custom_endpoint_id = ${params.customEndpointId}
                AND cec.server_id = ${serverId}
                AND cec.user_id IS NULL
                AND cec.capability = ${params.capability}
            `
          : await sql`
              UPDATE custom_endpoints ce
              SET is_default = true,
                  updated_at = CURRENT_TIMESTAMP
              FROM custom_endpoint_connections cec
              WHERE ce.connection_id = cec.connection_id
                AND ce.custom_endpoint_id = ${params.customEndpointId}
                AND cec.user_id = ${userId}
                AND cec.server_id IS NULL
                AND cec.capability = ${params.capability}
            `;

      const ok = result.count > 0;
      if (ok && serverId !== null && options.serverDiscId) invalidateTomoriStateCache(options.serverDiscId);
      return ok;
    } catch (error) {
      log.error(`Error setting default custom endpoint ${params.customEndpointId}:`, error);
      return false;
    }
  }

  async setActiveCustomEndpoint(params: {
    serverId: number;
    capability: "speech" | "transcription";
    customEndpointId: number;
  }): Promise<boolean> {
    return await this.setDefaultCustomEndpoint({
      serverId: params.serverId,
      capability: params.capability,
      customEndpointId: params.customEndpointId,
      clearScope: "capability",
    });
  }

  /**
   * Upserts an OpenRouter LLM model registration.
   *
   * @param params - {serverId?, userId?, llmId}
   */
  async upsertOpenRouterModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    llmId: number;
  }): Promise<OpenRouterModelRegistrationRow | null> {
    const { serverId = null, userId = null, llmId } = params;

    // Every scoped_model_registrations arbiter here repeats the `<column> IS NOT NULL` half of its
    // partial index predicate. Postgres infers a partial unique index only when the statement's WHERE
    // implies the index's, so dropping that conjunct as redundant makes the upsert fail at runtime with
    // 42P10, "no unique or exclusion constraint matching the ON CONFLICT specification". The same
    // applies to the embedding, diffusion, and video registrations below.
    try {
      const rows =
        serverId !== null
          ? await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, llm_id)
              VALUES (${serverId}, NULL, ${llmId})
              ON CONFLICT (server_id, llm_id) WHERE user_id IS NULL AND llm_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `
          : await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, llm_id)
              VALUES (NULL, ${userId}, ${llmId})
              ON CONFLICT (user_id, llm_id) WHERE server_id IS NULL AND llm_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `;

      if (!rows.length) return null;

      const parsed = openRouterModelRegistrationSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(`Failed to validate OpenRouter model registration for llm_id ${llmId}: ${parsed.error.message}`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(`Error upserting OpenRouter model registration for llm_id ${llmId} on ${owner}:`, error);
      return null;
    }
  }

  /**
   * Deletes an OpenRouter LLM model registration.
   *
   * @param params - {serverId?, userId?, llmId}
   */
  async deleteOpenRouterModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    llmId: number;
  }): Promise<boolean> {
    const { serverId = null, userId = null, llmId } = params;

    try {
      const result =
        serverId !== null
          ? await sql`
              DELETE FROM scoped_model_registrations
              WHERE server_id = ${serverId} AND user_id IS NULL AND llm_id = ${llmId}
            `
          : await sql`
              DELETE FROM scoped_model_registrations
              WHERE user_id = ${userId} AND server_id IS NULL AND llm_id = ${llmId}
            `;
      return result.count > 0;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(`Error deleting OpenRouter model registration for llm_id ${llmId} on ${owner}:`, error);
      return false;
    }
  }

  /**
   * Upserts an OpenRouter embedding model registration.
   *
   * @param params - {serverId?, userId?, embeddingModelId}
   */
  async upsertOpenRouterEmbeddingModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    embeddingModelId: number;
  }): Promise<OpenRouterEmbeddingModelRegistrationRow | null> {
    const { serverId = null, userId = null, embeddingModelId } = params;

    try {
      const rows =
        serverId !== null
          ? await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, embedding_model_id)
              VALUES (${serverId}, NULL, ${embeddingModelId})
              ON CONFLICT (server_id, embedding_model_id) WHERE user_id IS NULL AND embedding_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `
          : await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, embedding_model_id)
              VALUES (NULL, ${userId}, ${embeddingModelId})
              ON CONFLICT (user_id, embedding_model_id) WHERE server_id IS NULL AND embedding_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `;

      if (!rows.length) return null;

      const parsed = openRouterEmbeddingModelRegistrationSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(
          `Failed to validate OpenRouter embedding model registration for embedding_model_id ${embeddingModelId}: ${parsed.error.message}`,
        );
        return null;
      }
      return parsed.data;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error upserting OpenRouter embedding model registration for embedding_model_id ${embeddingModelId} on ${owner}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Deletes an OpenRouter embedding model registration.
   *
   * @param params - {serverId?, userId?, embeddingModelId}
   */
  async deleteOpenRouterEmbeddingModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    embeddingModelId: number;
  }): Promise<boolean> {
    const { serverId = null, userId = null, embeddingModelId } = params;

    try {
      const result =
        serverId !== null
          ? await sql`
              DELETE FROM scoped_model_registrations
              WHERE server_id = ${serverId} AND user_id IS NULL AND embedding_model_id = ${embeddingModelId}
            `
          : await sql`
              DELETE FROM scoped_model_registrations
              WHERE user_id = ${userId} AND server_id IS NULL AND embedding_model_id = ${embeddingModelId}
            `;
      return result.count > 0;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error deleting OpenRouter embedding model registration for embedding_model_id ${embeddingModelId} on ${owner}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Upserts an OpenRouter image model registration.
   *
   * @param params - {serverId?, userId?, diffusionModelId}
   */
  async upsertOpenRouterImageModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    diffusionModelId: number;
  }): Promise<OpenRouterImageModelRegistrationRow | null> {
    const { serverId = null, userId = null, diffusionModelId } = params;

    try {
      const rows =
        serverId !== null
          ? await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, diffusion_model_id)
              VALUES (${serverId}, NULL, ${diffusionModelId})
              ON CONFLICT (server_id, diffusion_model_id) WHERE user_id IS NULL AND diffusion_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `
          : await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, diffusion_model_id)
              VALUES (NULL, ${userId}, ${diffusionModelId})
              ON CONFLICT (user_id, diffusion_model_id) WHERE server_id IS NULL AND diffusion_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `;

      if (!rows.length) return null;

      const parsed = openRouterImageModelRegistrationSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(
          `Failed to validate OpenRouter image model registration for diffusion_model_id ${diffusionModelId}: ${parsed.error.message}`,
        );
        return null;
      }
      return parsed.data;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error upserting OpenRouter image model registration for diffusion_model_id ${diffusionModelId} on ${owner}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Deletes an OpenRouter image model registration.
   *
   * @param params - {serverId?, userId?, diffusionModelId}
   */
  async deleteOpenRouterImageModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    diffusionModelId: number;
  }): Promise<boolean> {
    const { serverId = null, userId = null, diffusionModelId } = params;

    try {
      const result =
        serverId !== null
          ? await sql`
              DELETE FROM scoped_model_registrations
              WHERE server_id = ${serverId} AND user_id IS NULL AND diffusion_model_id = ${diffusionModelId}
            `
          : await sql`
              DELETE FROM scoped_model_registrations
              WHERE user_id = ${userId} AND server_id IS NULL AND diffusion_model_id = ${diffusionModelId}
            `;
      return result.count > 0;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error deleting OpenRouter image model registration for diffusion_model_id ${diffusionModelId} on ${owner}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Upserts an OpenRouter video model registration.
   *
   * @param params - {serverId?, userId?, videoModelId}
   */
  async upsertOpenRouterVideoModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    videoModelId: number;
  }): Promise<OpenRouterVideoModelRegistrationRow | null> {
    const { serverId = null, userId = null, videoModelId } = params;

    try {
      const rows =
        serverId !== null
          ? await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, video_model_id)
              VALUES (${serverId}, NULL, ${videoModelId})
              ON CONFLICT (server_id, video_model_id) WHERE user_id IS NULL AND video_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `
          : await sql`
              INSERT INTO scoped_model_registrations (server_id, user_id, video_model_id)
              VALUES (NULL, ${userId}, ${videoModelId})
              ON CONFLICT (user_id, video_model_id) WHERE server_id IS NULL AND video_model_id IS NOT NULL
              DO UPDATE SET updated_at = CURRENT_TIMESTAMP
              RETURNING *
            `;

      if (!rows.length) return null;

      const parsed = openRouterVideoModelRegistrationSchema.safeParse(rows[0]);
      if (!parsed.success) {
        log.warn(
          `Failed to validate OpenRouter video model registration for video_model_id ${videoModelId}: ${parsed.error.message}`,
        );
        return null;
      }
      return parsed.data;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error upserting OpenRouter video model registration for video_model_id ${videoModelId} on ${owner}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Deletes an OpenRouter video model registration.
   *
   * @param params - {serverId?, userId?, videoModelId}
   */
  async deleteOpenRouterVideoModelRegistration(params: {
    serverId?: number | null;
    userId?: number | null;
    videoModelId: number;
  }): Promise<boolean> {
    const { serverId = null, userId = null, videoModelId } = params;

    try {
      const result =
        serverId !== null
          ? await sql`
              DELETE FROM scoped_model_registrations
              WHERE server_id = ${serverId} AND user_id IS NULL AND video_model_id = ${videoModelId}
            `
          : await sql`
              DELETE FROM scoped_model_registrations
              WHERE user_id = ${userId} AND server_id IS NULL AND video_model_id = ${videoModelId}
            `;
      return result.count > 0;
    } catch (error) {
      const owner = serverId !== null ? `server ${serverId}` : `user ${userId}`;
      log.error(
        `Error deleting OpenRouter video model registration for video_model_id ${videoModelId} on ${owner}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Exports server-scoped provider configuration.
   * Stub: full composition with the unified export pipeline lands in Phase 6 (#16.7).
   *
   * @param ownerId - Internal server DB ID
   */
  async toExportShape(ownerId: string | number): Promise<LlmProviderExportShape | null> {
    const serverId = Number(ownerId);
    if (Number.isNaN(serverId)) return null;
    const savedProviderConfigs = await this.loadSavedProviderConfigs(serverId);
    return { savedProviderConfigs };
  }

  /**
   * Restores server-scoped provider configuration from an export.
   * Stub: full implementation lands in Phase 6 (#16.7).
   */
  async fromExportShape(_ownerId: string | number, _data: LlmProviderExportShape): Promise<boolean> {
    return false;
  }
}

/** Singleton instance: import this in callers. */
export const llmProviderRepo = new LlmProviderRepository();
