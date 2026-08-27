/**
 * ServerRepository: manages server identity, emojis/stickers, managed webhooks,
 * and the personalization blacklist.
 *
 * Also owns the atomic setupServer transaction (creates server + tomori rows).
 * Schedule domain (reminders + random triggers) lives in ServerScheduleRepository.
 *
 * Export contract: toExportShape / fromExportShape are required by IRepository
 * and consumed by the Phase 6 (#16.7) export pipeline composition.
 *
 * Size note: ~1,070 lines after Phase 5.5e Stage C SQL inline. setupServer is a
 * single unavoidably large transaction (~400 SQL lines); splitting it would
 * separate transactional setup context from its server repository owner.
 * See refactor-integrity-audit.md Intentional Large File table.
 */
import type { Guild, GuildEmoji, Sticker } from "discord.js";
import type { ServerEmojiRow, ServerStickerRow, SetupConfig, SetupResult } from "@/types/db/schema";
import { serverEmojiSchema, serverStickerSchema, setupConfigSchema, setupResultSchema } from "@/types/db/schema";
import { toolRepository } from "@/utils/db/repositories/ToolRepository";
import { userRepository } from "@/utils/db/repositories/UserRepository";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import { keyManager } from "@/utils/security/keyManager";
import { getBaseTriggerWords } from "@/utils/text/localizer";
import { dedupeTriggerWords } from "@/utils/text/triggerWords";
import type { IRepository } from "./IRepository";

export const MANAGED_WEBHOOK_KIND_SHARED_CHANNEL = "shared_channel" as const;
type ManagedWebhookKind = typeof MANAGED_WEBHOOK_KIND_SHARED_CHANNEL;

type ManagedDiscordWebhookRow = {
  managed_webhook_id: number;
  guild_disc_id: string;
  kind: ManagedWebhookKind;
  channel_disc_id: string;
  webhook_disc_id: string;
  webhook_token: Buffer;
  key_version: number | null;
  created_at?: Date;
  updated_at?: Date;
};

/** Sync freshness for a server's emoji or sticker set (lazy-sync cache input). */
interface ServerAssetSyncStatus {
  /** Most recent `updated_at` across the rows, or null when none exist. */
  lastUpdated: Date | null;
  /** Number of synced rows for the server. */
  count: number;
}

// biome-ignore lint/suspicious/noExplicitAny: transaction type is complex and internal to Bun's SQL library
type TransactionSql = any;

interface SyncItemExistingMetadata {
  emoji_desc?: string | null;
  sticker_desc?: string | null;
  emotion_key?: string | null;
}

interface SyncItemConfig<TDiscord, TDatabase> {
  tableName: string;
  idColumnName: string;
  nameColumnName: string;
  descColumnName: string;
  conflictColumns: string[];
  mapToDatabase: (item: TDiscord, existing: SyncItemExistingMetadata | undefined, serverId: number) => TDatabase;
  getDiscordId: (item: TDiscord) => string;
}

/** Row shape for server_chat_configs (Phase 6). */
type ServerChatConfigsRow = {
  humanizer_degree: number;
  message_fetch_limit: number;
  send_message_limit: number;
  match_limit: number;
  cascade_limit: number;
  timezone_offset: number;
  self_debug_enabled: boolean;
  model_randomizer_enabled: boolean;
  system_prompt: string | null;
  context_note: string | null;
  context_note_depth: number;
  llm_stop_strings: string[];
  llm_stop_speaker_pattern_enabled: boolean;
  llm_max_output_tokens: number | null;
  llm_top_p: number;
  llm_top_k: number;
  llm_frequency_penalty: number;
  llm_presence_penalty: number;
  llm_min_p: number;
  llm_logit_biases: unknown[];
  fallback_model_refs: unknown[];
};

/** Row shape for server_notice_embeds_configs (Phase 6). */
type ServerNoticeEmbedsConfigsRow = {
  tool_notice_hidden_keys: string[];
};

/** Row shape for server_member_permissions_configs (Phase 6). */
type ServerMemberPermissionsConfigsRow = {
  server_memteaching_enabled: boolean;
  attribute_memteaching_enabled: boolean;
  sampledialogue_memteaching_enabled: boolean;
  self_teaching_enabled: boolean;
  personal_memories_enabled: boolean;
  hide_impersonation_embeds: boolean;
  prompt_snapshot_enabled: boolean;
};

/** Row shape for server_channel_scope_configs (Phase 6). */
type ServerChannelScopeConfigsRow = {
  rp_channel_ids: string[];
  private_channel_ids: string[];
  crosschannel_blocklist_ids: string[];
  stm_privacy_bypass: boolean;
  thought_log_channel_disc_id: string | null;
};

/** Row shape for server_welcome_configs (Phase 6). */
type ServerWelcomeConfigsRow = {
  welcome_channel_disc_id: string | null;
  welcome_prompt: string | null;
  welcome_persona_id: number | null;
};

/**
 * Composite export shape for ServerRepository's Phase 6 config tables.
 * Replaces the old server_disc_id-only stub.
 */
type ServerExportShape = {
  server_disc_id: string;
  chat: ServerChatConfigsRow | null;
  notice_embeds: ServerNoticeEmbedsConfigsRow | null;
  member_permissions: ServerMemberPermissionsConfigsRow | null;
  channel_scope: ServerChannelScopeConfigsRow | null;
  welcome: ServerWelcomeConfigsRow | null;
};

class ServerRepository implements IRepository<ServerExportShape> {
  /**
   * Atomically sets up a new server: creates server, tomori, config, and emoji rows.
   *
   * @param guild  - Discord Guild (null for DM contexts)
   */
  async setup(guild: Guild | null, config: SetupConfig): Promise<SetupResult> {
    return this.sqlSetupServer(guild, config);
  }

  /**
   * Returns the internal server DB ID for a given Discord server snowflake.
   *
   * @returns Internal server ID or null if not found
   */
  async loadServerIdByDiscId(serverDiscId: string): Promise<number | null> {
    try {
      const [row] = await sql<[{ server_id: number }]>`
        SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
      `;
      return row?.server_id ?? null;
    } catch (error) {
      log.error(`Error loading server ID for Discord ID ${serverDiscId}:`, error);
      return null;
    }
  }

  /**
   * Returns the existing Matrix room ID for a Discord channel, if any.
   *
   * @returns Matrix room ID or null if not linked
   */
  async getExistingMatrixLink(channelDiscId: string): Promise<string | null> {
    try {
      const [row] = await sql<[{ matrix_room_id: string }]>`
        SELECT matrix_room_id FROM matrix_channel_links
        WHERE channel_disc_id = ${channelDiscId} LIMIT 1
      `;
      return row?.matrix_room_id ?? null;
    } catch (error) {
      log.error(`Error loading Matrix link for channel ${channelDiscId}:`, error);
      return null;
    }
  }

  /**
   * Returns the Discord channel ID linked to a Matrix room, if any.
   *
   * @returns Discord channel snowflake or null if not linked
   */
  async getDiscordChannelForMatrixRoom(matrixRoomId: string): Promise<string | null> {
    try {
      const [row] = await sql<[{ channel_disc_id: string }]>`
        SELECT channel_disc_id FROM matrix_channel_links
        WHERE matrix_room_id = ${matrixRoomId} LIMIT 1
      `;
      return row?.channel_disc_id ?? null;
    } catch (error) {
      log.error(`Error loading Discord channel for Matrix room ${matrixRoomId}:`, error);
      return null;
    }
  }

  /**
   * Returns true if a user is already blacklisted from personalization on the server.
   *
   */
  async isUserBlacklisted(serverId: number, userDiscId: string): Promise<boolean> {
    try {
      const [row] = await sql<[{ exists: number }]>`
        SELECT 1 FROM personalization_blacklist
        WHERE server_id = ${serverId} AND user_disc_id = ${userDiscId} LIMIT 1
      `;
      return !!row;
    } catch (error) {
      log.error(`Error checking blacklist for server ${serverId}, user ${userDiscId}:`, error);
      return false;
    }
  }

  /**
   * Loads all synced server emojis by internal server ID.
   *
   */
  async loadEmojis(internalServerId: number): Promise<ServerEmojiRow[] | null> {
    return this.sqlLoadServerEmojis(internalServerId);
  }

  /**
   * Loads all synced server stickers by Discord server snowflake.
   *
   */
  async loadStickers(serverDiscId: string): Promise<ServerStickerRow[] | null> {
    return this.sqlLoadServerStickers(serverDiscId);
  }

  /**
   * Used by context builders that already hold the resolved server_id.
   *
   */
  async loadStickersByInternalId(internalServerId: number): Promise<ServerStickerRow[]> {
    try {
      const rows = await sql<ServerStickerRow[]>`
        SELECT sticker_disc_id, sticker_name, sticker_desc, emotion_key, created_at, updated_at
        FROM server_stickers
        WHERE server_id = ${internalServerId}
        ORDER BY created_at ASC
      `;
      return rows ?? [];
    } catch (error) {
      log.error(`Error loading stickers for server ID ${internalServerId}:`, error);
      return [];
    }
  }

