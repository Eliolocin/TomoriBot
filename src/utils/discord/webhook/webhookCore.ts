import type {
  AnyThreadChannel,
  BaseGuildTextChannel,
  TextChannel,
  Webhook,
  Message,
  Guild,
  MessageCreateOptions,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { MANAGED_WEBHOOK_KIND_SHARED_CHANNEL, serverRepository } from "@/utils/db/repositories/ServerRepository";
import { personaRepository } from "@/utils/db/repositories/PersonaRepository";
import { log } from "../../misc/logger";
import { safeDownload } from "../../security/safeDownload";
import { PERSONA_LIMITS } from "../../security/rateLimiter";
import { convertToPNG } from "../../image/imageProcessor";
import { invalidateTomoriStateCache } from "../../cache/tomoriStateCache";
import {
  isLocalPersonaAvatarPath,
  loadStoredPersonaAvatarDataUri,
  resolvePersonaAvatarPublicUrl,
  uploadPersonaAvatarToStorage,
} from "@/utils/storage/avatarStorage";

/**
 * In-memory webhook cache: channelId -> Webhook
 * Reduces webhook lookups and creation operations.
 * No TTL - webhooks persist unless manually deleted by users.
 */
const webhookCache = new Map<string, Webhook>();

/**
 * In-memory persona webhook cache: channelId:personaId -> Webhook
 * Retained for legacy persona-webhook compatibility and recovery helpers.
 */
const personaWebhookCache = new Map<string, Webhook>();

/**
 * Channels whose last webhook resolution failed: channelId -> reason and expiry.
 *
 * Without this the failure is retried on every turn, because `webhookCache` stores only successes
 * and several call sites resolve a webhook independently per turn. A 50013 stays true until an
 * admin edits the channel, so each retry spends a database read, a Discord call that cannot
 * succeed, and an error-log insert. Cleared on invalidation as well as on expiry, so granting the
 * permission takes effect at the next turn instead of at the end of the TTL.
 *
 * Distinct from `WEBHOOK_ERROR_COOLDOWN_MS` in `responseEmitter`, which throttles how often the
 * user-facing embed is posted. This one suppresses the API call; that one suppresses the message.
 * The cached `errorReason` is still returned to callers, so suppression here never silences that
 * notice.
 */
const webhookFailureCache = new Map<string, { reason: WebhookCreateErrorReason; expiresAt: number }>();

const WEBHOOK_FAILURE_RETRY_MS =
  Math.max(Number.parseInt(process.env.WEBHOOK_FAILURE_RETRY_MINUTES || "", 10) || 15, 1) * 60_000;

/**
 * Webhook name used for all multi-persona responses.
 * Consistent naming makes it easier to identify and manage.
 */
const WEBHOOK_NAME = "TomoriBot Multi-Persona";
const PERSONA_WEBHOOK_PREFIX = "TomoriBot Persona";
const IS_PRODUCTION = process.env.RUN_ENV === "production";

export type WebhookCreateErrorReason = "missing_permissions" | "max_webhooks" | "unknown";

export type WebhookCreateResult = {
  webhook: Webhook | null;
  errorReason?: WebhookCreateErrorReason;
};

export type ResolvedWebhookIdentity = {
  username?: string;
  avatarUrl?: string;
  avatarDataUri?: string;
};

type WebhookSendPayload = Exclude<Parameters<Webhook["send"]>[0], string>;

const MAX_AVATAR_SIZE_BYTES = PERSONA_LIMITS.MAX_AVATAR_SIZE_MB * 1024 * 1024;
const webhookMutationLocks = new Map<string, Promise<void>>();
const webhookAvatarStateCache = new Map<string, string>();
const persistedManagedWebhookIds = new Set<string>();

/**
 * Returns current sizes of every in-memory map owned by the webhook manager.
 * Used by the cache metrics logger to detect unbounded growth in webhook caches
 * (none of these maps have a TTL: they only shrink on explicit invalidation).
 */
export function getWebhookCacheSizes(): {
  webhookChannel: number;
  webhookPersona: number;
  webhookMutationLocks: number;
  webhookAvatarState: number;
  persistedManagedWebhookIds: number;
  webhookFailure: number;
} {
  return {
    webhookChannel: webhookCache.size,
    webhookPersona: personaWebhookCache.size,
    webhookMutationLocks: webhookMutationLocks.size,
    webhookAvatarState: webhookAvatarStateCache.size,
    persistedManagedWebhookIds: persistedManagedWebhookIds.size,
    webhookFailure: webhookFailureCache.size,
  };
}

function toWebhookAvatarData(avatar?: Buffer | string | null): string | null {
  if (!avatar) {
    return null;
  }

  if (typeof avatar === "string") {
    if (avatar.startsWith("data:image/")) {
      return avatar;
    }
    log.warn("[Webhook Manager] Ignoring avatar string that is not a data URI");
    return null;
  }

  if (avatar.length > MAX_AVATAR_SIZE_BYTES) {
    log.warn(`[Webhook Manager] Avatar buffer exceeds max size (${avatar.length} bytes)`);
    return null;
  }

  const base64 = avatar.toString("base64");
  return `data:image/png;base64,${base64}`;
}

function getPersonaWebhookName(personaId: number): string {
  return `${PERSONA_WEBHOOK_PREFIX} ${personaId}`;
}

function getPersonaWebhookCacheKey(channelId: string, personaId: number): string {
  return `${channelId}:${personaId}`;
}

function getWebhookErrorReason(error: unknown): WebhookCreateErrorReason {
  const code = (error as { code?: number | string })?.code;

  if (code === 50013 || code === "50013") {
    return "missing_permissions";
  }

  if (code === 30007 || code === "30007") {
    return "max_webhooks";
  }

  return "unknown";
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeAvatarUrl(url?: string | null): string | undefined {
  if (!url) {
    return undefined;
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return undefined;
  }

  if (!isValidHttpUrl(trimmedUrl)) {
    return undefined;
  }

  return trimmedUrl;
}

function isInvalidWebhookError(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 10015 || code === "10015" || code === 50027 || code === "50027";
}

async function withWebhookMutationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = webhookMutationLocks.get(lockKey);
  const waitForPrevious = previous?.catch(() => undefined) ?? Promise.resolve();

  let releaseLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chained = waitForPrevious.then(() => current);
  webhookMutationLocks.set(lockKey, chained);

  await waitForPrevious;

  try {
    return await operation();
  } finally {
    releaseLock();
    if (webhookMutationLocks.get(lockKey) === chained) {
      webhookMutationLocks.delete(lockKey);
    }
  }
}

async function normalizeAvatarToPng(buffer: Buffer, logLabel: string): Promise<Buffer | null> {
  if (buffer.length > MAX_AVATAR_SIZE_BYTES) {
    log.warn(`[Webhook Manager] ${logLabel} exceeds max size (${buffer.length} bytes)`);
    return null;
  }

  try {
    return await convertToPNG(buffer);
  } catch (error) {
    log.warn(`[Webhook Manager] Failed to convert ${logLabel} to PNG`, error);
    return null;
  }
}

async function persistPersonaAvatarReference(
  guildId: string,
  personaId: number,
  avatarReference: string,
): Promise<void> {
  const updated = await personaRepository.setAvatar(personaId, avatarReference);
  if (!updated) {
    throw new Error(`Failed to persist avatar reference for persona ${personaId}`);
  }
  invalidateTomoriStateCache(guildId);
}

async function storeMigratedPersonaAvatar(
  guildId: string,
  personaId: number,
  buffer: Buffer,
  label: string,
): Promise<string | null> {
  const storedReference = await uploadPersonaAvatarToStorage({
    personaId,
    serverDiscId: guildId,
    label,
    buffer,
  });

  if (!storedReference) {
    return null;
  }

  try {
    await persistPersonaAvatarReference(guildId, personaId, storedReference);
  } catch (error) {
    log.warn(`[Webhook Manager] Failed to persist migrated avatar reference for persona ${personaId}`, error);
  }

  return storedReference;
}

/**
 * Attempts to recover persona avatar by scanning guild for surviving webhooks.
 * Used when the stored webhook_avatar_url fails to download (Edge Case 2: last webhook deleted).
 *
 * @returns Avatar data URI and recovered URL, or null if no recovery possible
 */
async function attemptWebhookAvatarRecovery(
  guild: Guild,
  personaId: number,
): Promise<{ buffer: Buffer; url: string } | null> {
  const personaWebhookName = getPersonaWebhookName(personaId);

  log.info(`[Webhook Manager] Attempting avatar recovery for persona ${personaId} by scanning guild ${guild.id}`);

  // Scan all text channels in guild for surviving webhooks
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased()) {
      continue;
    }

    // Skip channels without webhook support
    if (!("fetchWebhooks" in channel)) {
      continue;
    }

    try {
      const webhooks = await (channel as TextChannel).fetchWebhooks();
      const matching = webhooks.find((wh) => wh.name === personaWebhookName);

      // Found a surviving webhook for this persona!
      if (matching?.avatar) {
        const avatarUrl = matching.avatarURL({ extension: "png", size: 256 });
        if (!avatarUrl) {
          continue;
        }

        log.info(`[Webhook Manager] Found surviving webhook in channel ${channel.id}, attempting to download avatar`);

        // Download avatar from surviving webhook
        const downloadResult = await safeDownload(avatarUrl, {
          maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
        });

        if (!downloadResult.success || !downloadResult.buffer) {
          log.warn(`[Webhook Manager] Failed to download from surviving webhook, continuing scan`);
          continue;
        }

        const buffer = await normalizeAvatarToPng(
          downloadResult.buffer,
          `surviving webhook avatar for persona ${personaId}`,
        );
        if (!buffer) {
          continue;
        }

        log.success(
          `[Webhook Manager] Successfully recovered avatar buffer from surviving webhook in channel ${channel.id}`,
        );
        return {
          buffer,
          url: avatarUrl,
        };
      }
    } catch (error) {
      log.warn(`[Webhook Manager] Error scanning channel ${channel.id} for recovery, continuing`, error);
    }
  }

  log.warn(`[Webhook Manager] Avatar recovery failed: no surviving webhooks found for persona ${personaId}`);
  return null;
}

