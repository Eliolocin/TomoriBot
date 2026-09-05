/**
 * SpeechRepository: manages voice sample CRUD and speech endpoint resolution.
 *
 * Owns tables: voice_samples, custom_endpoints and custom_endpoint_connections (speech/transcription rows),
 * saved_provider_configs (credential lookup by provider name), and
 * persona_voice_configs.speech_voice_sample_id (persona voice assignment).
 *
 * Note: decryptApiKey is NOT called here: credential decryption is a security
 * concern owned by the caller (speechEndpointResolver.ts). This repo returns
 * the raw encrypted key and key_version so callers can decrypt with the
 * appropriate key rotation context.
 *
 * Export contract: toExportShape returns null: voice samples reference
 * server-local files and are not portably exportable across servers.
 */
import type { CustomEndpointRow, VoiceSampleRow } from "@/types/db/schema";
import { customEndpointSchema, voiceSampleSchema } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import { deleteStoredVoiceSample } from "@/utils/storage/voiceSampleStorage";
import type {} from "./IRepository";

/**
 * Raw credential row returned by loadEndpointCredentials.
 * Callers decrypt api_key using decryptApiKey(api_key, key_version).
 */
export type EndpointCredentialRow = {
  api_key: Buffer;
  key_version: number;
};

/**
 * Find the active (is_default) custom endpoint for a speech/transcription capability.
 *
 * @param capability - "speech" or "transcription"
 * @returns Parsed CustomEndpointRow or null if none registered
 */
export async function loadActiveEndpoint(
  serverId: number,
  capability: "speech" | "transcription",
): Promise<CustomEndpointRow | null> {
  try {
    const rows = await sql`
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
        AND cec.capability = ${capability}
        AND cec.user_id IS NULL
        AND ce.is_default = true
      ORDER BY ce.updated_at DESC, ce.custom_endpoint_id DESC
      LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;

    const parsed = customEndpointSchema.safeParse(rows[0]);
    if (!parsed.success) {
      log.warn(
        `SpeechRepository.loadActiveEndpoint: parse failed for ${capability} on server ${serverId}: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.error(`SpeechRepository.loadActiveEndpoint: failed for server ${serverId}`, error);
    return null;
  }
}

/**
 * Load encrypted credentials for a provider (keyed by internal provider name).
 * Returns null when no credentials are stored.
 *
 * @param providerName - Internal provider name (for example, "custom:123")
 * @returns Raw encrypted credential row or null
 */
export async function loadEndpointCredentials(
  serverId: number,
  providerName: string,
): Promise<EndpointCredentialRow | null> {
  try {
    const [row] = await sql`
      SELECT api_key, key_version FROM saved_provider_configs
      WHERE server_id = ${serverId}
        AND provider = ${providerName}
      LIMIT 1
    `;
    if (!row?.api_key) return null;
    return { api_key: row.api_key as Buffer, key_version: (row.key_version as number) ?? 1 };
  } catch (error) {
    log.error(`SpeechRepository.loadEndpointCredentials: failed for server ${serverId}`, error);
    return null;
  }
}

/**
 * Load all voice samples registered for a server, ordered by name.
 *
 * @returns Array of VoiceSampleRow (may be empty)
 */
export async function loadVoiceSamples(serverId: number): Promise<VoiceSampleRow[]> {
  try {
    const rows = await sql`
      SELECT sample_id, name, file_path, ref_text, duration_ms, created_at
      FROM voice_samples
      WHERE server_id = ${serverId}
      ORDER BY name
    `;
    return rows as VoiceSampleRow[];
  } catch (error) {
    log.error(`SpeechRepository.loadVoiceSamples: failed for server ${serverId}`, error);
    return [];
  }
}

/**
 *
 * @returns Parsed VoiceSampleRow or null if not found
 */
export async function loadVoiceSampleById(sampleId: number): Promise<VoiceSampleRow | null> {
  try {
    const rows = await sql`
      SELECT * FROM voice_samples WHERE sample_id = ${sampleId} LIMIT 1
    `;
    if (!rows || rows.length === 0) return null;
    const parsed = voiceSampleSchema.safeParse(rows[0]);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    log.error(`SpeechRepository.loadVoiceSampleById: failed for sample ${sampleId}`, error);
    return null;
  }
}

/**
 * Insert a placeholder voice sample row to reserve a sample_id before storage.
 * Callers must follow up with updateVoiceSamplePath once the file is stored.
 *
 * @param refText    - Optional reference transcript text
 * @param durationMs - Audio duration in milliseconds (0 if unknown)
 * @returns Inserted sample_id or null on failure
 */
export async function insertVoiceSample(
  serverId: number,
  name: string,
  refText: string | null,
  durationMs: number,
): Promise<number | null> {
  try {
    const [row] = await sql<[{ sample_id: number }]>`
      INSERT INTO voice_samples (server_id, name, file_path, ref_text, duration_ms)
      VALUES (${serverId}, ${name}, '', ${refText}, ${durationMs})
      RETURNING sample_id
    `;
    return row?.sample_id ?? null;
  } catch (error) {
    log.error(`SpeechRepository.insertVoiceSample: failed for server ${serverId}`, error);
    return null;
  }
}

