/**
 * Stat-tracking metric catalog.
 *
 * Each value is one `metric` in the `stat_counters` table. Adding a new metric
 * is a new entry here: never an `ALTER TABLE` (the long/narrow counter table
 * carries the metric and its sub-key as data, not columns).
 *
 * `metric_key` semantics per metric:
 *   - presence_seen → "" (one per successful direct-triggerer turn). This is the
 *                     behavioral reunion clock, deliberately separate from
 *                     message_sent so DMs participate without changing telemetry
 *                     leaderboards. It is written immediately rather than buffered
 *                     because cross-channel context builds require read-after-write
 *                     consistency.
 *   - command_used  → full command path, space-joined (e.g. "config humanizer",
 *                     "server welcome-channel set"); not just the top-level category
 *   - model_used    → model id / codename
 *   - tokens_in     → model id / codename (count accumulates input token deltas, not 1)
 *   - tokens_out    → model id / codename (count accumulates output token deltas, not 1)
 *   - tool_used     → tool name
 *   - sprite_shown      → sprite name (every delivered sprite, identity or not)
 *   - sprite_emotion    → sprite name, recorded ONLY for non-identity sprites so the
 *                         sprite's user-given tag can feed the emotion breakdown
 *                         (getEmotionBreakdown) without dragging in DID-alter identity
 *                         sprites. sprite_shown stays the all-inclusive leaderboard count.
 *   - emoji_used        → emoji name
 *   - sticker_used      → sticker name/id
 *   - active_hour       → hour-of-day "0".."23"
 *   - text_generated    → "" (one per completed chat turn)
 *   - user_impersonation_triggered → impersonated Discord user id (one per
 *                                    completed user-impersonation chat turn)
 *   - image_generated   → model codename (one per successful image generation; keyed
 *                         so the total is SUM(count) over keys while still exposing a
 *                         per-model breakdown that cannot be backfilled later)
 *   - video_generated   → model codename (one per successful video generation)
 *   - provider_error    → "{provider}:{code}" (e.g. "nvidia:500"), one per terminal provider
 *                         failure. Low cardinality by construction: no model id, no user content,
 *                         no upstream message text. Paired with model_used (successful turns per
 *                         model) it makes a per-model success rate computable, which is the signal
 *                         that catches a default model failing 100% of the time without waiting
 *                         for a bug report. OPERATIONAL TELEMETRY ONLY: nothing behavioral may
 *                         read it, so no persona or routing decision ever takes it as input.
 *   - audio_generated   → TTS backend label ("elevenlabs" | "tts-clone" |
 *                         "tts-voice-design"); one per successful voice message.
 *                         Backend (not raw voice id) is used: low-cardinality,
 *                         privacy-safe, and answers "paid API vs local TTS" for cost.
 *   - (all others)      → "" (scalar event counter)
 */
const STAT_METRICS = [
  "message_sent",
  "presence_seen",
  "command_used",
  "model_used",
  "tokens_in",
  "tokens_out",
  "tool_used",
  "web_search",
  "memory_taught",
  "reminder_set",
  "sprite_shown",
  "sprite_emotion",
  "emoji_used",
  "sticker_used",
  "active_hour",
  "text_generated",
  "user_impersonation_triggered",
  "image_generated",
  "video_generated",
  "audio_generated",
  "provider_error",
] as const;

/** Union of all valid `stat_counters.metric` values. */
export type StatMetric = (typeof STAT_METRICS)[number];

/**
 * Persona-agnostic metrics: these are not scoped to a persona lineage, so they
 * are always written with the lineage-0 sentinel (see plan §5). All other
 * metrics carry the active persona's lineage id.
 */
export const PERSONA_AGNOSTIC_METRICS = new Set<StatMetric>(["command_used", "provider_error"]);