async function resolveNonProductionPersonaAvatarReference(persona: TomoriState, guild?: Guild): Promise<string | null> {
  const avatarReference = persona.webhook_avatar_url?.trim();
  if (!avatarReference) {
    return null;
  }

  if (
    IS_PRODUCTION ||
    !persona.is_alter ||
    !guild ||
    !persona.persona_id ||
    isLocalPersonaAvatarPath(avatarReference)
  ) {
    return avatarReference;
  }

  let normalizedBuffer: Buffer | null = null;
  const downloadResult = await safeDownload(avatarReference, {
    maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
  });

  if (downloadResult.success && downloadResult.buffer) {
    normalizedBuffer = await normalizeAvatarToPng(
      downloadResult.buffer,
      `legacy avatar for persona ${persona.persona_id}`,
    );
  } else {
    log.warn(
      `[Webhook Manager] Failed to download legacy avatar for persona ${persona.persona_id}: ${downloadResult.error ?? "unknown error"}`,
    );
  }

  if (!normalizedBuffer) {
    log.info(`[Webhook Manager] Attempting legacy webhook recovery for persona ${persona.persona_id}`);
    const recoveredAvatar = await attemptWebhookAvatarRecovery(guild, persona.persona_id);
    if (recoveredAvatar) {
      normalizedBuffer = recoveredAvatar.buffer;
    }
  }

  if (!normalizedBuffer) {
    return avatarReference;
  }

  const storedReference = await storeMigratedPersonaAvatar(
    guild.id,
    persona.persona_id,
    normalizedBuffer,
    "legacy avatar migration",
  );

  return storedReference ?? avatarReference;
}

