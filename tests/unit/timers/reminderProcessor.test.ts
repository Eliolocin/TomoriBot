import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Static imports are hoisted and evaluated before any `mock.module` runs, so
// these namespaces hold the genuine exports. Spreading them keeps every mock
// full-surface: `mock.module` is process-global and never restored, so a partial
// factory would break unrelated test files loaded later in a monolithic
// `bun test`.
import * as realMatrix from "@/utils/bridges/matrix";
import * as realTomoriStateCache from "@/utils/cache/tomoriStateCache";
import * as realRepositories from "@/utils/db/repositories";
import * as realMentionHelper from "@/utils/discord/mentionHelper";
import * as realWebhookManager from "@/utils/discord/webhookManager";
import * as realTomoriChat from "@/events/messageCreate/tomoriChat";
import * as realLogger from "@/utils/misc/logger";
import { createScopedModuleMocker, overrideMembers } from "../../helpers/mockSurface";

const getDueRemindersMock = mock(async () => []);
const rescheduleReminderMock = mock(async (_reminderId: number, nextReminderTime: Date) => ({
  reminder_id: _reminderId,
  reminder_time: nextReminderTime,
}));
const scheduleReminderRetryMock = mock(
  async (_reminderId: number, nextAttemptAt: Date, deliveryRetryCount: number) => ({
    reminder_id: _reminderId,
    next_attempt_at: nextAttemptAt,
    delivery_retry_count: deliveryRetryCount,
  }),
);
const deleteReminderByIdMock = mock(async () => true);
const tomoriChatMock = mock(async () => "run");
const suppressNextSelfReplyMock = mock(() => {});
const ensureDiscordUserMentionMock = mock(async () => {});

// Every factory spreads the real surface first, then overrides only the exports
// this file actually needs to control.
const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/db/repositories": realRepositories,
  "@/events/messageCreate/tomoriChat": realTomoriChat,
  "@/utils/discord/mentionHelper": realMentionHelper,
  "@/utils/cache/tomoriStateCache": realTomoriStateCache,
  "@/utils/discord/webhookManager": realWebhookManager,
  "@/utils/bridges/matrix": realMatrix,
});

scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  // Repositories are class instances, so delegate through the prototype to keep
  // the methods this file does not stub available to later test files.
  serverScheduleRepository: overrideMembers(realRepositories.serverScheduleRepository, {
    getDueReminders: getDueRemindersMock,
    rescheduleReminder: rescheduleReminderMock,
    scheduleReminderRetry: scheduleReminderRetryMock,
    deleteReminderById: deleteReminderByIdMock,
  }),
}));

scopedMock.module("@/events/messageCreate/tomoriChat", () => ({
  ...realTomoriChat,
  tomoriChat: tomoriChatMock,
  suppressNextSelfReply: suppressNextSelfReplyMock,
}));

scopedMock.module("@/utils/discord/mentionHelper", () => ({
  ...realMentionHelper,
  ensureDiscordUserMention: ensureDiscordUserMentionMock,
}));

scopedMock.module("@/utils/cache/tomoriStateCache", () => ({
  ...realTomoriStateCache,
  getCachedAllPersonas: mock(async () => []),
}));

scopedMock.module("@/utils/discord/webhookManager", () => ({
  ...realWebhookManager,
  getOrCreateWebhook: mock(async () => ({ webhook: null })),
  resolvePersonaWebhookIdentity: mock(async () => ({})),
  sendWebhookMessageWithIdentity: mock(async () => {}),
}));

scopedMock.module("@/utils/bridges/matrix", () => ({
  ...realMatrix,
  sendMatrixReminderMention: mock(async () => {}),
}));

let ReminderProcessor: typeof import("@/timers/reminderProcessor").ReminderProcessor;

/**
 * Silencing goes through `spyOn` on the live `log` singleton rather than a module mock. Nothing
 * here asserts on the logger, so the mock only ever suppressed noise, but registering it left the
 * module record replaced for the rest of the process: a later file's `spyOn(log, ...)` then
 * installs nothing at all, silently, and its assertions see the real implementation's output.
 * That cost `tests/unit/tools/searxngAvailabilityTransition.test.ts` a false failure. `spyOn`
 * mutates the singleton production already resolves at call time and is undone below.
 */
