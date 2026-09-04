import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import type {
  APIAttachment,
  ButtonInteraction,
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  Message,
  ModalSubmitInteraction,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ModalOptions } from "@/types/discord/modal";
import type {
  PersonaWorkflowComponentsV2Payload,
  PersonaWorkflowModalResult,
  PersonaWorkflowUpdateError,
} from "@/utils/discord/ui/personaWorkflow";
// Real namespaces captured before any `mock.module` runs (static imports are
// hoisted). Spreading them keeps each factory full-surface so a later test file
// in the monolithic `bun test` never links against a missing export.
import * as realInteractionCore from "@/utils/discord/ui/interactionCore";
import * as realLocalizer from "@/utils/text/localizer";
import { createScopedModuleMocker, stubLogMembers } from "../../helpers/mockSurface";

interface RecordedCall {
  method: string;
  source: string;
  payload?: unknown;
}

interface RecordedWarning {
  message: string;
  context?: unknown;
}

interface PickerOptionsMock {
  personas: TomoriState[];
  titleKey?: string;
  descriptionKey?: string;
  color?: string | number;
  preserveSelectedInteraction?: boolean;
  avatarSessionCache?: Map<number, unknown>;
}

type PickerResultMock =
  | {
      success: true;
      selectedIndex?: number;
      selectedItem?: string;
      interaction?: ButtonInteraction;
    }
  | {
      success: false;
      reason?: "cancelled" | "timeout" | "error" | "fatal";
    };

type PickerQueueItem = PickerResultMock | ((options: PickerOptionsMock) => PickerResultMock);

interface RawModalResultMock {
  outcome: "submit" | "timeout" | "error";
  values?: Record<string, string>;
  multiValues?: Record<string, string[]>;
  attachments?: Record<string, APIAttachment>;
  interaction?: ModalSubmitInteraction;
  error?: unknown;
}

const pickerQueue: PickerQueueItem[] = [];
const pickerCalls: PickerOptionsMock[] = [];
const rawModalQueue: RawModalResultMock[] = [];
const rawModalCalls: Array<{ button: ButtonInteraction; options: ModalOptions }> = [];
const calls: RecordedCall[] = [];
const warnings: RecordedWarning[] = [];
let rawModalAcknowledged = new WeakSet<object>();
let acknowledgeRawModal = true;
// Resolution-order + gate instrumentation for the collapse-at-open ordering tests.
// `resolutionOrder` records when an edit actually completes (not when it is invoked),
// so a terminal edit that awaits a gated collapse lands after it. `collapseGate` blocks
// the collapse edit until released; `rejectCollapse` makes it throw.
const resolutionOrder: string[] = [];
let collapseGate: Promise<void> | null = null;
let rejectCollapse = false;

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/text/localizer": realLocalizer,
  "@/utils/discord/ui/interactionCore": realInteractionCore,
});

stubLogMembers({
  error: () => undefined,
  info: () => undefined,
  warn: (message: string, context?: unknown) => warnings.push({ message, context }),
});

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  localizer: (_locale: string, key: string, variables?: Record<string, unknown>) =>
    variables ? `${key}:${JSON.stringify(variables)}` : key,
}));

// Mirror the real interactionCore constants so the faithful stubs below compute the
// same range/page math the persona range-selector tests rely on.
const MOCK_OPTIONS_PER_PAGE = 25;
const MOCK_RANGES_PER_SELECTOR_PAGE = 20;

scopedMock.module("@/utils/discord/ui/interactionCore", () => ({
  ...realInteractionCore,
  buildNoticeContainer: (options: {
    titleKey: string;
    descriptionKey: string;
    button?: { customId: string; labelKey: string; style: number };
  }) => [
    {
      type: ComponentType.Container,
      components: [
        { type: ComponentType.TextDisplay, content: options.titleKey },
        { type: ComponentType.TextDisplay, content: options.descriptionKey },
        ...(options.button
          ? [
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    customId: options.button.customId,
                    label: options.button.labelKey,
                    style: options.button.style,
                  },
                ],
              },
            ]
          : []),
      ],
    },
  ],
  hasRawModalAcknowledgement: (interaction: object) => rawModalAcknowledged.has(interaction),
  // Mirrors the real helper's two rejection shapes: the bare collector end-reason
  // string used by this harness, and the InteractionCollectorError message form.
  // `mock.module` replaces the whole module, so every export personaWorkflow.ts
  // imports must be stubbed or module linking fails.
  isCollectorTimeoutError: (error: unknown) => {
    if (error === "time" || error === "idle") return true;
    if (!error || typeof error !== "object") return false;
    const message = (error as { message?: unknown }).message;
    if (typeof message !== "string") return false;
    return /ending with reason: (time|idle)/i.test(message);
  },
  promptWithRawModal: async (button: ButtonInteraction, _locale: string, options: ModalOptions) => {
    calls.push({ method: "rawModal", source: button.id, payload: options });
    rawModalCalls.push({ button, options });
    if (acknowledgeRawModal) rawModalAcknowledged.add(button);
    return rawModalQueue.shift() ?? { outcome: "timeout" as const };
  },
  replyPaginatedPersonaChoicesV2: async (
    _interaction: ChatInputCommandInteraction | ButtonInteraction,
    _locale: string,
    options: PickerOptionsMock,
  ) => {
    pickerCalls.push(options);
    const queued = pickerQueue.shift();
    if (!queued) throw new Error("Persona picker mock queue is empty.");
    return typeof queued === "function" ? queued(options) : queued;
  },
  // ── shared paginated-modal helpers personaWorkflow.ts now imports from here ──
  // `mock.module` replaces the whole module, so these must be stubbed with faithful
  // behavior (the range-selector tests below click buttons from the rendered payload
  // and assert the sliced option offsets). They mirror the real pure helpers in
  // interactionCore.ts one-for-one.
  MODAL_OPTIONS_PER_PAGE: MOCK_OPTIONS_PER_PAGE,
  RANGES_PER_SELECTOR_PAGE: MOCK_RANGES_PER_SELECTOR_PAGE,
  getPaginatedModalComponent: (options: ModalOptions) =>
    options.components.find((component) => "options" in component && Array.isArray(component.options)),
  sliceModalOptions: (options: ModalOptions, target: unknown, start: number, end: number): ModalOptions => ({
    ...options,
    components: options.components.map((component) =>
      component === target && "options" in component
        ? { ...component, options: component.options.slice(start, end) }
        : component,
    ),
  }),
  parseModalRangeIndex: (customId: string, prefix: string): number | null => {
    const marker = `${prefix}_range_`;
    if (!customId.startsWith(marker)) return null;
    const parsed = Number.parseInt(customId.slice(marker.length), 10);
    return Number.isNaN(parsed) ? null : parsed;
  },
  buildRangeSelectorPayload: (_locale: string, prefix: string, optionCount: number, rangePage: number) => {
    const totalRanges = Math.ceil(optionCount / MOCK_OPTIONS_PER_PAGE);
    const totalRangePages = Math.ceil(totalRanges / MOCK_RANGES_PER_SELECTOR_PAGE);
    const firstRange = rangePage * MOCK_RANGES_PER_SELECTOR_PAGE;
    const lastRange = Math.min(firstRange + MOCK_RANGES_PER_SELECTOR_PAGE, totalRanges);
    const rangeButtons = [];
    for (let rangeIndex = firstRange; rangeIndex < lastRange; rangeIndex += 1) {
      rangeButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        customId: `${prefix}_range_${rangeIndex}`,
        label: `${rangeIndex * MOCK_OPTIONS_PER_PAGE + 1}`,
      });
    }
    const rows = [];
    for (let offset = 0; offset < rangeButtons.length; offset += 5) {
      rows.push({ type: ComponentType.ActionRow, components: rangeButtons.slice(offset, offset + 5) });
    }
    rows.push({
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Secondary, customId: `${prefix}_previous`, label: "prev" },
        { type: ComponentType.Button, style: ButtonStyle.Danger, customId: `${prefix}_cancel`, label: "cancel" },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: `${prefix}_next`,
          label: "next",
          disabled: rangePage >= totalRangePages - 1,
        },
      ],
    });
    return {
      components: [
        {
          type: ComponentType.Container,
          components: [
            { type: ComponentType.TextDisplay, content: "range-title" },
            { type: ComponentType.TextDisplay, content: "range-desc" },
            ...rows,
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    };
  },
}));