async function persistSharedChannelWebhook(
  channel: TextChannel | BaseGuildTextChannel,
  webhook: Webhook,
): Promise<void> {
  if (!channel.guildId || !webhook.token || persistedManagedWebhookIds.has(webhook.id)) {
    return;
  }

  const stored = await serverRepository.upsertManagedWebhook({
    guildDiscId: channel.guildId,
    kind: MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
    channelDiscId: channel.id,
    webhookDiscId: webhook.id,
    rawToken: webhook.token,
  });

  if (stored) {
    persistedManagedWebhookIds.add(webhook.id);
  }
}

async function restoreStoredSharedWebhook(
  channel: TextChannel | BaseGuildTextChannel,
  webhookId?: string | null,
): Promise<Webhook | null> {
  const storedRow = webhookId
    ? await serverRepository.loadManagedWebhookByChannelAndWebhookId(
        channel.id,
        webhookId,
        MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
      )
    : await serverRepository.loadManagedWebhookByChannel(channel.id, MANAGED_WEBHOOK_KIND_SHARED_CHANNEL);

  if (!storedRow) {
    return null;
  }

  const decryptedToken = await serverRepository.decryptManagedWebhookToken(storedRow);
  if (!decryptedToken) {
    await serverRepository.deleteManagedWebhook(
      channel.id,
      storedRow.webhook_disc_id,
      MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
    );
    return null;
  }

  try {
    const restoredWebhook = await channel.client.fetchWebhook(storedRow.webhook_disc_id, decryptedToken);
    if (restoredWebhook.channelId !== channel.id) {
      log.warn(
        `[Webhook Manager] Stored webhook ${storedRow.webhook_disc_id} does not belong to channel ${channel.id}; removing stale record`,
      );
      await serverRepository.deleteManagedWebhook(
        channel.id,
        storedRow.webhook_disc_id,
        MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
      );
      return null;
    }

    webhookCache.set(channel.id, restoredWebhook);
    persistedManagedWebhookIds.add(restoredWebhook.id);
    return restoredWebhook;
  } catch (error) {
    if (isInvalidWebhookError(error)) {
      log.warn(
        `[Webhook Manager] Stored webhook ${storedRow.webhook_disc_id} for channel ${channel.id} is no longer valid; removing stale record`,
      );
      await serverRepository.deleteManagedWebhook(
        channel.id,
        storedRow.webhook_disc_id,
        MANAGED_WEBHOOK_KIND_SHARED_CHANNEL,
      );
    } else {
      log.warn(`[Webhook Manager] Failed to restore stored webhook for channel ${channel.id}`, error);
    }
    return null;
  }
}

async function resolvePersonaAvatarIdentity(persona: TomoriState, guild?: Guild): Promise<ResolvedWebhookIdentity> {
  const identity: ResolvedWebhookIdentity = {
    username: persona.persona_nickname,
  };

  if (!persona.webhook_avatar_url) {
    return identity;
  }

  const avatarReference =
    !IS_PRODUCTION && persona.is_alter
      ? await resolveNonProductionPersonaAvatarReference(persona, guild)
      : persona.webhook_avatar_url;

  if (!avatarReference) {
    return identity;
  }

  const publicAvatarUrl = resolvePersonaAvatarPublicUrl(avatarReference);
  if (publicAvatarUrl) {
    identity.avatarUrl = publicAvatarUrl;
    return identity;
  }

  if (isLocalPersonaAvatarPath(avatarReference)) {
    const avatarDataUri = await loadStoredPersonaAvatarDataUri(avatarReference);
    if (avatarDataUri) {
      identity.avatarDataUri = avatarDataUri;
    }
    return identity;
  }

  const sanitizedAvatarUrl = sanitizeAvatarUrl(avatarReference);
  if (sanitizedAvatarUrl) {
    identity.avatarUrl = sanitizedAvatarUrl;
  }

  return identity;
}

async function resolvePersonaWebhookAvatar(persona: TomoriState, guild?: Guild): Promise<string | undefined> {
  const identity = await resolvePersonaAvatarIdentity(persona, guild);
  if (identity.avatarDataUri) {
    return identity.avatarDataUri;
  }

  if (!identity.avatarUrl) {
    return undefined;
  }

  const downloadResult = await safeDownload(identity.avatarUrl, {
    maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
  });
  if (!downloadResult.success || !downloadResult.buffer) {
    log.warn(
      `[Webhook Manager] Failed to download avatar for persona ${persona.persona_nickname}: ${downloadResult.error ?? "unknown error"}`,
    );
    return undefined;
  }

  const normalizedBuffer = await normalizeAvatarToPng(
    downloadResult.buffer,
    `avatar for persona ${persona.persona_nickname}`,
  );
  if (!normalizedBuffer) {
    return undefined;
  }

  return `data:image/png;base64,${normalizedBuffer.toString("base64")}`;
}

