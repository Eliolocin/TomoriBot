import { afterEach, describe, expect, it } from "bun:test";
import { TextChannel, type Client, type Message } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { evaluateAdmissionQueueAndTriggerGate } from "@/utils/chat/admissionQueue";
import {
  acquireChannelLockForTurn,
  channelLocks,
  clearChannelProcessingQueue,
  enqueueBusyChannelMessage,
  forceKillChannelStream,
  getOrCreateChannelLockEntry,
  releaseChannelLockAndReplayQueue,
  setActiveChannelTurnState,
} from "@/utils/chat/channelQueue";
import { shouldSurfaceChatUserErrors } from "@/utils/chat/errorVisibility";
import { shouldBotReply } from "@/utils/chat/replyDecision";
import type { ChatIncoming, ChatTurnContext } from "@/utils/chat/types";
import { runToolLoop } from "@/utils/chat/toolLoop";
import { determineMatchingPersonas, isSelfTriggerMessage } from "@/utils/chat/triggerProcessor";
import { StreamOrchestrator } from "@/utils/discord/streamOrchestrator";
import { parseTriggerWordListInput } from "@/utils/text/triggerWords";
import type { LLMProvider, StreamResult } from "@/types/provider/interfaces";

type ProviderFixtureName = "google" | "openrouter" | "novelai";

type PersonaFixture = {
  id: number;
  nickname: string;
  isAlter: boolean;
  triggers: string[];
};

type AutochatPersonaOverrideFixture = {
  channelDiscId: string;
  personaId: number;
};

type ConversationFixture = {
  id: string;
  provider: ProviderFixtureName;
  description: string;
  message: {
    authorId: string;
    authorName: string;
    authorBot?: boolean;
    content: string;
    mentionedUserIds: string[];
    webhookId?: string | null;
  };
  state: {
    deliberateTriggerMode: boolean;
    alwaysReplyEnabled: boolean;
    autochDiscIds: string[];
    autochPersonaOverrides: AutochatPersonaOverrideFixture[];
    autochCounter: number;
    autochNextTarget: number;
  };
  personas: PersonaFixture[];
  triggerContext: {
    isReplyToBot: boolean;
    replyPersonaId: number | null;
    isBotMentioned: boolean;
    isAutoMsgHit: boolean;
    isAlwaysReply: boolean;
    autoTriggerPersonaId: number | null;
    alwaysReplyFallbackPersonaId: number | null;
    deliberateTriggerMode: boolean;
    isAutochatDtmExemptChannel: boolean;
    allowedPersonaIds: number[] | null;
  };
};

type ExpectedDecision = {
  provider: ProviderFixtureName;
  shouldReply: boolean;
  matchingPersonaNicknames: string[];
};

const botUserId = "bot_001";
const guildId = "guild_001";
const channelId = "channel_001";

const conversations = (await Bun.file(
  "tests/regression/chat/fixtures/conversations.json",
).json()) as ConversationFixture[];
const expectedDecisions = (await Bun.file("tests/regression/chat/fixtures/expected-decisions.json").json()) as Record<
  string,
  ExpectedDecision
>;

function makeClient(): Client {
  return {
    user: {
      id: botUserId,
    },
  } as unknown as Client;
}

function makeTextChannel(): TextChannel {
  const channel = Object.create(TextChannel.prototype) as TextChannel & {
    id: string;
    parentId: string | null;
    messages: { cache: Map<string, Message> };
    isThread: () => boolean;
  };

  channel.id = channelId;
  channel.parentId = null;
  channel.messages = { cache: new Map<string, Message>() };
  channel.isThread = () => false;

  return channel;
}