const {
  beginAnchorPrivateWorkflow,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  PersonaWorkflowUpdateError: WorkflowUpdateError,
} = await import("@/utils/discord/ui/personaWorkflow");

type AwaitedButtonFactory = (renderedPayload: unknown) => ButtonInteraction;
type AwaitedButton = ButtonInteraction | AwaitedButtonFactory | "time" | Error;

interface WorkflowHarness {
  anchorMessageId: string;
  message: Message;
  root: ChatInputCommandInteraction;
  awaitQueue: AwaitedButton[];
  lastRenderedPayload: unknown;
  rootEditError?: unknown;
  rootEditMessage?: Message;
  rootFetchError?: unknown;
  rootFetchMessage?: Message;
  record(method: string, source: string, payload?: unknown): void;
}

let interactionSequence = 0;

function makePersona(personaId: number): TomoriState {
  return {
    persona_id: personaId,
    persona_nickname: `Persona ${personaId}`,
    persona_prompt: `Prompt ${personaId}`,
    attribute_list: [],
    is_alter: false,
  } as unknown as TomoriState;
}

function makeComponentMessage(id: string, harness: WorkflowHarness): Message {
  const interactiveTree = {
    type: ComponentType.Container,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [{ type: ComponentType.Button, custom_id: "button", style: 1, label: "Button" }],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: "select",
            options: [{ label: "One", value: "one" }],
          },
        ],
      },
      { type: ComponentType.TextDisplay, content: "Static text" },
    ],
  };

  return {
    id,
    components: [{ toJSON: () => interactiveTree }],
    awaitMessageComponent: async () => {
      harness.record("message.awaitMessageComponent", id, harness.lastRenderedPayload);
      const queued = harness.awaitQueue.shift();
      if (queued === undefined) throw new Error("Message component mock queue is empty.");
      if (queued === "time") throw "time";
      if (queued instanceof Error) throw queued;
      return typeof queued === "function" ? queued(harness.lastRenderedPayload) : queued;
    },
  } as unknown as Message;
}

function makeHarness(anchorMessageId = "anchor-message"): WorkflowHarness {
  const harness = {
    anchorMessageId,
    awaitQueue: [],
    lastRenderedPayload: undefined,
    record(method: string, source: string, payload?: unknown) {
      calls.push({ method, source, payload });
    },
  } as unknown as WorkflowHarness;

  harness.message = makeComponentMessage(anchorMessageId, harness);
  harness.root = {
    id: "root-interaction",
    user: { id: "workflow-user" },
    replied: false,
    deferred: false,
    reply: async (payload: unknown) => {
      harness.record("root.reply", "root-interaction", payload);
      harness.lastRenderedPayload = payload;
      return { resource: { message: harness.message } };
    },
    editReply: async (payload: InteractionEditReplyOptions) => {
      harness.record("root.editReply", "root-interaction", payload);
      harness.lastRenderedPayload = payload;
      if (harness.rootEditError !== undefined) throw harness.rootEditError;
      const isCollapse = JSON.stringify(payload?.components ?? []).includes("selector_opened");
      if (isCollapse && rejectCollapse) throw new Error("collapse edit failed");
      if (isCollapse && collapseGate) await collapseGate;
      resolutionOrder.push("root.editReply");
      return harness.rootEditMessage ?? harness.message;
    },
    fetchReply: async () => {
      harness.record("root.fetchReply", "root-interaction");
      if (harness.rootFetchError !== undefined) throw harness.rootFetchError;
      return harness.rootFetchMessage ?? harness.message;
    },
    deleteReply: async () => {
      harness.record("root.deleteReply", "root-interaction");
    },
  } as unknown as ChatInputCommandInteraction;
  return harness;
}

function makeButton(
  harness: WorkflowHarness,
  customId = "persona_select_0",
  messageId: string | null = harness.anchorMessageId,
): ButtonInteraction {
  const id = `button-${++interactionSequence}`;
  const button = {
    id,
    customId,
    user: { id: "workflow-user" },
    message: messageId === null ? undefined : { id: messageId },
    deferred: false,
    replied: false,
    update: async (payload: InteractionEditReplyOptions) => {
      harness.record("button.update", id, payload);
      harness.lastRenderedPayload = payload;
      button.replied = true;
      return { resource: { message: harness.message } };
    },
    deferUpdate: async (options?: unknown) => {
      harness.record("button.deferUpdate", id, options);
      button.deferred = true;
      return { resource: { message: harness.message } };
    },
    followUp: async (payload: unknown) => {
      harness.record("button.followUp", id, payload);
      return { id: "public-message" } as Message;
    },
  };
  return button as unknown as ButtonInteraction;
}

function makeModalSubmit(
  harness: WorkflowHarness,
  messageId: string | null = harness.anchorMessageId,
): ModalSubmitInteraction {
  const id = `modal-${++interactionSequence}`;
  const modal = {
    id,
    message: messageId === null ? undefined : { id: messageId },
    deferred: false,
    replied: false,
    update: async (payload: InteractionEditReplyOptions) => {
      harness.record("modal.update", id, payload);
      harness.lastRenderedPayload = payload;
      modal.replied = true;
      resolutionOrder.push("modal.update");
      return { resource: { message: harness.message } };
    },
    deferUpdate: async (options?: unknown) => {
      harness.record("modal.deferUpdate", id, options);
      modal.deferred = true;
      resolutionOrder.push("modal.deferUpdate");
      return { resource: { message: harness.message } };
    },
  };
  return modal as unknown as ModalSubmitInteraction;
}

function modalOptions(optionCount: number): ModalOptions {
  return {
    modalTitleKey: "modal.title",
    modalCustomId: "modal-id",
    components: [
      {
        customId: "choice",
        labelKey: "modal.choice",
        options: Array.from({ length: optionCount }, (_, index) => ({
          label: `Item ${index + 1}`,
          value: `item-${index}`,
        })),
      },
    ],
  };
}

