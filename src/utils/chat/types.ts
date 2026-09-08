import type { BaseGuildTextChannel, Client, Guild, GuildMember, Message, Sticker, Webhook } from "discord.js";
import type { ForcedMention } from "@/types/discord/mentions";
import type { ServerEmojiRow, ServerStickerRow, TomoriState, UserRow } from "@/types/db/schema";
import type { RequestSnapshot, StructuredContextItem } from "@/types/misc/context";
import type {
  FunctionCall,
  FunctionResponseImageMetadata,
  StreamResult,
  ThoughtLogPayload,
} from "@/types/provider/interfaces";
import type { StreamingContext } from "@/types/tool/interfaces";
import type { DeliberateToolIntentMatch } from "@/utils/tools/deliberateToolMode";
import type { ThoughtLogOwner } from "@/utils/discord/thoughtLog";
import type { ReunionPresenceScope } from "@/utils/chat/reunionPresence";
import type { MessageIdMap } from "@/utils/text/messageIdMap";
import type { SimplifiedMessageForContext } from "@/utils/text/contextBuilder";
import type { TextQuotaTriggerState } from "@/utils/chat/textQuotaState";

export type TextQuotaSource = "user" | "system";

export interface ChatReminderData {
  reminder_purpose: string;
  reminder_lateness?: string | null;
  self_reminder?: boolean;
}

export type QueuedMessageDiscardReason =
  | "admission_rejected"
  | "channel_queue_cleared"
  | "queued_processing_failed"
  | "stale_lock_release"
  | "superseded_follow_up"
  | "self_reply_work_cleared";

export type ChatGenerationResultHandler = (result: GenerationTurnResult) => void | Promise<void>;
export type QueuedMessageDiscardHandler = (reason: QueuedMessageDiscardReason) => void | Promise<void>;

export interface ManualTriggerInvoker {
  userDiscId: string;
  username: string;
  locale?: string;
  member?: GuildMember | null;
}

export interface SystemTriggerIdentity {
  serverDiscId: string;
  userDiscId: string;
}

export interface SceneTurnSpeaker {
  personaId: number;
  personaName: string;
}

export interface SceneTurnMetadata {
  commandId: string;
  sequence: SceneTurnSpeaker[];
  turnIndex: number;
  totalTurns: number;
  additionalInstructions?: string;
}

/** Public input to tomoriChat(): optional fields apply defaults in normalizeChatInvocation. */
export interface TomoriChatInput {
  client: Client;
  message: Message;
  isFromQueue: boolean;
  isManuallyTriggered?: boolean;
  forceReason?: boolean;
  reasoningQuery?: string;
  llmOverrideCodename?: string;
  isStopResponse?: boolean;
  retryCount?: number;
  skipLock?: boolean;
  reminderRecipientID?: string;
  reminderData?: ChatReminderData;
  selectedPersonaId?: number;
  triggeredPersonaIds?: number[];
  isPersonaJob?: boolean;
  isUserImpersonation?: boolean;
  impersonatedUserId?: string;
  textQuotaSource?: TextQuotaSource;
  textQuotaTriggerKey?: string;
  textQuotaUserDiscId?: string;
  manualSystemPrompt?: string;
  manualPrefill?: string;
  naiContinuationPrefill?: string;
  emptyResponseFinishReason?: string;
  shouldSurfaceUserErrors?: boolean;
  injectedContextItems?: StructuredContextItem[];
  forcedMentions?: ForcedMention[];
  manualTriggerInvoker?: ManualTriggerInvoker;
  systemTriggerIdentity?: SystemTriggerIdentity;
  manualStreamingContextOverrides?: Partial<StreamingContext>;
  sceneTurn?: SceneTurnMetadata;
  onGenerationResult?: ChatGenerationResultHandler;
  onQueueDiscard?: QueuedMessageDiscardHandler;
}