  /**
   * Returns how many emojis are synced for a server and when they were last
   * updated. Used by the lazy-sync cache to decide whether a Discord refetch is
   * due. A server with no synced emojis yields `{ lastUpdated: null, count: 0 }`.
   *
   */
  async getEmojiSyncStatus(serverId: number): Promise<ServerAssetSyncStatus> {
    try {
      const [row] = await sql<Array<{ last_updated: Date | null; asset_count: number | string }>>`
        SELECT MAX(updated_at) AS last_updated, COUNT(*) AS asset_count
        FROM server_emojis
        WHERE server_id = ${serverId}
      `;
      return { lastUpdated: row?.last_updated ?? null, count: Number(row?.asset_count ?? 0) };
    } catch (error) {
      log.error(`Error loading emoji sync status for server ${serverId}:`, error);
      return { lastUpdated: null, count: 0 };
    }
  }

  /**
   * Sticker counterpart of {@link getEmojiSyncStatus}.
   *
   */
  async getStickerSyncStatus(serverId: number): Promise<ServerAssetSyncStatus> {
    try {
      const [row] = await sql<Array<{ last_updated: Date | null; asset_count: number | string }>>`
        SELECT MAX(updated_at) AS last_updated, COUNT(*) AS asset_count
        FROM server_stickers
        WHERE server_id = ${serverId}
      `;
      return { lastUpdated: row?.last_updated ?? null, count: Number(row?.asset_count ?? 0) };
    } catch (error) {
      log.error(`Error loading sticker sync status for server ${serverId}:`, error);
      return { lastUpdated: null, count: 0 };
    }
  }

  /**
   * Returns true if the user is blacklisted from the given server.
   *
   */
  async isBlacklisted(serverDiscId: string, userDiscId: string): Promise<boolean> {
    return userRepository.isBlacklisted(serverDiscId, userDiscId);
  }

  /**
   * Returns all blacklisted user Discord IDs for a server.
   *
   */
  async getBlacklistedMemberIds(serverId: number): Promise<string[]> {
    return this.sqlGetBlacklistedMemberIds(serverId);
  }

  /**
   * Returns true if a Brave Search API key is configured for the server.
   *
   */
  async getBraveApiKeyStatus(serverId: number): Promise<boolean> {
    return toolRepository.getBraveApiKeyStatus(serverId);
  }

  /**
   *
   * @param params - Webhook parameters (guildDiscId, kind, channelDiscId, webhookDiscId, rawToken)
   * @returns true on success, false on failure or missing params
   */
  async upsertManagedWebhook(params: {
    guildDiscId: string;
    kind?: ManagedWebhookKind;
    channelDiscId: string;
    webhookDiscId: string;
    rawToken: string;
  }): Promise<boolean> {
    return this.sqlUpsertManagedWebhook(params);
  }

  /**
   * Loads a managed Discord webhook row by channel and kind.
   *
   * @param kind - Webhook kind (defaults to shared_channel)
   */
  async loadManagedWebhookByChannel(
    channelDiscId: string,
    kind: ManagedWebhookKind = MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
  ): Promise<ManagedDiscordWebhookRow | null> {
    return this.sqlLoadManagedWebhookByChannel(channelDiscId, kind);
  }

  /**
   * Loads a managed Discord webhook row by channel and webhook Discord ID.
   *
   * @param kind - Webhook kind (defaults to shared_channel)
   */
  async loadManagedWebhookByChannelAndWebhookId(
    channelDiscId: string,
    webhookDiscId: string,
    kind: ManagedWebhookKind = MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
  ): Promise<ManagedDiscordWebhookRow | null> {
    return this.sqlLoadManagedWebhookByChannelAndWebhookId(channelDiscId, webhookDiscId, kind);
  }

  /**
   * Deletes a managed Discord webhook by channel (and optionally webhook ID).
   *
   * @param webhookDiscId - Optional Discord webhook snowflake
   * @param kind - Webhook kind (defaults to shared_channel)
   */
  async deleteManagedWebhook(
    channelDiscId: string,
    webhookDiscId?: string | null,
    kind: ManagedWebhookKind = MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
  ): Promise<boolean> {
    return this.sqlDeleteManagedWebhook(channelDiscId, webhookDiscId, kind);
  }

  /**
   * Decrypts the token for a managed Discord webhook row, rotating the key if outdated.
   *
   * @param row - ManagedDiscordWebhookRow with encrypted webhook_token
   * @returns Decrypted token string or null on failure
   */
  async decryptManagedWebhookToken(row: ManagedDiscordWebhookRow): Promise<string | null> {
    return this.sqlDecryptManagedWebhookToken(row);
  }

  /**
   * Syncs emojis from Discord to the database within a transaction.
   * Preserves existing metadata (emoji_desc, emotion_key).
   *
   * @param tx - Active PostgreSQL transaction
   * @returns Number of emojis synced
   */
  async syncEmojis(tx: TransactionSql, serverId: number, currentEmojis: GuildEmoji[]): Promise<number> {
    return this.syncItemsToDatabase(tx, serverId, currentEmojis, {
      tableName: "server_emojis",
      idColumnName: "emoji_disc_id",
      nameColumnName: "emoji_name",
      descColumnName: "emoji_desc",
      conflictColumns: ["server_id", "emoji_disc_id"],
      mapToDatabase: (emoji, existing, sid) => ({
        server_id: sid,
        emoji_disc_id: emoji.id,
        emoji_name: emoji.name ?? "",
        emoji_desc: (existing?.emoji_desc as string) ?? "",
        emotion_key: existing?.emotion_key && existing.emotion_key.trim().length > 0 ? existing.emotion_key : "unset",
        is_animated: emoji.animated ?? false,
      }),
      getDiscordId: (emoji) => emoji.id,
    });
  }

  /**
   * Syncs stickers from Discord to the database within a transaction.
   * Preserves existing metadata (sticker_desc, emotion_key).
   *
   * @param tx - Active PostgreSQL transaction
   * @returns Number of stickers synced
   */
  async syncStickers(tx: TransactionSql, serverId: number, currentStickers: Sticker[]): Promise<number> {
    return this.syncItemsToDatabase(tx, serverId, currentStickers, {
      tableName: "server_stickers",
      idColumnName: "sticker_disc_id",
      nameColumnName: "sticker_name",
      descColumnName: "sticker_desc",
      conflictColumns: ["server_id", "sticker_disc_id"],
      mapToDatabase: (sticker, existing, sid) => ({
        server_id: sid,
        sticker_disc_id: sticker.id,
        sticker_name: sticker.name,
        sticker_desc: (existing?.sticker_desc as string) ?? sticker.description ?? "",
        emotion_key: existing?.emotion_key && existing.emotion_key.trim().length > 0 ? existing.emotion_key : "unset",
        sticker_format: sticker.format,
      }),
      getDiscordId: (sticker) => sticker.id,
    });
  }