function v2Payload(label: string): PersonaWorkflowComponentsV2Payload {
  return {
    components: [
      {
        type: ComponentType.Container,
        components: [{ type: ComponentType.TextDisplay, content: label }],
      },
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

function collectCustomIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectCustomIds);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.customId === "string" ? [record.customId] : []),
    ...(typeof record.custom_id === "string" ? [record.custom_id] : []),
    ...collectCustomIds(record.components),
  ];
}

function renderedButton(harness: WorkflowHarness, suffix: string): ButtonInteraction {
  const customId = collectCustomIds(harness.lastRenderedPayload).find((candidate) => candidate.endsWith(suffix));
  if (!customId) throw new Error(`No rendered button ends with ${suffix}.`);
  return makeButton(harness, customId);
}

function queueSelection(button: ButtonInteraction, selectedIndex: number | undefined): void {
  pickerQueue.push({
    success: true,
    selectedIndex,
    selectedItem: selectedIndex === undefined ? undefined : `Persona ${selectedIndex}`,
    interaction: button,
  });
}

function getPayload(call: RecordedCall): Record<string, unknown> {
  return call.payload as Record<string, unknown>;
}

function expectTypedError(error: unknown, code: PersonaWorkflowUpdateError["code"]): void {
  expect(error).toBeInstanceOf(WorkflowUpdateError);
  expect((error as PersonaWorkflowUpdateError).code).toBe(code);
}

function expectFatalLog(stage: string): void {
  const fatalLog = warnings.find((warning) => {
    const context = warning.context as
      | { errorType?: unknown; metadata?: { stage?: unknown; anchorMessageId?: unknown } }
      | undefined;
    return context?.errorType === "PersonaWorkflowFatal" && context.metadata?.stage === stage;
  });
  expect(fatalLog).toBeDefined();
}

function expectAllInPlacePayloadsAreV2(): void {
  const updates = calls.filter(
    (call) => call.method === "root.editReply" || call.method === "button.update" || call.method === "modal.update",
  );
  for (const update of updates) {
    const payload = getPayload(update);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(Array.isArray(payload.components)).toBe(true);
    expect(payload.content).toBeUndefined();
    expect(payload.embeds).toBeUndefined();
  }
}

beforeEach(() => {
  pickerQueue.length = 0;
  pickerCalls.length = 0;
  rawModalQueue.length = 0;
  rawModalCalls.length = 0;
  calls.length = 0;
  warnings.length = 0;
  rawModalAcknowledged = new WeakSet<object>();
  acknowledgeRawModal = true;
  interactionSequence = 0;
  resolutionOrder.length = 0;
  collapseGate = null;
  rejectCollapse = false;
});

describe("runPersonaPickerWorkflow selection and terminal outcomes", () => {
  it("normalizes selection index 0 without treating it as missing", async () => {
    const harness = makeHarness();
    const personas = [makePersona(10), makePersona(11)];
    queueSelection(makeButton(harness), 0);

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      onSelected: async (selection) => {
        expect(selection.persona).toBe(personas[0]);
        expect(selection.absoluteIndex).toBe(0);
        expect(selection.message.anchorMessageId).toBe(harness.anchorMessageId);
        return completePersonaWorkflow("selected-zero");
      },
    });

    expect(result).toEqual({
      outcome: "selected",
      persona: personas[0],
      absoluteIndex: 0,
      value: "selected-zero",
    });
  });

  it("preserves a later-page absolute persona index", async () => {
    const harness = makeHarness();
    const personas = Array.from({ length: 9 }, (_, index) => makePersona(100 + index));
    queueSelection(makeButton(harness, "persona_select_1"), 7);

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      onSelected: async (selection) => completePersonaWorkflow(selection.absoluteIndex),
    });

    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.absoluteIndex).toBe(7);
      expect(result.persona).toBe(personas[7]);
      expect(result.value).toBe(7);
    }
  });

  it("rejects missing, non-integral, out-of-range, and required-ID-mismatched contexts", async () => {
    const cases: Array<{
      name: string;
      selectedIndex?: number;
      withInteraction: boolean;
      requiredPersonaId?: number;
    }> = [
      { name: "missing interaction", selectedIndex: 0, withInteraction: false },
      { name: "missing index", withInteraction: true },
      { name: "fractional index", selectedIndex: 0.5, withInteraction: true },
      { name: "negative index", selectedIndex: -1, withInteraction: true },
      { name: "out-of-range index", selectedIndex: 2, withInteraction: true },
      { name: "required ID mismatch", selectedIndex: 0, withInteraction: true, requiredPersonaId: 999 },
    ];

    for (const testCase of cases) {
      const harness = makeHarness(`anchor-${testCase.name}`);
      const button = makeButton(harness);
      pickerQueue.push({
        success: true,
        selectedIndex: testCase.selectedIndex,
        interaction: testCase.withInteraction ? button : undefined,
      });
      let callbackCalled = false;

      const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        requiredPersonaId: testCase.requiredPersonaId,
        onSelected: async () => {
          callbackCalled = true;
          return completePersonaWorkflow();
        },
      });

      expect(result.outcome, testCase.name).toBe("error");
      expect(callbackCalled, testCase.name).toBe(false);
      if (result.outcome === "error") expectTypedError(result.error, "unsupported-replacement");
    }
  });

  it("preserves cancelled, timeout, error, and fatal as distinct outcomes", async () => {
    for (const reason of ["cancelled", "timeout", "error", "fatal"] as const) {
      const harness = makeHarness(`anchor-${reason}`);
      pickerQueue.push({ success: false, reason });
      let cancelCount = 0;
      let selectedCount = 0;

      const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onCancel: async () => {
          cancelCount++;
        },
        onSelected: async () => {
          selectedCount++;
          return retryPersonaWorkflow();
        },
      });

      expect(result.outcome).toBe(reason);
      expect(cancelCount).toBe(reason === "cancelled" ? 1 : 0);
      expect(selectedCount).toBe(0);
    }
  });

  it("never retries a fatal picker result", async () => {
    const harness = makeHarness();
    pickerQueue.push({ success: false, reason: "fatal" });
    queueSelection(makeButton(harness), 0);
    let callbackCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async () => {
        callbackCount++;
        return retryPersonaWorkflow();
      },
    });

    expect(result.outcome).toBe("fatal");
    expect(pickerCalls).toHaveLength(1);
    expect(callbackCount).toBe(0);
    expectFatalLog("picker");
  });

  it("does not retry after a caught fatal anchor-message controller failure", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    queueSelection(makeButton(harness), 0);
    harness.rootEditError = { code: 10062, message: "Unknown interaction" };
    let caughtError: unknown;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        try {
          await selection.message.replace(v2Payload("unavailable"));
        } catch (error) {
          caughtError = error;
        }
        return retryPersonaWorkflow();
      },
    });

    expectTypedError(caughtError, "anchor-message-unavailable");
    expect(result.outcome).toBe("fatal");
    expect(pickerCalls).toHaveLength(1);
    expectFatalLog("root-edit");
  });

  it("does not attempt a callback fallback after the controller is already fatal", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        await selection.beginInPlaceWork();
        harness.rootEditError = { code: 10062, message: "Unknown interaction" };
        await selection.message.replace(v2Payload("unavailable"));
        return retryPersonaWorkflow();
      },
    });

    expect(result.outcome).toBe("fatal");
    expect(calls.filter((call) => call.method === "root.editReply")).toHaveLength(1);
    expect(pickerCalls).toHaveLength(1);
    expectFatalLog("root-edit");
  });

  it("replaces the anchor message after an acknowledged callback throws", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    const callbackError = new Error("unexpected callback failure");

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        await selection.beginInPlaceWork();
        throw callbackError;
      },
    });

    expect(result).toEqual({ outcome: "error", error: callbackError });
    expect(calls.map((call) => call.method)).toEqual(["button.deferUpdate", "root.editReply"]);
    const fallbackPayload = getPayload(calls[1] ?? { method: "", source: "" });
    expect(JSON.stringify(fallbackPayload.components)).toContain("general.errors.operation_failed_title");
    expectAllInPlacePayloadsAreV2();
  });

  it("promotes a fatal acknowledged callback fallback and never retries", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    queueSelection(makeButton(harness), 0);
    const callbackError = new Error("unexpected callback failure");

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        await selection.beginInPlaceWork();
        harness.rootEditError = { code: 10062, message: "Unknown interaction" };
        throw callbackError;
      },
    });

    expect(result.outcome).toBe("fatal");
    if (result.outcome === "fatal") {
      expectTypedError(result.error, "anchor-message-unavailable");
    }
    expect(pickerCalls).toHaveLength(1);
    expectFatalLog("root-edit");
  });
});