export interface ChatIncoming {
  client: Client;
  message: Message;
  isFromQueue: boolean;
  isManuallyTriggered?: boolean;
  forceReason?: boolean;
  reasoningQuery?: string;
  llmOverrideCodename?: string;
  isStopResponse?: boolean;
  retryCount: number;
  skipLock: boolean;
  reminderRecipientID?: string;
  reminderData?: ChatReminderData;
  selectedPersonaId?: number;
  triggeredPersonaIds?: number[];
  isPersonaJob: boolean;
  isUserImpersonation: boolean;
  impersonatedUserId?: string;
  textQuotaSource: TextQuotaSource;
  textQuotaTriggerKey?: string;
  textQuotaUserDiscId?: string;
  manualSystemPrompt?: string;
  manualPrefill?: string;
  naiContinuationPrefill?: string;
  emptyResponseFinishReason?: string;
  shouldSurfaceUserErrors?: boolean;
  injectedContextItems?: StructuredContextItem[];
  forcedMentions?: ForcedMention[];
  manualTriggerInvoker?: ManualTriggerInvoker;
  systemTriggerIdentity?: SystemTriggerIdentity;
  manualStreamingContextOverrides?: Partial<StreamingContext>;
  sceneTurn?: SceneTurnMetadata;
  onGenerationResult?: ChatGenerationResultHandler;
  onQueueDiscard?: QueuedMessageDiscardHandler;
}

export type ChatAdmissionDisposition = "run" | "ignore" | "queued" | "blocked" | "error";

interface ChatAdmissionBase {
  incoming: ChatIncoming;
  disposition: ChatAdmissionDisposition;
  locale: string;
  reason?: string;
}

export interface RunnableChatAdmission extends ChatAdmissionBase {
  disposition: "run";
  client: Client;
  message: Message;
  channel: Message["channel"];
  guild?: Guild | null;
  serverDiscId?: string;
  serverName?: string;
  channelName?: string;
  userDiscId?: string;
  cooldownUserDiscId?: string;
  isDMChannel?: boolean;
  tomoriState?: TomoriState;
  allPersonas?: TomoriState[];
  userRow?: UserRow | null;
  requestSnapshot?: RequestSnapshot;
}

export interface NonRunnableChatAdmission extends ChatAdmissionBase {
  disposition: Exclude<ChatAdmissionDisposition, "run">;
  reason: string;
  error?: unknown;
}

export type ChatAdmission = RunnableChatAdmission | NonRunnableChatAdmission;

export interface LockedChatTurn {
  admission: RunnableChatAdmission;
  channelId: string;
  lockedAt: number;
  queueDepth: number;
  skipLock: boolean;
}

export interface ChatTurnPlan {
  lockedTurn: LockedChatTurn;
  turns: ChatTurn[];
}

export interface ChatTurn {
  lockedTurn: LockedChatTurn;
  persona: TomoriState;
  personaIndex: number;
  totalPersonas: number;
  allPersonas: TomoriState[];
  tomoriState: TomoriState;
  mainPersona: TomoriState | null;
  userRow: UserRow;
  requestSnapshot: RequestSnapshot;
  serverDiscId: string;
  guild: Guild | null;
  isDMChannel: boolean;
  isSelfMessage: boolean;
  userDiscId: string;
  cooldownUserDiscId: string;
  triggererName: string;
  triggererFormattedName: string;
  triggererAddressTerm: string;
  channelName: string;
  channelDescription: string | null;
  serverName: string;
  serverDescription: string | null;
  textCredentialSource: "server" | "personal";
  personalRoutingUserId: number | null;
  personalTextProvider: string | null;
  shouldApplyTextQuota: boolean;
  textQuotaTriggerKey: string;
  textQuotaState: TextQuotaTriggerState | null;
  shouldSurfaceUserErrors: boolean;
  forcedMentions?: ForcedMention[];
  isUserImpersonation: boolean;
  impersonatedUserId?: string;
  triggeredPersonaIds: number[];
}