/**
 * Gets or creates a shared channel webhook with cache + encrypted DB-backed restore.
 * Webhooks are used to send messages with custom avatars and usernames for alter personas.
 *
 * Flow:
 * 1. Check in-memory cache
 * 2. If cached webhook still exists, return it
 * 3. If the process restarted, try to restore the webhook from encrypted DB storage
 * 4. If still unavailable, fetch existing webhook by name
 * 5. If no usable webhook exists, create a new one
 * 6. Cache and persist the webhook for future use
 *
 * @returns Webhook object, or null if missing permissions
 */
/**
 * Resolves the managed webhook for the channel a message will appear in, mapping a thread to
 * its parent: webhooks live on the parent channel and post into threads via `threadId`.
 *
 * Thin convenience wrapper over {@link getOrCreateWebhook} for callers that hold an arbitrary
 * channel and only want "the webhook, or null". Used by post-turn senders (stickers, the
 * "Fallback Used" notice) which (unlike alter turns) have no pre-resolved
 * `responseTarget.webhook` when the main persona reaches the webhook path via a sprite.
 *
 * @returns The managed webhook, or null when the channel cannot host one or permissions are missing
 */
export async function resolveManagedChannelWebhook(channel: unknown): Promise<Webhook | null> {
  const candidate = channel as {
    isThread?: () => boolean;
    parent?: unknown;
  };
  const targetChannel = typeof candidate.isThread === "function" && candidate.isThread() ? candidate.parent : channel;

  if (
    !targetChannel ||
    typeof targetChannel !== "object" ||
    !("fetchWebhooks" in targetChannel) ||
    !("createWebhook" in targetChannel)
  ) {
    return null;
  }

  const webhookResult = await getOrCreateWebhook(targetChannel as BaseGuildTextChannel);
  return webhookResult.webhook ?? null;
}

export async function getOrCreateWebhook(channel: TextChannel | BaseGuildTextChannel): Promise<WebhookCreateResult> {
  const cachedFailure = webhookFailureCache.get(channel.id);
  if (cachedFailure) {
    if (cachedFailure.expiresAt > Date.now()) {
      return { webhook: null, errorReason: cachedFailure.reason };
    }
    webhookFailureCache.delete(channel.id);
  }

  try {
    const channelId = channel.id;

    const cachedWebhook = webhookCache.get(channelId);
    if (cachedWebhook) {
      // Verify cached webhook still has a valid token (not deleted)
      if (!cachedWebhook.token) {
        log.warn(
          `[Webhook Manager] Cached webhook for channel ${channelId} has no token (likely deleted), invalidating cache`,
        );
        webhookCache.delete(channelId);
        // Continue to fetch/create a new webhook
      } else {
        try {
          // Verify webhook still exists remotely; cached objects may survive manual deletes.
          const liveWebhooks = await channel.fetchWebhooks();
          if (liveWebhooks.has(cachedWebhook.id)) {
            await persistSharedChannelWebhook(channel, cachedWebhook);
            return { webhook: cachedWebhook };
          }
          log.warn(`[Webhook Manager] Cached webhook missing in channel ${channelId}, invalidating cache`);
          await serverRepository.deleteManagedWebhook(channelId, cachedWebhook.id, MANAGED_WEBHOOK_KIND_SHARED_CHANNEL);
          webhookCache.delete(channelId);
        } catch (fetchError) {
          log.warn(
            `[Webhook Manager] Cached webhook fetch failed for channel ${channelId}, invalidating cache`,
            fetchError,
          );
          webhookCache.delete(channelId);
          // Continue to fetch/create a new webhook
        }
      }
    }

    const restoredWebhook = await restoreStoredSharedWebhook(channel);
    if (restoredWebhook) {
      log.info(`[Webhook Manager] Restored shared webhook for channel ${channelId} from stored credentials`);
      return { webhook: restoredWebhook };
    }

    log.info(`[Webhook Manager] Cache MISS for channel ${channelId}, fetching webhooks`);
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((wh) => wh.name === WEBHOOK_NAME);

    if (webhook && !webhook.token) {
      log.warn(
        `[Webhook Manager] Found webhook for channel ${channelId} but it has no token (fetched webhook). Deleting and recreating.`,
      );
      await webhook.delete("Recreating webhook to get token");
      webhook = undefined;
    }

    if (!webhook) {
      log.info(`[Webhook Manager] No webhook found for channel ${channelId}, creating new one`);
      webhook = await channel.createWebhook({
        name: WEBHOOK_NAME,
        reason: "TomoriBot multi-persona support",
      });
      log.success(`[Webhook Manager] Created webhook for channel ${channelId} (${channel.name})`);
    }

    // Cache + persist the webhook
    webhookCache.set(channelId, webhook);
    webhookFailureCache.delete(channelId);
    await persistSharedChannelWebhook(channel, webhook);
    return { webhook };
  } catch (error) {
    const errorReason = getWebhookErrorReason(error);
    webhookFailureCache.set(channel.id, {
      reason: errorReason,
      expiresAt: Date.now() + WEBHOOK_FAILURE_RETRY_MS,
    });

    // A missing permission is a server configuration state rather than a bot fault: it stays true
    // until an admin acts, so recording it at error level buries genuine failures underneath it.
    if (errorReason === "missing_permissions") {
      log.warn(
        `[Webhook Manager] No Manage Webhooks permission in channel ${channel.id} (${channel.name}); persona replies fall back to plain bot messages, and resolution is suppressed for ${WEBHOOK_FAILURE_RETRY_MS / 60_000} minutes`,
      );
      return { webhook: null, errorReason };
    }

    log.error(`[Webhook Manager] Failed to get/create webhook for channel ${channel.id}:`, {
      errorType: "webhook_error",
      metadata: { channelId: channel.id, channelName: channel.name, error },
    });
    return { webhook: null, errorReason };
  }
}