describe("workflow acknowledgment and modal phases", () => {
  it("acknowledges in-place work before slow work and only once", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    queueSelection(selectedButton, 0);
    let repeatedAckError: unknown;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        await selection.beginInPlaceWork();
        harness.record("slow-work", "callback");
        await selection.message.replace(v2Payload("done"));
        try {
          await selection.beginInPlaceWork();
        } catch (error) {
          repeatedAckError = error;
        }
        return completePersonaWorkflow();
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["button.deferUpdate", "slow-work", "root.editReply"]);
    expectTypedError(repeatedAckError, "already-acknowledged");
    expectAllInPlacePayloadsAreV2();
  });

  it("opens a ready modal as the selected button's first acknowledgment", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    rawModalQueue.push({
      outcome: "submit",
      values: { choice: "item-0" },
      multiValues: { checks: ["one"] },
      attachments: { file: { id: "attachment-1", filename: "one.txt" } as APIAttachment },
      interaction: modalSubmit,
    });

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const modal = await selection.openModal(modalOptions(1));
        expect(modal.outcome).toBe("submitted");
        if (modal.outcome !== "submitted") return completePersonaWorkflow("unexpected");
        expect(modal.phase.values.choice).toBe("item-0");
        expect(modal.phase.multiValues.checks).toEqual(["one"]);
        expect(modal.phase.attachments.file?.filename).toBe("one.txt");
        await modal.phase.beginInPlaceWork();
        await modal.phase.message.replace(v2Payload("modal complete"));
        return completePersonaWorkflow("submitted");
      },
    });

    expect(result.outcome).toBe("selected");
    // The leading root.editReply is collapse-at-open, fired as the modal opened so a
    // dismissal cannot strand live controls; the trailing one is the terminal render.
    expect(calls.map((call) => call.method)).toEqual([
      "root.editReply",
      "rawModal",
      "modal.deferUpdate",
      "root.editReply",
    ]);
    expect(JSON.stringify(getPayload(calls[0]).components)).toContain("selector_opened_title");
    expect(calls.some((call) => call.method === "button.deferUpdate" && call.source === selectedButton.id)).toBe(false);
    expect(calls.some((call) => call.method === "button.update" && call.source === selectedButton.id)).toBe(false);
    expectAllInPlacePayloadsAreV2();
  });

  it("replaces the anchor V2 message through an unacknowledged message-backed modal submit", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    rawModalQueue.push({ outcome: "submit", interaction: modalSubmit });

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const modal = await selection.openModal(modalOptions(1));
        expect(modal.outcome).toBe("submitted");
        if (modal.outcome !== "submitted") return completePersonaWorkflow();
        await modal.phase.replace(v2Payload("direct modal replacement"));
        return completePersonaWorkflow();
      },
    });

    expect(result.outcome).toBe("selected");
    // Collapse-at-open adds one root.editReply as the modal opens; the terminal edit
    // still lands through the fresh, message-backed modal submit (modal.update).
    expect(calls.map((call) => call.method)).toEqual(["root.editReply", "rawModal", "modal.update"]);
    expect(calls.some((call) => call.method === "modal.deferUpdate")).toBe(false);
    const rootEdits = calls.filter((call) => call.method === "root.editReply");
    expect(rootEdits).toHaveLength(1);
    expect(JSON.stringify(getPayload(rootEdits[0]).components)).toContain("selector_opened_title");
    expectAllInPlacePayloadsAreV2();
  });

  it("orders the terminal edit after a slow collapse-at-open edit (constraint C)", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    rawModalQueue.push({ outcome: "submit", interaction: modalSubmit });

    // Gate the collapse edit so it resolves only after we release it. If the terminal
    // edit did not settle the collapse first, modal.update would complete before the
    // collapse, flipping the recorded resolution order.
    let releaseCollapse!: () => void;
    collapseGate = new Promise<void>((resolve) => {
      releaseCollapse = resolve;
    });

    const runPromise = runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const modal = await selection.openModal(modalOptions(1));
        if (modal.outcome !== "submitted") return completePersonaWorkflow();
        await modal.phase.replace(v2Payload("terminal after collapse"));
        return completePersonaWorkflow();
      },
    });

    // Let the flow progress to where the terminal edit is blocked on the gated collapse.
    await Promise.resolve();
    expect(resolutionOrder).not.toContain("modal.update");
    releaseCollapse();
    const result = await runPromise;

    expect(result.outcome).toBe("selected");
    expect(resolutionOrder).toEqual(["root.editReply", "modal.update"]);
  });

  it("swallows a rejecting collapse-at-open edit so the submit still succeeds (Review B5)", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    rawModalQueue.push({ outcome: "submit", interaction: modalSubmit });
    // The collapse edit rejects; because it is `.catch()`ed at storage, settling it must
    // not throw and the real submit must still render its terminal state.
    rejectCollapse = true;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const modal = await selection.openModal(modalOptions(1));
        if (modal.outcome !== "submitted") return completePersonaWorkflow();
        await modal.phase.replace(v2Payload("terminal despite rejected collapse"));
        return completePersonaWorkflow("done");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(calls.some((call) => call.method === "modal.update")).toBe(true);
  });

  it("acknowledges before asynchronously loading modal options, then opens from a fresh button", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    harness.awaitQueue.push(() => renderedButton(harness, "_open"));
    rawModalQueue.push({ outcome: "submit", interaction: modalSubmit });

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const modal = await selection.openModal(async () => {
          harness.record("load-options", "callback");
          return modalOptions(25);
        });
        return completePersonaWorkflow(modal.outcome);
      },
    });

    const methods = calls.map((call) => call.method);
    expect(methods[0]).toBe("button.deferUpdate");
    expect(methods.indexOf("button.deferUpdate")).toBeLessThan(methods.indexOf("load-options"));
    expect(methods.indexOf("load-options")).toBeLessThan(methods.indexOf("rawModal"));
    const modalButton = rawModalCalls[0]?.button;
    expect(modalButton).toBeDefined();
    expect(calls.some((call) => call.method === "button.deferUpdate" && call.source === modalButton?.id)).toBe(false);
    expectAllInPlacePayloadsAreV2();
  });

  it("tracks raw-modal acknowledgment even when discord.js flags stay false during retry", async () => {
    const harness = makeHarness();
    const firstButton = makeButton(harness);
    const secondButton = makeButton(harness);
    queueSelection(firstButton, 0);
    queueSelection(secondButton, 0);
    rawModalQueue.push({ outcome: "timeout" });
    let selectionCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        selectionCount++;
        if (selectionCount === 1) {
          expect(firstButton.replied).toBe(false);
          expect(firstButton.deferred).toBe(false);
          expect((await selection.openModal(modalOptions(1))).outcome).toBe("timeout");
          return retryPersonaWorkflow();
        }
        return completePersonaWorkflow("done");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(pickerCalls).toHaveLength(2);
    expect(calls.some((call) => call.method === "button.deferUpdate" && call.source === firstButton.id)).toBe(false);
  });

  it("returns typed modal failures for acknowledged, legacy-backed, and non-message-backed contexts", async () => {
    const cases: Array<{
      expectedCode: PersonaWorkflowUpdateError["code"];
      modalMessageId: string | null;
      preAcknowledge?: boolean;
    }> = [
      { expectedCode: "already-acknowledged", modalMessageId: "anchor-message", preAcknowledge: true },
      { expectedCode: "message-mismatch", modalMessageId: "legacy-message" },
      { expectedCode: "non-message-backed-interaction", modalMessageId: null },
    ];

    for (const testCase of cases) {
      const harness = makeHarness();
      const selectedButton = makeButton(harness);
      queueSelection(selectedButton, 0);
      if (!testCase.preAcknowledge) {
        rawModalQueue.push({ outcome: "submit", interaction: makeModalSubmit(harness, testCase.modalMessageId) });
      }
      let modalResult: PersonaWorkflowModalResult | undefined;

      await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onSelected: async (selection) => {
          if (testCase.preAcknowledge) await selection.beginInPlaceWork();
          modalResult = await selection.openModal(modalOptions(1));
          return completePersonaWorkflow();
        },
      });

      expect(modalResult?.outcome).toBe("error");
      if (modalResult?.outcome === "error") expectTypedError(modalResult.error, testCase.expectedCode);
    }
  });

  it("reports missing raw-modal acknowledgment as a typed error", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    acknowledgeRawModal = false;
    rawModalQueue.push({ outcome: "timeout" });
    let modalResult: PersonaWorkflowModalResult | undefined;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        modalResult = await selection.openModal(modalOptions(1));
        return completePersonaWorkflow();
      },
    });

    expect(modalResult?.outcome).toBe("error");
    if (modalResult?.outcome === "error") expectTypedError(modalResult.error, "discord-update-failed");
  });

  for (const code of [10062, 50027]) {
    it(`preserves raw-modal fatal code ${code} and refuses a requested retry`, async () => {
      const harness = makeHarness();
      queueSelection(makeButton(harness), 0);
      queueSelection(makeButton(harness), 0);
      acknowledgeRawModal = false;
      rawModalQueue.push({
        outcome: "error",
        error: { code, message: code === 10062 ? "Unknown interaction" : "Invalid webhook token" },
      });
      let callbackCount = 0;

      const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onSelected: async (selection) => {
          callbackCount++;
          const modal = await selection.openModal(modalOptions(1));
          expect(modal.outcome).toBe("fatal");
          if (modal.outcome === "fatal") {
            expectTypedError(modal.error, "anchor-message-unavailable");
          }
          return retryPersonaWorkflow();
        },
      });

      expect(result.outcome).toBe("fatal");
      expect(callbackCount).toBe(1);
      expect(pickerCalls).toHaveLength(1);
      expect(rawModalCalls).toHaveLength(1);
      expectFatalLog("raw-modal");
    });
  }
});

