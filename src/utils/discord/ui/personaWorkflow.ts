import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import type {
  APIAttachment,
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  Message,
  ModalMessageModalSubmitInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ModalOptions } from "@/types/discord/modal";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import {
  buildNoticeContainer,
  buildRangeSelectorPayload,
  getPaginatedModalComponent,
  hasRawModalAcknowledgement,
  isCollectorTimeoutError,
  MODAL_OPTIONS_PER_PAGE,
  parseModalRangeIndex,
  promptWithRawModal,
  RANGES_PER_SELECTOR_PAGE,
  replyPaginatedPersonaChoicesV2,
  sliceModalOptions,
} from "./interactionCore";
import type { AvatarSessionCache } from "./interactionCore";
import type { NoticeContainerOptions } from "./interactionCore";

// Re-exported so anchor-workflow callers (e.g. commands/model/text.ts) can detect a
// collector timeout without importing the heavy interactionCore module directly, keeping
// their unit-test module graph small.
export { isCollectorTimeoutError } from "./interactionCore";

const DEFAULT_WORKFLOW_COMPONENT_TIMEOUT_MS = 120000;
const configuredWorkflowTimeout = Number.parseInt(process.env.PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS || "", 10);
export const PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS =
  Number.isFinite(configuredWorkflowTimeout) && configuredWorkflowTimeout > 0
    ? configuredWorkflowTimeout
    : DEFAULT_WORKFLOW_COMPONENT_TIMEOUT_MS;

/**
 * Command files built on the anchor one-message workflow. The lock-down audit
 * (`tests/unit/commands/anchorMigrationLockdown.test.ts`) forbids every file listed here
 * from calling the pre-anchor picker/modal primitives (`promptForSavedProvider`,
 * `promptWithPaginatedModal`, `replaceProviderPickerWithInfo`, `promptWithRawModal`). Their
 * absence transitively guarantees the only modal path is the anchor controller, so no
 * post-modal terminal can escape it via `replyInfoEmbed`/`followUp`.
 *
 * Add a file here only once every one of its terminals renders on the anchor message.
 */
export const MIGRATED_ANCHOR_CALLERS: readonly string[] = [
  "src/commands/model/text.ts",
  "src/commands/model/vision.ts",
  "src/commands/model/video.ts",
  "src/commands/model/image.ts",
  "src/commands/model/embedding.ts",
  "src/commands/model/fallback.ts",
];

/** Primitives a migrated caller must not reach for; see {@link MIGRATED_ANCHOR_CALLERS}. */
export const PRE_ANCHOR_PRIMITIVES: readonly string[] = [
  "promptForSavedProvider",
  "promptWithPaginatedModal",
  "replaceProviderPickerWithInfo",
  "promptWithRawModal",
];

type PersonaWorkflowRootInteraction = ChatInputCommandInteraction | ButtonInteraction;
type PersonaWorkflowMessageInteraction = ButtonInteraction | ModalMessageModalSubmitInteraction;

/** The only supported delivery policies for a persona-picker workflow. */
export type PersonaWorkflowDeliveryPolicy = "replace-picker" | "separate-public";

/**
 * A Components V2 edit payload. Legacy content and embeds are impossible to
 * express through the command-facing workflow API.
 */
export interface PersonaWorkflowComponentsV2Payload
  extends Pick<InteractionEditReplyOptions, "allowedMentions" | "attachments" | "files"> {
  components: NonNullable<InteractionEditReplyOptions["components"]>;
  flags: MessageFlags.IsComponentsV2;
  content?: never;
  embeds?: never;
}

/** A public response payload used only by the explicit visibility-change phase. */
export type PersonaWorkflowPublicPayload = Omit<
  InteractionReplyOptions,
  "ephemeral" | "fetchReply" | "withResponse"
> & {
  ephemeral?: never;
  fetchReply?: never;
  withResponse?: never;
};

export type PersonaWorkflowUpdateErrorCode =
  | "already-acknowledged"
  | "anchor-message-unavailable"
  | "deleted"
  | "discord-update-failed"
  | "message-mismatch"
  | "non-message-backed-interaction"
  | "public-reply-already-sent"
  | "public-reply-must-not-be-ephemeral"
  | "unsupported-replacement";

/** Typed failure raised by anchor-message and acknowledgment operations. */
export class PersonaWorkflowUpdateError extends Error {
  public readonly code: PersonaWorkflowUpdateErrorCode;
  public readonly cause?: unknown;

  public constructor(code: PersonaWorkflowUpdateErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PersonaWorkflowUpdateError";
    this.code = code;
    this.cause = cause;
  }
}

export interface PersonaWorkflowMessageController {
  readonly anchorMessageId: string;
  readonly deliveryPolicy: "replace-picker";
  replace(payload: PersonaWorkflowComponentsV2Payload): Promise<Message>;
  edit(payload: PersonaWorkflowComponentsV2Payload): Promise<Message>;
  fetchMessage(): Promise<Message>;
  disableControls(): Promise<Message>;
  delete(): Promise<void>;
}

export interface PersonaWorkflowInPlacePhase {
  readonly deliveryPolicy: "replace-picker";
  readonly message: PersonaWorkflowMessageController;
}

export interface PersonaWorkflowPublicReplyPhase {
  readonly deliveryPolicy: "separate-public";
  readonly privateMessage: PersonaWorkflowMessageController;
  reply(payload: PersonaWorkflowPublicPayload): Promise<Message>;
}

export type PersonaWorkflowModalResult =
  | { outcome: "submitted"; phase: PersonaWorkflowModalPhase }
  | { outcome: "cancelled" }
  | { outcome: "timeout" }
  | { outcome: "error"; error: PersonaWorkflowUpdateError }
  | { outcome: "fatal"; error: PersonaWorkflowUpdateError };

export interface PersonaWorkflowModalPhase {
  readonly values: Readonly<Record<string, string>>;
  readonly multiValues: Readonly<Record<string, string[]>>;
  readonly attachments: Readonly<Record<string, APIAttachment>>;
  /** Absolute offset of the first option in a paginated modal range. */
  readonly optionOffset: number;
  readonly message: PersonaWorkflowMessageController;
  /** Uses the unacknowledged, message-backed modal submit to replace the anchor message directly. */
  replace(payload: PersonaWorkflowComponentsV2Payload): Promise<Message>;
  beginInPlaceWork(): Promise<PersonaWorkflowInPlacePhase>;
  unsafeInteraction(): ModalSubmitInteraction;
}