/**
 * Returns a cached bot-managed webhook for a channel when the webhook ID matches.
 * This is intentionally read-only: unlike getOrCreateWebhook(), it never fetches,
 * recreates, or mutates remote webhook state.
 *
 * Shared multi-persona webhooks are cached by channel ID. Legacy persona webhooks
 * are cached by `channelId:personaId`, so this helper scans both caches.
 *
 * @returns Cached webhook with token, or null when unavailable/not bot-managed
 */
export function getCachedManagedWebhookForChannel(channelId: string, webhookId?: string | null): Webhook | null {
  if (!channelId || !webhookId) {
    return null;
  }

  const cachedSharedWebhook = webhookCache.get(channelId);
  if (cachedSharedWebhook?.id === webhookId && cachedSharedWebhook.token) {
    return cachedSharedWebhook;
  }

  for (const [cacheKey, webhook] of personaWebhookCache.entries()) {
    if (!cacheKey.startsWith(`${channelId}:`)) {
      continue;
    }

    if (webhook.id === webhookId && webhook.token) {
      return webhook;
    }
  }

  return null;
}

export async function resolveManagedWebhookForChannel(
  channel: TextChannel | BaseGuildTextChannel,
  webhookId?: string | null,
): Promise<Webhook | null> {
  if (!channel.id || !webhookId) {
    return null;
  }

  const cachedWebhook = getCachedManagedWebhookForChannel(channel.id, webhookId);
  if (cachedWebhook) {
    return cachedWebhook;
  }

  return await restoreStoredSharedWebhook(channel, webhookId);
}

function buildWebhookSendPayload(payload: WebhookSendPayload, identity?: ResolvedWebhookIdentity): WebhookSendPayload {
  const avatarUrl = sanitizeAvatarUrl(identity?.avatarUrl);

  return {
    ...payload,
    ...(identity?.username ? { username: identity.username } : {}),
    ...(avatarUrl ? { avatarURL: avatarUrl } : {}),
  } as WebhookSendPayload;
}

function shouldResetWebhookAvatar(webhook: Webhook, identity?: ResolvedWebhookIdentity): boolean {
  if (identity?.avatarDataUri || sanitizeAvatarUrl(identity?.avatarUrl)) {
    return false;
  }

  return webhookAvatarStateCache.has(webhook.id) || Boolean(webhook.avatar);
}

async function ensureWebhookAvatarState(webhook: Webhook, identity?: ResolvedWebhookIdentity): Promise<void> {
  if (identity?.avatarDataUri) {
    const cachedAvatar = webhookAvatarStateCache.get(webhook.id);
    if (cachedAvatar !== identity.avatarDataUri) {
      await webhook.edit({
        avatar: identity.avatarDataUri,
        reason: "TomoriBot persona identity update",
      });
      webhookAvatarStateCache.set(webhook.id, identity.avatarDataUri);
    }
    return;
  }

  if (shouldResetWebhookAvatar(webhook, identity)) {
    await webhook.edit({
      avatar: null,
      reason: "TomoriBot persona identity reset",
    });
    webhookAvatarStateCache.delete(webhook.id);
  }
}

async function sendWebhookMessagesInternal(
  webhook: Webhook,
  payloads: WebhookSendPayload[],
  identity?: ResolvedWebhookIdentity,
): Promise<Message[]> {
  await ensureWebhookAvatarState(webhook, identity);

  const messages: Message[] = [];
  for (const payload of payloads) {
    const finalPayload = buildWebhookSendPayload(payload, identity);
    if (identity?.avatarDataUri && "avatarURL" in finalPayload) {
      delete finalPayload.avatarURL;
    }
    messages.push(await webhook.send(finalPayload));
  }

  return messages;
}

export async function sendWebhookMessagesWithIdentity(
  webhook: Webhook,
  payloads: WebhookSendPayload[],
  identity?: ResolvedWebhookIdentity,
  lockKey?: string,
): Promise<Message[]> {
  try {
    if (identity?.avatarDataUri || shouldResetWebhookAvatar(webhook, identity)) {
      return await withWebhookMutationLock(lockKey ?? webhook.channelId ?? webhook.id, () =>
        sendWebhookMessagesInternal(webhook, payloads, identity),
      );
    }

    return await sendWebhookMessagesInternal(webhook, payloads, identity);
  } catch (error) {
    if (isInvalidWebhookError(error) && webhook.channelId) {
      invalidateWebhookCache(webhook.channelId);
    }
    throw error;
  }
}

export async function sendWebhookMessageWithIdentity(
  webhook: Webhook,
  payload: WebhookSendPayload,
  identity?: ResolvedWebhookIdentity,
  lockKey?: string,
): Promise<Message> {
  const [message] = await sendWebhookMessagesWithIdentity(webhook, [payload], identity, lockKey);
  return message;
}

/**
 * Gets or creates a webhook for a specific persona in a channel.
 * Legacy compatibility helper used for recovery-oriented persona webhook flows.
 */