  private async sqlSetupServer(guild: Guild | null, config: SetupConfig): Promise<SetupResult> {
    const validConfig = setupConfigSchema.parse(config);

    const isDMChannel = guild === null;
    log.section(`Starting server setup transaction (${isDMChannel ? "DM" : "Guild"} context)`);

    try {
      const result = await sql.transaction(async (tx) => {
        let selectedLlm: { llm_id: number; llm_codename: string } | null = null;
        let selectedDiffusionModel: { diffusion_model_id: number; codename: string } | null = null;
        let selectedEmbeddingModel: { embedding_model_id: number; codename: string } | null = null;

        if (validConfig.provider) {
          // Find the default model for the selected provider within the transaction
          // First try to get the default model (is_default = true), excluding deprecated
          selectedLlm = (
            await tx`
              SELECT * FROM llms
              WHERE llm_provider = ${validConfig.provider}
                AND is_default = true
                AND is_deprecated = false
              ORDER BY llm_id ASC
              LIMIT 1
            `
          )[0];

          // Fallback: if no default model found, get the first available non-deprecated model
          if (!selectedLlm) {
            selectedLlm = (
              await tx`
                SELECT * FROM llms
                WHERE llm_provider = ${validConfig.provider}
                  AND is_deprecated = false
                ORDER BY llm_id ASC
                LIMIT 1
              `
            )[0];

            if (!selectedLlm) {
              throw new Error(`No available models found for provider: ${validConfig.provider}`);
            }

            log.warn(
              `No default model found for provider ${validConfig.provider}, using fallback: ${selectedLlm.llm_codename}`,
            );
          } else {
            log.info(`Using default model for ${validConfig.provider}: ${selectedLlm.llm_codename}`);
          }

          // Find the default diffusion model for the selected provider
          selectedDiffusionModel = (
            await tx`
              SELECT * FROM image_diffusion_models
              WHERE provider = ${validConfig.provider}
                AND is_default = true
                AND is_deprecated = false
              ORDER BY diffusion_model_id ASC
              LIMIT 1
            `
          )[0];

          if (!selectedDiffusionModel) {
            selectedDiffusionModel = (
              await tx`
                SELECT * FROM image_diffusion_models
                WHERE provider = ${validConfig.provider}
                  AND is_deprecated = false
                ORDER BY diffusion_model_id ASC
                LIMIT 1
              `
            )[0];

            if (selectedDiffusionModel) {
              log.warn(
                `No default diffusion model found for provider ${validConfig.provider}, using fallback: ${selectedDiffusionModel.codename}`,
              );
            } else {
              log.info(
                `No diffusion models available for provider ${validConfig.provider} (image generation not supported)`,
              );
            }
          } else {
            log.info(`Using default diffusion model for ${validConfig.provider}: ${selectedDiffusionModel.codename}`);
          }

          // Find the default embedding model for the selected provider
          selectedEmbeddingModel = (
            await tx`
              SELECT * FROM embedding_models
              WHERE provider = ${validConfig.provider}
                AND is_default = true
                AND is_deprecated = false
              ORDER BY embedding_model_id ASC
              LIMIT 1
            `
          )[0];

          if (!selectedEmbeddingModel) {
            selectedEmbeddingModel = (
              await tx`
                SELECT * FROM embedding_models
                WHERE provider = ${validConfig.provider}
                  AND is_deprecated = false
                ORDER BY embedding_model_id ASC
                LIMIT 1
              `
            )[0];

            if (selectedEmbeddingModel) {
              log.warn(
                `No default embedding model found for provider ${validConfig.provider}, using fallback: ${selectedEmbeddingModel.codename}`,
              );
            } else {
              log.info(
                `No embedding models available for provider ${validConfig.provider} (document retrieval not supported)`,
              );
            }
          } else {
            log.info(`Using default embedding model for ${validConfig.provider}: ${selectedEmbeddingModel.codename}`);
          }
        } else {
          if (validConfig.userByokMode) {
            log.info("Setup is bootstrapping BYOK-only mode with no server text provider");
          } else if (validConfig.deferredCustomEndpointSetup) {
            log.info("Setup is bootstrapping deferred custom-endpoint mode with no server text provider");
          } else {
            log.info("Setup is bootstrapping with no immediate server text provider");
          }
        }

        const selectedLlmId = selectedLlm ? selectedLlm.llm_id : null;
        const selectedDiffusionModelId = selectedDiffusionModel ? selectedDiffusionModel.diffusion_model_id : null;
        const selectedEmbeddingModelId = selectedEmbeddingModel ? selectedEmbeddingModel.embedding_model_id : null;

        const presetRows = await tx<
          Array<{
            preset_trigger_words: string[] | null;
            persona_preset_desc: string | null;
          }>
        >`
          SELECT preset_trigger_words, persona_preset_desc
          FROM persona_presets
          WHERE persona_preset_id = ${validConfig.presetId}
          LIMIT 1
        `;
        const presetTriggerCandidates =
          presetRows[0]?.preset_trigger_words?.filter(
            (trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0,
          ) ?? [];
        const dedupedPresetTriggers = dedupeTriggerWords(presetTriggerCandidates, { lowercase: false });

        const defaultTriggers =
          dedupedPresetTriggers.length > 0 ? dedupedPresetTriggers : getBaseTriggerWords(validConfig.locale);
        const presetPersonaPrompt = presetRows[0]?.persona_preset_desc?.trim() || null;

        const [server] = await tx`
          INSERT INTO servers (server_disc_id, is_dm_channel, registration_locale)
          VALUES (${validConfig.serverId}, ${isDMChannel}, ${validConfig.registrationLocale})
          ON CONFLICT (server_disc_id) DO UPDATE
          SET is_dm_channel = EXCLUDED.is_dm_channel
          RETURNING *
        `;

        // Setup reaches here only when the server has no main persona, and it deliberately
        // preserves alters while clearing config rows. An alter can therefore already hold the
        // default name (swapPersona demotes the old main into one), and the persona INSERT below
        // is the only write in this transaction without an ON CONFLICT clause, so the collision
        // surfaced as a raw constraint violation that blocked recovery entirely.
        // Suffixing the alter rather than the incoming main matches the priority schema.sql
        // already applies to legacy duplicates: `ORDER BY is_alter ASC` keeps mains unsuffixed.
        await tx`
          UPDATE personas
          SET persona_nickname = persona_nickname || ' [dup-' || persona_id::TEXT || ']'
          WHERE server_id = ${server.server_id}
            AND is_alter = true
            AND lower(btrim(persona_nickname)) = lower(btrim(${validConfig.tomoriName}))
        `;

        const [tomori] = await tx`
          INSERT INTO personas (
            server_id,
            persona_nickname,
            attribute_list,
            sample_dialogues_in,
            sample_dialogues_out,
            persona_lineage_id,
            is_pointer,
            preset_lineage_id,
            preset_language
          )
          VALUES (
            ${server.server_id},
            ${validConfig.tomoriName},
            (SELECT preset_attribute_list FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
            (SELECT preset_sample_dialogues_in FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
            (SELECT preset_sample_dialogues_out FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
            COALESCE(
              (SELECT preset_lineage_id FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
              nextval('persona_lineage_id_seq')
            ),
            (SELECT preset_lineage_id IS NOT NULL FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
            (SELECT preset_lineage_id FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId}),
            (SELECT preset_language FROM persona_presets WHERE persona_preset_id = ${validConfig.presetId})
          )
          RETURNING *
        `;

        await tx`
          INSERT INTO persona_attributes (persona_id, attribute_order, attribute_text, is_public)
          SELECT
            ${tomori.persona_id},
            attr.ord::INT,
            attr.attribute_text,
            COALESCE(pp.preset_attribute_public_flags[attr.ord::INT], false)
          FROM persona_presets pp
          CROSS JOIN LATERAL unnest(COALESCE(pp.preset_attribute_list, ARRAY[]::TEXT[]))
            WITH ORDINALITY AS attr(attribute_text, ord)
          WHERE pp.persona_preset_id = ${validConfig.presetId}
          ON CONFLICT (persona_id, attribute_order) DO UPDATE
          SET
            attribute_text = EXCLUDED.attribute_text,
            is_public = EXCLUDED.is_public,
            updated_at = NOW()
        `;

        // Format trigger words as PostgreSQL array
        const triggerWordsArrayLiteral = `{${defaultTriggers.map((t) => `"${t.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;

        // Seed the split config tables
        await tx`
          INSERT INTO server_model_configs (
            server_id, llm_id, embedding_model_id, diffusion_model_id, api_key, key_version
          ) VALUES (
            ${server.server_id}, ${selectedLlmId}, ${selectedEmbeddingModelId}, ${selectedDiffusionModelId}, ${validConfig.encryptedApiKey}, ${validConfig.keyVersion}
          ) ON CONFLICT (server_id) DO NOTHING
        `;
        // system_prompt stays NULL so DEFAULT_SYSTEM_PROMPT resolves at read time.
        // Seeding it here froze every server on the constant's value at setup, which
        // is why tuning the default needed a migration to reach anyone.
        await tx`
          INSERT INTO server_chat_configs (
            server_id, humanizer_degree, timezone_offset
          ) VALUES (
            ${server.server_id}, ${validConfig.humanizer}, ${validConfig.timezoneOffset}
          ) ON CONFLICT (server_id) DO NOTHING
        `;
        await tx`
          INSERT INTO server_member_permissions_configs (
            server_id, attribute_memteaching_enabled, sampledialogue_memteaching_enabled
          ) VALUES (
            ${server.server_id}, ${isDMChannel}, ${isDMChannel}
          ) ON CONFLICT (server_id) DO NOTHING
        `;
        await tx`
          INSERT INTO server_byok_configs (server_id, user_byok_mode)
          VALUES (${server.server_id}, ${validConfig.userByokMode})
          ON CONFLICT (server_id) DO NOTHING
        `;
        await tx`INSERT INTO server_notice_embeds_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_channel_scope_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_welcome_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_trigger_behavior_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_auto_trigger_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_capabilities_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_novelai_imagegen_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_nsfw_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_speech_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;
        await tx`INSERT INTO server_memory_configs (server_id) VALUES (${server.server_id}) ON CONFLICT (server_id) DO NOTHING`;

        await tx`
          INSERT INTO persona_configs (persona_id, trigger_words, persona_prompt)
          VALUES (${tomori.persona_id}, ${triggerWordsArrayLiteral}::text[], ${presetPersonaPrompt})
          ON CONFLICT (persona_id) DO NOTHING
        `;

        // Seed the saved_provider_configs row for the provider registered at setup.
        if (validConfig.provider && validConfig.encryptedApiKey && selectedLlmId) {
          await tx`
            INSERT INTO saved_provider_configs (
              server_id, provider, api_key, key_version,
              llm_id, diffusion_model_id, embedding_model_id,
              nai_diffusion_model_id, video_model_id, vision_llm_id,
              nai_preset_name, thinking_level, fallback_model_refs,
              llm_temperature, llm_top_p, llm_top_k,
              llm_frequency_penalty, llm_presence_penalty, llm_min_p,
              llm_max_output_tokens,
              llm_logit_biases, llm_disabled_params
            ) VALUES (
              ${server.server_id}, ${validConfig.provider}, ${validConfig.encryptedApiKey}, ${validConfig.keyVersion},
              ${selectedLlmId}, ${selectedDiffusionModelId}, ${selectedEmbeddingModelId},
              NULL, NULL, NULL,
              NULL, 'auto', '[]'::jsonb,
              NULL, NULL, NULL,
              NULL, NULL, NULL,
              NULL,
              '[]'::jsonb, '{}'::text[]
            )
            ON CONFLICT (server_id, provider) DO NOTHING
          `;
        }

        // Register guild emojis in bulk insert (only for guild contexts)
        const emojis = [];
        if (!isDMChannel && guild) {
          const emojiValues = Array.from(guild.emojis.cache.values()).map((e) => ({
            emoji_disc_id: e.id,
            emoji_name: e.name ?? "",
            emotion_key: "unset",
            is_animated: e.animated || false,
          }));

          for (const { emoji_disc_id, emoji_name, emotion_key, is_animated } of emojiValues) {
            const [row] = await tx`
              INSERT INTO server_emojis (
                server_id,
                emoji_disc_id,
                emoji_name,
                emotion_key,
                is_animated
              )
              VALUES (
                ${server.server_id},
                ${emoji_disc_id},
                ${emoji_name},
                ${emotion_key},
                ${is_animated}
              )
              RETURNING *
            `;
            emojis.push(row);
          }
        } else {
          log.info("Skipping emoji registration for DM context");
        }

        // Register guild stickers (only for guild contexts)
        const stickers = [];
        if (!isDMChannel && guild) {
          log.info(`Registering stickers for server ${server.server_id}`);
          const stickerValues = Array.from(guild.stickers.cache.values()).map((s) => ({
            sticker_disc_id: s.id,
            sticker_name: s.name,
            sticker_desc: s.description ?? "",
            emotion_key: "unset",
            sticker_format: s.format,
          }));

          for (const { sticker_disc_id, sticker_name, sticker_desc, emotion_key, sticker_format } of stickerValues) {
            const [row] = await tx`
              INSERT INTO server_stickers (
                server_id,
                sticker_disc_id,
                sticker_name,
                sticker_desc,
                emotion_key,
                sticker_format
              ) VALUES (
                ${server.server_id},
                ${sticker_disc_id},
                ${sticker_name},
                ${sticker_desc},
                ${emotion_key},
                ${sticker_format}
              )
              ON CONFLICT (server_id, sticker_disc_id) DO NOTHING
              RETURNING *
            `;
            if (row) {
              stickers.push(row);
            }
          }
          log.info(`Finished registering ${stickers.length} stickers.`);
        } else {
          log.info("Skipping sticker registration for DM context");
        }

        return {
          server,
          tomori,
          config,
          emojis,
          stickers,
        };
      });

      setupResultSchema.parse(result);

      log.success(
        `${isDMChannel ? "DM pseudo-server" : "Server"} setup completed successfully for Server ID (${validConfig.serverId})`,
      );
      if (!isDMChannel) {
        log.info(`Registered ${result.emojis.length} emojis and ${result.stickers.length} stickers`);
      } else {
        log.info("DM setup completed - emoji/sticker registration skipped");
      }

      return result;
    } catch (error) {
      log.error("Server setup transaction failed:", error);
      throw error;
    }
  }

  private async sqlLoadServerEmojis(internalServerId: number): Promise<ServerEmojiRow[] | null> {
    try {
      const emojiRows = await sql`
        SELECT *
        FROM server_emojis
        WHERE server_id = ${internalServerId}
      `;

      if (!emojiRows || emojiRows.length === 0) {
        return null;
      }

      const parsedEmojis = serverEmojiSchema.array().safeParse(emojiRows);

      if (!parsedEmojis.success) {
        log.error(`Failed to validate emojis for server ID ${internalServerId}:`, parsedEmojis.error.flatten());
        return null;
      }

      return parsedEmojis.data;
    } catch (error) {
      log.error(`Error loading emojis for server ID ${internalServerId}:`, error);
      return null;
    }
  }

  private async sqlLoadServerStickers(serverDiscId: string): Promise<ServerStickerRow[] | null> {
    try {
      const [server] = await sql`
        SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
      `;

      if (!server?.server_id) {
        log.warn(`Server not found in DB with Discord ID: ${serverDiscId} when trying to load stickers.`);
        return null;
      }
      // biome-ignore lint/style/noNonNullAssertion: server check guarantees server_id (Rule 8)
      const serverId = server.server_id!;

      const stickersData = await sql`
        SELECT sticker_id, server_id, sticker_disc_id, sticker_name, sticker_desc, emotion_key, format_type, is_global, created_at, updated_at
        FROM server_stickers
        WHERE server_id = ${serverId}
      `;

      if (!stickersData) {
        log.warn(`Stickers data was unexpectedly null for server ID: ${serverId} (Discord ID: ${serverDiscId})`);
        return [];
      }
      if (stickersData.length === 0) {
        log.info(`No stickers found in DB for server ID: ${serverId} (Discord ID: ${serverDiscId})`);
        return [];
      }

      const validatedStickers: ServerStickerRow[] = [];
      for (const sticker of stickersData) {
        const parsed = serverStickerSchema.safeParse(sticker);
        if (parsed.success) {
          validatedStickers.push(parsed.data);
        } else {
          log.warn(
            `Invalid sticker data found in DB for server ${serverId}, sticker_disc_id ${sticker.sticker_disc_id}: ${JSON.stringify(sticker)}. Errors: ${parsed.error.flatten()}`,
          );
        }
      }
      log.info(`Loaded ${validatedStickers.length} stickers for server ID ${serverId}.`);
      return validatedStickers;
    } catch (error) {
      log.error(`Error loading stickers for server Discord ID ${serverDiscId}:`, error);
      return null;
    }
  }

  private async sqlGetBlacklistedMemberIds(serverId: number): Promise<string[]> {
    try {
      const result = await sql`
        SELECT user_disc_id FROM personalization_blacklist
        WHERE server_id = ${serverId}
        ORDER BY user_disc_id ASC
      `;

      if (!result || result.length === 0) {
        return [];
      }

      // Map to array of Discord IDs
      const memberIds = result.map((row: unknown) => (row as { user_disc_id: string }).user_disc_id);
      log.info(`Found ${memberIds.length} blacklisted members for server ${serverId}`);
      return memberIds;
    } catch (error) {
      log.error(`Error loading blacklisted members for server ${serverId}:`, error);
      return [];
    }
  }

  private async sqlUpsertManagedWebhook(params: {
    guildDiscId: string;
    kind?: ManagedWebhookKind;
    channelDiscId: string;
    webhookDiscId: string;
    rawToken: string;
  }): Promise<boolean> {
    const { guildDiscId, kind = MANAGED_WEBHOOK_KIND_SHARED_CHANNEL, channelDiscId, webhookDiscId, rawToken } = params;

    if (!guildDiscId || !channelDiscId || !webhookDiscId || !rawToken.trim()) {
      log.warn("[ManagedWebhookDb] Missing required parameters for webhook upsert");
      return false;
    }

    try {
      const currentKey = keyManager.getCurrentKey();
      const currentVersion = keyManager.getCurrentVersion();

      await sql`
        INSERT INTO discord_managed_webhooks (
          guild_disc_id, kind, channel_disc_id, webhook_disc_id, webhook_token, key_version
        )
        VALUES (
          ${guildDiscId}, ${kind}, ${channelDiscId}, ${webhookDiscId},
          pgp_sym_encrypt(${rawToken.trim()}, ${currentKey}, 'compress-algo=1, cipher-algo=aes256'),
          ${currentVersion}
        )
        ON CONFLICT (kind, channel_disc_id) DO UPDATE SET
          guild_disc_id = EXCLUDED.guild_disc_id,
          webhook_disc_id = EXCLUDED.webhook_disc_id,
          webhook_token = EXCLUDED.webhook_token,
          key_version = EXCLUDED.key_version,
          updated_at = CURRENT_TIMESTAMP
      `;

      return true;
    } catch (error) {
      log.error(
        `[ManagedWebhookDb] Failed to upsert webhook for guild ${guildDiscId}, channel ${channelDiscId}`,
        error,
      );
      return false;
    }
  }

  private async sqlLoadManagedWebhookByChannel(
    channelDiscId: string,
    kind: ManagedWebhookKind,
  ): Promise<ManagedDiscordWebhookRow | null> {
    if (!channelDiscId) return null;

    try {
      const [row] = await sql`
        SELECT managed_webhook_id, guild_disc_id, kind, channel_disc_id, webhook_disc_id,
               webhook_token, key_version, created_at, updated_at
        FROM discord_managed_webhooks
        WHERE channel_disc_id = ${channelDiscId} AND kind = ${kind}
        LIMIT 1
      `;

      return (row as ManagedDiscordWebhookRow | undefined) ?? null;
    } catch (error) {
      log.error(`[ManagedWebhookDb] Failed to load stored webhook for channel ${channelDiscId}`, error);
      return null;
    }
  }

  private async sqlLoadManagedWebhookByChannelAndWebhookId(
    channelDiscId: string,
    webhookDiscId: string,
    kind: ManagedWebhookKind,
  ): Promise<ManagedDiscordWebhookRow | null> {
    if (!channelDiscId || !webhookDiscId) return null;

    try {
      const [row] = await sql`
        SELECT managed_webhook_id, guild_disc_id, kind, channel_disc_id, webhook_disc_id,
               webhook_token, key_version, created_at, updated_at
        FROM discord_managed_webhooks
        WHERE channel_disc_id = ${channelDiscId}
          AND webhook_disc_id = ${webhookDiscId}
          AND kind = ${kind}
        LIMIT 1
      `;

      return (row as ManagedDiscordWebhookRow | undefined) ?? null;
    } catch (error) {
      log.error(
        `[ManagedWebhookDb] Failed to load stored webhook for channel ${channelDiscId} and webhook ${webhookDiscId}`,
        error,
      );
      return null;
    }
  }

  private async sqlDeleteManagedWebhook(
    channelDiscId: string,
    webhookDiscId: string | null | undefined,
    kind: ManagedWebhookKind,
  ): Promise<boolean> {
    if (!channelDiscId) return false;

    try {
      const result =
        webhookDiscId && webhookDiscId.trim().length > 0
          ? await sql`
              DELETE FROM discord_managed_webhooks
              WHERE channel_disc_id = ${channelDiscId}
                AND webhook_disc_id = ${webhookDiscId}
                AND kind = ${kind}
            `
          : await sql`
              DELETE FROM discord_managed_webhooks
              WHERE channel_disc_id = ${channelDiscId} AND kind = ${kind}
            `;

      return result.count > 0;
    } catch (error) {
      log.error(
        `[ManagedWebhookDb] Failed to delete stored webhook for channel ${channelDiscId}${webhookDiscId ? ` and webhook ${webhookDiscId}` : ""}`,
        error,
      );
      return false;
    }
  }

  private async sqlDecryptManagedWebhookToken(row: ManagedDiscordWebhookRow): Promise<string | null> {
    if (!row.webhook_token || row.webhook_token.length === 0) return null;

    try {
      const keyVersion = row.key_version || 1;
      const key = keyManager.getKey(keyVersion);

      const [result] = await sql`
        SELECT pgp_sym_decrypt(${row.webhook_token}, ${key}) AS decrypted_token
      `;

      if (!result?.decrypted_token) {
        log.warn(`[ManagedWebhookDb] Decryption returned empty for stored webhook ${row.webhook_disc_id}`);
        return null;
      }

      const decryptedToken = result.decrypted_token.toString();
      const currentVersion = keyManager.getCurrentVersion();
      if (keyVersion !== currentVersion) {
        const currentKey = keyManager.getCurrentKey();
        await sql`
          UPDATE discord_managed_webhooks
          SET webhook_token = pgp_sym_encrypt(${decryptedToken}, ${currentKey}, 'compress-algo=1, cipher-algo=aes256'),
              key_version = ${currentVersion},
              updated_at = CURRENT_TIMESTAMP
          WHERE managed_webhook_id = ${row.managed_webhook_id}
        `;
      }

      return decryptedToken;
    } catch (error) {
      log.error(`[ManagedWebhookDb] Failed to decrypt stored webhook token for ${row.webhook_disc_id}`, error);
      return null;
    }
  }

  /**
   * Must stay idempotent (upsert-only, no counters or append-style writes). Its callers wrap
   * the enclosing transaction in `withTransientDbRetry`, which replays the whole reconcile
   * when Bun's pool retires the connection mid-sync.
   */
  private async syncItemsToDatabase<TDiscord, TDatabase extends Record<string, unknown>>(
    tx: TransactionSql,
    serverId: number,
    currentItems: TDiscord[],
    config: SyncItemConfig<TDiscord, TDatabase>,
  ): Promise<number> {
    const existingItems = await tx.unsafe(`
      SELECT ${config.idColumnName}, ${config.descColumnName}, emotion_key
      FROM ${config.tableName}
      WHERE server_id = ${serverId}
    `);

    const existingMetadata = new Map<string, SyncItemExistingMetadata>(
      existingItems.map((item: { [key: string]: string | null }) => [
        item[config.idColumnName] as string,
        item as SyncItemExistingMetadata,
      ]),
    );

    const dbItems = currentItems.map((item) => {
      const discordId = config.getDiscordId(item);
      const existing = existingMetadata.get(discordId);
      return config.mapToDatabase(item, existing, serverId);
    });

    log.info(`[Sync] Prepared ${dbItems.length} ${config.tableName} for upsert`);

    if (dbItems.length > 0) {
      const [beforeCount] = await tx.unsafe(
        `SELECT COUNT(*) as count FROM ${config.tableName} WHERE server_id = ${serverId}`,
      );
      log.info(`[Sync] BEFORE bulk insert: ${beforeCount.count} ${config.tableName} exist`);

      for (const item of dbItems) {
        if (config.tableName === "server_emojis") {
          await tx`
            INSERT INTO server_emojis (server_id, emoji_disc_id, emoji_name, emoji_desc, emotion_key, is_animated)
            VALUES (${item.server_id}, ${item.emoji_disc_id}, ${item.emoji_name}, ${item.emoji_desc}, ${item.emotion_key}, ${item.is_animated})
            ON CONFLICT (server_id, emoji_disc_id) DO UPDATE SET
              emoji_name = EXCLUDED.emoji_name, emoji_desc = EXCLUDED.emoji_desc,
              emotion_key = EXCLUDED.emotion_key, is_animated = EXCLUDED.is_animated,
              updated_at = CURRENT_TIMESTAMP
          `;
        } else {
          await tx`
            INSERT INTO server_stickers (server_id, sticker_disc_id, sticker_name, sticker_desc, emotion_key, sticker_format)
            VALUES (${item.server_id}, ${item.sticker_disc_id}, ${item.sticker_name}, ${item.sticker_desc}, ${item.emotion_key}, ${item.sticker_format})
            ON CONFLICT (server_id, sticker_disc_id) DO UPDATE SET
              sticker_name = EXCLUDED.sticker_name, sticker_desc = EXCLUDED.sticker_desc,
              emotion_key = EXCLUDED.emotion_key, sticker_format = EXCLUDED.sticker_format,
              updated_at = CURRENT_TIMESTAMP
          `;
        }
      }

      const [afterCount] = await tx.unsafe(
        `SELECT COUNT(*) as count FROM ${config.tableName} WHERE server_id = ${serverId}`,
      );
      log.success(`[Sync] AFTER bulk insert: ${afterCount.count} ${config.tableName} in database`);
    }

    const currentDiscordIds = currentItems.map(config.getDiscordId);

    if (currentDiscordIds.length > 0) {
      const dbItemsForCleanup = await tx.unsafe(
        `SELECT ${config.idColumnName}, ${config.nameColumnName} FROM ${config.tableName} WHERE server_id = ${serverId}`,
      );

      const currentIdSet = new Set(currentDiscordIds);
      const toDelete = dbItemsForCleanup.filter(
        (item: { [key: string]: string }) => !currentIdSet.has(item[config.idColumnName]),
      );

      if (toDelete.length > 0) {
        log.info(`[Sync] Found ${toDelete.length} stale ${config.tableName} to delete`);

        if (config.tableName === "server_emojis") {
          for (const item of toDelete) {
            await tx`
              DELETE FROM server_emojis
              WHERE server_id = ${serverId} AND emoji_disc_id = ${item[config.idColumnName]}
            `;
          }
        } else {
          for (const item of toDelete) {
            await tx`
              DELETE FROM server_stickers
              WHERE server_id = ${serverId} AND sticker_disc_id = ${item[config.idColumnName]}
            `;
          }
        }

        log.warn(`[Sync] Removed ${toDelete.length} stale ${config.tableName}`);
      }
    } else {
      let deletedCount = 0;
      if (config.tableName === "server_emojis") {
        const result = await tx`DELETE FROM server_emojis WHERE server_id = ${serverId}`;
        deletedCount = result.count || 0;
      } else {
        const result = await tx`DELETE FROM server_stickers WHERE server_id = ${serverId}`;
        deletedCount = result.count || 0;
      }
      if (deletedCount > 0) {
        log.info(`[Sync] Removed all ${deletedCount} ${config.tableName} (none in Discord)`);
      }
    }

    const [verifyCount] = await tx.unsafe(
      `SELECT COUNT(*) as count FROM ${config.tableName} WHERE server_id = ${serverId}`,
    );

    log.info(`[Sync] PRE-COMMIT verification: ${verifyCount.count} ${config.tableName} in transaction`);

    const actualCount = Number(verifyCount.count);
    const expectedCount = currentItems.length;

    if (actualCount !== expectedCount) {
      log.error(`[Sync] CRITICAL: Pre-commit count mismatch! Expected ${expectedCount}, got ${actualCount}`);
      throw new Error(
        `Sync transaction integrity violation: expected ${expectedCount} items, but transaction has ${actualCount}`,
      );
    }

    return currentItems.length;
  }

  /**
   * Reads chat, notice-embeds, member-permissions, channel-scope, and welcome
   * configs for the given server from their Phase 6 tables.
   *
   */
  async toExportShape(ownerId: string | number): Promise<ServerExportShape | null> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerInternalId(serverDiscId);
    if (!serverId) return null;

    const [chat, noticeEmbeds, memberPerms, channelScope, welcome] = await Promise.all([
      this.sqlLoadChatConfigs(serverId),
      this.sqlLoadNoticeEmbedsConfigs(serverId),
      this.sqlLoadMemberPermissionsConfigs(serverId),
      this.sqlLoadChannelScopeConfigs(serverId),
      this.sqlLoadWelcomeConfigs(serverId),
    ]);

    return {
      server_disc_id: serverDiscId,
      chat,
      notice_embeds: noticeEmbeds,
      member_permissions: memberPerms,
      channel_scope: channelScope,
      welcome,
    };
  }

  /**
   * Restores ServerRepository-owned config table rows for a server.
   */
  async fromExportShape(ownerId: string | number, data: ServerExportShape): Promise<boolean> {
    const serverDiscId = String(ownerId);
    const serverId = await this.resolveServerInternalId(serverDiscId);
    if (!serverId) {
      log.error(`ServerRepository.fromExportShape: server ${serverDiscId} not found`);
      return false;
    }

    try {
      const ops: Promise<void>[] = [];

      if (data.chat) ops.push(this.sqlUpsertChatConfigs(serverId, data.chat));
      if (data.notice_embeds) ops.push(this.sqlUpsertNoticeEmbedsConfigs(serverId, data.notice_embeds));
      if (data.member_permissions) ops.push(this.sqlUpsertMemberPermissionsConfigs(serverId, data.member_permissions));
      if (data.channel_scope) ops.push(this.sqlUpsertChannelScopeConfigs(serverId, data.channel_scope));
      if (data.welcome) ops.push(this.sqlUpsertWelcomeConfigs(serverId, data.welcome));

      await Promise.all(ops);
      return true;
    } catch (error) {
      log.error(`ServerRepository.fromExportShape: write failed for ${serverDiscId}:`, error);
      return false;
    }
  }

  async addUserBlacklist(serverId: number, userDiscId: string): Promise<boolean> {
    try {
      await sql`
        INSERT INTO personalization_blacklist (server_id, user_disc_id)
        VALUES (${serverId}, ${userDiscId})
        ON CONFLICT DO NOTHING
      `;
      return true;
    } catch (e) {
      log.error(`Error adding user blacklist for server ${serverId}:`, e);
      return false;
    }
  }

  async removeUserBlacklist(serverId: number, userDiscId: string): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM personalization_blacklist
        WHERE server_id = ${serverId} AND user_disc_id = ${userDiscId}
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error removing user blacklist for server ${serverId}:`, e);
      return false;
    }
  }

  /**
   * Batch-remove multiple users from the server's personalization blacklist.
   * Single round trip via `user_disc_id = ANY(...)`: preferable to looping
   * `removeUserBlacklist` when removing several IDs at once.
   *
   * @param userDiscIds - Discord IDs of users to remove from the blacklist
   * @returns Number of rows actually deleted
   */
  async removeUserBlacklistMany(serverId: number, userDiscIds: string[]): Promise<number> {
    if (userDiscIds.length === 0) return 0;
    try {
      const result = await sql`
        DELETE FROM personalization_blacklist
        WHERE server_id = ${serverId}
          AND user_disc_id = ANY(${sql.array(userDiscIds, "TEXT")})
        RETURNING server_id
      `;
      return result.length;
    } catch (e) {
      log.error(`Error batch-removing user blacklist entries for server ${serverId}:`, e);
      return 0;
    }
  }

  async linkMatrix(serverId: number, channelDiscId: string, matrixRoomId: string): Promise<boolean> {
    try {
      await sql`
        INSERT INTO matrix_channel_links (server_id, channel_disc_id, matrix_room_id)
        VALUES (${serverId}, ${channelDiscId}, ${matrixRoomId})
        ON CONFLICT (channel_disc_id) DO UPDATE
          SET matrix_room_id = EXCLUDED.matrix_room_id
      `;
      return true;
    } catch (e) {
      log.error(`Error linking matrix room for server ${serverId}:`, e);
      return false;
    }
  }

  async unlinkMatrix(channelDiscId: string): Promise<boolean> {
    try {
      const result = await sql`
        DELETE FROM matrix_channel_links
        WHERE channel_disc_id = ${channelDiscId}
        RETURNING *
      `;
      return result.length > 0;
    } catch (e) {
      log.error(`Error unlinking matrix room for channel ${channelDiscId}:`, e);
      return false;
    }
  }

  private async resolveServerInternalId(serverDiscId: string): Promise<number | null> {
    const [row] = await sql`
      SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
    `;
    return (row?.server_id as number | undefined) ?? null;
  }

  private async sqlLoadChatConfigs(serverId: number): Promise<ServerChatConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT humanizer_degree, message_fetch_limit, send_message_limit, match_limit,
               cascade_limit, timezone_offset, self_debug_enabled, model_randomizer_enabled,
               system_prompt,
               context_note, context_note_depth, llm_stop_strings,
               llm_stop_speaker_pattern_enabled, llm_max_output_tokens,
               llm_top_p, llm_top_k, llm_frequency_penalty, llm_presence_penalty,
               llm_min_p, llm_logit_biases, fallback_model_refs
        FROM server_chat_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerChatConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_chat_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadNoticeEmbedsConfigs(serverId: number): Promise<ServerNoticeEmbedsConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT tool_notice_hidden_keys FROM server_notice_embeds_configs WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerNoticeEmbedsConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_notice_embeds_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadMemberPermissionsConfigs(serverId: number): Promise<ServerMemberPermissionsConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT server_memteaching_enabled, attribute_memteaching_enabled,
               sampledialogue_memteaching_enabled, self_teaching_enabled,
               personal_memories_enabled, hide_impersonation_embeds, prompt_snapshot_enabled
        FROM server_member_permissions_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerMemberPermissionsConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_member_permissions_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadChannelScopeConfigs(serverId: number): Promise<ServerChannelScopeConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT rp_channel_ids, private_channel_ids, crosschannel_blocklist_ids,
               stm_privacy_bypass, thought_log_channel_disc_id
        FROM server_channel_scope_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerChannelScopeConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_channel_scope_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlLoadWelcomeConfigs(serverId: number): Promise<ServerWelcomeConfigsRow | null> {
    try {
      const [row] = await sql`
        SELECT welcome_channel_disc_id, welcome_prompt, welcome_persona_id
        FROM server_welcome_configs
        WHERE server_id = ${serverId}
      `;
      return row ? (row as unknown as ServerWelcomeConfigsRow) : null;
    } catch (error) {
      log.error(`Error loading server_welcome_configs for server ${serverId}:`, error);
      return null;
    }
  }

  private async sqlUpsertChatConfigs(serverId: number, row: ServerChatConfigsRow): Promise<void> {
    const logitBiasesJson = JSON.stringify(row.llm_logit_biases);
    const fallbackRefsJson = JSON.stringify(row.fallback_model_refs);
    await sql`
      INSERT INTO server_chat_configs (
        server_id, humanizer_degree, message_fetch_limit, send_message_limit,
        match_limit, cascade_limit, timezone_offset, self_debug_enabled,
        model_randomizer_enabled,
        system_prompt, context_note, context_note_depth, llm_stop_strings,
        llm_stop_speaker_pattern_enabled, llm_max_output_tokens,
        llm_top_p, llm_top_k, llm_frequency_penalty, llm_presence_penalty,
        llm_min_p, llm_logit_biases, fallback_model_refs
      ) VALUES (
        ${serverId}, ${row.humanizer_degree}, ${row.message_fetch_limit},
        ${row.send_message_limit}, ${row.match_limit}, ${row.cascade_limit},
        ${row.timezone_offset}, ${row.self_debug_enabled}, ${row.model_randomizer_enabled},
        ${row.system_prompt},
        ${row.context_note}, ${row.context_note_depth},
        ${sql.array(row.llm_stop_strings, "TEXT")}, ${row.llm_stop_speaker_pattern_enabled},
        ${row.llm_max_output_tokens}, ${row.llm_top_p}, ${row.llm_top_k},
        ${row.llm_frequency_penalty}, ${row.llm_presence_penalty}, ${row.llm_min_p},
        ${logitBiasesJson}::JSONB, ${fallbackRefsJson}::JSONB
      )
      ON CONFLICT (server_id) DO UPDATE SET
        humanizer_degree                 = EXCLUDED.humanizer_degree,
        message_fetch_limit              = EXCLUDED.message_fetch_limit,
        send_message_limit               = EXCLUDED.send_message_limit,
        match_limit                      = EXCLUDED.match_limit,
        cascade_limit                    = EXCLUDED.cascade_limit,
        timezone_offset                  = EXCLUDED.timezone_offset,
        self_debug_enabled               = EXCLUDED.self_debug_enabled,
        model_randomizer_enabled         = EXCLUDED.model_randomizer_enabled,
        system_prompt                    = EXCLUDED.system_prompt,
        context_note                     = EXCLUDED.context_note,
        context_note_depth               = EXCLUDED.context_note_depth,
        llm_stop_strings                 = EXCLUDED.llm_stop_strings,
        llm_stop_speaker_pattern_enabled = EXCLUDED.llm_stop_speaker_pattern_enabled,
        llm_max_output_tokens            = EXCLUDED.llm_max_output_tokens,
        llm_top_p                        = EXCLUDED.llm_top_p,
        llm_top_k                        = EXCLUDED.llm_top_k,
        llm_frequency_penalty            = EXCLUDED.llm_frequency_penalty,
        llm_presence_penalty             = EXCLUDED.llm_presence_penalty,
        llm_min_p                        = EXCLUDED.llm_min_p,
        llm_logit_biases                 = EXCLUDED.llm_logit_biases,
        fallback_model_refs              = EXCLUDED.fallback_model_refs,
        updated_at                       = NOW()
    `;
  }

  private async sqlUpsertNoticeEmbedsConfigs(serverId: number, row: ServerNoticeEmbedsConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_notice_embeds_configs (server_id, tool_notice_hidden_keys)
      VALUES (${serverId}, ${sql.array(row.tool_notice_hidden_keys, "TEXT")})
      ON CONFLICT (server_id) DO UPDATE SET
        tool_notice_hidden_keys = EXCLUDED.tool_notice_hidden_keys,
        updated_at              = NOW()
    `;
  }

  private async sqlUpsertMemberPermissionsConfigs(
    serverId: number,
    row: ServerMemberPermissionsConfigsRow,
  ): Promise<void> {
    await sql`
      INSERT INTO server_member_permissions_configs (
        server_id, server_memteaching_enabled, attribute_memteaching_enabled,
        sampledialogue_memteaching_enabled, self_teaching_enabled,
        personal_memories_enabled, hide_impersonation_embeds, prompt_snapshot_enabled
      ) VALUES (
        ${serverId}, ${row.server_memteaching_enabled}, ${row.attribute_memteaching_enabled},
        ${row.sampledialogue_memteaching_enabled}, ${row.self_teaching_enabled},
        ${row.personal_memories_enabled}, ${row.hide_impersonation_embeds},
        ${row.prompt_snapshot_enabled}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        server_memteaching_enabled         = EXCLUDED.server_memteaching_enabled,
        attribute_memteaching_enabled      = EXCLUDED.attribute_memteaching_enabled,
        sampledialogue_memteaching_enabled = EXCLUDED.sampledialogue_memteaching_enabled,
        self_teaching_enabled              = EXCLUDED.self_teaching_enabled,
        personal_memories_enabled          = EXCLUDED.personal_memories_enabled,
        hide_impersonation_embeds          = EXCLUDED.hide_impersonation_embeds,
        prompt_snapshot_enabled            = EXCLUDED.prompt_snapshot_enabled,
        updated_at                         = NOW()
    `;
  }

  private async sqlUpsertChannelScopeConfigs(serverId: number, row: ServerChannelScopeConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_channel_scope_configs (
        server_id, rp_channel_ids, private_channel_ids, crosschannel_blocklist_ids,
        stm_privacy_bypass, thought_log_channel_disc_id
      ) VALUES (
        ${serverId}, ${sql.array(row.rp_channel_ids, "TEXT")}, ${sql.array(row.private_channel_ids, "TEXT")},
        ${sql.array(row.crosschannel_blocklist_ids, "TEXT")}, ${row.stm_privacy_bypass},
        ${row.thought_log_channel_disc_id}
      )
      ON CONFLICT (server_id) DO UPDATE SET
        rp_channel_ids              = EXCLUDED.rp_channel_ids,
        private_channel_ids         = EXCLUDED.private_channel_ids,
        crosschannel_blocklist_ids  = EXCLUDED.crosschannel_blocklist_ids,
        stm_privacy_bypass          = EXCLUDED.stm_privacy_bypass,
        thought_log_channel_disc_id = EXCLUDED.thought_log_channel_disc_id,
        updated_at                  = NOW()
    `;
  }

  /**
   * Minimal classification shape used by initializeExpressions.
   * Mirrors ExpressionClassification from structuredOutput.ts without importing from providers.
   */

  /**
   * Load all server emojis that have not yet been classified (emotion_key is null/unset
   * or description is empty).
   *
   */
  async loadUninitializedEmojis(
    serverId: number,
  ): Promise<Array<{ emoji_disc_id: string; emoji_name: string; is_animated: boolean }>> {
    return await sql<Array<{ emoji_disc_id: string; emoji_name: string; is_animated: boolean }>>`
      SELECT emoji_disc_id, emoji_name, is_animated
      FROM server_emojis
      WHERE server_id = ${serverId}
        AND (
          emotion_key IS NULL
          OR emotion_key = 'unset'
          OR emoji_desc IS NULL
          OR emoji_desc = ''
        )
    `;
  }

  /**
   * Load all server stickers that have not yet been classified.
   *
   */
  async loadUninitializedStickers(
    serverId: number,
  ): Promise<Array<{ sticker_disc_id: string; sticker_name: string; sticker_format: number }>> {
    return await sql<Array<{ sticker_disc_id: string; sticker_name: string; sticker_format: number }>>`
      SELECT sticker_disc_id, sticker_name, sticker_format
      FROM server_stickers
      WHERE server_id = ${serverId}
        AND (
          emotion_key IS NULL
          OR emotion_key = 'unset'
          OR sticker_desc IS NULL
          OR sticker_desc = ''
        )
    `;
  }

  /**
   * Clear emotion_key and description from all server emojis.
   * Called before a full overwrite re-initialization.
   *
   */
  async clearEmojiExpressions(serverId: number): Promise<void> {
    await sql`UPDATE server_emojis SET emotion_key = NULL, emoji_desc = NULL WHERE server_id = ${serverId}`;
  }

  /**
   * Clear emotion_key and description from all server stickers.
   * Called before a full overwrite re-initialization.
   *
   */
  async clearStickerExpressions(serverId: number): Promise<void> {
    await sql`UPDATE server_stickers SET emotion_key = NULL, sticker_desc = NULL WHERE server_id = ${serverId}`;
  }

  /**
   * Apply LLM expression classification results to server_emojis and server_stickers
   * within a single transaction.
   * Each result is matched by name (case-insensitive) and only written when the row
   * is still uninitialized (guards against clobbering manual edits mid-batch).
   *
   * @returns Object with counts of emojis and stickers that were updated
   */
  async initializeExpressions(
    serverId: number,
    results: Array<{ name: string; emotion_key: string; description: string }>,
  ): Promise<{ emojiCount: number; stickerCount: number }> {
    let emojiCount = 0;
    let stickerCount = 0;

    await sql.transaction(async (tx) => {
      for (const result of results) {
        // Try emoji first (only update if still uninitialized)
        const emojiRows = await tx`
          UPDATE server_emojis
          SET
            emotion_key = ${result.emotion_key},
            emoji_desc  = ${result.description},
            updated_at  = CURRENT_TIMESTAMP
          WHERE server_id = ${serverId}
            AND LOWER(emoji_name) = LOWER(${result.name})
            AND (
              emotion_key IS NULL
              OR emotion_key = 'unset'
              OR emoji_desc IS NULL
              OR emoji_desc = ''
            )
          RETURNING emoji_disc_id
        `;

        if (emojiRows.length > 0) {
          emojiCount++;
          continue;
        }

        // Fall through to sticker if no emoji matched
        const stickerRows = await tx`
          UPDATE server_stickers
          SET
            emotion_key  = ${result.emotion_key},
            sticker_desc = ${result.description},
            updated_at   = CURRENT_TIMESTAMP
          WHERE server_id = ${serverId}
            AND LOWER(sticker_name) = LOWER(${result.name})
            AND (
              emotion_key IS NULL
              OR emotion_key = 'unset'
              OR sticker_desc IS NULL
              OR sticker_desc = ''
            )
          RETURNING sticker_disc_id
        `;

        if (stickerRows.length > 0) {
          stickerCount++;
        }
      }
    });

    return { emojiCount, stickerCount };
  }

  /**
   * Manually overwrite a single emoji's emotion classification and usage description.
   * Used by `/server expressions edit`. Unlike {@link initializeExpressions}, this
   * writes unconditionally (no "still uninitialized" guard) because the invoking user
   * is deliberately correcting an existing classification.
   *
   * @param emojiDiscId - Discord emoji snowflake identifying the row to update
   * @param emotionKey - New emotion key (must be one of the 28 valid EmotionKey values)
   * @param description - New usage/description text surfaced to the model
   * @returns True if a matching emoji row was updated, false otherwise
   */
  async updateEmojiExpression(
    serverId: number,
    emojiDiscId: string,
    emotionKey: string,
    description: string,
  ): Promise<boolean> {
    const rows = await sql<Array<{ emoji_disc_id: string }>>`
      UPDATE server_emojis
      SET
        emotion_key = ${emotionKey},
        emoji_desc  = ${description},
        updated_at  = CURRENT_TIMESTAMP
      WHERE server_id = ${serverId} AND emoji_disc_id = ${emojiDiscId}
      RETURNING emoji_disc_id
    `;
    return rows.length > 0;
  }

  /**
   * Manually overwrite a single sticker's emotion classification and usage description.
   * Sibling of {@link updateEmojiExpression} for the server_stickers table.
   *
   * @param stickerDiscId - Discord sticker snowflake identifying the row to update
   * @param emotionKey - New emotion key (must be one of the 28 valid EmotionKey values)
   * @param description - New usage/description text surfaced to the model
   * @returns True if a matching sticker row was updated, false otherwise
   */
  async updateStickerExpression(
    serverId: number,
    stickerDiscId: string,
    emotionKey: string,
    description: string,
  ): Promise<boolean> {
    const rows = await sql<Array<{ sticker_disc_id: string }>>`
      UPDATE server_stickers
      SET
        emotion_key  = ${emotionKey},
        sticker_desc = ${description},
        updated_at   = CURRENT_TIMESTAMP
      WHERE server_id = ${serverId} AND sticker_disc_id = ${stickerDiscId}
      RETURNING sticker_disc_id
    `;
    return rows.length > 0;
  }

  /**
   * Server-scoped tables wiped in preserve-personas mode.
   *
   * Maintenance rule: only add a table here if it has a real `server_id`
   * column referencing `servers(server_id)` AND is not inside the persona
   * subtree AND is not intentionally preserved (like `server_memories`).
   * Every entry is wiped with `DELETE FROM <table> WHERE server_id = $1`, so a
   * table WITHOUT a `server_id` column raises a Postgres
   * `column "server_id" does not exist` error and aborts the whole transaction.
   *
   * Excluded by design:
   *  - `personas` and the persona subtree (`persona_*` tables): preserved
   *  - `server_memories`: preserved per product decision
   *  - `error_logs`; uses ON DELETE SET NULL; nuke leaves history intact
   *  - `discord_managed_webhooks`: keyed by `guild_disc_id` (handled separately)
   *  - `documents`: has nullable `persona_id`; serverwide rows handled separately
   *  - Global seed catalogs (`nai_presets`, `system_prompt_presets`): shared
   *    across all servers, have NO `server_id` column; never wipe these.
   */
  private static readonly PRESERVE_MODE_WIPE_TABLES: readonly string[] = [
    // Server config tables
    "server_chat_configs",
    "server_model_configs",
    "server_notice_embeds_configs",
    "server_member_permissions_configs",
    "server_channel_scope_configs",
    "server_welcome_configs",
    "server_trigger_behavior_configs",
    "server_auto_trigger_configs",
    "server_auto_trigger_persona_overrides",
    "server_capabilities_configs",
    "server_novelai_imagegen_configs",
    "server_nsfw_configs",
    "server_speech_configs",
    "server_byok_configs",
    "server_memory_configs",
    // Whitelists / blacklists
    "channel_whitelist",
    "role_whitelist",
    "channel_persona_whitelist",
    "personalization_blacklist",
    // Quotas
    "image_quota_configs",
    "image_quotas",
    "image_serverwide_quotas",
    "text_quota_configs",
    "text_quotas",
    "text_serverwide_quotas",
    "video_quota_configs",
    "video_quotas",
    "video_serverwide_quotas",
    // API keys / providers
    "opt_api_keys",
    "api_key_rotation",
    "saved_provider_configs",
    // History / triggers / scheduling
    "conditioning_history",
    "reminders",
    "random_triggers",
    // Integrations / overrides
    "matrix_channel_links",
    "channel_llm_overrides",
    "guild_mcp_servers",
    "custom_endpoints",
    // Model registrations
    "openrouter_model_registrations",
    "openrouter_embedding_model_registrations",
    "openrouter_image_model_registrations",
    "openrouter_video_model_registrations",
    // Misc server-scoped
    "server_emojis",
    "server_stickers",
    "voice_samples",
    "personal_spotlights",
  ];

  /**
   * Lists every managed webhook for a guild with its decrypted token, so the
   * caller can delete the webhook on Discord's side before the DB row is wiped.
   *
   * @returns Array of `{ webhookDiscId, token }` pairs; failed decryptions are skipped (with a warn log)
   */
  async listManagedWebhooksDecrypted(guildDiscId: string): Promise<Array<{ webhookDiscId: string; token: string }>> {
    try {
      const rows = (await sql`
        SELECT managed_webhook_id, guild_disc_id, kind, channel_disc_id, webhook_disc_id,
               webhook_token, key_version, created_at, updated_at
        FROM discord_managed_webhooks
        WHERE guild_disc_id = ${guildDiscId}
      `) as ManagedDiscordWebhookRow[];

      const decrypted: Array<{ webhookDiscId: string; token: string }> = [];
      for (const row of rows) {
        const token = await this.sqlDecryptManagedWebhookToken(row);
        if (token) {
          decrypted.push({ webhookDiscId: row.webhook_disc_id, token });
        }
      }
      return decrypted;
    } catch (error) {
      log.error(`[Nuke] Failed to list managed webhooks for guild ${guildDiscId}`, error);
      return [];
    }
  }

  /**
   * Wipes a server's data. Two modes:
   *
   *  - **Full nuke** (`preservePersonas: false`): single
   *    `DELETE FROM servers WHERE server_id = ?`: all `ON DELETE CASCADE`
   *    children (personas, configs, memories, etc.) drop atomically.
   *
   *  - **Preserve personas** (`preservePersonas: true`): leaves the `servers`
   *    row, the persona subtree, and `server_memories` intact. Selectively
   *    deletes from every other server-scoped table (see
   *    `PRESERVE_MODE_WIPE_TABLES`) plus special-cases for
   *    `discord_managed_webhooks` (keyed by `guild_disc_id`) and `documents`
   *    (only serverwide rows, i.e. `persona_id IS NULL`).
   *
   * Discord-side webhook cleanup (calling `webhook.delete()` on Discord) is the
   * caller's responsibility: use `listManagedWebhooksDecrypted` beforehand.
   *
   * @param serverDiscId - Discord guild snowflake (needed for webhook table)
   * @param options.preservePersonas - When true, keep personas + their subtree
   * @returns `true` if any rows were affected (false implies the server row was already missing)
   */
  async nukeServer(serverId: number, serverDiscId: string, options: { preservePersonas: boolean }): Promise<boolean> {
    try {
      if (!options.preservePersonas) {
        // Full nuke: cascade-delete via the servers row
        const result = await sql`DELETE FROM servers WHERE server_id = ${serverId}`;
        return result.count > 0;
      }

      // Preserve mode: atomic selective wipe inside a transaction
      let totalDeleted = 0;
      await sql.transaction(async (tx) => {
        // Wipe every server-scoped table in the maintained list
        for (const table of ServerRepository.PRESERVE_MODE_WIPE_TABLES) {
          // table name is a constant from a private allowlist, not user input, so safe to interpolate
          const result = await tx.unsafe(`DELETE FROM ${table} WHERE server_id = $1`, [serverId]);
          totalDeleted += result.count ?? 0;
        }
        // discord_managed_webhooks is keyed by guild_disc_id, not server_id
        const whResult = await tx`
          DELETE FROM discord_managed_webhooks WHERE guild_disc_id = ${serverDiscId}
        `;
        totalDeleted += whResult.count ?? 0;
        // Documents: only wipe serverwide rows; persona-scoped docs stay
        const docResult = await tx`
          DELETE FROM documents WHERE server_id = ${serverId} AND persona_id IS NULL
        `;
        totalDeleted += docResult.count ?? 0;
      });

      return totalDeleted > 0;
    } catch (error) {
      log.error(`[Nuke] Failed to nuke server ${serverId} (preserve=${options.preservePersonas})`, error);
      throw error;
    }
  }

  private async sqlUpsertWelcomeConfigs(serverId: number, row: ServerWelcomeConfigsRow): Promise<void> {
    await sql`
      INSERT INTO server_welcome_configs (server_id, welcome_channel_disc_id, welcome_prompt, welcome_persona_id)
      VALUES (${serverId}, ${row.welcome_channel_disc_id}, ${row.welcome_prompt}, ${row.welcome_persona_id})
      ON CONFLICT (server_id) DO UPDATE SET
        welcome_channel_disc_id = EXCLUDED.welcome_channel_disc_id,
        welcome_prompt          = EXCLUDED.welcome_prompt,
        welcome_persona_id      = EXCLUDED.welcome_persona_id,
        updated_at              = NOW()
    `;
  }
}

/** Singleton instance: import this in callers. */
export const serverRepository = new ServerRepository();
