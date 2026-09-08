/**
 * Generic tool interface for provider-agnostic function calling
 * This abstracts tools away from specific LLM provider formats
 */

import type { LlmRow, TomoriState } from "../db/schema";
import type { StructuredContextItem } from "../misc/context";
import type {
  BaseGuildTextChannel,
  BaseGuildVoiceChannel,
  Client,
  Message,
  DMChannel,
  NewsChannel,
  TextChannel,
  AnyThreadChannel,
  Webhook,
} from "discord.js";
import type { TypedMCPToolResult } from "./mcpTypes";
import type { FunctionResponseImageMetadata } from "../provider/interfaces";
import type { MessageIdMap } from "@/utils/text/messageIdMap";

/**
 * Tool parameter schema definition
 * Provider-agnostic parameter specification
 */
export type ToolParameterType = "string" | "number" | "boolean" | "array" | "object";

interface ToolParameterSchemaBase {
  type: ToolParameterType;
  description?: string;
  enum?: string[];
}

export interface ToolStringParameterSchema extends ToolParameterSchemaBase {
  type: "string";
}

interface ToolNumberParameterSchema extends ToolParameterSchemaBase {
  type: "number";
}

interface ToolBooleanParameterSchema extends ToolParameterSchemaBase {
  type: "boolean";
}

interface ToolArrayParameterSchema extends ToolParameterSchemaBase {
  type: "array";
  items: ToolParameterPropertySchema;
}

interface ToolObjectParameterSchema extends ToolParameterSchemaBase {
  type: "object";
  properties: Record<string, ToolParameterPropertySchema>;
  required?: string[];
}

export type ToolParameterPropertySchema =
  | ToolStringParameterSchema
  | ToolNumberParameterSchema
  | ToolBooleanParameterSchema
  | ToolArrayParameterSchema
  | ToolObjectParameterSchema;

export interface ToolParameterSchema extends ToolObjectParameterSchema {
  type: "object";
  properties: Record<string, ToolParameterPropertySchema>;
  required: string[];
}

/**
 * A single Discord message the streaming layer has already committed to the channel.
 * Collected into {@link StreamingContext.deliveredMessageRefs} so the fallback orchestrator
 * can delete the partial output of a superseded (timed-out / errored) generation attempt.
 */
export interface DeliveredStreamMessage {
  /** Discord snowflake ID of the delivered message. */
  messageId: string;
  /** Channel (or thread) ID the message was delivered to. */
  channelId: string;
  /** True when delivered through a persona/alter webhook (deleted via `webhook.deleteMessage`). */
  isWebhook: boolean;
}

/**
 * Streaming context for enhanced functionality during streaming
 */