export interface PersonaWorkflowNestedButtonPhase {
  readonly message: PersonaWorkflowMessageController;
  replace(payload: PersonaWorkflowComponentsV2Payload): Promise<Message>;
  beginInPlaceWork(): Promise<PersonaWorkflowInPlacePhase>;
  openModal(options: PersonaWorkflowModalSource): Promise<PersonaWorkflowModalResult>;
  delete(): Promise<void>;
}

/**
 * Anchor private-message phase for a non-persona sibling scope. Persona
 * branches must still enter through `runPersonaPickerWorkflow`.
 */
export interface AnchorPrivateWorkflowPhase {
  readonly phaseId: string;
  readonly message: PersonaWorkflowMessageController;
  useButton(button: ButtonInteraction): PersonaWorkflowNestedButtonPhase;
}

export type PersonaWorkflowModalSource = ModalOptions | (() => Promise<ModalOptions>);

export interface PersonaWorkflowSelectionPhase<TPersona extends TomoriState> {
  readonly persona: TPersona;
  readonly absoluteIndex: number;
  /** Stable id used to scope nested component custom ids. */
  readonly phaseId: string;
  readonly message: PersonaWorkflowMessageController;
  readonly deliveryPolicy: "replace-picker";
  beginInPlaceWork(): Promise<PersonaWorkflowInPlacePhase>;
  openModal(options: PersonaWorkflowModalSource): Promise<PersonaWorkflowModalResult>;
  beginSeparatePublicReply(
    compactPrivatePicker: PersonaWorkflowComponentsV2Payload,
  ): Promise<PersonaWorkflowPublicReplyPhase>;
  /** Binds a collector button to safe same-message operations. */
  useButton(button: ButtonInteraction): PersonaWorkflowNestedButtonPhase;
  /** Explicit escape hatch for Discord APIs not modeled by the workflow. */
  unsafeInteractions(): {
    root: PersonaWorkflowRootInteraction;
    selectedButton: ButtonInteraction;
  };
}

export type PersonaWorkflowDirective<TPersona extends TomoriState = TomoriState, TValue = void> =
  | { action: "complete"; value: TValue }
  | { action: "retry"; personas?: readonly TPersona[] };

export function completePersonaWorkflow(): { action: "complete"; value: undefined };
export function completePersonaWorkflow<TValue>(value: TValue): { action: "complete"; value: TValue };
export function completePersonaWorkflow<TValue>(value?: TValue): { action: "complete"; value: TValue | undefined } {
  return { action: "complete", value };
}

export function retryPersonaWorkflow(): { action: "retry" };
export function retryPersonaWorkflow<TPersona extends TomoriState>(
  personas: readonly TPersona[],
): PersonaWorkflowDirective<TPersona, never>;
export function retryPersonaWorkflow<TPersona extends TomoriState>(
  personas?: readonly TPersona[],
): PersonaWorkflowDirective<TPersona, never> {
  if (personas) return { action: "retry", personas };
  return { action: "retry" };
}

export type PersonaPickerWorkflowResult<TPersona extends TomoriState, TValue = void> =
  | {
      outcome: "selected";
      persona: TPersona;
      absoluteIndex: number;
      value: TValue;
    }
  | { outcome: "cancelled" }
  | { outcome: "timeout" }
  | { outcome: "empty" }
  | { outcome: "error"; error?: unknown }
  | { outcome: "fatal"; error?: unknown };

/**
 * Declares which personas an item-scoped command can actually act on. Supplied
 * to {@link runPersonaPickerWorkflow} so the picker filter and the terminal
 * empty state are both driven by one predicate. The identical `isEligible`
 * function must also back the caller's pre-picker guard and its post-selection
 * concurrency backstop; divergence between the three reintroduces the wasted
 * round trip this option exists to remove.
 */
export interface PersonaWorkflowEligibility<TPersona extends TomoriState> {
  /**
   * Synchronous predicate deciding whether a persona qualifies. Class B callers
   * close over a precomputed `Set` of eligible keys so no per-persona query runs
   * between the persona click and its acknowledgment.
   */
  isEligible: (persona: TPersona) => boolean;
  /** Title locale key for the terminal state rendered when no persona qualifies. */
  emptyTitleKey: string;
  /** Description locale key for that terminal state. */
  emptyDescriptionKey: string;
  /**
   * Locale key for the bare item noun ("attributes", "documents"). Interpolated
   * into the single shared filtered-notice sentence shown when the picker was
   * narrowed.
   */
  itemsLabelKey: string;
}

export interface PersonaPickerWorkflowOptions<TPersona extends TomoriState, TValue = void> {
  personas: readonly TPersona[];
  titleKey?: string;
  descriptionKey?: string;
  color?: string | number;
  requiredPersonaId?: number;
  /**
   * Optional eligibility filter. When supplied, only personas satisfying
   * `isEligible` are shown, a filtered notice is appended when any persona was
   * excluded, and the workflow reaches a terminal `empty` outcome instead of
   * ever rendering a zero-persona picker.
   */
  eligibility?: PersonaWorkflowEligibility<TPersona>;
  onCancel?: () => Promise<void>;
  onSelected: (
    selection: PersonaWorkflowSelectionPhase<TPersona>,
  ) => Promise<PersonaWorkflowDirective<TPersona, TValue>>;
}

type AcknowledgementKind = "defer-update" | "modal" | "update";

class AcknowledgementLedger {
  readonly #acknowledged = new WeakMap<object, AcknowledgementKind>();

  public get(interaction: object): AcknowledgementKind | undefined {
    return this.#acknowledged.get(interaction);
  }

  public mark(interaction: object, kind: AcknowledgementKind): void {
    this.#acknowledged.set(interaction, kind);
  }
}

function assertComponentsV2Payload(payload: PersonaWorkflowComponentsV2Payload): void {
  if (payload.flags !== MessageFlags.IsComponentsV2 || !Array.isArray(payload.components)) {
    throw new PersonaWorkflowUpdateError(
      "unsupported-replacement",
      "Anchor persona workflow updates must be Components V2 payloads.",
    );
  }

  const unsafePayload = payload as PersonaWorkflowComponentsV2Payload & {
    content?: unknown;
    embeds?: unknown;
  };
  if (unsafePayload.content !== undefined || unsafePayload.embeds !== undefined) {
    throw new PersonaWorkflowUpdateError(
      "unsupported-replacement",
      "Anchor persona workflow updates cannot contain legacy content or embeds.",
    );
  }
}

function interactionWasAcknowledged(
  interaction: PersonaWorkflowMessageInteraction,
  ledger: AcknowledgementLedger,
): boolean {
  return interaction.deferred || interaction.replied || ledger.get(interaction) !== undefined;
}

function getInteractionMessageId(interaction: PersonaWorkflowMessageInteraction): string | null {
  return interaction.message?.id ?? null;
}