describe("anchor persona message controller", () => {
  it("starts a non-persona sibling scope on the same anchor controller", async () => {
    const harness = makeHarness();
    const phase = await beginAnchorPrivateWorkflow(harness.root, "en-US", v2Payload("initial"));
    const nested = makeButton(harness, "serverwide-next");

    expect(phase.message.anchorMessageId).toBe(harness.anchorMessageId);
    expect(phase.phaseId).toBe(harness.root.id);
    await phase.useButton(nested).replace(v2Payload("next"));
    await phase.message.disableControls();

    const initial = getPayload(calls[0] ?? { method: "", source: "" });
    expect(calls[0]?.method).toBe("root.reply");
    expect(initial.flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
    expect(initial.withResponse).toBe(true);
    expect(calls.some((call) => call.method === "button.update" && call.source === nested.id)).toBe(true);
    expect(calls.some((call) => call.method === "root.editReply")).toBe(true);
  });

  it("logs a fatal anchor-controller failure outside the persona runner", async () => {
    const harness = makeHarness();
    const phase = await beginAnchorPrivateWorkflow(harness.root, "en-US", v2Payload("initial"));
    harness.rootEditError = { code: 50027, message: "Invalid webhook token" };
    let failure: unknown;

    try {
      await phase.message.replace(v2Payload("unavailable"));
    } catch (error) {
      failure = error;
    }

    expectTypedError(failure, "anchor-message-unavailable");
    expectFatalLog("root-edit");
  });

  it("replaces, edits, fetches, disables controls, handles attachments, and deletes one anchor message", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    queueSelection(selectedButton, 0);
    let deletedFailure: unknown;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        await selection.beginInPlaceWork();
        const controller = selection.message;
        expect(controller.anchorMessageId).toBe(harness.anchorMessageId);

        const replaced = await controller.replace(v2Payload("replace and clear stale avatar"));
        const edited = await controller.edit(v2Payload("edit and retain attachments"));
        const fetched = await controller.fetchMessage();
        const disabled = await controller.disableControls();
        const withFile = v2Payload("replacement file") as PersonaWorkflowComponentsV2Payload;
        withFile.components = [
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.MediaGallery,
                items: [{ media: { url: "attachment://replacement.png" } }],
              },
            ],
          },
        ];
        withFile.files = [{ attachment: Buffer.from("replacement"), name: "replacement.png" }];
        withFile.attachments = [{ id: "keep-me" }];
        await controller.replace(withFile);

        expect([replaced.id, edited.id, fetched.id, disabled.id]).toEqual([
          harness.anchorMessageId,
          harness.anchorMessageId,
          harness.anchorMessageId,
          harness.anchorMessageId,
        ]);
        await controller.delete();
        try {
          await controller.fetchMessage();
        } catch (error) {
          deletedFailure = error;
        }
        return completePersonaWorkflow();
      },
    });

    expect(result.outcome).toBe("selected");
    const edits = calls.filter((call) => call.method === "root.editReply");
    expect(getPayload(edits[0] ?? { method: "", source: "" }).attachments).toEqual([]);
    expect(getPayload(edits[1] ?? { method: "", source: "" }).attachments).toBeUndefined();
    const disablePayload = getPayload(edits[2] ?? { method: "", source: "" });
    const disabledJson = JSON.stringify(disablePayload.components);
    expect(disabledJson).toContain('"disabled":true');
    expect(disabledJson).toContain("Static text");
    const filePayload = getPayload(edits[3] ?? { method: "", source: "" });
    expect(filePayload.attachments).toEqual([{ id: "keep-me" }]);
    expect(filePayload.files).toHaveLength(1);
    expect(JSON.stringify(filePayload.components)).toContain("attachment://replacement.png");
    expect(calls.filter((call) => call.method === "root.deleteReply")).toHaveLength(1);
    expectTypedError(deletedFailure, "deleted");
    expectAllInPlacePayloadsAreV2();
  });

  it("uses the latest nested button and rejects wrong-message or missing-message buttons", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    const nested = makeButton(harness, "nested");
    const deferredNested = makeButton(harness, "deferred-nested");
    const wrongMessage = makeButton(harness, "wrong", "other-message");
    const missingMessage = makeButton(harness, "missing", null);
    const failures: unknown[] = [];

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const nestedMessage = await selection.useButton(nested).replace(v2Payload("nested replacement"));
        expect(nestedMessage.id).toBe(harness.anchorMessageId);
        const deferredPhase = await selection.useButton(deferredNested).beginInPlaceWork();
        await deferredPhase.message.replace(v2Payload("deferred nested replacement"));
        for (const button of [wrongMessage, missingMessage]) {
          try {
            await selection.useButton(button).replace(v2Payload("invalid replacement"));
          } catch (error) {
            failures.push(error);
          }
        }
        return completePersonaWorkflow();
      },
    });

    expect(calls.filter((call) => call.method === "button.update" && call.source === nested.id)).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === "button.deferUpdate" && call.source === deferredNested.id),
    ).toHaveLength(1);
    expect(calls.some((call) => call.method === "button.update" && call.source === deferredNested.id)).toBe(false);
    expectTypedError(failures[0], "message-mismatch");
    expectTypedError(failures[1], "non-message-backed-interaction");
    expectAllInPlacePayloadsAreV2();
  });

  it("returns typed unsupported, Discord, fatal-token, and message-mismatch failures", async () => {
    const scenarios: Array<{
      expectedCode: PersonaWorkflowUpdateError["code"];
      configure(harness: WorkflowHarness): PersonaWorkflowComponentsV2Payload;
    }> = [
      {
        expectedCode: "unsupported-replacement",
        configure: () =>
          ({ ...v2Payload("legacy"), content: "not allowed" }) as unknown as PersonaWorkflowComponentsV2Payload,
      },
      {
        expectedCode: "discord-update-failed",
        configure: (harness) => {
          harness.rootEditError = new Error("ordinary Discord failure");
          return v2Payload("ordinary failure");
        },
      },
      {
        expectedCode: "anchor-message-unavailable",
        configure: (harness) => {
          harness.rootEditError = { code: 10062, message: "Unknown interaction" };
          return v2Payload("fatal failure");
        },
      },
      {
        expectedCode: "message-mismatch",
        configure: (harness) => {
          harness.rootEditMessage = { id: "replacement-message" } as Message;
          return v2Payload("wrong message");
        },
      },
    ];

    for (const scenario of scenarios) {
      const harness = makeHarness();
      queueSelection(makeButton(harness), 0);
      let failure: unknown;

      await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onSelected: async (selection) => {
          try {
            await selection.message.replace(scenario.configure(harness));
          } catch (error) {
            failure = error;
          }
          return completePersonaWorkflow();
        },
      });

      expectTypedError(failure, scenario.expectedCode);
    }
  });

  it("rejects over-budget Components V2 replacements with unsupported-replacement", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    let failure: unknown;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        try {
          const overBudgetPayload = {
            flags: MessageFlags.IsComponentsV2,
            components: [
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: "A".repeat(4005),
                  },
                ],
              },
            ],
          } as unknown as PersonaWorkflowComponentsV2Payload;
          await selection.message.replace(overBudgetPayload);
        } catch (error) {
          failure = error;
        }
        return completePersonaWorkflow();
      },
    });

    expectTypedError(failure, "unsupported-replacement");
    expect((failure as PersonaWorkflowUpdateError).message).toContain("TEXT_DISPLAY_TOTAL_EXCEEDED");
  });
});