export interface StreamingContext {
  disableYouTubeProcessing: boolean; // Flag to temporarily disable YouTube function during enhanced context restart
  disableProfilePictureProcessing?: boolean; // Flag to temporarily disable profile picture processing during enhanced context restart
  disableGifProcessing?: boolean; // Flag to temporarily disable GIF processing during enhanced context restart
  disableShortTermMemoryUpdate?: boolean; // Flag to prevent update_short_term_memory from being called more than once per turn
  disableCrossChannelMessage?: boolean; // Flag to prevent nested cross-channel dispatch during tool-driven cross-channel turns
  explicitLongTermMemoryIntent?: boolean; // Flag to suppress STM tool nudges when the current user message explicitly asks for persistent memory
  disableMessageMetadataContext?: boolean; // Flag to prevent reveal_message_metadata from being called more than once per turn
  disableRecentMessageReplyTool?: boolean; // Allow reactions but block tool-sent replies when the stream is already replying
  forceReason?: boolean; // Flag to indicate reasoning mode for enhanced AI responses
  isManuallyTriggered?: boolean; // Flag to indicate this stream was triggered by a manual command
  suppressUserErrors?: boolean; // Suppress user-facing error embeds during retries or non-deliberate chat turns
  /**
   * Whose credentials answered this turn's text request. Error recovery tips must name the
   * commands that can actually repair the failing configuration, and scope cannot be inferred
   * from the provider or model name because both scopes can run the same provider. Optional
   * only for non-chat provider calls that have no user-scoped routing decision to report.
   */
  textCredentialSource?: "server" | "personal";
  forceModelFallback?: boolean; // Force suppress errors regardless of key availability (model fallback retries)
  rotationKeyRetriesUsed?: boolean; // True if one or more rotation-key retries were attempted
  disableAllTools?: boolean; // Flag to disable all tool calling (e.g., during user impersonation)
  deliberateToolAllowedNames?: string[]; // Optional per-turn allowlist when deliberate tool mode detects scoped intent
  disableReminderTool?: boolean; // Flag to prevent create_task from being called during a reminder-triggered turn
  outputPrefill?: string; // Optional prefill to output before streaming (hybrid prefix)
  outputPrefillState?: { sent: boolean }; // Tracks if prefill was already output (avoid duplicates on retry)
  replyNoticeState?: { attempted: boolean; sent: boolean }; // Tracks the standalone alter reply notice across tool-call stream retries
  forcedMentions?: Array<{
    handle: string;
    userId: string;
  }>; // Additional mention handles to force-resolve (e.g., reminder recipients)
  suppressTextOutput?: boolean; // Suppress text output to Discord (NAI tool retry mode : keeps model state coherent but hides repeated text)
  /** NAI GLM-4.6: incomplete trailing fragment from previous stream, to append as prompt continuation on retry */
  naiContinuationPrefill?: string;
  /** AbortSignal to cancel the underlying HTTP request when the SDK call timeout fires */
  abortSignal?: AbortSignal;
  /**
   * Empty-response retry count of the current chat turn (incoming.retryCount). The stream
   * segment processor's opening-label leak guard uses it to decide between discard-and-retry
   * (budget remaining) and strip-and-deliver (budget exhausted).
   */
  emptyResponseRetryCount?: number;
  /** Called when streaming makes visible or provider-side progress, so outer watchdogs can refresh their timers. */
  onStreamProgress?: () => void;
  /**
   * Tool names that should return `endTurn: true` on success.
   * Used by hidden agent turns (e.g., the hidden image agent) to terminate the streaming
   * loop cleanly after their target tool completes, without hardcoding a specific "mode".
   * Any tool whose name appears in this list will end the turn immediately on success.
   */
  endTurnAfterTools?: string[];

  messageIdMap?: MessageIdMap;

  /**
   * Internal `users` FK of whoever triggered this turn, carried so the streaming layer can scope
   * telemetry without a DB lookup on a hot path. Absent for turns with no resolved triggerer
   * (scheduler-driven jobs, some manual flows), which simply record nothing.
   */
  triggererUserId?: number;

  /**
   * Shared, mutable sink of messages the streaming layer has committed to Discord this turn.
   * The orchestrator pushes one entry per successful send (see uiUpdater's `recordSuccessfulSend`);
   * because it is a reference threaded through {@link buildStreamContext} onto the per-attempt
   * StreamContext, entries survive even when a timed-out `streamToDiscord` promise is abandoned by
   * the SDK-call-timeout race. `runGenerationTurn` reads it to delete the partial output of a
   * superseded generation attempt so only the surviving (fallback) response remains visible.
   */
  deliveredMessageRefs?: DeliveredStreamMessage[];
}

/**
 * Context passed to tool execution
 * Contains all necessary Discord and Tomori state information
 */
export interface ToolContext {
  channel: BaseGuildTextChannel | BaseGuildVoiceChannel | DMChannel | NewsChannel | TextChannel | AnyThreadChannel;
  client: Client;
  message?: Message;

  tomoriState: TomoriState;
  locale: string;

  provider: string;

  emojiStrings?: string[];
  userId?: string;
  internalUserId?: number;
  guildId?: string;
  streamContext?: StreamingContext; // Optional streaming context for enhanced functionality

  webhook?: Webhook;
  personaUsername?: string;
  personaAvatarUrl?: string; // URL or data URI for the active persona/user identity
  activePersonaId?: number; // Active responding persona for tool-driven follow-up turns
  isUserImpersonation?: boolean; // True when the active turn is a user impersonation session
  impersonatedUserId?: string; // Discord user ID currently being impersonated, if any
  suppressProgressNotices?: boolean; // Skip public "working..." embeds for fire-and-forget flows
  showKillHint?: boolean; // When true, tool notice footers include the /kill hint (set after SOFT_WARN_ITERATION_THRESHOLD)
  contextItems?: StructuredContextItem[]; // Current LLM context for tools that need hidden resolution metadata

  messageIdMap?: MessageIdMap;