function isFatalInteractionFailure(error: unknown): boolean {
  if (error instanceof PersonaWorkflowUpdateError) {
    return error.code === "anchor-message-unavailable" || isFatalInteractionFailure(error.cause);
  }
  const candidate = error as { code?: unknown; rawError?: { code?: unknown }; message?: unknown };
  const code = candidate?.code ?? candidate?.rawError?.code;
  if (code === 10062 || code === 50027) {
    return true;
  }

  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  return message.includes("unknown interaction") || message.includes("invalid webhook token");
}

function classifyUpdateFailure(message: string, error: unknown): PersonaWorkflowUpdateError {
  return new PersonaWorkflowUpdateError(
    isFatalInteractionFailure(error) ? "anchor-message-unavailable" : "discord-update-failed",
    message,
    error,
  );
}

function logWorkflowFailure(
  action: string,
  anchorMessageId: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
): void {
  log.warn(`Persona workflow ${action} failed`, {
    errorType: "PersonaWorkflowFailure",
    metadata: {
      action,
      anchorMessageId,
      ...metadata,
      error,
    },
  });
}

function logWorkflowTimeout(
  stage: string,
  anchorMessageId: string | null,
  metadata: Record<string, unknown> = {},
): void {
  log.warn(`Persona workflow ${stage} timed out`, {
    errorType: "PersonaWorkflowTimeout",
    metadata: {
      stage,
      anchorMessageId,
      ...metadata,
    },
  });
}

function logWorkflowEmpty(
  stage: string,
  anchorMessageId: string | null,
  counts: { totalPersonas: number; eligiblePersonas: number; interactionId?: string },
): void {
  // Empty is a normal terminal state, not a warning, so it uses info-level
  // logging. The total-vs-eligible counts are folded into the message because
  // the info channel does not carry structured metadata.
  log.info(
    `Persona workflow ${stage} reached an empty eligible set (message=${anchorMessageId ?? "none"}, ` +
      `total=${counts.totalPersonas}, eligible=${counts.eligiblePersonas}` +
      `${counts.interactionId ? `, interaction=${counts.interactionId}` : ""})`,
  );
}

function logWorkflowFatal(
  stage: string,
  anchorMessageId: string | null,
  error?: unknown,
  metadata: Record<string, unknown> = {},
): void {
  log.warn(`Persona workflow ${stage} terminated fatally`, {
    errorType: "PersonaWorkflowFatal",
    metadata: {
      stage,
      anchorMessageId,
      ...metadata,
      ...(error === undefined ? {} : { error }),
    },
  });
}

function disableInteractiveComponents(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(disableInteractiveComponents);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const component = { ...(value as Record<string, unknown>) };
  if (Array.isArray(component.components)) {
    component.components = component.components.map(disableInteractiveComponents);
  }

  const type = component.type;
  if (
    type === ComponentType.Button ||
    type === ComponentType.StringSelect ||
    type === ComponentType.UserSelect ||
    type === ComponentType.RoleSelect ||
    type === ComponentType.MentionableSelect ||
    type === ComponentType.ChannelSelect
  ) {
    component.disabled = true;
  }
  return component;
}

class AnchorMessageController implements PersonaWorkflowMessageController {
  public readonly deliveryPolicy = "replace-picker" as const;
  readonly #root: PersonaWorkflowRootInteraction;
  readonly #ledger: AcknowledgementLedger;
  #deleted = false;
  #fatalError?: PersonaWorkflowUpdateError;
  #fatalLogged = false;
  // Collapse-at-open edit that is in flight while a modal is open (constraint C).
  // Stored fire-and-forget; every terminal edit settles it first so the final
  // state deterministically lands last, and it is `.catch()`ed at storage so a
  // rejected collapse can never convert a real submit into an error.
  #pendingCollapse?: Promise<unknown>;

  public constructor(
    root: PersonaWorkflowRootInteraction,
    public readonly anchorMessageId: string,
    ledger: AcknowledgementLedger,
  ) {
    this.#root = root;
    this.#ledger = ledger;
  }

  public get fatalError(): PersonaWorkflowUpdateError | undefined {
    return this.#fatalError;
  }

  public recordFailure(
    error: PersonaWorkflowUpdateError,
    stage = "anchor-message-controller",
    metadata: Record<string, unknown> = {},
  ): PersonaWorkflowUpdateError {
    if (error.code === "anchor-message-unavailable") {
      this.#fatalError ??= error;
      this.logLatchedFatal(stage, metadata);
    }
    return error;
  }

  public classifyFailure(
    message: string,
    error: unknown,
    stage = "anchor-message-controller",
    metadata: Record<string, unknown> = {},
  ): PersonaWorkflowUpdateError {
    return this.recordFailure(classifyUpdateFailure(message, error), stage, metadata);
  }

  public logLatchedFatal(stage: string, metadata: Record<string, unknown> = {}): void {
    if (!this.#fatalError || this.#fatalLogged) return;
    this.#fatalLogged = true;
    logWorkflowFatal(stage, this.anchorMessageId, this.#fatalError, metadata);
  }

  async #verifyMessage(message: Message): Promise<Message> {
    if (message.id !== this.anchorMessageId) {
      throw new PersonaWorkflowUpdateError(
        "message-mismatch",
        `Expected anchor message ${this.anchorMessageId}, received ${message.id}.`,
      );
    }
    return message;
  }

  #ensureAvailable(): void {
    if (this.#deleted) {
      throw new PersonaWorkflowUpdateError("deleted", "The anchor persona workflow message was deleted.");
    }
  }