describe("in-place paginated modal bridge", () => {
  it("opens exactly 25 options directly and preserves first/last mapping", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    const modalSubmit = makeModalSubmit(harness);
    queueSelection(selectedButton, 0);
    rawModalQueue.push({ outcome: "submit", values: { choice: "item-24" }, interaction: modalSubmit });
    let modalResult: PersonaWorkflowModalResult | undefined;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        modalResult = await selection.openModal(modalOptions(25));
        return completePersonaWorkflow();
      },
    });

    expect(rawModalCalls).toHaveLength(1);
    expect(rawModalCalls[0]?.button).toBe(selectedButton);
    const options = rawModalCalls[0]?.options.components[0];
    expect(options && "options" in options ? options.options.map((option) => option.value) : []).toEqual(
      Array.from({ length: 25 }, (_, index) => `item-${index}`),
    );
    expect(modalResult?.outcome).toBe("submitted");
    if (modalResult?.outcome === "submitted") {
      expect(modalResult.phase.optionOffset).toBe(0);
      expect(modalResult.phase.values.choice).toBe("item-24");
    }
    expect(calls.filter((call) => call.method === "message.awaitMessageComponent")).toHaveLength(0);
  });

  it("maps the first and last ranges of exactly 26 options to absolute offsets", async () => {
    for (const rangeIndex of [0, 1] as const) {
      const harness = makeHarness(`anchor-range-${rangeIndex}`);
      queueSelection(makeButton(harness), 0);
      harness.awaitQueue.push(() => renderedButton(harness, `_range_${rangeIndex}`));
      rawModalQueue.push({
        outcome: "submit",
        values: { choice: rangeIndex === 0 ? "item-0" : "item-25" },
        interaction: makeModalSubmit(harness),
      });
      let modalResult: PersonaWorkflowModalResult | undefined;

      await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onSelected: async (selection) => {
          modalResult = await selection.openModal(modalOptions(26));
          return completePersonaWorkflow();
        },
      });

      expect(modalResult?.outcome).toBe("submitted");
      if (modalResult?.outcome === "submitted") {
        expect(modalResult.phase.optionOffset).toBe(rangeIndex * 25);
        const localIndex = 0;
        expect(modalResult.phase.optionOffset + localIndex).toBe(rangeIndex === 0 ? 0 : 25);
      }
      const rangedComponent = rawModalCalls.at(-1)?.options.components[0];
      const values =
        rangedComponent && "options" in rangedComponent ? rangedComponent.options.map((item) => item.value) : [];
      expect(values).toEqual(
        rangeIndex === 0 ? Array.from({ length: 25 }, (_, index) => `item-${index}`) : ["item-25"],
      );
      expectAllInPlacePayloadsAreV2();
      calls.length = 0;
    }
  });

  it("keeps range cancellation and timeout on the anchor message", async () => {
    for (const outcome of ["cancelled", "timeout"] as const) {
      const harness = makeHarness(`anchor-${outcome}`);
      queueSelection(makeButton(harness), 0);
      harness.awaitQueue.push(outcome === "timeout" ? "time" : () => renderedButton(harness, "_cancel"));
      let modalResult: PersonaWorkflowModalResult | undefined;

      await runPersonaPickerWorkflow(harness.root, "en-US", {
        personas: [makePersona(1)],
        onSelected: async (selection) => {
          modalResult = await selection.openModal(modalOptions(26));
          return completePersonaWorkflow();
        },
      });

      expect(modalResult?.outcome).toBe(outcome);
      expect(rawModalCalls).toHaveLength(0);
      const replacements = calls.filter((call) => call.method === "button.update" || call.method === "root.editReply");
      expect(replacements.length).toBeGreaterThanOrEqual(2);
      expectAllInPlacePayloadsAreV2();
      calls.length = 0;
    }
  });

  it("supports previous/next range pages without changing the anchor message", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    harness.awaitQueue.push(
      () => renderedButton(harness, "_next"),
      () => renderedButton(harness, "_previous"),
      () => renderedButton(harness, "_range_0"),
    );
    rawModalQueue.push({ outcome: "submit", interaction: makeModalSubmit(harness) });
    let modalResult: PersonaWorkflowModalResult | undefined;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        modalResult = await selection.openModal(modalOptions(501));
        return completePersonaWorkflow();
      },
    });

    expect(modalResult?.outcome).toBe("submitted");
    expect(calls.filter((call) => call.method === "message.awaitMessageComponent")).toHaveLength(3);
    expect(calls.filter((call) => call.method === "button.update")).toHaveLength(3);
    expect(rawModalCalls[0]?.button.message.id).toBe(harness.anchorMessageId);
    expectAllInPlacePayloadsAreV2();
  });

  it("maps a selection from the second selector page to its absolute option offset", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    harness.awaitQueue.push(
      () => renderedButton(harness, "_next"),
      () => renderedButton(harness, "_range_20"),
    );
    rawModalQueue.push({
      outcome: "submit",
      values: { choice: "item-500" },
      interaction: makeModalSubmit(harness),
    });
    let modalResult: PersonaWorkflowModalResult | undefined;

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        modalResult = await selection.openModal(modalOptions(501));
        return completePersonaWorkflow();
      },
    });

    expect(modalResult?.outcome).toBe("submitted");
    if (modalResult?.outcome === "submitted") {
      expect(modalResult.phase.optionOffset).toBe(500);
      expect(modalResult.phase.values.choice).toBe("item-500");
    }
    const rangedComponent = rawModalCalls[0]?.options.components[0];
    const values =
      rangedComponent && "options" in rangedComponent ? rangedComponent.options.map((item) => item.value) : [];
    expect(values).toEqual(["item-500"]);
    expect(rawModalCalls[0]?.button.customId).toEndWith("_range_20");
    expect(rawModalCalls[0]?.button.message.id).toBe(harness.anchorMessageId);
    expect(calls.filter((call) => call.method === "message.awaitMessageComponent")).toHaveLength(2);
    expectAllInPlacePayloadsAreV2();
  });

  it("re-enters the picker after range cancellation without a follow-up", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    queueSelection(makeButton(harness), 0);
    harness.awaitQueue.push(() => renderedButton(harness, "_cancel"));
    let callbackCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        callbackCount++;
        if (callbackCount === 1) {
          expect((await selection.openModal(modalOptions(26))).outcome).toBe("cancelled");
          return retryPersonaWorkflow();
        }
        return completePersonaWorkflow("done");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(pickerCalls).toHaveLength(2);
    expect(calls.filter((call) => call.method === "button.followUp")).toHaveLength(0);
    expectAllInPlacePayloadsAreV2();
  });

  it("promotes a fatal bridge failure and prevents a requested retry", async () => {
    const harness = makeHarness();
    queueSelection(makeButton(harness), 0);
    queueSelection(makeButton(harness), 0);
    harness.awaitQueue.push(Object.assign(new Error("Unknown interaction"), { code: 10062 }));
    let callbackCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        callbackCount++;
        const modal = await selection.openModal(modalOptions(26));
        expect(modal.outcome).toBe("fatal");
        return retryPersonaWorkflow();
      },
    });

    expect(result.outcome).toBe("fatal");
    expect(callbackCount).toBe(1);
    expect(pickerCalls).toHaveLength(1);
    expectFatalLog("range-selector");
  });
});