  /** Turn-level AbortSignal. Tools should forward this to their fetch/HTTP calls for true cancellation on /kill. */
  abortSignal?: AbortSignal;
}

/**
 * Result returned by tool execution
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  imageMetadata?: FunctionResponseImageMetadata;
  /** True when the tool successfully delivered the persona's response directly to the user. */
  responseDelivered?: boolean;
  /** When true, the streaming loop should end the LLM's turn immediately after processing
   *  this tool result. Used by tools that trigger async follow-up work (e.g., boomerang). */
  endTurn?: boolean;
}

/**
 * Tool category classification
 */
export type ToolCategory = "discord" | "search" | "memory" | "utility" | "mcp";

/**
 * Model capability flags that tools may require to be exposed.
 */
type ToolModelCapabilityKey = "has_tools" | "sees_images" | "sees_videos" | "sees_youtube" | "supports_structoutput";

export type ToolModelCapabilityRequirements = Partial<Pick<LlmRow, ToolModelCapabilityKey>>;

export type ToolAvailabilityLlmState = Pick<LlmRow, "llm_codename" | ToolModelCapabilityKey>;

/**
 * Minimal state used while assembling the LLM-visible tool schema before
 * provider-specific adapters serialize it.
 */
export interface ToolAssemblyState {
  server_id: string;
  /** True when the active persona has either a local voice sample or provider-hosted voice assigned. */
  activePersonaHasElevenlabsVoice: boolean;
  /** Present when the active persona should use instruct-based VoiceDesign synthesis. */
  activePersonaVoiceDesignPrompt?: string | null;
  /** Display/name marker for the active speech voice selection. */
  activePersonaVoiceName?: string | null;
  llm: ToolAvailabilityLlmState;
  diffusion_model_id?: number | null;
  nai_diffusion_model_id?: number | null;
  video_model_id?: number | null;
  config: {
    sticker_usage_enabled: boolean;
    web_search_enabled: boolean;
    self_teaching_enabled: boolean;
    manage_message_enabled: boolean;
    imagegen_enabled: boolean;
    videogen_enabled: boolean;
    voice_message_enabled: boolean;
    user_blocking_enabled: boolean;
    // Required, not optional: every construction site copies these fields by hand, and an
    // optional flag here silently reads as enabled through the mapper's fallback, leaving
    // the capability toggle with no effect and no compile error.
    user_info_updates_enabled: boolean;
    thread_creation_enabled: boolean;
  };
}

export interface ToolAssemblyContext {
  provider: string;
  state: ToolAssemblyState;
  /** Names admitted before context-specific schema variants are assembled. */
  availableToolNames?: ReadonlySet<string>;
}

/**
 * Generic tool interface
 * All tools must implement this interface regardless of provider
 */
export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;

  parameters: ToolParameterSchema;

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  isAvailableFor(provider: string): boolean;

  /**
   * Availability that depends on live turn state (per-turn dedup flags, active
   * model capabilities, configured server slots). A `false` here means "not
   * right now", never "this provider cannot", so callers must report the two
   * rejections differently to the model.
   */
  isAvailableForContext?(provider: string, context: ToolContext): boolean;

  assembleForContext?(context: ToolAssemblyContext): Tool | null | Promise<Tool | null>;

  requiredModelCapabilities?: ToolModelCapabilityRequirements;
  requiresPermissions?: string[];
  requiresFeatureFlag?: string;
  requiresFollowUp?: boolean; // If true, always allow follow-up generation after tool execution (e.g., search/fetch tools)
}

/**
 * Abstract base tool class with common functionality
 */
