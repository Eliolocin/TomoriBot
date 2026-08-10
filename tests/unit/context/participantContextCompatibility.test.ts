import { describe, expect, it } from "bun:test";
import { PrivacyLevel } from "@/types/db/schema";
import type { StructuredContextItem } from "@/types/misc/context";
import { buildParticipantContextItem } from "@/utils/text/context/participants";
import type { PublicPersonaProfile } from "@/utils/text/context/types";
import { resolveContextReferences } from "@/utils/text/contextReferences";
import { buildParticipantDiscoveryPlan } from "@/utils/text/participants/discoveryPlan";
import { createPersonaKey } from "@/utils/text/participants/identity";
import { composeParticipantDiscoveryPlan } from "@/utils/text/participants/sources";
import {
  createParticipantContextFixture,
  PARTICIPANT_FIXTURE_IDS,
  type ParticipantContextFixture,
} from "./fixtures/participantContextFixture";

interface BuildHumanOptions {
  personaLineageId?: number;
  isUserImpersonation?: boolean;
  impersonatedUserId?: string;
  impersonatedIdentityName?: string | null;
  publicPersonaProfiles?: readonly PublicPersonaProfile[];
}

async function buildHumanItem(
  fixture: ParticipantContextFixture,
  options: BuildHumanOptions = {},
): Promise<StructuredContextItem> {
  const referencePlan = buildParticipantDiscoveryPlan({
    candidates: (options.publicPersonaProfiles ?? []).map((profile) => ({
      key: createPersonaKey(profile.personaId),
      reasons: new Set(["persona_trigger_reference"]),
      aliases: [],
      capabilities: new Set(),
      sourceDisplayName: profile.personaName,
      evidenceSources: ["persona_trigger_reference"],
    })),
  });
  const { plan } = await composeParticipantDiscoveryPlan({
    visibleInput: {
      participantIds: [PARTICIPANT_FIXTURE_IDS.human, PARTICIPANT_FIXTURE_IDS.bot],
      clientUserId: PARTICIPANT_FIXTURE_IDS.bot,
      activePersonaId: fixture.activePersona.persona_id,
      activePersonaIsAlter: fixture.activePersona.is_alter,
    },
    personas: fixture.personas,
    referencePlan,
  });
  const item = await buildParticipantContextItem({
    client: fixture.client,
    guildId: PARTICIPANT_FIXTURE_IDS.guild,
    channelName: "general",
    channelId: PARTICIPANT_FIXTURE_IDS.channel,
    participantSeeds: plan.seeds,
    triggererName: "Alice",
    botName: options.isUserImpersonation ? "Copied Alice" : "Tomori",
    personaLineageId: options.personaLineageId ?? PARTICIPANT_FIXTURE_IDS.activeLineage,
    tomoriState: fixture.activePersona,
    tomoriConfig: fixture.config,
    isDMChannel: false,
    isUserImpersonation: options.isUserImpersonation ?? false,
    impersonatedUserId: options.impersonatedUserId,
    impersonatedIdentityName: options.impersonatedIdentityName ?? null,
    publicPersonaProfiles: options.publicPersonaProfiles,
    toolPromptMacroResolver: { expand: async (text) => text },
    conversationCorpus: "maps",
    convertMentions: async (text) => text,
  });
  if (!item) throw new Error("Human compatibility fixture unexpectedly rendered no context item");
  return item;
}

function getText(item: StructuredContextItem): string {
  const part = item.parts.find((candidate) => candidate.type === "text");
  return part?.type === "text" ? part.text : "";
}