export interface ChatTurnContext {
  turn: ChatTurn;
  client: Client;
  message: Message;
  channel: Message["channel"];
  guild: Guild | null;
  locale: string;
  serverDiscId: string;
  userDiscId: string;
  /** Internal users FK of the triggerer, resolved once at turn planning (no per-turn lookup). */
  triggererUserId: number | undefined;
  isDMChannel: boolean;
  isFromQueue: boolean;
  isStopResponse: boolean;
  isPersonaJob: boolean;
  isSelfMessage: boolean;
  isUserImpersonation: boolean;
  impersonatedUserId?: string;
  allPersonas: TomoriState[];
  /**
   * Direct-triggerer presence and any one-shot claim awaiting the post-turn
   * success decision. Both phases live in `@/utils/chat/reunionPresence`.
   */
  reunionPresence: ReunionPresenceScope | null;
  currentPersona: TomoriState;
  tomoriState: TomoriState;
  requestSnapshot: RequestSnapshot;
  contextItems: StructuredContextItem[];
  simplifiedMessages: SimplifiedMessageForContext[];
  streamingContext: StreamingContext;
  messageIdMap: MessageIdMap;
  emojiStrings: string[];
  loadedEmojis: ServerEmojiRow[] | null;
  loadedStickers: ServerStickerRow[] | null;
  channelName: string;
  channelDescription: string | null;
  serverName: string;
  serverDescription: string | null;
  triggererName: string;
  triggererFormattedName: string;
  triggererAddressTerm: string;
  textCredentialSource: "server" | "personal";
  personalRoutingUserId: number | null;
  personalTextProvider: string | null;
  shouldApplyTextQuota: boolean;
  textQuotaTriggerKey: string;
  textQuotaState: TextQuotaTriggerState | null;
  shouldSurfaceUserErrors: boolean;
  responseTarget?: ChatResponseTarget;
  /** Whether deliberate-tool-mode is gating this turn (server flag OR user override). */
  deliberateToolModeActive: boolean;
  /** Resolved per-turn context window for retained-affordance carryover. */
  deliberateToolContextTurns: number;
  /** Map of tool name -> the trigger match that admitted it (used for hidden-notice routing). */
  deliberateToolTriggerMatchByToolName: Map<string, DeliberateToolIntentMatch>;
}

export interface ChatResponseTarget {
  webhook?: Webhook;
  temporaryWebhook?: Webhook;
  personaUsername?: string;
  personaAvatarUrl?: string;
  prefixStrippingName?: string;
  webhookTargetChannel?: BaseGuildTextChannel;
}

export interface ChatResponseSink {
  prepare?(context: ChatTurnContext): Promise<ChatResponseTarget | undefined>;
  emitStreamResult(result: StreamResult): Promise<void>;
  emitError(error: unknown): Promise<void>;
  finalize(result: GenerationTurnResult): Promise<void>;
  /**
   * Releases per-turn resources (currently the temporary impersonation webhook) on every exit
   * path, including the throws that bypass {@link ChatResponseSink.finalize}. Must be idempotent.
   */
  cleanup?(): Promise<void>;
}

interface ChatPersonaResponse {
  text: string;
  personaName: string;
  personaId?: number;
  personaLineageId?: number | null;
}

export interface ToolHistoryEntry {
  functionCall: FunctionCall;
  functionResponse: Record<string, unknown>;
  imageMetadata?: FunctionResponseImageMetadata;
  preToolCallTextParts?: Array<Record<string, unknown>>;
}

export interface GenerationTurnResult {
  status: StreamResult["status"] | "skipped";
  streamResults: StreamResult[];
  personaResponses: ChatPersonaResponse[];
  /** A tool delivered the response directly even though no streamed text was captured. */
  toolResponseDelivered?: boolean;
  thoughtLog?: ThoughtLogPayload;
  thoughtLogOwner?: ThoughtLogOwner;
  selectedSticker?: Sticker;
}
