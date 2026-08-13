import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { HumanizerDegree, type AssembledServerConfig } from "@/types/db/schema";
import { appendDialogueHistoryContext } from "@/utils/text/context/dialogueHistory";
import { buildDateSpacer, buildReunionNote, SPACER_TEMPLATE } from "@/utils/text/context/timeAwareness";
import type { SimplifiedMessageForContext } from "@/utils/text/context/types";
import { getCalendarDayWithOffset } from "@/utils/text/timezoneHelper";

const NOW = Date.parse("2026-07-15T12:00:00Z");
const EXPANDED_TEMPLATE = SPACER_TEMPLATE.replace("{message_metadata_tool}", "`reveal_message_metadata`");

function makeMessage(id: string, createdAt?: number): SimplifiedMessageForContext {
  return {
    id,
    authorId: `user-${id}`,
    authorName: "Alice",
    authorType: "user",
    content: id,
    createdAt,
    imageAttachments: [],
    videoAttachments: [],
  };
}

function makeConfig(timezoneOffset = 0): AssembledServerConfig {
  return {
    message_fetch_limit: 80,
    context_note: null,
    context_note_depth: 0,
    humanizer_degree: HumanizerDegree.NONE,
    personal_memories_enabled: true,
    uncensor_unicode_space_enabled: false,
    uncensor_sanitize_enabled: false,
    timezone_offset: timezoneOffset,
    time_awareness_enabled: true,
    verbatim_tool_calling_enabled: false,
  } as AssembledServerConfig;
}