describe("retry cache and separate-public policy", () => {
  it("owns and reuses one avatar cache across picker retries", async () => {
    const harness = makeHarness();
    const firstPersonas = [makePersona(1)];
    const firstButton = makeButton(harness);
    const secondButton = makeButton(harness);
    pickerQueue.push((options) => {
      options.avatarSessionCache?.set(0, { type: "url", url: "cached-avatar" });
      return { success: true, selectedIndex: 0, interaction: firstButton };
    });
    pickerQueue.push({ success: true, selectedIndex: 0, interaction: secondButton });
    let callbackCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: firstPersonas,
      onSelected: async () => {
        callbackCount++;
        return callbackCount === 1 ? retryPersonaWorkflow() : completePersonaWorkflow("finished");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(pickerCalls).toHaveLength(2);
    expect(pickerCalls[0]?.avatarSessionCache).toBe(pickerCalls[1]?.avatarSessionCache);
    expect(pickerCalls[1]?.avatarSessionCache?.get(0)).toEqual({ type: "url", url: "cached-avatar" });
    expect(pickerCalls[0]?.preserveSelectedInteraction).toBe(true);
    expect(pickerCalls[1]?.personas).toEqual(firstPersonas);
    expect(calls.filter((call) => call.method === "button.deferUpdate" && call.source === firstButton.id)).toHaveLength(
      1,
    );
  });

  it("compacts the private picker before creating exactly one public response", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    queueSelection(selectedButton, 0);
    let duplicateFailure: unknown;
    let ephemeralFailure: unknown;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas: [makePersona(1)],
      onSelected: async (selection) => {
        const publicPhase = await selection.beginSeparatePublicReply(v2Payload("private compacted"));
        try {
          await publicPhase.reply({ flags: MessageFlags.Ephemeral, content: "private" });
        } catch (error) {
          ephemeralFailure = error;
        }
        const publicMessage = await publicPhase.reply({ content: "public result" });
        expect(publicMessage.id).toBe("public-message");
        try {
          await publicPhase.reply({ content: "duplicate" });
        } catch (error) {
          duplicateFailure = error;
        }
        return completePersonaWorkflow("published");
      },
    });

    expect(result.outcome).toBe("selected");
    const policyCalls = calls.filter((call) => call.method === "button.update" || call.method === "button.followUp");
    expect(policyCalls.map((call) => call.method)).toEqual(["button.update", "button.followUp"]);
    expect(getPayload(policyCalls[0] ?? { method: "", source: "" }).flags).toBe(MessageFlags.IsComponentsV2);
    expect(getPayload(policyCalls[1] ?? { method: "", source: "" }).content).toBe("public result");
    expectTypedError(ephemeralFailure, "public-reply-must-not-be-ephemeral");
    expectTypedError(duplicateFailure, "public-reply-already-sent");
    expectAllInPlacePayloadsAreV2();
  });
});