export async function getOrCreatePersonaWebhook(
  channel: TextChannel | BaseGuildTextChannel,
  persona: TomoriState,
): Promise<WebhookCreateResult> {
  try {
    if (!persona.persona_id) {
      log.warn(
        `[Webhook Manager] Missing persona_id for persona ${persona.persona_nickname}, cannot create persona webhook.`,
      );
      return { webhook: null, errorReason: "unknown" };
    }

    const channelId = channel.id;
    const cacheKey = getPersonaWebhookCacheKey(channelId, persona.persona_id);

    const cachedWebhook = personaWebhookCache.get(cacheKey);
    if (cachedWebhook) {
      if (!cachedWebhook.token) {
        log.warn(
          `[Webhook Manager] Cached persona webhook for channel ${channelId} has no token (likely deleted), invalidating cache`,
        );
        personaWebhookCache.delete(cacheKey);
      } else {
        try {
          // Verify webhook still exists remotely; cached objects may survive manual deletes.
          const liveWebhooks = await channel.fetchWebhooks();
          if (liveWebhooks.has(cachedWebhook.id)) {
            log.info(`[Webhook Manager] Persona cache HIT for channel ${channelId} (persona ${persona.persona_id})`);
            return { webhook: cachedWebhook };
          }
          log.warn(`[Webhook Manager] Cached persona webhook missing in channel ${channelId}, invalidating cache`);
          personaWebhookCache.delete(cacheKey);
        } catch (fetchError) {
          log.warn(
            `[Webhook Manager] Cached persona webhook fetch failed for channel ${channelId}, invalidating cache`,
            fetchError,
          );
          personaWebhookCache.delete(cacheKey);
        }
      }
    }

    log.info(`[Webhook Manager] Persona cache MISS for channel ${channelId}, fetching webhooks`);
    const webhooks = await channel.fetchWebhooks();
    const personaWebhookName = getPersonaWebhookName(persona.persona_id);
    let webhook = webhooks.find((wh) => wh.name === personaWebhookName);

    if (webhook && !webhook.token) {
      log.warn(
        `[Webhook Manager] Found persona webhook for channel ${channelId} but it has no token (fetched webhook). Deleting and recreating.`,
      );
      await webhook.delete("Recreating webhook to get token");
      webhook = undefined;
    }

    if (!webhook) {
      const avatar = await resolvePersonaWebhookAvatar(persona, channel.guild);
      log.info(`[Webhook Manager] No persona webhook found for channel ${channelId}, creating new one`);
      webhook = await channel.createWebhook({
        name: personaWebhookName,
        avatar,
        reason: "TomoriBot persona avatar support",
      });
      log.success(`[Webhook Manager] Created persona webhook for channel ${channelId} (${channel.name})`);

      // Update stored URL to webhook's permanent avatar URL (replaces temporary Discord CDN attachment URLs)
      // This ensures future webhook recreations use a permanent URL that doesn't expire
      const webhookAvatarUrl = webhook.avatarURL({
        extension: "png",
        size: 256,
      });
      if (webhookAvatarUrl && webhookAvatarUrl !== persona.webhook_avatar_url) {
        try {
          const updated = await personaRepository.setAvatar(persona.persona_id, webhookAvatarUrl);
          if (!updated) {
            throw new Error(`Failed to update stored avatar URL for persona ${persona.persona_id}`);
          }
          // Invalidate cache so updated URL is used immediately
          if (channel.guild) {
            invalidateTomoriStateCache(channel.guild.id);
          }
          log.success(
            `[Webhook Manager] Updated stored avatar URL to permanent webhook URL for persona ${persona.persona_id}`,
          );
        } catch (error) {
          log.warn(`[Webhook Manager] Failed to update stored avatar URL for persona ${persona.persona_id}`, error);
        }
      }
    }

    personaWebhookCache.set(cacheKey, webhook);
    return { webhook };
  } catch (error) {
    const errorReason = getWebhookErrorReason(error);
    log.error(`[Webhook Manager] Failed to get/create persona webhook for channel ${channel.id}:`, {
      errorType: "webhook_error",
      metadata: { channelId: channel.id, channelName: channel.name, error },
    });
    return { webhook: null, errorReason };
  }
}

/**
 * Updates existing persona webhooks across a guild to use the latest avatar.
 * Legacy maintenance helper for surviving persona webhooks in non-production.
 *
 * @param avatar - Avatar data (Buffer or data URI)
 */
export async function updatePersonaWebhooksAvatar(
  guild: Guild,
  personaId: number,
  avatar?: Buffer | string | null,
): Promise<number> {
  if (IS_PRODUCTION) {
    return 0;
  }

  const avatarData = toWebhookAvatarData(avatar);
  if (!avatarData) {
    log.warn(`[Webhook Manager] Skipping persona webhook update for persona ${personaId} due to missing avatar data`);
    return 0;
  }

  const personaWebhookName = getPersonaWebhookName(personaId);
  let updatedCount = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased()) {
      continue;
    }

    if (!("fetchWebhooks" in channel)) {
      continue;
    }

    try {
      const webhooks = await (channel as TextChannel).fetchWebhooks();
      const matching = webhooks.filter((wh) => wh.name === personaWebhookName);

      for (const webhook of matching.values()) {
        await webhook.edit({
          avatar: avatarData,
          reason: "TomoriBot persona avatar updated",
        });
        updatedCount++;
        const cacheKey = getPersonaWebhookCacheKey(channel.id, personaId);
        personaWebhookCache.set(cacheKey, webhook);

        // Store permanent webhook avatar URL (first channel only, all webhooks have same avatar)
        if (updatedCount === 1) {
          const webhookAvatarUrl = webhook.avatarURL({
            extension: "png",
            size: 256,
          });
          if (webhookAvatarUrl) {
            try {
              const updated = await personaRepository.setAvatar(personaId, webhookAvatarUrl);
              if (!updated) {
                throw new Error(`Failed to store permanent webhook avatar URL for persona ${personaId}`);
              }
              invalidateTomoriStateCache(guild.id);
              log.info(`[Webhook Manager] Stored permanent webhook avatar URL for persona ${personaId}`);
            } catch (dbError) {
              log.warn(
                `[Webhook Manager] Failed to store permanent webhook avatar URL for persona ${personaId}`,
                dbError,
              );
            }
          }
        }
      }
    } catch (error) {
      log.warn(`[Webhook Manager] Failed to update persona webhook in channel ${channel.id}`, error);
    }
  }

  if (updatedCount > 0) {
    log.info(`[Webhook Manager] Updated ${updatedCount} persona webhook(s) for persona ${personaId}`);
  }

  return updatedCount;
}