function itemText(item: { parts: Array<{ type: string; text?: string }> }): string {
  return item.parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

describe("time awareness calendar helpers", () => {
  it("computes calendar-day differences across month and year boundaries", () => {
    const dec31 = getCalendarDayWithOffset(Date.parse("2025-12-31T23:30:00Z"), 0);
    const jan1 = getCalendarDayWithOffset(Date.parse("2026-01-01T00:30:00Z"), 0);
    expect(jan1 - dec31).toBe(1);
  });

  it("applies negative offsets before choosing the calendar day", () => {
    const beforeMidnight = getCalendarDayWithOffset(Date.parse("2026-01-01T00:30:00Z"), -1);
    const afterMidnight = getCalendarDayWithOffset(Date.parse("2026-01-01T02:00:00Z"), -1);
    expect(afterMidnight - beforeMidnight).toBe(1);
  });
});

describe("buildReunionNote", () => {
  it("covers first-timer, recent, reunion, and already-seen conditions", () => {
    expect(
      buildReunionNote({
        lastPreviousDayAt: null,
        seenToday: false,
        displayName: "Alice",
        nowMs: NOW,
        reunionDays: 3,
      }),
    ).toBe(
      "Alice is talking to you directly for the very first time! Welcome them naturally and ask something friendly to get to know them.",
    );

    expect(
      buildReunionNote({
        lastPreviousDayAt: new Date("2026-07-14T12:00:00Z"),
        seenToday: false,
        displayName: "Alice",
        nowMs: NOW,
        reunionDays: 3,
      }),
    ).toBeNull();

    expect(
      buildReunionNote({
        lastPreviousDayAt: new Date("2026-07-12T12:00:00Z"),
        seenToday: false,
        displayName: "Alice",
        nowMs: NOW,
        reunionDays: 3,
      }),
    ).toBe(
      "Alice hasn't interacted with you specifically since July 12, 2026 (3 days ago), though they may have been around the server. Acknowledge them interacting with you again.",
    );

    expect(
      buildReunionNote({
        lastPreviousDayAt: new Date("2026-07-12T12:00:00Z"),
        seenToday: true,
        displayName: "Alice",
        nowMs: NOW,
        reunionDays: 3,
      }),
    ).toBeNull();
  });

  it("uses personal, then server, then UTC timezone fallback", () => {
    const args = {
      lastPreviousDayAt: new Date("2026-07-12T23:30:00Z"),
      seenToday: false,
      displayName: "Alice",
      nowMs: Date.parse("2026-07-15T00:30:00Z"),
      reunionDays: 3,
    };

    expect(buildReunionNote({ ...args, personalOffset: 2, serverOffset: 0 })).toBeNull();
    expect(buildReunionNote({ ...args, personalOffset: null, serverOffset: 0 })).toContain("July 12, 2026");
    expect(buildReunionNote({ ...args, personalOffset: null, serverOffset: null })).toContain("July 12, 2026");
  });
});

describe("buildDateSpacer", () => {
  it("returns null within one server calendar day", () => {
    expect(
      buildDateSpacer(
        Date.parse("2026-07-12T10:00:00Z"),
        Date.parse("2026-07-12T23:00:00Z"),
        0,
        EXPANDED_TEMPLATE,
        NOW,
      ),
    ).toBeNull();
  });

  it("emits an absolute date and preserves the already-expanded tool macro", () => {
    const spacer = buildDateSpacer(
      Date.parse("2026-07-12T23:30:00Z"),
      Date.parse("2026-07-13T00:30:00Z"),
      0,
      EXPANDED_TEMPLATE,
      NOW,
    );
    expect(spacer).toContain("July 12, 2026");
    expect(spacer).toContain("3 days ago");
    expect(spacer).toContain("`reveal_message_metadata`");
    expect(spacer).not.toContain("{message_metadata_tool}");
  });

  it("detects a boundary caused only by the server offset", () => {
    const previous = Date.parse("2026-07-12T14:30:00Z");
    const next = Date.parse("2026-07-12T15:30:00Z");
    expect(buildDateSpacer(previous, next, 0, EXPANDED_TEMPLATE, NOW)).toBeNull();
    expect(buildDateSpacer(previous, next, 9, EXPANDED_TEMPLATE, NOW)).toContain("July 12, 2026");
  });
});

describe("appendDialogueHistoryContext — time-awareness injections", () => {
  it("injects the producer-supplied reunion note above the newest messages", async () => {
    const contextItems = [];
    await appendDialogueHistoryContext({
      contextItems,
      client: {} as Client,
      guildId: "guild-1",
      simplifiedMessageHistory: [
        makeMessage("one"),
        makeMessage("two"),
        makeMessage("three"),
        makeMessage("four"),
        makeMessage("five"),
      ],
      botName: "Tomori",
      tomoriConfig: makeConfig(),
      tomoriState: null,
      reunionNote: "Alice is talking to you directly for the very first time!",
      includeTimestamps: false,
      isUserImpersonation: false,
      uncensorInputOptions: { unicodeSpacesEnabled: false, sanitizeEnabled: false },
      convertMentions: async (text) => text,
    });

    // TIME_AWARENESS_NOTE_DEPTH (3) targets the 3rd-from-last message, so the note
    // lands above it rather than directly against the triggering prompt.
    const noteIndex = contextItems.findIndex((item) => itemText(item).includes("very first time"));
    const depthTargetIndex = contextItems.findIndex((item) => item.messageId === "three");
    expect(noteIndex).toBe(depthTargetIndex - 1);

    const noteText = itemText(contextItems[noteIndex]);
    expect(noteText).toBe("[System: Alice is talking to you directly for the very first time!]");
    expect(contextItems.filter((item) => itemText(item).startsWith("[System: Alice"))).toHaveLength(1);
  });

  it("emits exactly one spacer per boundary across a multi-day history", async () => {
    const contextItems = [];
    await appendDialogueHistoryContext({
      contextItems,
      client: {} as Client,
      guildId: "guild-1",
      simplifiedMessageHistory: [
        makeMessage("one", Date.parse("2026-07-11T10:00:00Z")),
        makeMessage("two", Date.parse("2026-07-11T20:00:00Z")),
        makeMessage("three", Date.parse("2026-07-12T10:00:00Z")),
        makeMessage("four", Date.parse("2026-07-13T10:00:00Z")),
      ],
      botName: "Tomori",
      tomoriConfig: makeConfig(),
      tomoriState: null,
      dateSpacerTemplate: EXPANDED_TEMPLATE,
      includeTimestamps: false,
      isUserImpersonation: false,
      uncensorInputOptions: { unicodeSpacesEnabled: false, sanitizeEnabled: false },
      convertMentions: async (text) => text,
    });

    const spacers = contextItems.filter((item) => item.messageId?.startsWith("date_spacer_"));
    expect(spacers).toHaveLength(2);
    expect(itemText(spacers[0])).toContain("July 11, 2026");
    expect(itemText(spacers[1])).toContain("July 12, 2026");
  });

  it("keeps the producer-to-native-builder reunion field wired", async () => {
    const producer = await Bun.file("src/utils/chat/contextPipeline.ts").text();
    const nativeBuilder = await Bun.file("src/utils/text/context/nativeBuilder.ts").text();
    expect(producer).toContain("reunionNote,");
    expect(nativeBuilder).toContain("reunionNote,");
    expect(nativeBuilder).toContain("dateSpacerTemplate,");
  });

  it("keeps both phases of the reunion presence protocol wired", async () => {
    // The clock only works if phase 1 (resolve, at context build) and phase 2
    // (commit, post-turn) both run. They live in one module so they stay in sync;
    // this guards the two call sites that drain it.
    const producer = await Bun.file("src/utils/chat/contextPipeline.ts").text();
    const postTurn = await Bun.file("src/utils/chat/postTurnEffects.ts").text();
    const presence = await Bun.file("src/utils/chat/reunionPresence.ts").text();

    expect(producer).toContain("resolveReunionNote");
    expect(producer).toContain("reunionPresence,");
    expect(postTurn).toContain("recordReunionPresence(context.reunionPresence, result)");

    // Phase 2 must stay response-gated: a turn that never answered delivered no
    // acknowledgment, so it must not consume the reunion.
    expect(presence).toContain("result.personaResponses.length === 0");
    // ...and must NOT inherit recordUsageStats' DM exclusion.
    expect(presence).not.toContain("isDMChannel");
  });
});