/**
 * Update the file_path on a voice sample row after successful storage.
 *
 * @param filePath - Storage reference (S3 URL or local path)
 */
export async function updateVoiceSamplePath(sampleId: number, filePath: string): Promise<void> {
  await sql`UPDATE voice_samples SET file_path = ${filePath} WHERE sample_id = ${sampleId}`;
}

export async function deleteVoiceSample(sampleId: number): Promise<void> {
  await sql`DELETE FROM voice_samples WHERE sample_id = ${sampleId}`;
}

/**
 * Count how many persona rows currently reference a voice sample.
 * Used to display a warning before deletion.
 *
 * @returns Reference count (0 when not referenced)
 */
export async function countPersonaVoiceSampleRefs(serverId: number, sampleId: number): Promise<number> {
  try {
    const [row] = await sql<[{ count: string }]>`
      SELECT COUNT(*) AS count
      FROM persona_voice_configs pvc
      JOIN personas p ON p.persona_id = pvc.persona_id
      WHERE p.server_id = ${serverId}
        AND pvc.speech_voice_sample_id = ${sampleId}
    `;
    return Number(row?.count ?? 0);
  } catch (error) {
    log.error(`SpeechRepository.countPersonaVoiceSampleRefs: failed for sample ${sampleId}`, error);
    return 0;
  }
}

/**
 * Clear the voice sample assignment from all persona rows that reference the given sample.
 * Called before deletion so no persona is left pointing to a deleted sample.
 *
 */
export async function clearPersonaVoiceSampleRefs(serverId: number, sampleId: number): Promise<void> {
  // speech_voice_name must clear with the sample id: every provider reads it as the active voice
  // name, so leaving it set makes a persona report a voice that no longer exists. The surviving
  // design prompt is the only remaining name source, and a surviving speech_voice_id is
  // deliberately left nameless rather than inheriting the deleted sample's name.
  // The regex tests for any non-whitespace character, which is what the JS `.trim()` truthiness
  // check in the voice-assign clear ladder resolves to, and it leaves a NULL prompt NULL.
  await sql`
    UPDATE persona_voice_configs pvc
    SET speech_voice_sample_id = NULL,
        speech_voice_name = CASE
          WHEN pvc.speech_voice_design_prompt ~ '[^[:space:]]' THEN 'VoiceDesign'
          ELSE NULL
        END
    FROM personas p
    WHERE p.persona_id = pvc.persona_id
      AND p.server_id = ${serverId}
      AND pvc.speech_voice_sample_id = ${sampleId}
  `;
}

/** Identifies the sample to retire and the workspace whose cached state references it. */
export interface VoiceSampleRemovalInput {
  serverId: number;
  /** Guild id, or the invoking user's id for a DM-backed workspace: the tomoriStateCache key. */
  serverDiscId: string;
  sampleId: number;
  filePath: string;
}

export interface VoiceSampleRemovalResult {
  storedFileRemoved: boolean;
}

/**
 * Collaborators of removeVoiceSample, injectable so a test can observe call ordering.
 * Bun cannot unregister `mock.module`, so mocking the sql client or the cache store would leak
 * into every other test sharing the lane process.
 */
export interface VoiceSampleRemovalDeps {
  clearRefs: typeof clearPersonaVoiceSampleRefs;
  deleteRow: typeof deleteVoiceSample;
  invalidateCache: typeof invalidateTomoriStateCache;
  deleteStoredFile: typeof deleteStoredVoiceSample;
}

const DEFAULT_REMOVAL_DEPS: VoiceSampleRemovalDeps = {
  clearRefs: clearPersonaVoiceSampleRefs,
  deleteRow: deleteVoiceSample,
  invalidateCache: invalidateTomoriStateCache,
  deleteStoredFile: deleteStoredVoiceSample,
};

/**
 * Retires a voice sample completely: clears every persona reference, deletes the row, invalidates
 * cached state, then removes the stored audio file.
 *
 * Cache invalidation runs after the row delete commits and before stored-file cleanup, so a cleanup
 * failure can never leave the deleted assignment being served from cache. Cleanup failure is
 * reported rather than thrown, because the row is already gone and a retry would find nothing.
 */
export async function removeVoiceSample(
  { serverId, serverDiscId, sampleId, filePath }: VoiceSampleRemovalInput,
  deps: VoiceSampleRemovalDeps = DEFAULT_REMOVAL_DEPS,
): Promise<VoiceSampleRemovalResult> {
  await deps.clearRefs(serverId, sampleId);
  await deps.deleteRow(sampleId);

  deps.invalidateCache(serverDiscId);

  try {
    await deps.deleteStoredFile(filePath);
    return { storedFileRemoved: true };
  } catch (error) {
    log.error(`SpeechRepository.removeVoiceSample: stored file cleanup failed for sample ${sampleId}`, error);
    return { storedFileRemoved: false };
  }
}