export async function resolvePersonaWebhookIdentity(
  persona: TomoriState,
  guild: Guild,
): Promise<ResolvedWebhookIdentity> {
  const identity = await resolvePersonaAvatarIdentity(persona, guild);

  if (!persona.is_alter && !identity.avatarUrl && !identity.avatarDataUri) {
    const fallbackAvatarUrl = resolvePersonaAvatarURL(persona, guild);
    if (fallbackAvatarUrl) {
      identity.avatarUrl = fallbackAvatarUrl;
    }
  }

  return identity;
}

/**
 * Sends a message via webhook with persona-specific avatar and username.
 * Used for multi-persona responses to show different avatars per persona.
 *
 * Avatar resolution priority:
 * 1. Alter personas: Use webhook_avatar_url from database
 * 2. Main persona: Use guild avatar or fallback to webhook_avatar_url
 * 3. Fallback: Use bot's global avatar (webhook default)
 *
 * @returns The sent message, or null if failed
 */
export async function sendAsPersona(
  webhook: Webhook,
  persona: TomoriState,
  content: string,
  options?: {
    replyToMessageId?: string;
    avatarURL?: string;
    guild?: Guild;
    files?: MessageCreateOptions["files"];
    embeds?: MessageCreateOptions["embeds"];
    components?: MessageCreateOptions["components"];
  },
): Promise<Message | null> {
  try {
    const resolvedIdentity = options?.guild
      ? await resolvePersonaWebhookIdentity(persona, options.guild)
      : { username: persona.persona_nickname };
    const avatarURL = sanitizeAvatarUrl(options?.avatarURL);
    const identity: ResolvedWebhookIdentity = {
      ...resolvedIdentity,
      ...(avatarURL ? { avatarUrl: avatarURL } : {}),
    };

    const message = await sendWebhookMessageWithIdentity(
      webhook,
      {
        content,
        allowedMentions: {
          parse: ["users", "roles"],
          repliedUser: true,
        },
        ...(options?.replyToMessageId && {
          reply: {
            messageReference: options.replyToMessageId,
            failIfNotExists: false,
          },
        }),
        ...(options?.files && { files: options.files }),
        ...(options?.embeds && { embeds: options.embeds }),
        ...(options?.components && { components: options.components }),
      },
      identity,
    );

    log.info(
      `[Webhook Manager] Sent message as persona ${persona.persona_nickname} (${persona.is_alter ? "alter" : "main"})`,
    );
    return message;
  } catch (error) {
    const code = (error as { code?: number | string })?.code;
    if ((code === 10015 || code === "10015" || code === 50027 || code === "50027") && webhook.channelId) {
      invalidateWebhookCache(webhook.channelId);
    }

    log.error(`[Webhook Manager] Failed to send message as persona ${persona.persona_nickname}:`, {
      errorType: "webhook_send_error",
      metadata: {
        personaId: persona.persona_id,
        personaName: persona.persona_nickname,
        isAlter: persona.is_alter,
        error,
      },
    });
    return null;
  }
}

/**
 * Sends a voice transcript as a blockquote chat message impersonating the user.
 *
 * Used when `voice_transcript_chat_mode` is enabled. Instead of storing the
 * transcript in an internal TTL cache, it is posted visibly to the channel so:
 *   - Other users can see what was said
 *   - The LLM reads it naturally from chat history (no re-transcription)
 *   - Audio attachments are never sent to the AI
 *
 * The message is prefixed with `> ` (Discord blockquote) to visually distinguish
 * it from a regular typed message.
 *
 * @returns The sent Discord message, or null if posting failed
 */
export async function sendUserTranscriptViaWebhook(
  channel: BaseGuildTextChannel | AnyThreadChannel,
  displayName: string,
  avatarUrl: string,
  transcript: string,
): Promise<Message | null> {
  // Threads cannot own webhooks, so use the parent channel for creation/lookup
  const isThread = channel.isThread();
  const webhookTargetChannel = isThread ? (channel.parent as BaseGuildTextChannel | null) : channel;

  if (
    !webhookTargetChannel ||
    !("fetchWebhooks" in webhookTargetChannel) ||
    !("createWebhook" in webhookTargetChannel)
  ) {
    log.warn(`[Webhook Manager] Channel ${channel.id} does not support webhooks for transcript posting`);
    return null;
  }

  // Reuse the shared TomoriBot Multi-Persona webhook for this channel
  const webhookResult = await getOrCreateWebhook(webhookTargetChannel);
  if (!webhookResult.webhook) {
    log.warn(
      `[Webhook Manager] Could not get webhook for transcript posting in channel ${channel.id}: ${webhookResult.errorReason}`,
    );
    return null;
  }

  const quotedTranscript = `> ${transcript.replace(/\n/g, "\n> ")}`;

  const payload: WebhookSendPayload = {
    content: quotedTranscript,
    allowedMentions: { parse: [] },
    ...(isThread ? { threadId: channel.id } : {}),
  };

  const identity: ResolvedWebhookIdentity = {
    username: displayName,
    avatarUrl,
  };

  try {
    const message = await sendWebhookMessageWithIdentity(webhookResult.webhook, payload, identity);
    log.info(`[Webhook Manager] Sent voice transcript webhook as "${displayName}" in channel ${channel.id}`);
    return message;
  } catch (error) {
    if (isInvalidWebhookError(error) && webhookResult.webhook.channelId) {
      invalidateWebhookCache(webhookResult.webhook.channelId);
    }
    log.warn(`[Webhook Manager] Failed to send transcript webhook in channel ${channel.id}`, error);
    return null;
  }
}