describe("participant context compatibility matrix", () => {
  for (const scenario of [
    {
      label: "minimal privacy",
      privacy: PrivacyLevel.MINIMAL,
      personalization: true,
      blacklisted: false,
      savedNameVisible: true,
      rolesVisible: true,
      memoriesVisible: true,
    },
    {
      label: "partial privacy",
      privacy: PrivacyLevel.PARTIAL,
      personalization: true,
      blacklisted: false,
      savedNameVisible: true,
      rolesVisible: false,
      memoriesVisible: false,
    },
    {
      label: "full privacy",
      privacy: PrivacyLevel.FULL,
      personalization: true,
      blacklisted: false,
      savedNameVisible: true,
      rolesVisible: false,
      memoriesVisible: false,
    },
    {
      label: "personalization disabled",
      privacy: PrivacyLevel.MINIMAL,
      personalization: false,
      blacklisted: false,
      savedNameVisible: false,
      rolesVisible: true,
      memoriesVisible: false,
    },
    {
      label: "server blacklist",
      privacy: PrivacyLevel.MINIMAL,
      personalization: true,
      blacklisted: true,
      savedNameVisible: false,
      rolesVisible: true,
      memoriesVisible: false,
    },
  ]) {
    it(`locks field exposure for ${scenario.label}`, async () => {
      const fixture = createParticipantContextFixture();
      try {
        const user = fixture.users.get(PARTICIPANT_FIXTURE_IDS.human);
        if (!user) throw new Error("Fixture human is missing");
        user.privacy_level = scenario.privacy;
        fixture.config.personal_memories_enabled = scenario.personalization;
        if (scenario.blacklisted) fixture.blacklistedUserIds.add(user.user_disc_id);

        const item = await buildHumanItem(fixture);
        const text = getText(item);

        expect(text.includes("Alice Saved")).toBe(scenario.savedNameVisible);
        expect(text.includes("Server Roles: Archivist")).toBe(scenario.rolesVisible);
        expect(text.includes("Alice likes archival maps.")).toBe(scenario.memoriesVisible);
        expect(text).toContain(
          "Alice Saved's Physical Appearance".replace(
            "Alice Saved",
            scenario.savedNameVisible ? "Alice Saved" : "Alice Display",
          ),
        );
        expect(text).toContain('ID:92 "Bring the atlas"');
      } finally {
        fixture.restoreRepositories();
      }
    });
  }

  it("keeps deterministic saved-name rendering available at full privacy", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const referencedUser = fixture.users.get(PARTICIPANT_FIXTURE_IDS.referencedHuman);
      if (!referencedUser) throw new Error("Fixture reference user is missing");
      referencedUser.privacy_level = PrivacyLevel.FULL;
      fixture.history[0] = { ...fixture.history[0], content: "Please ask Bob Saved about this." };

      const references = await resolveContextReferences({
        client: fixture.client,
        guildId: PARTICIPANT_FIXTURE_IDS.guild,
        simplifiedMessageHistory: fixture.history,
        personas: fixture.personas,
        activePersonaId: PARTICIPANT_FIXTURE_IDS.activePersona,
        existingParticipantIds: new Set([PARTICIPANT_FIXTURE_IDS.human]),
      });
      expect(references.referencedUserIds).toEqual(new Set([PARTICIPANT_FIXTURE_IDS.referencedHuman]));

      const { plan } = await composeParticipantDiscoveryPlan({
        visibleInput: {
          participantIds: [PARTICIPANT_FIXTURE_IDS.bot],
          clientUserId: PARTICIPANT_FIXTURE_IDS.bot,
          activePersonaId: fixture.activePersona.persona_id,
          activePersonaIsAlter: fixture.activePersona.is_alter,
        },
        personas: fixture.personas,
        referencePlan: references.discoveryPlan,
      });
      const item = await buildParticipantContextItem({
        client: fixture.client,
        guildId: PARTICIPANT_FIXTURE_IDS.guild,
        channelName: "general",
        channelId: PARTICIPANT_FIXTURE_IDS.channel,
        participantSeeds: plan.seeds,
        triggererName: "Alice",
        botName: "Tomori",
        personaLineageId: PARTICIPANT_FIXTURE_IDS.activeLineage,
        tomoriState: fixture.activePersona,
        tomoriConfig: fixture.config,
        isDMChannel: false,
        isUserImpersonation: false,
        impersonatedIdentityName: null,
        preloadedReferencedUserRows: references.referencedUserRows,
        referencedUserIds: references.referencedUserIds,
        toolPromptMacroResolver: { expand: async (text) => text },
        conversationCorpus: "",
        convertMentions: async (text) => text,
      });
      if (!item) throw new Error("Reference compatibility fixture unexpectedly rendered no context item");

      const text = getText(item);
      expect(text).toContain("Bob Saved");
      expect(item.conversationUsers?.[0]?.aliases).toContain("Bob Saved");
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("locks user-impersonation suppression and persona self-task behavior", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildHumanItem(fixture, {
        isUserImpersonation: true,
        impersonatedUserId: PARTICIPANT_FIXTURE_IDS.human,
        impersonatedIdentityName: "Copied Alice",
      });
      const text = getText(item);

      expect(text).not.toContain("Physical Appearance");
      expect(text).toContain("Alice likes archival maps.");
      expect(text).not.toContain("Pending Tasks Assigned to You:");
      expect(text).not.toContain("(This is you!)");
      expect(item.conversationUsers?.[0]).toMatchObject({
        targetId: PARTICIPANT_FIXTURE_IDS.human,
        displayLabel: "Copied Alice",
      });
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("keeps personal memories isolated between active persona lineages", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const human = fixture.users.get(PARTICIPANT_FIXTURE_IDS.human);
      if (!human) throw new Error("Fixture human is missing");
      fixture.personalMemories.push({
        ...fixture.personalMemories[0],
        personal_memory_id: 94,
        user_id: human.user_id,
        persona_lineage_id: 80,
        content: "Alice likes old radio dramas.",
        tags: [],
      });

      const mainLineageText = getText(
        await buildHumanItem(fixture, { personaLineageId: PARTICIPANT_FIXTURE_IDS.activeLineage }),
      );
      const alterLineageText = getText(await buildHumanItem(fixture, { personaLineageId: 80 }));

      expect(mainLineageText).toContain("Alice likes archival maps.");
      expect(mainLineageText).not.toContain("Alice likes old radio dramas.");
      expect(alterLineageText).not.toContain("Alice likes archival maps.");
      expect(alterLineageText).toContain("Alice likes old radio dramas.");
    } finally {
      fixture.restoreRepositories();
    }
  });

  it("keeps same-name user and persona profile fields on separate stable identities", async () => {
    const fixture = createParticipantContextFixture();
    try {
      const item = await buildHumanItem(fixture, {
        publicPersonaProfiles: [
          {
            personaId: 999,
            personaName: "Alice Saved",
            attributes: ["This field belongs to persona 999, not the Discord user."],
            imageAppearanceTags: ["persona-only silver hair"],
          },
        ],
      });
      const text = getText(item);

      expect(text.match(/^Alice Saved(?: \(|$)/gm)).toHaveLength(2);
      expect(text).toContain("Alice Saved's Physical Appearance: auburn hair, green eyes");
      expect(text).toContain("Known Information about Alice Saved:");
      expect(text).toContain("This field belongs to persona 999, not the Discord user.");
      expect(text).toContain("Alice Saved's Physical Appearance: persona-only silver hair");
      expect(item.conversationUsers).toHaveLength(2);
      expect(item.conversationUsers?.find((target) => target.targetId === "persona:999")).toMatchObject({
        displayLabel: "Alice Saved",
        aliases: ["Alice Saved"],
        mentionable: false,
      });
    } finally {
      fixture.restoreRepositories();
    }
  });
});
