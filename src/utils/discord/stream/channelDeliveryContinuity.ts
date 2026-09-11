import type { ResolvedWebhookIdentity } from "@/utils/discord/webhook/identity";
import { log } from "@/utils/misc/logger";
import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";

/**
 * Cross-turn Discord delivery continuity, keyed by channel.
 *
 * Discord groups consecutive webhook messages by `webhook_id` + `username` and ignores the
 * per-message avatar. Two things depend on that, and both need state that outlives a single
 * stream: `StreamState` is rebuilt for every SDK call, so anything held there is reset at
 * every turn boundary (queued chain, follow-up, persona job, tool-loop continuation):
 *
 * - **Sprite group-break alternation**: adjacent *different* sprites must not share a
 *    username, or the second renders under the first one's avatar. Held per channel because
 *    grouping spans turns, and reset whenever a foreign message lands between our own
 *    deliveries, since Discord only ever groups a message with the one directly above it.
 * - **Last delivered webhook identity**: post-turn artifacts (stickers, the "Fallback Used"
 *    notice) should be posted as the identity that actually delivered the final message, so
 *    they group with it instead of splitting off under a different name.
 *
 * Entries expire once messages are far enough apart that Discord would not group them anyway.
 * Runtime-authoritative state with no database behind it: mirrors `utils/chat/selfReplyState.ts`.
 */

// Discord stops grouping consecutive same-author messages after a few minutes, so continuity
// beyond that window is pointless, so an expired entry is equivalent to a fresh channel.
const CONTINUITY_TTL_MS = parseIntegerEnvFlag(process.env.SPRITE_GROUP_CONTINUITY_TTL_MINUTES, 10, 1) * 60 * 1000;

// Housekeeping (not an operational limit): channels are unbounded, so sweep expired entries
// once the map grows past this size rather than wiring up a timer.
const SWEEP_SIZE_THRESHOLD = 2000;

interface ChannelDeliveryState {
  /** Sprite key of the most recent non-identity sprite delivered in this channel. */
  lastSpriteKey: string | null;
  /** Current half of the clean/decorated username alternation. */
  groupParity: boolean;
  /**
   * Identity of the most recent WEBHOOK delivery, or null when the last delivery was an
   * ordinary bot message. Null is meaningful: it means post-turn artifacts must also go out
   * as the bot, since that is what they would group with.
   */
  lastWebhookIdentity: ResolvedWebhookIdentity | null;
  /**
   * Message id of the most recent WEBHOOK delivery, or null when the last delivery was an
   * ordinary bot message. Null blocks adjacency outright: a bot-user message is a different
   * Discord author, so no webhook group can continue through it.
   */
  lastDeliveredMessageId: string | null;
  updatedAt: number;
}

const channelDeliveryStates = new Map<string, ChannelDeliveryState>();

function sweepExpiredEntries(now: number): void {
  for (const [channelId, entry] of channelDeliveryStates) {
    if (now - entry.updatedAt >= CONTINUITY_TTL_MS) {
      channelDeliveryStates.delete(channelId);
    }
  }
}

/**
 * Returns the channel's live entry, creating a fresh one when absent or stale. A stale entry is
 * discarded rather than revived: past the grouping window nothing collides, so the channel
 * should start over on the clean name with no inherited identity.
 */
function getLiveEntry(channelId: string, now: number): ChannelDeliveryState {
  if (channelDeliveryStates.size >= SWEEP_SIZE_THRESHOLD) {
    sweepExpiredEntries(now);
  }

  const existing = channelDeliveryStates.get(channelId);
  if (existing && now - existing.updatedAt < CONTINUITY_TTL_MS) {
    return existing;
  }

  const fresh: ChannelDeliveryState = {
    lastSpriteKey: null,
    groupParity: false,
    lastWebhookIdentity: null,
    lastDeliveredMessageId: null,
    updatedAt: now,
  };
  channelDeliveryStates.set(channelId, fresh);
  return fresh;
}

/**
 * Reports whether a message from someone else landed after our last webhook delivery, which
 * means Discord has already broken the group and the next sprite cannot collide with anything.
 *
 * Compares snowflake magnitude rather than equality because `channel.lastMessageId` is
 * maintained from the gateway `MESSAGE_CREATE` dispatch, which can lag a send we just made: an
 * equality check would read our own back-to-back segments as non-adjacent and drop the group
 * break that keeps them from merging. Snowflakes are time-ordered, so only a strictly greater
 * id proves a later message exists; a lagging (smaller) read falls through to "adjacent", whose
 * worst case is a redundant suffix rather than two sprites collapsing under one avatar.
 */