  #normalizePayload(
    payload: PersonaWorkflowComponentsV2Payload,
    retainAttachments: boolean,
  ): InteractionEditReplyOptions {
    assertComponentsV2Payload(payload);
    return {
      ...payload,
      ...(!retainAttachments && payload.attachments === undefined ? { attachments: [] } : {}),
    };
  }

  async #editRootInner(payload: PersonaWorkflowComponentsV2Payload, retainAttachments: boolean): Promise<Message> {
    this.#ensureAvailable();
    try {
      const message = await this.#root.editReply(this.#normalizePayload(payload, retainAttachments));
      return await this.#verifyMessage(message);
    } catch (error) {
      if (error instanceof PersonaWorkflowUpdateError) throw this.recordFailure(error, "root-edit");
      logWorkflowFailure("root-edit", this.anchorMessageId, error);
      throw this.classifyFailure("Failed to edit the anchor persona workflow message.", error, "root-edit");
    }
  }

  async #editRoot(payload: PersonaWorkflowComponentsV2Payload, retainAttachments: boolean): Promise<Message> {
    await this.settlePendingCollapse();
    return this.#editRootInner(payload, retainAttachments);
  }

  /**
   * Awaits any in-flight collapse-at-open edit so a later render deterministically
   * lands last. The stored promise is already `.catch()`ed, so this never throws.
   * Cleared once settled; safe to call repeatedly and when no collapse is pending.
   */
  public async settlePendingCollapse(): Promise<void> {
    const pending = this.#pendingCollapse;
    if (!pending) return;
    this.#pendingCollapse = undefined;
    await pending;
  }

  /**
   * Collapse-at-open: fire-and-forget replacement of the anchor message's live
   * controls with an inert notice as a modal opens. Discord emits no modal-dismiss
   * event, so without this a dismissed modal would strand clickable buttons for the
   * full modal timeout. Not awaited here: the promise is stored (and swallowed at
   * storage) so the modal's own await is never blocked, and {@link settlePendingCollapse}
   * lets the terminal edit order itself after it.
   */
  public collapseAtOpen(payload: PersonaWorkflowComponentsV2Payload): void {
    if (this.#pendingCollapse) return;
    this.#pendingCollapse = this.#editRootInner(payload, false).catch(() => undefined);
  }

  public async replace(payload: PersonaWorkflowComponentsV2Payload): Promise<Message> {
    return this.#editRoot(payload, false);
  }

  public async edit(payload: PersonaWorkflowComponentsV2Payload): Promise<Message> {
    return this.#editRoot(payload, true);
  }

  public async replaceFrom(
    source: PersonaWorkflowMessageInteraction,
    payload: PersonaWorkflowComponentsV2Payload,
  ): Promise<Message> {
    this.#ensureAvailable();
    const sourceMessageId = getInteractionMessageId(source);
    if (!sourceMessageId) {
      throw new PersonaWorkflowUpdateError(
        "non-message-backed-interaction",
        "The interaction is not backed by the anchor picker message.",
      );
    }
    if (sourceMessageId !== this.anchorMessageId) {
      throw new PersonaWorkflowUpdateError(
        "message-mismatch",
        `Interaction message ${sourceMessageId} does not match ${this.anchorMessageId}.`,
      );
    }
    if (interactionWasAcknowledged(source, this.#ledger)) {
      throw new PersonaWorkflowUpdateError(
        "already-acknowledged",
        "The interaction has already performed its first acknowledgment.",
      );
    }

    // A terminal edit through the freshest bound interaction must still land after
    // any collapse-at-open edit fired on the root token when the modal opened.
    await this.settlePendingCollapse();

    try {
      const response = await source.update({
        ...this.#normalizePayload(payload, false),
        withResponse: true,
      });
      this.#ledger.mark(source, "update");
      const message = response.resource?.message ?? (await this.fetchMessage());
      return await this.#verifyMessage(message);
    } catch (error) {
      if (error instanceof PersonaWorkflowUpdateError) {
        throw this.recordFailure(error, "interaction-update", { interactionId: source.id });
      }
      logWorkflowFailure("interaction-update", this.anchorMessageId, error, {
        interactionId: source.id,
      });
      throw this.classifyFailure(
        "Failed to replace the anchor message through the interaction.",
        error,
        "interaction-update",
        {
          interactionId: source.id,
        },
      );
    }
  }

  public async acknowledgeInPlace(source: PersonaWorkflowMessageInteraction): Promise<Message> {
    this.#ensureAvailable();
    const sourceMessageId = getInteractionMessageId(source);
    if (!sourceMessageId) {
      throw new PersonaWorkflowUpdateError(
        "non-message-backed-interaction",
        "The interaction cannot update the anchor picker because it has no source message.",
      );
    }
    if (sourceMessageId !== this.anchorMessageId) {
      throw new PersonaWorkflowUpdateError(
        "message-mismatch",
        `Interaction message ${sourceMessageId} does not match ${this.anchorMessageId}.`,
      );
    }
    if (interactionWasAcknowledged(source, this.#ledger)) {
      throw new PersonaWorkflowUpdateError(
        "already-acknowledged",
        "The interaction has already performed its first acknowledgment.",
      );
    }

    try {
      const response = await source.deferUpdate({ withResponse: true });
      this.#ledger.mark(source, "defer-update");
      const message = response.resource?.message ?? (await this.fetchMessage());
      return await this.#verifyMessage(message);
    } catch (error) {
      if (error instanceof PersonaWorkflowUpdateError) {
        throw this.recordFailure(error, "defer-update", { interactionId: source.id });
      }
      logWorkflowFailure("defer-update", this.anchorMessageId, error, {
        interactionId: source.id,
      });
      throw this.classifyFailure("Failed to acknowledge in-place persona workflow work.", error, "defer-update", {
        interactionId: source.id,
      });
    }
  }

  public markModalAcknowledged(source: ButtonInteraction): void {
    this.#ledger.mark(source, "modal");
  }

  public hasAcknowledged(source: PersonaWorkflowMessageInteraction): boolean {
    return interactionWasAcknowledged(source, this.#ledger);
  }

  public async acknowledgeForRetry(source: ButtonInteraction): Promise<void> {
    if (interactionWasAcknowledged(source, this.#ledger) || hasRawModalAcknowledgement(source)) {
      if (hasRawModalAcknowledgement(source) && this.#ledger.get(source) === undefined) {
        this.markModalAcknowledged(source);
      }
      return;
    }
    await this.acknowledgeInPlace(source);
  }

  public async fetchMessage(): Promise<Message> {
    this.#ensureAvailable();
    try {
      const message = await this.#root.fetchReply();
      return await this.#verifyMessage(message);
    } catch (error) {
      if (error instanceof PersonaWorkflowUpdateError) throw this.recordFailure(error, "fetch");
      logWorkflowFailure("fetch", this.anchorMessageId, error);
      throw this.classifyFailure("Failed to fetch the anchor persona workflow message.", error, "fetch");
    }
  }

  public async disableControls(): Promise<Message> {
    const message = await this.fetchMessage();
    const components = disableInteractiveComponents(
      message.components.map((component) => component.toJSON()),
    ) as NonNullable<PersonaWorkflowComponentsV2Payload["components"]>;
    return this.edit({ components, flags: MessageFlags.IsComponentsV2 });
  }

  public async delete(): Promise<void> {
    this.#ensureAvailable();
    try {
      await this.#root.deleteReply();
      this.#deleted = true;
    } catch (error) {
      logWorkflowFailure("delete", this.anchorMessageId, error);
      throw this.classifyFailure("Failed to delete the anchor persona workflow message.", error, "delete");
    }
  }
}

function noticePayload(
  locale: string,
  titleKey: string,
  descriptionKey: string,
  color: string | number,
): PersonaWorkflowComponentsV2Payload {
  return {
    components: buildNoticeContainer({ locale, titleKey, descriptionKey, color }),
    flags: MessageFlags.IsComponentsV2,
  };
}

/** Builds a localized, strict Components V2 notice for controller updates. */
export function buildPersonaWorkflowNotice(options: NoticeContainerOptions): PersonaWorkflowComponentsV2Payload {
  return {
    components: buildNoticeContainer(options),
    flags: MessageFlags.IsComponentsV2,
  };
}

/**
 * Starts one ephemeral Components V2 message for a non-persona sibling scope.
 * This is intentionally a narrow adapter: it exposes the same typed controller
 * and nested-button phase used by persona workflows without adding a competing
 * persona-selection abstraction.
 */
export async function beginAnchorPrivateWorkflow(
  interaction: ChatInputCommandInteraction,
  locale: string,
  initialPayload: PersonaWorkflowComponentsV2Payload,
): Promise<AnchorPrivateWorkflowPhase> {
  assertComponentsV2Payload(initialPayload);
  if (interaction.replied || interaction.deferred) {
    throw new PersonaWorkflowUpdateError(
      "already-acknowledged",
      "The anchor private workflow must perform the command's first acknowledgment.",
    );
  }

  let message: Message;
  try {
    const response = await interaction.reply({
      ...initialPayload,
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      withResponse: true,
    });
    message = response.resource?.message ?? (await interaction.fetchReply());
  } catch (error) {
    const failure = classifyUpdateFailure("Failed to create the anchor private workflow message.", error);
    if (failure.code === "anchor-message-unavailable") {
      logWorkflowFatal("anchor-private-start", null, failure, { interactionId: interaction.id });
    }
    throw failure;
  }

  const ledger = new AcknowledgementLedger();
  const controller = new AnchorMessageController(interaction, message.id, ledger);
  const phaseId = interaction.id;
  return {
    phaseId,
    message: controller,
    useButton(button) {
      return {
        message: controller,
        replace: (payload) => controller.replaceFrom(button, payload),
        async beginInPlaceWork() {
          await controller.acknowledgeInPlace(button);
          return { deliveryPolicy: "replace-picker", message: controller };
        },
        openModal: (options) => openModalWithBridge(button, locale, options, controller),
        async delete() {
          await controller.acknowledgeInPlace(button);
          await controller.delete();
        },
      };
    },
  };
}

function buildModalReadyPayload(locale: string, customId: string): PersonaWorkflowComponentsV2Payload {
  return {
    components: buildNoticeContainer({
      locale,
      color: ColorCode.INFO,
      titleKey: "general.persona_workflow.modal_ready_title",
      descriptionKey: "general.persona_workflow.modal_ready_description",
      button: {
        customId,
        labelKey: "general.persona_workflow.open_modal_button",
        style: ButtonStyle.Secondary,
      },
    }),
    flags: MessageFlags.IsComponentsV2,
  };
}

function publicPayloadIsEphemeral(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & MessageFlags.Ephemeral) !== 0;
  if (typeof flags === "bigint") return (flags & BigInt(MessageFlags.Ephemeral)) !== 0n;
  if (typeof flags === "string") return flags === "Ephemeral";
  if (Array.isArray(flags)) return flags.some(publicPayloadIsEphemeral);
  if (flags && typeof flags === "object" && "bitfield" in flags) {
    return publicPayloadIsEphemeral((flags as { bitfield: unknown }).bitfield);
  }
  return false;
}

async function awaitWorkflowButton(
  controller: AnchorMessageController,
  userId: string,
  customIdPrefix: string,
): Promise<ButtonInteraction> {
  const message = await controller.fetchMessage();
  return message.awaitMessageComponent({
    componentType: ComponentType.Button,
    filter: (candidate) => candidate.user.id === userId && candidate.customId.startsWith(customIdPrefix),
    time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
  });
}

function createModalPhase(
  result: {
    values?: Record<string, string>;
    multiValues?: Record<string, string[]>;
    attachments?: Record<string, APIAttachment>;
    interaction: ModalMessageModalSubmitInteraction;
  },
  optionOffset: number,
  controller: AnchorMessageController,
): PersonaWorkflowModalPhase {
  const modalInteraction = result.interaction;
  return {
    values: result.values ?? {},
    multiValues: result.multiValues ?? {},
    attachments: result.attachments ?? {},
    optionOffset,
    message: controller,
    replace: (payload) => controller.replaceFrom(modalInteraction, payload),
    async beginInPlaceWork() {
      await controller.acknowledgeInPlace(modalInteraction);
      return { deliveryPolicy: "replace-picker", message: controller };
    },
    unsafeInteraction: () => modalInteraction,
  };
}

async function openRawWorkflowModal(
  button: ButtonInteraction,
  locale: string,
  options: ModalOptions,
  optionOffset: number,
  controller: AnchorMessageController,
): Promise<PersonaWorkflowModalResult> {
  if (controller.hasAcknowledged(button)) {
    return {
      outcome: "error",
      error: new PersonaWorkflowUpdateError(
        "already-acknowledged",
        "A modal-opening button must use openModal as its first acknowledgment.",
      ),
    };
  }

  // Collapse-at-open: as the modal opens, replace the anchor message's live
  // controls (provider picker, modal-ready button, or range selector) with an
  // inert notice. Fire-and-forget relative to the modal await below, because Discord
  // emits no modal-dismiss event, so this is the only thing that keeps a dismissed
  // modal from leaving clickable-but-dead buttons until the 10-minute timeout.
  // The edit uses the root token because `button` is consumed by showModal; every
  // terminal edit calls `settlePendingCollapse()` so this lands before the result.
  controller.collapseAtOpen(
    noticePayload(
      locale,
      "general.interaction.selector_opened_title",
      "general.interaction.selector_opened_description",
      ColorCode.INFO,
    ),
  );

  const modalResult = await promptWithRawModal(button, locale, options);
  const rawModalAcknowledged = hasRawModalAcknowledgement(button);
  if (rawModalAcknowledged) {
    controller.markModalAcknowledged(button);
  }

  if (modalResult.outcome === "error") {
    const failure = controller.classifyFailure(
      "Failed to show or collect the workflow modal.",
      modalResult.error,
      "raw-modal",
      {
        interactionId: button.id,
      },
    );
    if (failure.code === "anchor-message-unavailable") {
      return { outcome: "fatal", error: failure };
    }
    return { outcome: "error", error: failure };
  }

  if (!rawModalAcknowledged) {
    const error = new PersonaWorkflowUpdateError(
      "discord-update-failed",
      "Discord did not acknowledge the modal-opening interaction.",
    );
    return { outcome: "error", error };
  }

  if (modalResult.outcome === "timeout") {
    logWorkflowTimeout("raw-modal", controller.anchorMessageId, {
      interactionId: button.id,
    });
    try {
      await controller.replace(
        noticePayload(locale, "general.interaction.timeout_title", "general.pagination.timeout", ColorCode.WARN),
      );
    } catch (error) {
      const failure = controller.classifyFailure(
        "Failed to render the workflow modal timeout state.",
        error,
        "raw-modal-timeout-replacement",
        { interactionId: button.id },
      );
      if (failure.code === "anchor-message-unavailable") {
        return { outcome: "fatal", error: failure };
      }
      return { outcome: "error", error: failure };
    }
    return { outcome: "timeout" };
  }
  if (!modalResult.interaction) {
    return {
      outcome: "error",
      error: new PersonaWorkflowUpdateError(
        "non-message-backed-interaction",
        "Discord returned a submitted workflow modal without its interaction.",
      ),
    };
  }
  const messageId = modalResult.interaction.message?.id;
  if (!messageId) {
    return {
      outcome: "error",
      error: new PersonaWorkflowUpdateError(
        "non-message-backed-interaction",
        "The modal submission is not backed by the anchor workflow message.",
      ),
    };
  }
  if (messageId !== controller.anchorMessageId) {
    return {
      outcome: "error",
      error: new PersonaWorkflowUpdateError(
        "message-mismatch",
        `Modal message ${messageId} does not match ${controller.anchorMessageId}.`,
      ),
    };
  }

  return {
    outcome: "submitted",
    phase: createModalPhase(
      {
        values: modalResult.values,
        multiValues: modalResult.multiValues,
        attachments: modalResult.attachments,
        interaction: modalResult.interaction as ModalMessageModalSubmitInteraction,
      },
      optionOffset,
      controller,
    ),
  };
}

async function openModalWithBridge(
  initialButton: ButtonInteraction,
  locale: string,
  source: PersonaWorkflowModalSource,
  controller: AnchorMessageController,
): Promise<PersonaWorkflowModalResult> {
  let options: ModalOptions;
  let modalButton = initialButton;

  if (typeof source === "function") {
    await controller.acknowledgeInPlace(initialButton);
    await controller.replace(
      noticePayload(
        locale,
        "general.persona_workflow.loading_title",
        "general.persona_workflow.loading_description",
        ColorCode.INFO,
      ),
    );
    try {
      options = await source();
    } catch (cause) {
      await controller.replace(
        noticePayload(
          locale,
          "general.errors.operation_failed_title",
          "general.errors.operation_failed_description",
          ColorCode.ERROR,
        ),
      );
      return {
        outcome: "error",
        error: new PersonaWorkflowUpdateError("discord-update-failed", "Failed to load modal options.", cause),
      };
    }
  } else {
    options = source;
  }

  const paginatedComponent = getPaginatedModalComponent(options);
  const optionCount = paginatedComponent && "options" in paginatedComponent ? paginatedComponent.options.length : 0;

  if (typeof source === "function" && optionCount <= MODAL_OPTIONS_PER_PAGE) {
    const prefix = `persona_workflow_${initialButton.id}_open`;
    await controller.replace(buildModalReadyPayload(locale, prefix));
    try {
      modalButton = await awaitWorkflowButton(controller, initialButton.user.id, prefix);
    } catch (error) {
      if (isCollectorTimeoutError(error)) {
        logWorkflowTimeout("modal-launcher", controller.anchorMessageId, {
          interactionId: initialButton.id,
        });
        await controller.replace(
          noticePayload(locale, "general.interaction.timeout_title", "general.pagination.timeout", ColorCode.WARN),
        );
        return { outcome: "timeout" };
      }
      const failure = controller.classifyFailure(
        "Failed while waiting to open the workflow modal.",
        error,
        "modal-launcher",
        {
          interactionId: initialButton.id,
        },
      );
      if (failure.code === "anchor-message-unavailable") {
        return { outcome: "fatal", error: failure };
      }
      return { outcome: "error", error: failure };
    }
  }

  if (!paginatedComponent || optionCount <= MODAL_OPTIONS_PER_PAGE) {
    return openRawWorkflowModal(modalButton, locale, options, 0, controller);
  }

  const prefix = `persona_workflow_${initialButton.id}_${Date.now().toString(36)}`;
  let rangePage = 0;
  if (modalButton === initialButton && !controller.hasAcknowledged(initialButton)) {
    await controller.replaceFrom(initialButton, buildRangeSelectorPayload(locale, prefix, optionCount, rangePage));
  } else {
    await controller.replace(buildRangeSelectorPayload(locale, prefix, optionCount, rangePage));
  }

  while (true) {
    let rangeButton: ButtonInteraction;
    try {
      rangeButton = await awaitWorkflowButton(controller, initialButton.user.id, prefix);
    } catch (error) {
      if (isCollectorTimeoutError(error)) {
        logWorkflowTimeout("range-selector", controller.anchorMessageId, {
          interactionId: initialButton.id,
          rangePage,
        });
        await controller.replace(
          noticePayload(locale, "general.interaction.timeout_title", "general.pagination.timeout", ColorCode.WARN),
        );
        return { outcome: "timeout" };
      }
      const failure = controller.classifyFailure("The workflow range selector failed.", error, "range-selector", {
        interactionId: initialButton.id,
      });
      if (failure.code === "anchor-message-unavailable") {
        return { outcome: "fatal", error: failure };
      }
      return { outcome: "error", error: failure };
    }

    if (rangeButton.customId === `${prefix}_cancel`) {
      await controller.replaceFrom(
        rangeButton,
        noticePayload(locale, "general.interaction.cancel_title", "general.pagination.cancelled", ColorCode.WARN),
      );
      return { outcome: "cancelled" };
    }
    if (rangeButton.customId === `${prefix}_previous`) {
      rangePage = Math.max(0, rangePage - 1);
      await controller.replaceFrom(rangeButton, buildRangeSelectorPayload(locale, prefix, optionCount, rangePage));
      continue;
    }
    if (rangeButton.customId === `${prefix}_next`) {
      const totalRangePages = Math.ceil(Math.ceil(optionCount / MODAL_OPTIONS_PER_PAGE) / RANGES_PER_SELECTOR_PAGE);
      rangePage = Math.min(totalRangePages - 1, rangePage + 1);
      await controller.replaceFrom(rangeButton, buildRangeSelectorPayload(locale, prefix, optionCount, rangePage));
      continue;
    }

    const rangeIndex = parseModalRangeIndex(rangeButton.customId, prefix);
    if (rangeIndex === null) {
      await controller.replaceFrom(
        rangeButton,
        noticePayload(
          locale,
          "general.errors.invalid_option_title",
          "general.errors.invalid_option_description",
          ColorCode.ERROR,
        ),
      );
      return {
        outcome: "error",
        error: new PersonaWorkflowUpdateError("unsupported-replacement", "The selected modal range was invalid."),
      };
    }

    const optionOffset = rangeIndex * MODAL_OPTIONS_PER_PAGE;
    const rangedOptions = sliceModalOptions(
      options,
      paginatedComponent,
      optionOffset,
      Math.min(optionOffset + MODAL_OPTIONS_PER_PAGE, optionCount),
    );
    return openRawWorkflowModal(rangeButton, locale, rangedOptions, optionOffset, controller);
  }
}

function createSelectionPhase<TPersona extends TomoriState>(
  root: PersonaWorkflowRootInteraction,
  locale: string,
  persona: TPersona,
  absoluteIndex: number,
  selectedButton: ButtonInteraction,
  controller: AnchorMessageController,
): {
  phase: PersonaWorkflowSelectionPhase<TPersona>;
  state: { fatalError?: PersonaWorkflowUpdateError };
} {
  const state: { fatalError?: PersonaWorkflowUpdateError } = {};
  const phase: PersonaWorkflowSelectionPhase<TPersona> = {
    persona,
    absoluteIndex,
    phaseId: selectedButton.id,
    message: controller,
    deliveryPolicy: "replace-picker",
    async beginInPlaceWork() {
      await controller.acknowledgeInPlace(selectedButton);
      return { deliveryPolicy: "replace-picker", message: controller };
    },
    async openModal(options) {
      const result = await openModalWithBridge(selectedButton, locale, options, controller);
      if (result.outcome === "fatal") state.fatalError = result.error;
      return result;
    },
    useButton(button) {
      return {
        message: controller,
        replace: (payload) => controller.replaceFrom(button, payload),
        async beginInPlaceWork() {
          await controller.acknowledgeInPlace(button);
          return { deliveryPolicy: "replace-picker", message: controller };
        },
        async openModal(options) {
          const result = await openModalWithBridge(button, locale, options, controller);
          if (result.outcome === "fatal") state.fatalError = result.error;
          return result;
        },
        async delete() {
          await controller.acknowledgeInPlace(button);
          await controller.delete();
        },
      };
    },
    async beginSeparatePublicReply(compactPrivatePicker) {
      await controller.replaceFrom(selectedButton, compactPrivatePicker);
      let publicReplySent = false;
      return {
        deliveryPolicy: "separate-public",
        privateMessage: controller,
        async reply(payload) {
          if (publicReplySent) {
            throw new PersonaWorkflowUpdateError(
              "public-reply-already-sent",
              "The separate-public workflow phase already created its public response.",
            );
          }
          if (publicPayloadIsEphemeral(payload.flags)) {
            throw new PersonaWorkflowUpdateError(
              "public-reply-must-not-be-ephemeral",
              "The separate-public workflow phase cannot create an ephemeral response.",
            );
          }
          publicReplySent = true;
          try {
            return await selectedButton.followUp(payload);
          } catch (error) {
            logWorkflowFailure("separate-public", controller.anchorMessageId, error, {
              interactionId: selectedButton.id,
            });
            throw controller.classifyFailure(
              "Failed to create the workflow's public response.",
              error,
              "separate-public",
              {
                interactionId: selectedButton.id,
              },
            );
          }
        },
      };
    },
    unsafeInteractions: () => ({ root, selectedButton }),
  };
  return { phase, state };
}

function normalizeSelectedPersona<TPersona extends TomoriState>(
  personas: readonly TPersona[],
  selectedIndex: number | undefined,
  requiredPersonaId: number | undefined,
): { persona: TPersona; absoluteIndex: number } | null {
  if (selectedIndex === undefined || !Number.isInteger(selectedIndex) || selectedIndex < 0) return null;
  const persona = personas[selectedIndex];
  if (!persona || selectedIndex >= personas.length) return null;
  if (requiredPersonaId !== undefined && persona.persona_id !== requiredPersonaId) return null;
  return { persona, absoluteIndex: selectedIndex };
}

/**
 * Runs the complete persona-picker lifecycle. The runner owns the picker retry
 * loop and avatar cache; only an explicit retry directive can reopen the picker.
 * A fatal picker result is returned before the callback runs and is therefore
 * mechanically impossible to retry.
 */
export async function runPersonaPickerWorkflow<TPersona extends TomoriState, TValue = void>(
  interaction: PersonaWorkflowRootInteraction,
  locale: string,
  options: PersonaPickerWorkflowOptions<TPersona, TValue>,
): Promise<PersonaPickerWorkflowResult<TPersona, TValue>> {
  const avatarSessionCache: AvatarSessionCache = new Map();
  const ledger = new AcknowledgementLedger();
  const { eligibility } = options;

  // Resolve eligibility once. `filterPersonas` is the single filtering point;
  //    both the initial entry and every persona-supplying retry pass through it,
  //    so the picker can never render a persona the command cannot act on.
  const filterPersonas = (list: readonly TPersona[]): { filtered: readonly TPersona[]; excluded: number } => {
    if (!eligibility) return { filtered: list, excluded: 0 };
    const filtered = list.filter((persona) => eligibility.isEligible(persona));
    return { filtered, excluded: list.length - filtered.length };
  };

  const initialFilter = filterPersonas(options.personas);
  let currentPersonas = initialFilter.filtered;
  let currentExcluded = initialFilter.excluded;

  // Pre-picker empty case. The caller owns rendering its own notice on its
  //     deferred reply (it computes the same eligible set for its own guard), so
  //     the workflow returns `empty` here without ever rendering a picker.
  if (eligibility && currentPersonas.length === 0) {
    logWorkflowEmpty("initial", null, {
      totalPersonas: options.personas.length,
      eligiblePersonas: 0,
      interactionId: interaction.id,
    });
    return { outcome: "empty" };
  }

  while (true) {
    // The filtered notice is verb-agnostic: one shared sentence with the family's
    // bare item noun interpolated in. It is only shown when the current picker
    // actually hides at least one persona.
    const filteredNotice =
      eligibility && currentExcluded > 0
        ? localizer(locale, "general.persona_workflow.filtered_notice", {
            items: localizer(locale, eligibility.itemsLabelKey),
          })
        : undefined;
    const pickerResult = await replyPaginatedPersonaChoicesV2(interaction, locale, {
      personas: [...currentPersonas],
      titleKey: options.titleKey,
      descriptionKey: options.descriptionKey,
      color: options.color,
      preserveSelectedInteraction: true,
      avatarSessionCache,
      filteredNotice,
    });

    if (!pickerResult.success) {
      const outcome = pickerResult.reason ?? "error";
      if (outcome === "cancelled") {
        await options.onCancel?.();
        return { outcome: "cancelled" };
      }
      if (outcome === "timeout") {
        logWorkflowTimeout("picker", null, { interactionId: interaction.id });
        return { outcome: "timeout" };
      }
      if (outcome === "fatal") {
        logWorkflowFatal("picker", null, undefined, { interactionId: interaction.id });
        return { outcome: "fatal" };
      }
      return { outcome: "error" };
    }

    const selectedButton = pickerResult.interaction;
    const normalized = normalizeSelectedPersona(currentPersonas, pickerResult.selectedIndex, options.requiredPersonaId);
    if (!selectedButton || !normalized) {
      const error = new PersonaWorkflowUpdateError(
        "unsupported-replacement",
        "The picker returned an invalid selected persona context.",
      );
      if (selectedButton) {
        const controller = new AnchorMessageController(interaction, selectedButton.message.id, ledger);
        try {
          await controller.replaceFrom(
            selectedButton,
            noticePayload(
              locale,
              "general.errors.invalid_option_title",
              "general.errors.invalid_option_description",
              ColorCode.ERROR,
            ),
          );
        } catch (ackError) {
          logWorkflowFailure("invalid-selection", controller.anchorMessageId, ackError);
          if (isFatalInteractionFailure(ackError)) {
            const failure =
              controller.fatalError ?? controller.classifyFailure("Invalid selection fallback failed.", ackError);
            controller.logLatchedFatal("invalid-selection-fallback", { interactionId: selectedButton.id });
            return { outcome: "fatal", error: failure };
          }
        }
      }
      return { outcome: "error", error };
    }

    const controller = new AnchorMessageController(interaction, selectedButton.message.id, ledger);
    const selectionContext = createSelectionPhase(
      interaction,
      locale,
      normalized.persona,
      normalized.absoluteIndex,
      selectedButton,
      controller,
    );

    let directive: PersonaWorkflowDirective<TPersona, TValue>;
    try {
      directive = await options.onSelected(selectionContext.phase);
    } catch (error) {
      logWorkflowFailure("selected-callback", controller.anchorMessageId, error, {
        absoluteIndex: normalized.absoluteIndex,
        personaId: normalized.persona.persona_id,
      });
      const preexistingFatal = controller.fatalError;
      if (preexistingFatal) {
        controller.logLatchedFatal("selected-callback", {
          absoluteIndex: normalized.absoluteIndex,
          personaId: normalized.persona.persona_id,
        });
        return { outcome: "fatal", error: preexistingFatal };
      }
      if (isFatalInteractionFailure(error)) {
        logWorkflowFatal("selected-callback", controller.anchorMessageId, error, {
          absoluteIndex: normalized.absoluteIndex,
          personaId: normalized.persona.persona_id,
        });
        return { outcome: "fatal", error };
      }

      try {
        if (!interactionWasAcknowledged(selectedButton, ledger) && !hasRawModalAcknowledgement(selectedButton)) {
          await controller.replaceFrom(
            selectedButton,
            noticePayload(
              locale,
              "general.errors.operation_failed_title",
              "general.errors.operation_failed_description",
              ColorCode.ERROR,
            ),
          );
        } else {
          await controller.replace(
            noticePayload(
              locale,
              "general.errors.operation_failed_title",
              "general.errors.operation_failed_description",
              ColorCode.ERROR,
            ),
          );
        }
      } catch (replacementError) {
        logWorkflowFailure("selected-callback-fallback", controller.anchorMessageId, replacementError);
      }

      const fatalError = controller.fatalError;
      if (fatalError) {
        controller.logLatchedFatal("selected-callback-fallback", {
          absoluteIndex: normalized.absoluteIndex,
          personaId: normalized.persona.persona_id,
        });
        return { outcome: "fatal", error: fatalError };
      }
      return { outcome: "error", error };
    }

    const fatalError = controller.fatalError ?? selectionContext.state.fatalError;
    if (fatalError) {
      controller.logLatchedFatal("runner-sticky-latch", {
        absoluteIndex: normalized.absoluteIndex,
        personaId: normalized.persona.persona_id,
      });
      return { outcome: "fatal", error: fatalError };
    }

    if (directive.action === "retry") {
      try {
        await controller.acknowledgeForRetry(selectedButton);
      } catch (error) {
        if (isFatalInteractionFailure(error)) {
          controller.logLatchedFatal("retry-acknowledgment", {
            interactionId: selectedButton.id,
          });
          return { outcome: "fatal", error };
        }
        return { outcome: "error", error };
      }
      log.info(
        `Persona workflow retrying picker ${controller.anchorMessageId} in place for persona ${normalized.persona.persona_id}`,
      );
      if (directive.personas) {
        const { filtered, excluded } = filterPersonas(directive.personas);

        // Mid-loop empty case: the user just removed the last item from the last
        // eligible persona. Replace the anchor message in place with the
        // terminal empty state and return `empty`; never render an empty picker
        // and never emit a second ephemeral message.
        if (eligibility && filtered.length === 0) {
          try {
            await controller.replace(
              noticePayload(locale, eligibility.emptyTitleKey, eligibility.emptyDescriptionKey, ColorCode.INFO),
            );
          } catch (error) {
            if (isFatalInteractionFailure(error)) {
              controller.logLatchedFatal("retry-empty-state", {
                interactionId: selectedButton.id,
              });
              return { outcome: "fatal", error };
            }
            return { outcome: "error", error };
          }
          logWorkflowEmpty("retry", controller.anchorMessageId, {
            totalPersonas: directive.personas.length,
            eligiblePersonas: 0,
            interactionId: selectedButton.id,
          });
          return { outcome: "empty" };
        }

        // Avatar-cache identity comparison stays sound because both sides are the
        // post-filter arrays: filtering changes indices, so comparing the raw
        // retry array against the already-filtered current array would spuriously
        // clear the cache. Comparing filtered-to-filtered keeps it accurate.
        const identityChanged =
          filtered.length !== currentPersonas.length ||
          filtered.some((persona, index) => persona.persona_id !== currentPersonas[index]?.persona_id);
        if (identityChanged) avatarSessionCache.clear();
        currentPersonas = filtered;
        currentExcluded = excluded;
      }
      continue;
    }

    return {
      outcome: "selected",
      persona: normalized.persona,
      absoluteIndex: normalized.absoluteIndex,
      value: directive.value,
    };
  }
}
