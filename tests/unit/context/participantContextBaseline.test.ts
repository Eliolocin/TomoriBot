import { describe, expect, it } from "bun:test";
import type { CachedPresetData } from "@/utils/cache/stPresetCache";
import type { ToolContext } from "@/types/tool/interfaces";
import type { StreamContext } from "@/types/stream/interfaces";
import { ContextItemTag } from "@/types/misc/context";
import { relocateAssistantMediaContextItems } from "@/providers/utils/strictChatCompat";
import { cache as tomoriStateCache } from "@/utils/cache/tomoriStateCacheStore";
import { collectKnownSpeakerNames, resolveCopiedRenderModifierTarget } from "@/utils/discord/renderModifierResolver";
import { buildMentionLookup } from "@/utils/discord/stream/textConfig";
import { resolveUserTarget } from "@/utils/discord/targetResolver";
import { cleanToolReplyText } from "@/utils/discord/toolReplyText";
import { reassembleWithPreset } from "@/utils/text/presetContextBuilder";
import { replaceMentionHandles } from "@/utils/text/processors/mentionProcessor";
import { createParticipantRequestScope } from "@/utils/text/participants/preparation";
import {
  buildPreparedParticipantContext,
  createParticipantContextFixture,
  normalizeParticipantContextItem,
  PARTICIPANT_FIXTURE_IDS,
} from "./fixtures/participantContextFixture";

const EXPECTED_PARTICIPANT_GOLDEN = {
  role: "user",
  metadataTag: ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION,
  parts: [
    {
      type: "text",
      text: `[System: The following users are having a conversation:

If Tomori wants to ping any of these users, prepend an "@" symbol to a unique mention handle shown below (case-insensitive). If there is ambiguity with names, ask for clarification instead of guessing. Use mentions only when the notification matters.

Alice Saved (Mention: @{Alice Guild}; Aliases: @{Alice Saved}, @{Alice Display Global}, @{alice_username})
- Alice Saved's Physical Appearance: auburn hair, green eyes
- Server Roles: Archivist
- Memories: ID:91 [tags: #general, maps] Alice likes archival maps.
- Reminders:
  - ID:92 "Bring the atlas" (scheduled for Sun, Aug 2, 2026, 09:00 AM (UTC+8))

Tomori (This is you!)
- Tomori's Physical Appearance: black hair, blue eyes
- Status: Online - Currently active and responding to messages

Ren
- Ren's Physical Appearance: silver hair, violet eyes
- Known Information about Ren:
  - Ren keeps a public notebook.

Webhook Guest

Bob Saved (Mention: @{Bob Guild}; Aliases: @{Bob Saved}, @{Bob Display Global}, @{bob_username})
- Server Roles: Archivist

Mika Matrix
- Status: Online or status unknown

Pending Tasks Assigned to You:
- ID:93 "Review the field notes" (scheduled for Sun, Aug 2, 2026, 10:00 AM (UTC+8), repeats every 24 hour(s)) (destination: <#200000000000000001>)

Conversation context: #general (ID: 200000000000000001).
Current time: <NOW>.
]`,
    },
  ],
  conversationUsers: [
    {
      targetId: PARTICIPANT_FIXTURE_IDS.human,
      displayLabel: "Alice Saved",
      aliases: ["Alice Saved", "Alice Guild", "Alice Display Global", "alice_username"],
      mentionable: true,
    },
    {
      targetId: PARTICIPANT_FIXTURE_IDS.referencedHuman,
      displayLabel: "Bob Saved",
      aliases: ["Bob Saved", "Bob Guild", "Bob Display Global", "bob_username"],
      mentionable: true,
    },
    {
      targetId: PARTICIPANT_FIXTURE_IDS.matrix,
      displayLabel: "Mika Matrix",
      aliases: ["Mika Matrix"],
      mentionable: false,
    },
  ],
  personaMentionMap: [
    ["ren", "ren"],
    ["ren senpai", "Ren Senpai"],
    ["tomori", "tomori"],
  ],
};

function markerNode(identifier: string, nodeOrder: number): CachedPresetData["nodes"][number] {
  return {
    preset_id: 1,
    identifier,
    name: identifier,
    role: "system",
    content: "",
    is_marker: true,
    is_enabled: true,
    is_comment: false,
    node_order: nodeOrder,
    injection_position: 0,
    injection_depth: 0,
    injection_order: 100,
  };
}