function makeMessage(fixture: ConversationFixture, client: Client): Message {
  const mentionedUserIds = new Set(fixture.message.mentionedUserIds);
  const channel = makeTextChannel();

  const message = {
    id: `msg_${fixture.id}`,
    channel,
    channelId,
    client,
    guild: {
      id: guildId,
    },
    webhookId: null,
    interaction: null,
    reference: null,
    content: fixture.message.content,
    author: {
      id: fixture.message.authorId,
      username: fixture.message.authorName,
      bot: fixture.message.authorBot ?? false,
    },
    mentions: {
      users: {
        has: (userId: string) => mentionedUserIds.has(userId),
      },
    },
  } as unknown as Message;

  message.webhookId = fixture.message.webhookId ?? null;
  return message;
}

function makeTomoriState(fixture: ConversationFixture, persona: PersonaFixture): TomoriState {
  return {
    persona_id: persona.id,
    persona_nickname: persona.nickname,
    is_alter: persona.isAlter,
    trigger_words: persona.triggers,
    autoch_counter: fixture.state.autochCounter,
    autoch_next_target: fixture.state.autochNextTarget,
    config: {
      trigger_words: persona.isAlter ? [] : persona.triggers,
      deliberate_trigger_mode: fixture.state.deliberateTriggerMode,
      always_reply_enabled: fixture.state.alwaysReplyEnabled,
      autoch_disc_ids: fixture.state.autochDiscIds,
      autoch_persona_overrides: fixture.state.autochPersonaOverrides.map((override) => ({
        channel_disc_id: override.channelDiscId,
        persona_id: override.personaId,
      })),
      autoch_threshold: 0,
      autoch_threshold_max: 0,
      cascade_limit: 0,
    },
  } as unknown as TomoriState;
}