describe("runPersonaPickerWorkflow eligibility filtering", () => {
  // Mirrors the shared `hasAttributes` predicate: eligible personas carry at
  // least one attribute. Using one function for both the picker filter and any
  // post-selection guard is exactly the parity the eligibility feature enforces.
  const hasAttr = (persona: TomoriState): boolean => (persona.attribute_list?.length ?? 0) > 0;

  function makeEligPersona(personaId: number, eligible: boolean): TomoriState {
    return { ...makePersona(personaId), attribute_list: eligible ? ["trait"] : [] } as TomoriState;
  }

  const eligibility = {
    isEligible: hasAttr,
    emptyTitleKey: "empty.title",
    emptyDescriptionKey: "empty.description",
    itemsLabelKey: "general.persona_workflow.items.attributes",
  };

  function filteredNoticeOf(index: number): unknown {
    return (pickerCalls[index] as unknown as { filteredNotice?: unknown } | undefined)?.filteredNotice;
  }

  it("renders the full list with no filtered notice when every persona is eligible", async () => {
    const harness = makeHarness();
    pickerQueue.push({ success: false, reason: "cancelled" });
    const personas = [makeEligPersona(1, true), makeEligPersona(2, true)];

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async () => completePersonaWorkflow(),
    });

    expect(result.outcome).toBe("cancelled");
    expect(pickerCalls).toHaveLength(1);
    expect(pickerCalls[0]?.personas.map((persona) => persona.persona_id)).toEqual([1, 2]);
    expect(filteredNoticeOf(0)).toBeUndefined();
  });

  it("shows only eligible personas and appends the filtered notice when some are excluded", async () => {
    const harness = makeHarness();
    pickerQueue.push({ success: false, reason: "cancelled" });
    const personas = [makeEligPersona(1, true), makeEligPersona(2, false), makeEligPersona(3, true)];

    await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async () => completePersonaWorkflow(),
    });

    expect(pickerCalls[0]?.personas.map((persona) => persona.persona_id)).toEqual([1, 3]);
    expect(filteredNoticeOf(0)).toBeDefined();
  });

  it("still renders a picker and requires an explicit click when exactly one persona is eligible", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    // The filtered list is [persona 2]; absolute index 0 must resolve to it.
    queueSelection(selectedButton, 0);
    const personas = [makeEligPersona(1, false), makeEligPersona(2, true)];

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async (selection) => {
        expect(selection.persona.persona_id).toBe(2);
        return completePersonaWorkflow("done");
      },
    });

    expect(result.outcome).toBe("selected");
    // A picker was rendered (no auto-selection of the lone eligible persona).
    expect(pickerCalls).toHaveLength(1);
    expect(pickerCalls[0]?.personas.map((persona) => persona.persona_id)).toEqual([2]);
  });

  it("returns the empty outcome without rendering a picker when no persona is eligible at entry", async () => {
    const harness = makeHarness();
    const personas = [makeEligPersona(1, false), makeEligPersona(2, false)];

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async () => completePersonaWorkflow(),
    });

    expect(result.outcome).toBe("empty");
    expect(pickerCalls).toHaveLength(0);
    // Distinct from cancelled/timeout/error/fatal.
    expect(result.outcome).not.toBe("cancelled");
  });

  it("replaces the anchor message in place and returns empty when a retry filters to empty", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    queueSelection(selectedButton, 0);
    const personas = [makeEligPersona(1, true)];
    const freshAllIneligible = [makeEligPersona(1, false)];

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async () => retryPersonaWorkflow(freshAllIneligible),
    });

    expect(result.outcome).toBe("empty");
    // Exactly one picker was rendered; the empty state did not open a second one.
    expect(pickerCalls).toHaveLength(1);
    // The selected button was acknowledged for the retry and the anchor message
    // was replaced in place (root editReply), not via a new ephemeral message.
    expect(calls.some((call) => call.method === "button.deferUpdate" && call.source === selectedButton.id)).toBe(true);
    expect(calls.some((call) => call.method === "root.editReply")).toBe(true);
    expect(calls.some((call) => call.method === "button.followUp")).toBe(false);
    expectAllInPlacePayloadsAreV2();
  });

  it("maps an absolute index to the right persona when the filtered list crosses a page boundary", async () => {
    const harness = makeHarness();
    const selectedButton = makeButton(harness);
    // 8 personas, alternating eligibility -> 6 eligible: ids [1,3,5,7,9,11].
    // The persona pager holds 4 per page, so absolute index 5 (the 6th eligible,
    // id 11) lands on page 2 and must resolve past the boundary.
    const personas = Array.from({ length: 12 }, (_, i) => makeEligPersona(i, i % 2 === 1));
    queueSelection(selectedButton, 5);

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async (selection) => {
        expect(selection.persona.persona_id).toBe(11);
        expect(selection.absoluteIndex).toBe(5);
        return completePersonaWorkflow("done");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(pickerCalls[0]?.personas.map((persona) => persona.persona_id)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("does not clear the avatar cache when a retry returns the same eligible set in the same order", async () => {
    const harness = makeHarness();
    const firstButton = makeButton(harness);
    const secondButton = makeButton(harness);
    const personas = [makeEligPersona(1, true), makeEligPersona(2, true)];
    pickerQueue.push((options) => {
      options.avatarSessionCache?.set(0, { type: "url", url: "cached-avatar" });
      return { success: true, selectedIndex: 0, interaction: firstButton };
    });
    pickerQueue.push({ success: true, selectedIndex: 0, interaction: secondButton });
    let callbackCount = 0;

    const result = await runPersonaPickerWorkflow(harness.root, "en-US", {
      personas,
      eligibility,
      onSelected: async () => {
        callbackCount++;
        // Retry with a fresh array that filters to the same eligible set/order.
        return callbackCount === 1
          ? retryPersonaWorkflow([makeEligPersona(1, true), makeEligPersona(2, true)])
          : completePersonaWorkflow("finished");
      },
    });

    expect(result.outcome).toBe("selected");
    expect(pickerCalls).toHaveLength(2);
    // Comparing filtered-to-filtered keeps identity stable, so the cache survives.
    expect(pickerCalls[1]?.avatarSessionCache?.get(0)).toEqual({ type: "url", url: "cached-avatar" });
  });
});