const silencedLogMethods = ["error", "info", "success", "warn"] as const;
const logSpies = silencedLogMethods.map((method) => spyOn(realLogger.log, method));

beforeAll(async () => {
  // `error` is the only async member, so its replacement has to stay thenable for callers that
  // chain `.catch()` on the returned promise.
  for (const spy of logSpies) spy.mockImplementation((() => undefined) as never);
  logSpies[0].mockImplementation((async () => undefined) as never);

  ({ ReminderProcessor } = await import("@/timers/reminderProcessor"));
});

afterAll(() => {
  for (const spy of logSpies) spy.mockRestore();
});

function makeReminder(overrides: Record<string, unknown> = {}) {
  return {
    reminder_id: 42,
    server_id: 1,
    channel_disc_id: "channel_001",
    user_discord_id: "user_001",
    user_nickname: "User",
    reminder_purpose: "Take meds",
    reminder_time: new Date(Date.now() - 1_000),
    next_attempt_at: null,
    delivery_retry_count: 0,
    repetition_interval_hours: null,
    self_reminder: false,
    created_by_user_id: 1,
    persona_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeClient() {
  const message = {
    id: "message_001",
    author: {
      username: "User",
      bot: false,
    },
  };
  const channel = {
    id: "channel_001",
    isTextBased: () => true,
    send: mock(async (_payload?: unknown) => ({ id: "fallback_001" })),
    messages: {
      fetch: mock(async () => ({
        first: () => message,
      })),
    },
  };

  return {
    user: {
      id: "bot_001",
    },
    channels: {
      fetch: mock(async () => channel),
    },
  };
}

describe("ReminderProcessor delivery acknowledgement", () => {
  beforeEach(() => {
    getDueRemindersMock.mockImplementation(async () => []);
    rescheduleReminderMock.mockImplementation(async (_reminderId: number, nextReminderTime: Date) => ({
      reminder_id: _reminderId,
      reminder_time: nextReminderTime,
    }));
    scheduleReminderRetryMock.mockImplementation(
      async (_reminderId: number, nextAttemptAt: Date, deliveryRetryCount: number) => ({
        reminder_id: _reminderId,
        next_attempt_at: nextAttemptAt,
        delivery_retry_count: deliveryRetryCount,
      }),
    );
    deleteReminderByIdMock.mockImplementation(async () => true);
    tomoriChatMock.mockImplementation(async () => "run");
    suppressNextSelfReplyMock.mockClear();
    ensureDiscordUserMentionMock.mockClear();
  });

  afterEach(() => {
    getDueRemindersMock.mockClear();
    rescheduleReminderMock.mockClear();
    scheduleReminderRetryMock.mockClear();
    deleteReminderByIdMock.mockClear();
    tomoriChatMock.mockClear();
  });

  it("reschedules instead of deleting when /kill stops reminder generation", async () => {
    const reminder = makeReminder();
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    tomoriChatMock.mockImplementation(async (input) => {
      await input.onGenerationResult?.({
        status: "stopped_by_user",
        streamResults: [],
        personaResponses: [],
      });
      return "run";
    });

    const before = Date.now();
    await new ReminderProcessor(makeClient() as never).processDueReminders();

    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
    expect(scheduleReminderRetryMock).toHaveBeenCalledTimes(1);
    expect(scheduleReminderRetryMock.mock.calls[0]?.[0]).toBe(reminder.reminder_id);
    expect(scheduleReminderRetryMock.mock.calls[0]?.[1].getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(reminder.reminder_time.getTime()).toBeLessThan(before);
    expect(tomoriChatMock.mock.calls[0]?.[0].shouldSurfaceUserErrors).toBeFalse();
  });

  it("deletes a one-time reminder after acknowledged generation", async () => {
    const reminder = makeReminder();
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    tomoriChatMock.mockImplementation(async (input) => {
      await input.onGenerationResult?.({
        status: "completed",
        streamResults: [],
        personaResponses: [{ personaName: "Tomori", text: "Reminder!", personaId: 1 }],
      });
      return "run";
    });

    await new ReminderProcessor(makeClient() as never).processDueReminders();

    expect(rescheduleReminderMock).not.toHaveBeenCalled();
    expect(scheduleReminderRetryMock).not.toHaveBeenCalled();
    expect(deleteReminderByIdMock).toHaveBeenCalledWith(reminder.reminder_id);
  });

  it("keeps queued reminders leased and retries them when the queue is cleared", async () => {
    const reminder = makeReminder();
    let onQueueDiscard: ((reason: "channel_queue_cleared") => Promise<void>) | undefined;
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    tomoriChatMock.mockImplementation(async (input) => {
      onQueueDiscard = input.onQueueDiscard;
      return "queued";
    });
    const processor = new ReminderProcessor(makeClient() as never);

    await processor.processDueReminders();
    await processor.processDueReminders();

    expect(tomoriChatMock).toHaveBeenCalledTimes(1);
    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
    expect(scheduleReminderRetryMock).not.toHaveBeenCalled();

    await onQueueDiscard?.("channel_queue_cleared");

    expect(scheduleReminderRetryMock).toHaveBeenCalledTimes(1);
    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
  });

  it("routes automated DM turns through the reminder's stored private-server identity", async () => {
    const reminder = makeReminder({
      server_disc_id: "human_001",
      server_is_dm_channel: true,
    });
    getDueRemindersMock.mockImplementation(async () => [reminder]);

    await new ReminderProcessor(makeClient() as never).processDueReminders();

    expect(tomoriChatMock.mock.calls[0]?.[0].systemTriggerIdentity).toEqual({
      serverDiscId: "human_001",
      userDiscId: "human_001",
    });
  });
});

describe("ReminderProcessor delivery retry cap", () => {
  beforeEach(() => {
    getDueRemindersMock.mockImplementation(async () => []);
    rescheduleReminderMock.mockImplementation(async (_reminderId: number, nextReminderTime: Date) => ({
      reminder_id: _reminderId,
      reminder_time: nextReminderTime,
    }));
    scheduleReminderRetryMock.mockImplementation(
      async (_reminderId: number, nextAttemptAt: Date, deliveryRetryCount: number) => ({
        reminder_id: _reminderId,
        next_attempt_at: nextAttemptAt,
        delivery_retry_count: deliveryRetryCount,
      }),
    );
    deleteReminderByIdMock.mockImplementation(async () => true);
    suppressNextSelfReplyMock.mockClear();
    ensureDiscordUserMentionMock.mockClear();
  });

  afterEach(() => {
    getDueRemindersMock.mockClear();
    rescheduleReminderMock.mockClear();
    scheduleReminderRetryMock.mockClear();
    deleteReminderByIdMock.mockClear();
    tomoriChatMock.mockClear();
  });

  function alwaysFailDelivery() {
    tomoriChatMock.mockImplementation(async (input) => {
      await input.onGenerationResult?.({
        status: "stopped_by_user",
        streamResults: [],
        personaResponses: [],
      });
      return "run";
    });
  }

  function alwaysSucceedDelivery() {
    tomoriChatMock.mockImplementation(async (input) => {
      await input.onGenerationResult?.({
        status: "completed",
        streamResults: [],
        personaResponses: [{ personaName: "Tomori", text: "Reminder!", personaId: 1 }],
      });
      return "run";
    });
  }

  it("stops retrying after the cap and falls back to a plain embed", async () => {
    const reminder = makeReminder();
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    alwaysFailDelivery();

    const client = makeClient();
    const channel = await client.channels.fetch();
    const processor = new ReminderProcessor(client as never);

    for (let attempt = 0; attempt < 5; attempt++) {
      await processor.processDueReminders();
    }

    expect(scheduleReminderRetryMock).toHaveBeenCalledTimes(5);
    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();

    await processor.processDueReminders();

    expect(scheduleReminderRetryMock).toHaveBeenCalledTimes(5);
    expect(deleteReminderByIdMock).toHaveBeenCalledWith(reminder.reminder_id);
    expect(channel.send).toHaveBeenCalledTimes(1);

    const fallbackPayload = channel.send.mock.calls[0]?.[0] as
      | { content?: string; embeds?: Array<{ toJSON(): { description?: string } }> }
      | undefined;
    expect(fallbackPayload?.content).toBe("<@user_001>");
    const fallbackDescription = fallbackPayload?.embeds?.[0]?.toJSON().description;
    expect(fallbackDescription).toContain("Take meds");
    expect(fallbackDescription).toContain("```text");
  });

  it("keeps a failed recurring reminder on its original cadence after the retry cap", async () => {
    const canonicalTime = new Date(Date.now() - 90 * 60 * 1_000);
    const reminder = makeReminder({
      reminder_time: canonicalTime,
      repetition_interval_hours: 1,
    });
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    alwaysFailDelivery();

    const client = makeClient();
    const channel = await client.channels.fetch();
    const processor = new ReminderProcessor(client as never);
    for (let attempt = 0; attempt <= 5; attempt++) {
      await processor.processDueReminders();
    }

    expect(scheduleReminderRetryMock).toHaveBeenCalledTimes(5);
    expect(rescheduleReminderMock).toHaveBeenCalledTimes(1);
    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
    const nextOccurrence = rescheduleReminderMock.mock.calls[0]?.[1];
    expect(nextOccurrence.getTime()).toBeGreaterThan(Date.now());
    expect((nextOccurrence.getTime() - canonicalTime.getTime()) % (60 * 60 * 1_000)).toBe(0);

    const fallbackPayload = channel.send.mock.calls[0]?.[0] as
      | { embeds?: Array<{ toJSON(): { footer?: { text?: string } } }> }
      | undefined;
    const footerText = fallbackPayload?.embeds?.[0]?.toJSON().footer?.text;
    expect(
      footerText === "reminders.triggered_footer_recurring_retained" || footerText?.includes("original cadence"),
    ).toBeTrue();
  });

  it("does not mention a user when a self-task falls back", async () => {
    const reminder = makeReminder({ self_reminder: true });
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    alwaysFailDelivery();

    const client = makeClient();
    const channel = await client.channels.fetch();
    const processor = new ReminderProcessor(client as never);
    for (let attempt = 0; attempt <= 5; attempt++) {
      await processor.processDueReminders();
    }

    const fallbackPayload = channel.send.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(fallbackPayload?.content).toBeUndefined();
  });

  it("resets the retry budget once a delivery is acknowledged", async () => {
    // Recurring so an acknowledged delivery reschedules rather than deleting, which
    // keeps deleteReminderById unambiguous evidence that the cap fired.
    const reminder = makeReminder({ repetition_interval_hours: 24 });
    getDueRemindersMock.mockImplementation(async () => [reminder]);
    const processor = new ReminderProcessor(makeClient() as never);

    alwaysFailDelivery();
    for (let attempt = 0; attempt < 3; attempt++) {
      await processor.processDueReminders();
    }

    alwaysSucceedDelivery();
    await processor.processDueReminders();

    alwaysFailDelivery();
    for (let attempt = 0; attempt < 3; attempt++) {
      await processor.processDueReminders();
    }

    // Six failures total: without the reset the cap would have fired on the last one.
    expect(deleteReminderByIdMock).not.toHaveBeenCalled();
  });

  it("neutralizes backtick runs (3, 4, 5, 6, 8) in fallback description so no two adjacent backticks survive", async () => {
    for (const runLen of [3, 4, 5, 6, 8]) {
      const purpose = `prefix ${"`".repeat(runLen)} middle ${"`".repeat(runLen)} suffix`;
      const reminder = makeReminder({ reminder_purpose: purpose });
      getDueRemindersMock.mockImplementation(async () => [reminder]);
      alwaysFailDelivery();

      const client = makeClient();
      const channel = await client.channels.fetch();
      const processor = new ReminderProcessor(client as never);
      for (let attempt = 0; attempt <= 5; attempt++) {
        await processor.processDueReminders();
      }

      const fallbackPayload = channel.send.mock.calls[0]?.[0] as
        | { embeds?: Array<{ toJSON(): { description?: string } }> }
        | undefined;
      const description = fallbackPayload?.embeds?.[0]?.toJSON().description ?? "";
      const fenceStart = description.indexOf("```text\n");
      const fenceEnd = description.lastIndexOf("\n```");
      expect(fenceStart).toBeGreaterThanOrEqual(0);
      expect(fenceEnd).toBeGreaterThan(fenceStart);
      const innerContent = description.slice(fenceStart + "```text\n".length, fenceEnd);
      expect(innerContent).not.toContain("``");
    }
  });
});