describe("chat regression harness", () => {
  afterEach(() => {
    StreamOrchestrator.clearStopRequest(channelId);
    channelLocks.clear();
  });

  for (const fixture of conversations) {
    it(`${fixture.provider}: ${fixture.description}`, () => {
      const client = makeClient();
      const message = makeMessage(fixture, client);
      const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));
      const mainPersona = personas.find((persona) => !persona.is_alter);
      const replyPersona =
        fixture.triggerContext.replyPersonaId === null
          ? null
          : (personas.find((persona) => persona.persona_id === fixture.triggerContext.replyPersonaId) ?? null);
      const allowedPersonaIds =
        fixture.triggerContext.allowedPersonaIds === null ? null : new Set(fixture.triggerContext.allowedPersonaIds);

      if (!mainPersona) {
        throw new Error(`Fixture ${fixture.id} is missing a main persona`);
      }

      const actualDecision: ExpectedDecision = {
        provider: fixture.provider,
        shouldReply: shouldBotReply(message, mainPersona, personas, {
          allowedPersonaIds,
        }),
        matchingPersonaNicknames: determineMatchingPersonas(
          message,
          personas,
          client,
          fixture.triggerContext.isReplyToBot,
          replyPersona,
          fixture.triggerContext.isBotMentioned,
          fixture.triggerContext.isAutoMsgHit,
          fixture.triggerContext.isAlwaysReply,
          fixture.triggerContext.autoTriggerPersonaId,
          fixture.triggerContext.alwaysReplyFallbackPersonaId,
          fixture.triggerContext.deliberateTriggerMode,
          fixture.triggerContext.isAutochatDtmExemptChannel,
          allowedPersonaIds,
        ).map((persona) => persona.persona_nickname ?? `id:${persona.persona_id}`),
      };

      expect(actualDecision).toEqual(expectedDecisions[fixture.id]);
    });
  }

  it("identifies persona webhook messages as self-trigger messages", () => {
    const fixture = conversations.find((conversation) => conversation.id === "google-persona-webhook-self-trigger");
    if (!fixture) {
      throw new Error("Missing google-persona-webhook-self-trigger fixture");
    }

    const client = makeClient();
    const message = makeMessage(fixture, client);
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));

    expect(isSelfTriggerMessage(message, personas)).toBe(true);
  });

  it("normalizes quoted trigger input before storage", () => {
    expect(parseTriggerWordListInput('"Quetz", `Tomo`, quetz')).toEqual(["quetz", "tomo"]);
  });

  it("keeps passive autochat-style turns quiet for user-facing error embeds", () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(
      {
        ...fixture,
        id: "passive_error_visibility",
        message: {
          ...fixture.message,
          content: "just a normal chat message",
          mentionedUserIds: [],
        },
      },
      client,
    );
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));
    const incoming: ChatIncoming = {
      client,
      message,
      isFromQueue: false,
      retryCount: 0,
      skipLock: false,
      isPersonaJob: false,
      isUserImpersonation: false,
      textQuotaSource: "user",
    };

    expect(
      shouldSurfaceChatUserErrors({
        incoming,
        client,
        message,
        isDMChannel: false,
        allPersonas: personas,
      }),
    ).toBe(false);
  });

  it("surfaces user-facing error embeds for deliberate chat triggers", () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(
      {
        ...fixture,
        id: "direct_error_visibility",
        message: {
          ...fixture.message,
          content: "Tomori, are you there?",
          mentionedUserIds: [],
        },
      },
      client,
    );
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));
    const incoming: ChatIncoming = {
      client,
      message,
      isFromQueue: false,
      retryCount: 0,
      skipLock: false,
      isPersonaJob: false,
      isUserImpersonation: false,
      textQuotaSource: "user",
    };

    expect(
      shouldSurfaceChatUserErrors({
        incoming,
        client,
        message,
        isDMChannel: false,
        allPersonas: personas,
      }),
    ).toBe(true);
  });

  it("lets internal triggers explicitly suppress user-facing error embeds", () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(
      {
        ...fixture,
        id: "explicit_suppressed_error_visibility",
        message: {
          ...fixture.message,
          content: "Tomori, are you there?",
          mentionedUserIds: [],
        },
      },
      client,
    );
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));
    const incoming: ChatIncoming = {
      client,
      message,
      isFromQueue: false,
      retryCount: 0,
      skipLock: false,
      isPersonaJob: false,
      isUserImpersonation: false,
      textQuotaSource: "system",
      shouldSurfaceUserErrors: false,
    };

    expect(
      shouldSurfaceChatUserErrors({
        incoming,
        client,
        message,
        isDMChannel: false,
        allPersonas: personas,
      }),
    ).toBe(false);
  });

  it("matches legacy stored trigger words with surrounding quotes", () => {
    const client = makeClient();
    const fixture: ConversationFixture = {
      id: "quoted-trigger-legacy",
      provider: "google",
      description: "legacy quoted trigger values still route to the expected persona",
      message: {
        authorId: "user_quoted_trigger",
        authorName: "Quoted Trigger User",
        content: "quetz, are you there?",
        mentionedUserIds: [],
      },
      state: {
        deliberateTriggerMode: false,
        alwaysReplyEnabled: false,
        autochDiscIds: [],
        autochPersonaOverrides: [],
        autochCounter: 0,
        autochNextTarget: 0,
      },
      personas: [
        {
          id: 1,
          nickname: "Tomori",
          isAlter: false,
          triggers: ["tomori"],
        },
        {
          id: 2,
          nickname: "Quetz",
          isAlter: true,
          triggers: ['"quetz"'],
        },
      ],
      triggerContext: {
        isReplyToBot: false,
        replyPersonaId: null,
        isBotMentioned: false,
        isAutoMsgHit: false,
        isAlwaysReply: false,
        autoTriggerPersonaId: null,
        alwaysReplyFallbackPersonaId: null,
        deliberateTriggerMode: false,
        isAutochatDtmExemptChannel: false,
        allowedPersonaIds: null,
      },
    };
    const message = makeMessage(fixture, client);
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));
    const mainPersona = personas.find((persona) => !persona.is_alter);

    if (!mainPersona) {
      throw new Error("Quoted trigger fixture is missing a main persona");
    }

    expect(
      determineMatchingPersonas(
        message,
        personas,
        client,
        fixture.triggerContext.isReplyToBot,
        null,
        fixture.triggerContext.isBotMentioned,
        fixture.triggerContext.isAutoMsgHit,
        fixture.triggerContext.isAlwaysReply,
        fixture.triggerContext.autoTriggerPersonaId,
        fixture.triggerContext.alwaysReplyFallbackPersonaId,
        fixture.triggerContext.deliberateTriggerMode,
        fixture.triggerContext.isAutochatDtmExemptChannel,
        null,
      ).map((persona) => persona.persona_nickname),
    ).toEqual(["Quetz"]);
    expect(shouldBotReply(message, mainPersona, personas)).toBe(true);
  });

  it("does not treat a diacritic letter as a word boundary around a trigger word", () => {
    const client = makeClient();
    // Boundary semantics live in tests/unit/text/regexUtils.test.ts; this pins that persona
    // routing consumes them, so a trigger buried in an unrelated word admits no persona.
    const triggerWord = "lex";
    const wordContainingTrigger = `prä${triggerWord}`;
    const fixture: ConversationFixture = {
      id: "diacritic-word-boundary",
      provider: "google",
      description: "an accented letter must not fake a word boundary next to a trigger substring",
      message: {
        authorId: "user_diacritic_trigger",
        authorName: "Diacritic User",
        content: `this message only contains the unrelated word ${wordContainingTrigger}`,
        mentionedUserIds: [],
      },
      state: {
        deliberateTriggerMode: false,
        alwaysReplyEnabled: false,
        autochDiscIds: [],
        autochPersonaOverrides: [],
        autochCounter: 0,
        autochNextTarget: 0,
      },
      personas: [
        {
          id: 1,
          nickname: "Tomori",
          isAlter: false,
          triggers: ["tomori"],
        },
        {
          id: 2,
          nickname: "Placeholder",
          isAlter: true,
          triggers: [triggerWord],
        },
      ],
      triggerContext: {
        isReplyToBot: false,
        replyPersonaId: null,
        isBotMentioned: false,
        isAutoMsgHit: false,
        isAlwaysReply: false,
        autoTriggerPersonaId: null,
        alwaysReplyFallbackPersonaId: null,
        deliberateTriggerMode: false,
        isAutochatDtmExemptChannel: false,
        allowedPersonaIds: null,
      },
    };
    const message = makeMessage(fixture, client);
    const personas = fixture.personas.map((persona) => makeTomoriState(fixture, persona));

    expect(
      determineMatchingPersonas(
        message,
        personas,
        client,
        fixture.triggerContext.isReplyToBot,
        null,
        fixture.triggerContext.isBotMentioned,
        fixture.triggerContext.isAutoMsgHit,
        fixture.triggerContext.isAlwaysReply,
        fixture.triggerContext.autoTriggerPersonaId,
        fixture.triggerContext.alwaysReplyFallbackPersonaId,
        fixture.triggerContext.deliberateTriggerMode,
        fixture.triggerContext.isAutochatDtmExemptChannel,
        null,
      ).map((persona) => persona.persona_nickname),
    ).toEqual([]);
  });

  it("acquireChannelLockForTurn sets isLocked and releaseChannelLockAndReplayQueue clears it", () => {
    const lockEntry = getOrCreateChannelLockEntry(channelId, guildId);

    acquireChannelLockForTurn(lockEntry, {
      messageId: "lock_lifecycle_msg",
      userDiscId: "user_lifecycle",
      isPersonaJob: false,
      isCommandTriggered: false,
    });

    expect(lockEntry.isLocked).toBe(true);

    releaseChannelLockAndReplayQueue({
      channelId,
      lockEntry,
      completedMessageId: "lock_lifecycle_msg",
      handleStopResponse: async () => {},
      processQueuedMessage: async () => {},
    });

    expect(lockEntry.isLocked).toBe(false);
  });

  it("enqueueBusyChannelMessage followed by lock release replays the queued message", async () => {
    const client = makeClient();
    const fixture = conversations[0];
    const activeMessage = makeMessage(fixture, client);
    const queuedMessage = makeMessage(
      {
        ...fixture,
        id: "queued_lifecycle",
        message: {
          ...fixture.message,
          content: "Tomori, queued lifecycle check",
        },
      },
      client,
    );
    const processedMessageIds: string[] = [];
    const lockEntry = getOrCreateChannelLockEntry(channelId, guildId);
    acquireChannelLockForTurn(lockEntry, {
      messageId: activeMessage.id,
      userDiscId: activeMessage.author.id,
      isPersonaJob: false,
      isCommandTriggered: false,
    });

    enqueueBusyChannelMessage({
      lockEntry,
      channelId,
      simulatedAutochatCounterReset: false,
      queuedMessage: {
        message: queuedMessage,
        textQuotaSource: "user",
      },
    });

    releaseChannelLockAndReplayQueue({
      channelId,
      lockEntry,
      completedMessageId: activeMessage.id,
      handleStopResponse: async () => {},
      processQueuedMessage: async (queued) => {
        processedMessageIds.push(queued.message.id);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(processedMessageIds).toEqual([queuedMessage.id]);
  });

  it("notifies queued message discard handlers when the channel queue is cleared", async () => {
    const client = makeClient();
    const fixture = conversations[0];
    const queuedMessage = makeMessage(fixture, client);
    const discardedReasons: string[] = [];
    const lockEntry = getOrCreateChannelLockEntry(channelId, guildId);

    enqueueBusyChannelMessage({
      lockEntry,
      channelId,
      simulatedAutochatCounterReset: false,
      queuedMessage: {
        message: queuedMessage,
        textQuotaSource: "system",
        onQueueDiscard: (reason) => {
          discardedReasons.push(reason);
        },
      },
    });

    expect(clearChannelProcessingQueue(channelId)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discardedReasons).toEqual(["channel_queue_cleared"]);
  });

  it("does not queue same-user follow-ups while a hard stop is pending", async () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(
      {
        ...fixture,
        id: "post_kill_follow_up",
        message: {
          ...fixture.message,
          content: "Tomori, are you still there?",
          mentionedUserIds: [],
        },
      },
      client,
    );
    const tomoriState = makeTomoriState(fixture, {
      id: 1001,
      nickname: "Tomori",
      isAlter: false,
      triggers: ["tomori"],
    });
    const incoming: ChatIncoming = {
      client,
      message,
      isFromQueue: false,
      retryCount: 0,
      skipLock: false,
      isPersonaJob: false,
      isUserImpersonation: false,
      textQuotaSource: "user",
    };
    const lockEntry = getOrCreateChannelLockEntry(channelId, guildId);
    acquireChannelLockForTurn(lockEntry, {
      messageId: "active_before_kill",
      userDiscId: message.author.id,
      isPersonaJob: false,
      isCommandTriggered: false,
    });
    setActiveChannelTurnState(lockEntry, {
      activePersonaId: tomoriState.persona_id,
      triggeredPersonaIds: [tomoriState.persona_id],
      followUpEligible: true,
    });
    StreamOrchestrator.requestStop(channelId, message.author.id);

    const disposition = await evaluateAdmissionQueueAndTriggerGate({
      incoming,
      channelScope: {
        guild: null,
        serverDiscId: guildId,
        isDMChannel: false,
      },
      earlyTomoriState: tomoriState,
      earlyAllPersonas: [tomoriState],
      userDiscId: message.author.id,
      cooldownUserDiscId: message.author.id,
      isActiveNaturalStopMessage: false,
      isNaturalStopMessage: false,
    });

    expect(disposition?.disposition).toBe("ignore");
    expect(disposition?.reason).toBe("locked_stop_requested");
    expect(lockEntry.messageQueue).toHaveLength(0);
  });

  it("treats /bot kill stream aborts as stopped_by_user and clears the stop request", async () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(fixture, client);
    const tomoriState = makeTomoriState(fixture, {
      id: 1001,
      nickname: "Tomori",
      isAlter: false,
      triggers: ["tomori"],
    });
    const lockEntry = getOrCreateChannelLockEntry(channelId, guildId);
    acquireChannelLockForTurn(lockEntry, {
      messageId: message.id,
      userDiscId: message.author.id,
      isPersonaJob: false,
      isCommandTriggered: false,
    });
    const provider = {
      streamToDiscord: () => new Promise<StreamResult>(() => {}),
    } as unknown as LLMProvider;
    const context = {
      turn: {
        lockedTurn: {
          admission: {
            incoming: {},
          },
        },
      },
      client,
      message,
      channel: message.channel,
      isFromQueue: false,
      streamingContext: {
        suppressUserErrors: true,
      },
      currentPersona: tomoriState,
      isUserImpersonation: false,
    } as unknown as ChatTurnContext;

    const resultPromise = runToolLoop({
      context,
      provider,
      providerConfig: {
        model: "test",
        apiKey: "test",
        temperature: 0,
      },
      tomoriState,
    });

    StreamOrchestrator.requestStop(channelId, message.author.id);
    expect(forceKillChannelStream(channelId)).toBe(true);

    const result = await resultPromise;

    expect(result.status).toBe("stopped_by_user");
    expect(StreamOrchestrator.hasStopRequest(channelId)).toBe(false);
  });

  it("pre-lock admission ignores non-triggering messages without locking the channel", async () => {
    const client = makeClient();
    const fixture = conversations[0];
    const message = makeMessage(
      {
        ...fixture,
        id: "pre_lock_non_trigger",
        message: {
          ...fixture.message,
          content: "just passing through with no trigger",
          mentionedUserIds: [],
        },
        state: {
          ...fixture.state,
          alwaysReplyEnabled: false,
          autochDiscIds: [],
          autochCounter: 0,
          autochNextTarget: 10,
        },
      },
      client,
    );
    const earlyTomoriState = makeTomoriState(
      {
        ...fixture,
        state: {
          ...fixture.state,
          alwaysReplyEnabled: false,
          autochDiscIds: [],
          autochCounter: 0,
          autochNextTarget: 10,
        },
      },
      {
        id: 1001,
        nickname: "Tomori",
        isAlter: false,
        triggers: ["tomori"],
      },
    );
    earlyTomoriState.config.thought_log_channel_disc_id = null;
    const incoming: ChatIncoming = {
      client,
      message,
      isFromQueue: false,
      retryCount: 0,
      skipLock: false,
      isPersonaJob: false,
      isUserImpersonation: false,
      textQuotaSource: "user",
    };

    const disposition = await evaluateAdmissionQueueAndTriggerGate({
      incoming,
      channelScope: {
        guild: null,
        serverDiscId: guildId,
        isDMChannel: false,
      },
      earlyTomoriState,
      earlyAllPersonas: [earlyTomoriState],
      userDiscId: message.author.id,
      cooldownUserDiscId: message.author.id,
      isActiveNaturalStopMessage: false,
      isNaturalStopMessage: false,
    });

    expect(disposition?.disposition).toBe("ignore");
    expect(disposition?.reason).toBe("non_trigger_pre_lock");
    expect(channelLocks.get(channelId)?.isLocked).not.toBe(true);
  });

  it.skip("[REGRESSION PROBE] fails when a fixture expectation is deliberately inverted", () => {
    const googleFixture = conversations.find((fixture) => fixture.id === "google-direct-mention-main");
    if (!googleFixture) {
      throw new Error("Missing google-direct-mention-main fixture");
    }

    const client = makeClient();
    const message = makeMessage(googleFixture, client);
    const personas = googleFixture.personas.map((persona) => makeTomoriState(googleFixture, persona));
    const mainPersona = personas.find((persona) => !persona.is_alter);

    if (!mainPersona) {
      throw new Error("Probe fixture is missing a main persona");
    }

    expect(shouldBotReply(message, mainPersona, personas)).toBe(false);
  });
});