function hasForeignMessageSinceDelivery(
  deliveredMessageId: string | null,
  channelLastMessageId: string | null,
): boolean {
  if (deliveredMessageId === null) return true;
  if (channelLastMessageId === null) return false;

  try {
    return BigInt(channelLastMessageId) > BigInt(deliveredMessageId);
  } catch {
    // A non-numeric id should be impossible, so assume adjacency and keep the group break.
    return false;
  }
}

/**
 * Advances the channel's sprite alternation for a sprite about to be delivered, and reports
 * which username representation it must use.
 *
 * Parity flips only when the sprite differs from the previous one delivered in this channel, so
 * same-sprite runs keep an identical username and still group naturally, while adjacent
 * different-sprite messages are guaranteed to differ.
 *
 * The run restarts whenever anything else spoke since our last delivery (a user, another
 * persona's webhook, our own bot-user fallback). Discord groups a message only with the one
 * directly above it, so a broken group means the decorated name would be noise rather than a
 * collision break.
 *
 * @param channelLastMessageId - The channel's current `lastMessageId`, used for the adjacency test
 */
export function advanceChannelSpriteGroupParity(
  channelId: string,
  spriteKey: string,
  channelLastMessageId: string | null,
): boolean {
  const now = Date.now();
  const entry = getLiveEntry(channelId, now);
  entry.updatedAt = now;

  if (hasForeignMessageSinceDelivery(entry.lastDeliveredMessageId, channelLastMessageId)) {
    entry.lastSpriteKey = null;
    entry.groupParity = false;
  }

  // A null previous key means this sprite is the channel's first in the current window, so it
  // stays on the clean name, so there is nothing before it to collide with.
  if (entry.lastSpriteKey !== null && entry.lastSpriteKey !== spriteKey) {
    entry.groupParity = !entry.groupParity;
  }
  entry.lastSpriteKey = spriteKey;
  return entry.groupParity;
}

/**
 * Records the identity a webhook message was just delivered under, so later sends in the same
 * channel can reuse it verbatim and group with it.
 *
 * The stored username is the one actually sent: which may be the decorated `Persona (sprite)`
 * form chosen by the group-break alternation. Re-resolving the sprite from scratch would produce
 * the clean name instead and split the group, which is exactly what this avoids.
 *
 * @param identity - Identity used for the send
 * @param messageId - Id of the sent message, which anchors the sprite alternation's adjacency test
 */
export function recordChannelDeliveredWebhookIdentity(
  channelId: string,
  identity: ResolvedWebhookIdentity,
  messageId: string | null = null,
): void {
  const now = Date.now();
  const entry = getLiveEntry(channelId, now);
  entry.lastWebhookIdentity = { ...identity };
  entry.lastDeliveredMessageId = messageId;
  entry.updatedAt = now;
}

/**
 * Records that the channel's most recent delivery was an ordinary bot message, clearing any
 * remembered webhook identity. Without this a stale identity would be reused after the persona
 * had already reverted to the bot, putting artifacts under a name nothing else is using.
 *
 */
export function recordChannelDeliveredBotMessage(channelId: string): void {
  const now = Date.now();
  const entry = getLiveEntry(channelId, now);
  entry.lastWebhookIdentity = null;
  entry.lastDeliveredMessageId = null;
  entry.updatedAt = now;
}

/**
 * Returns the identity of the channel's most recent webhook delivery, or null when the last
 * delivery was an ordinary bot message, nothing has been delivered, or the window has expired.
 * Callers should send as the bot when this is null.
 *
 */
export function getChannelDeliveredWebhookIdentity(channelId: string): ResolvedWebhookIdentity | null {
  const entry = channelDeliveryStates.get(channelId);
  if (!entry || Date.now() - entry.updatedAt >= CONTINUITY_TTL_MS) {
    return null;
  }
  return entry.lastWebhookIdentity;
}

/** Test seam: drops all continuity state. */
export function clearAllChannelDeliveryContinuity(): void {
  const cleared = channelDeliveryStates.size;
  channelDeliveryStates.clear();
  if (cleared > 0) {
    log.info(`Cleared delivery continuity for ${cleared} channel(s).`);
  }
}