describe("participant context Phase 0 baseline", () => {
  it("locks native participant text, order, target metadata, aliases, and aggregate I/O", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildPreparedParticipantContext(fixture);

      expect(normalizeParticipantContextItem(item)).toEqual(EXPECTED_PARTICIPANT_GOLDEN);
      expect(fixture.counters).toEqual({
        userRowLoads: 1,
        candidateQueries: 1,
        registrations: 0,
        blacklistReads: 2,
        privacyReads: 2,
        personalMemoryReads: 2,
        reminderReads: 3,
        memberFetches: 2,
        fullGuildMemberFetches: 0,
      });
      expect(fixture.memberCache.hits).toBe(3);
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("preserves participant metadata through SillyTavern preset reassembly", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildPreparedParticipantContext(fixture);
      const presetData: CachedPresetData = {
        preset: {
          preset_id: 1,
          server_id: 1,
          preset_name: "Participant Baseline",
          raw_json: {},
          is_active: true,
        },
        nodes: [markerNode("main", 0), markerNode("chatHistory", 1)],
      };

      const result = await reassembleWithPreset(
        { contextItems: [item], tailDirectives: [], lowerPriorityTailDirectives: [] },
        presetData,
        {
          triggererName: "Alice",
          tomoriNickname: "Tomori",
          tomoriAttributes: [],
          personaPrompt: null,
          sampleDialoguesIn: [],
          sampleDialoguesOut: [],
          lastUserMessage: "Please ask Bob and Ren about maps.",
        },
        {
          client: fixture.client,
          guildId: PARTICIPANT_FIXTURE_IDS.guild,
          triggererName: "Alice",
          botName: "Tomori",
          personalMemoriesEnabled: true,
        },
      );

      expect(result.contextItems.map((contextItem) => contextItem.metadataTag)).toEqual([
        ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION,
      ]);
      expect(normalizeParticipantContextItem(result.contextItems[0] ?? null)).toEqual(EXPECTED_PARTICIPANT_GOLDEN);
      expect(result.contextItems[0]?.participantTargetIndex).toEqual(item.participantTargetIndex);
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("produces equivalent live and prompt-snapshot participant output from the same sanitized fixture", async () => {
    const liveFixture = createParticipantContextFixture();
    let liveOutput: unknown;
    try {
      liveOutput = normalizeParticipantContextItem(await buildPreparedParticipantContext(liveFixture));
    } finally {
      liveFixture.restoreRepositories();
    }

    const snapshotFixture = createParticipantContextFixture();
    try {
      const snapshotOutput = normalizeParticipantContextItem(await buildPreparedParticipantContext(snapshotFixture));
      expect(snapshotOutput).toEqual(liveOutput);
      expect(snapshotFixture.counters).toEqual(liveFixture.counters);
    } finally {
      snapshotFixture.restoreRepositories();
    }
  });

  it("rehydrates memories and reminders for each active persona after shared discovery", async () => {
    const fixture = createParticipantContextFixture();
    const requestScope = createParticipantRequestScope();
    const alterPersona = fixture.personas.find(
      (persona) => persona.persona_id === PARTICIPANT_FIXTURE_IDS.historicalPersona,
    );
    if (!alterPersona) throw new Error("Alter persona fixture is missing");

    try {
      const mainItem = await buildPreparedParticipantContext(fixture, { requestScope });
      const alterItem = await buildPreparedParticipantContext(fixture, {
        activePersona: alterPersona,
        requestScope,
      });
      const mainText = mainItem.parts.find((part) => part.type === "text")?.text ?? "";
      const alterText = alterItem.parts.find((part) => part.type === "text")?.text ?? "";

      expect(fixture.counters.candidateQueries).toBe(1);
      expect(fixture.hydrationObservations.memoryLineages).toEqual([70, 70, 80, 80]);
      expect(fixture.hydrationObservations.reminderScopes.slice(0, 3)).toEqual([
        {
          discordId: PARTICIPANT_FIXTURE_IDS.human,
          personaId: PARTICIPANT_FIXTURE_IDS.activePersona,
          includeUnassignedForMainPersona: true,
        },
        {
          discordId: PARTICIPANT_FIXTURE_IDS.referencedHuman,
          personaId: PARTICIPANT_FIXTURE_IDS.activePersona,
          includeUnassignedForMainPersona: true,
        },
        {
          discordId: PARTICIPANT_FIXTURE_IDS.bot,
          personaId: PARTICIPANT_FIXTURE_IDS.activePersona,
          includeUnassignedForMainPersona: undefined,
        },
      ]);
      expect(fixture.hydrationObservations.reminderScopes.slice(3)).toEqual([
        {
          discordId: PARTICIPANT_FIXTURE_IDS.human,
          personaId: PARTICIPANT_FIXTURE_IDS.historicalPersona,
          includeUnassignedForMainPersona: false,
        },
        {
          discordId: PARTICIPANT_FIXTURE_IDS.referencedHuman,
          personaId: PARTICIPANT_FIXTURE_IDS.historicalPersona,
          includeUnassignedForMainPersona: false,
        },
        {
          discordId: PARTICIPANT_FIXTURE_IDS.bot,
          personaId: PARTICIPANT_FIXTURE_IDS.historicalPersona,
          includeUnassignedForMainPersona: undefined,
        },
      ]);
      expect(mainText).toContain("Alice likes archival maps.");
      expect(mainText).not.toContain("Alice remembers the alter's star chart.");
      expect(alterText).not.toContain("Alice likes archival maps.");
      expect(alterText).toContain("Alice remembers the alter's star chart.");
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("retains participant metadata through strict-chat context normalization", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildPreparedParticipantContext(fixture);
      const normalized = relocateAssistantMediaContextItems([
        item,
        {
          role: "model",
          parts: [
            { type: "text", text: "Tomori: Here is the map." },
            { type: "image", uri: "https://example.test/map.png", mimeType: "image/png" },
          ],
          sender: { name: "Tomori", type: "persona" },
          metadataTag: ContextItemTag.DIALOGUE_HISTORY,
          conversationUsers: item.conversationUsers,
          participantTargetIndex: item.participantTargetIndex,
          personaMentionMap: item.personaMentionMap,
        },
      ]);

      expect(normalizeParticipantContextItem(normalized[0] ?? null)).toEqual(EXPECTED_PARTICIPANT_GOLDEN);
      expect(normalized[0]?.participantTargetIndex).toEqual(item.participantTargetIndex);
      expect(normalized[2]).toMatchObject({
        conversationUsers: item.conversationUsers,
        participantTargetIndex: item.participantTargetIndex,
        personaMentionMap: item.personaMentionMap,
      });
      expect(normalized.map((contextItem) => contextItem.role)).toEqual(["user", "model", "user"]);
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("drives stream, tool-target, and tool-reply resolution from the same golden metadata", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildPreparedParticipantContext(fixture);
      expect(item.participantTargetIndex?.targets.length).toBeGreaterThan(0);
      const indexedItem = {
        ...item,
        conversationUsers: [],
        personaMentionMap: undefined,
      };
      const lookup = buildMentionLookup([indexedItem]);
      const streamText = replaceMentionHandles(
        "Ask @{Alice Guild} and @{Ren}.",
        lookup.mentionMap,
        lookup.mentionIdSet,
        lookup.personaMentionMap,
      );
      expect(streamText).toBe(`Ask <@${PARTICIPANT_FIXTURE_IDS.human}> and @ren.`);

      const guild = fixture.client.guilds.cache.get(PARTICIPANT_FIXTURE_IDS.guild);
      if (!guild) throw new Error("Participant fixture guild is missing");
      const toolContext = {
        channel: { guild },
        client: fixture.client,
        tomoriState: fixture.activePersona,
        locale: "en-US",
        provider: "fixture",
        personaUsername: "Tomori",
        contextItems: [indexedItem],
      } as unknown as ToolContext;

      await expect(resolveUserTarget("Alice Guild", toolContext)).resolves.toMatchObject({
        status: "resolved",
        targetId: PARTICIPANT_FIXTURE_IDS.human,
        source: "conversation",
      });
      await expect(cleanToolReplyText("Ask @{Alice Guild} and @{Ren}.", toolContext)).resolves.toBe(
        `Ask <@${PARTICIPANT_FIXTURE_IDS.human}> and @ren.`,
      );

      tomoriStateCache.set(PARTICIPANT_FIXTURE_IDS.guild, {
        personas: fixture.personas,
        mainPersona: fixture.activePersona,
        cachedAt: Date.now(),
      });
      await expect(
        collectKnownSpeakerNames({
          ...toolContext,
          contextItems: [indexedItem],
          currentTurnModelParts: [],
        } as unknown as StreamContext),
      ).resolves.toEqual(expect.arrayContaining(["Alice Saved", "Alice Guild", "Ren"]));
      const copiedTarget = await resolveCopiedRenderModifierTarget(
        "Alice Guild",
        {
          ...toolContext,
          contextItems: [indexedItem],
          currentTurnModelParts: [],
        } as unknown as StreamContext,
        "Tomori",
      );
      expect(copiedTarget).toMatchObject({
        displayName: "Alice Saved",
        identity: { username: "Alice Saved (Tomori)" },
        contextLabel: "Tomori (Alice Saved)",
      });
    } finally {
      tomoriStateCache.delete(PARTICIPANT_FIXTURE_IDS.guild);
      fixture.restoreRepositories();
    }
  });
});