/**
 * Resolves the avatar URL for a given persona and guild.
 * Handles fallback chain: alter avatar -> bot's guild avatar -> default avatar.
 *
 * @returns Avatar URL string, or undefined to use webhook default
 */
export function resolvePersonaAvatarURL(persona: TomoriState, guild: Guild): string | undefined {
  const validateAvatarURL = (avatarReference: string): string | undefined => {
    const resolvedUrl = resolvePersonaAvatarPublicUrl(avatarReference);
    if (!resolvedUrl) {
      return undefined;
    }

    return sanitizeAvatarUrl(resolvedUrl);
  };

  // Alter personas: Use webhook_avatar_url from database
  if (persona.is_alter && persona.webhook_avatar_url) {
    const validatedURL = validateAvatarURL(persona.webhook_avatar_url);
    if (validatedURL) {
      return validatedURL;
    }
  }

  if (!persona.is_alter) {
    const memberAvatar = guild.members.me?.displayAvatarURL({
      extension: "png",
      size: 256,
      forceStatic: true,
    });
    if (memberAvatar) {
      return memberAvatar;
    }

    // Fallback to webhook_avatar_url if guild has no icon
    if (persona.webhook_avatar_url) {
      const validatedURL = validateAvatarURL(persona.webhook_avatar_url);
      if (validatedURL) {
        return validatedURL;
      }
    }
  }

  // Fallback: undefined = use webhook's default avatar (bot's global avatar)
  return undefined;
}

/**
 * Invalidates the webhook cache for a specific channel.
 * Useful when webhooks are manually deleted or need to be refreshed.
 *
 */
export function invalidateWebhookCache(channelId: string): void {
  const hadCache = webhookCache.has(channelId);
  const cachedWebhook = webhookCache.get(channelId);
  webhookCache.delete(channelId);
  webhookFailureCache.delete(channelId);
  const personaCacheRemoved = invalidatePersonaWebhookCacheForChannel(channelId);
  if (cachedWebhook) {
    webhookAvatarStateCache.delete(cachedWebhook.id);
    persistedManagedWebhookIds.delete(cachedWebhook.id);
  }

  if (hadCache || personaCacheRemoved > 0) {
    log.info(`[Webhook Manager] Invalidated cache for channel ${channelId}`);
  }
}

function invalidatePersonaWebhookCacheForChannel(channelId: string): number {
  let removed = 0;
  const prefix = `${channelId}:`;
  for (const key of personaWebhookCache.keys()) {
    if (key.startsWith(prefix)) {
      personaWebhookCache.delete(key);
      removed++;
    }
  }
  return removed;
}

export function invalidatePersonaWebhookCacheForPersona(personaId: number): number {
  let removed = 0;
  const suffix = `:${personaId}`;
  for (const key of personaWebhookCache.keys()) {
    if (key.endsWith(suffix)) {
      personaWebhookCache.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    log.info(`[Webhook Manager] Invalidated persona webhook cache for persona ${personaId}`);
  }
  return removed;
}

/**
 * Useful for testing or manual refresh operations.
 */
export function clearWebhookCache(): void {
  const previousSize = webhookCache.size;
  webhookCache.clear();
  const personaSize = personaWebhookCache.size;
  personaWebhookCache.clear();
  webhookAvatarStateCache.clear();
  persistedManagedWebhookIds.clear();
  webhookFailureCache.clear();

  log.info(`[Webhook Manager] Cleared entire webhook cache (${previousSize + personaSize} entries)`);
}

/**
 * Gets webhook cache statistics for monitoring.
 *
 */
export function getWebhookCacheStats(): {
  cacheSize: number;
} {
  return {
    cacheSize: webhookCache.size + personaWebhookCache.size,
  };
}

/**
 * Deletes persona-specific webhooks across all channels in a guild.
 * Legacy cleanup helper. Normal avatar/storage flows no longer depend on these webhooks.
 *
 */
export async function deletePersonaWebhooks(guild: Guild, personaId: number): Promise<number> {
  const personaWebhookName = getPersonaWebhookName(personaId);
  let deletedCount = 0;

  invalidatePersonaWebhookCacheForPersona(personaId);

  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased()) {
      continue;
    }

    if (!("fetchWebhooks" in channel)) {
      continue;
    }

    try {
      const webhooks = await (channel as TextChannel).fetchWebhooks();
      const matching = webhooks.filter((wh) => wh.name === personaWebhookName);

      for (const webhook of matching.values()) {
        await webhook.delete("Persona removed");
        deletedCount++;
      }

      const cacheKey = getPersonaWebhookCacheKey(channel.id, personaId);
      personaWebhookCache.delete(cacheKey);
    } catch (error) {
      log.warn(`[Webhook Manager] Failed to delete persona webhook in channel ${channel.id}`, error);
    }
  }

  if (deletedCount > 0) {
    log.info(`[Webhook Manager] Deleted ${deletedCount} persona webhook(s) for persona ${personaId}`);
  }

  return deletedCount;
}