export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract category: ToolCategory;
  abstract parameters: ToolParameterSchema;
  requiredModelCapabilities?: ToolModelCapabilityRequirements;

  isAvailableFor(_provider: string): boolean {
    return true;
  }

  abstract execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /**
   * Helper method to validate required parameters
   * @param args - Arguments provided to the tool
   * @returns ValidationResult indicating if parameters are valid
   */
  protected validateParameters(args: Record<string, unknown>): {
    isValid: boolean;
    missingParams?: string[];
    errors?: string[];
  } {
    const missingParams: string[] = [];
    const errors: string[] = [];

    for (const requiredParam of this.parameters.required) {
      if (!(requiredParam in args) || args[requiredParam] === undefined || args[requiredParam] === null) {
        missingParams.push(requiredParam);
      }
    }

    for (const [paramName, paramValue] of Object.entries(args)) {
      if (paramValue === undefined || paramValue === null) continue;

      const paramSchema = this.parameters.properties[paramName];
      if (paramSchema) {
        errors.push(...this.validateParameterValue(paramValue, paramSchema, paramName));
      }
    }

    return {
      isValid: missingParams.length === 0 && errors.length === 0,
      missingParams: missingParams.length > 0 ? missingParams : undefined,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private validateParameterValue(value: unknown, schema: ToolParameterPropertySchema, path: string): string[] {
    const errors: string[] = [];
    const actualType = Array.isArray(value) ? "array" : typeof value;

    if (schema.type !== actualType) {
      errors.push(`Parameter '${path}' expected type '${schema.type}' but got '${actualType}'`);
      return errors;
    }

    if (schema.enum && typeof value === "string") {
      if (!schema.enum.includes(value)) {
        errors.push(`Parameter '${path}' must be one of: ${schema.enum.join(", ")}`);
      }
    }

    if (schema.type === "array") {
      for (const [index, item] of (value as unknown[]).entries()) {
        errors.push(...this.validateParameterValue(item, schema.items, `${path}[${index}]`));
      }
      return errors;
    }

    if (schema.type === "object") {
      const objectValue = value as Record<string, unknown>;

      for (const requiredParam of schema.required ?? []) {
        if (
          !(requiredParam in objectValue) ||
          objectValue[requiredParam] === undefined ||
          objectValue[requiredParam] === null
        ) {
          errors.push(`Parameter '${path}.${requiredParam}' is required`);
        }
      }

      for (const [key, nestedValue] of Object.entries(objectValue)) {
        const nestedSchema = schema.properties[key];
        if (!nestedSchema || nestedValue === undefined || nestedValue === null) {
          continue;
        }

        errors.push(...this.validateParameterValue(nestedValue, nestedSchema, `${path}.${key}`));
      }
    }

    return errors;
  }

  /**
   * Helper method to check if tool is enabled based on Tomori configuration
   * @param _context - Tool context containing Tomori state
   * @returns True if the tool should be available
   */
  protected isEnabled(_context: ToolContext): boolean {
    return true;
  }
}

/**
 * Tool adapter interface for converting between generic tools and provider-specific formats
 */
interface ToolAdapter {
  /**
   * Convert a generic tool to provider-specific format
   */
  convertTool(tool: Tool): Record<string, unknown>;

  /**
   * Convert tool result back to provider-specific format
   */
  convertResult(result: ToolResult): Record<string, unknown>;

  getProviderName(): string;
}

/**
 * Enhanced tool adapter interface that includes MCP capabilities
 * Provides provider-agnostic access to both built-in and MCP tools
 */
export interface MCPCapableToolAdapter extends ToolAdapter {
  /**
   * Get all available tools (built-in + MCP) in provider-specific format
   * @param serverId - Optional Discord server ID for server-specific tool selection
   * @param allowedMCPFunctions - Optional pre-filtered list of MCP function names to include
   */
  getAllToolsInProviderFormat(
    builtInTools: Tool[],
    serverId?: number,
    allowedMCPFunctions?: string[],
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Check if a function name belongs to an MCP tool
   * @returns Promise<boolean> - True if this is an MCP tool function
   */
  isMCPFunction(functionName: string): Promise<boolean>;

  /**
   * Execute an MCP tool function
   * @param context - Tool execution context for Discord operations
   */
  executeMCPFunction(
    functionName: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<TypedMCPToolResult>;
}

/**
 * Tool execution event for monitoring and debugging
 */
export interface ToolExecutionEvent {
  toolName: string;
  provider: string;
  serverId: string;
  userId?: string;
  parameters: Record<string, unknown>;
  result: ToolResult;
  executionTime: number;
  timestamp: Date;
}

/**
 * Tool registry interface for managing all available tools
 */
export interface ToolRegistryInterface {
  registerTool(tool: Tool): void;

  /**
   * @returns The tool instance or undefined if not found
   */
  getTool(name: string): Tool | undefined;

  /**
   * @param context - Tool context for feature flag checking
   */
  getAvailableTools(provider: string, context: ToolContext): Tool[];

  /**
   * Get all registered tools
   */
  getAllTools(): Tool[];

  /**
   * @param args - Arguments for the tool
   */
  executeTool(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
