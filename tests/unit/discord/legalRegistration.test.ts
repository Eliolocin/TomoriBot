import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Client, Guild } from "discord.js";
import { loadCommandData, type CommandExecutionMap, resetCommandDataCache } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { buildHelpDashboardPayload } from "@/utils/discord/ui/helpDashboard";
import * as realHostedPolicy from "@/utils/misc/hostedPolicy";
import * as realEmbedHelper from "@/utils/discord/embedHelper";
import * as realServerRepositoryModule from "@/utils/db/repositories/ServerRepository";
import * as realPersonaRepositoryModule from "@/utils/db/repositories/PersonaRepository";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";

/**
 * The hosted-policy decision is one boolean read by four surfaces: the `/legal` registration
 * gate, the plaintext notices, the `/help` dashboard, and the guild welcome. This file drives
 * all four from one value, so a future edit that reads `RUN_ENV` directly in one of them fails
 * here rather than shipping a surface that disagrees with the others.
 *
 * `process.env.RUN_ENV` is steered as well as the predicate, because the command loader re-derives
 * `/legal`'s description from the leaf set it actually gated, and that path reads the real
 * predicate. Steering only the mock would let the leaf set and the wording answer from two
 * different environments and still look green.
 */
let hostedEnvironment = false;
const isHostedPolicyEnvironment = (): boolean => hostedEnvironment;

function setHostedEnvironment(hosted: boolean): void {
  hostedEnvironment = hosted;
  if (hosted) {
    process.env.RUN_ENV = "production";
  } else {
    delete process.env.RUN_ENV;
  }
}

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/misc/hostedPolicy": realHostedPolicy,
  "@/utils/discord/embedHelper": realEmbedHelper,
  "@/utils/db/repositories/ServerRepository": realServerRepositoryModule,
  "@/utils/db/repositories/PersonaRepository": realPersonaRepositoryModule,
});

/** Captures the embed options the guild-join handler hands to the shared embed sender. */
const sentEmbeds: Array<{ descriptionKey: string; descriptionVars?: Record<string, string | number | boolean> }> = [];

/**
 * What the stubbed workspace lookup answers, and how many times it was asked.
 *
 * The call count is the evidence that the stub reached the handler: the handler swallows a read
 * failure and falls through to the same embed, so a passing assertion alone cannot tell a
 * controlled answer from a database that was never there.
 */
const serverIdStub: number | null = 1;
let serverIdReads = 0;
const recordedServerIdReads = (): number => serverIdReads;

stubLogMembers({ info: () => undefined, success: () => undefined, warn: () => undefined, error: () => undefined });

scopedMock.module("@/utils/misc/hostedPolicy", () => ({
  ...realHostedPolicy,
  isHostedPolicyEnvironment,
}));

scopedMock.module("@/utils/discord/embedHelper", () => ({
  ...realEmbedHelper,
  sendStandardEmbed: async (
    _channel: unknown,
    _locale: string,
    options: { descriptionKey: string; descriptionVars?: Record<string, string | number | boolean> },
  ) => {
    sentEmbeds.push(options);
  },
}));

/**
 * The guild-join handler imports the repository singletons by their own module path, not through
 * the barrel, so these stubs target the modules it actually resolves. A barrel mock would leave
 * the handler on the real singletons, letting a swallowed database failure masquerade as the
 * controlled "no personas yet" state this test claims to drive.
 */
scopedMock.module("@/utils/db/repositories/ServerRepository", () => ({
  ...realServerRepositoryModule,
  serverRepository: overrideMembers(realServerRepositoryModule.serverRepository, {
    loadServerIdByDiscId: async () => {
      serverIdReads += 1;
      return serverIdStub;
    },
  }),
}));

scopedMock.module("@/utils/db/repositories/PersonaRepository", () => ({
  ...realPersonaRepositoryModule,
  personaRepository: overrideMembers(realPersonaRepositoryModule.personaRepository, {
    // An empty list is the "no personas yet" answer, which selects the setup welcome copy.
    loadServerPersonaSummaries: async () => [],
  }),
}));

beforeAll(async () => {
  await initializeLocalizer();
});

/** Captured at module load so the file leaves the process environment as it found it. */
const originalRunEnv = process.env.RUN_ENV;

beforeEach(() => {
  sentEmbeds.length = 0;
  serverIdReads = 0;
});

afterEach(() => {
  resetCommandDataCache();
  if (originalRunEnv === undefined) {
    delete process.env.RUN_ENV;
  } else {
    process.env.RUN_ENV = originalRunEnv;
  }
});

function registeredLegalPaths(executionMap: CommandExecutionMap): string[] {
  return [...(executionMap.get("legal")?.keys() ?? [])].sort();
}

describe("hosted legal registration", () => {
  it("registers all three legal leaves in the hosted environment", async () => {
    setHostedEnvironment(true);
    resetCommandDataCache();

    const { executionMap, registrationData } = await loadCommandData();

    expect(registeredLegalPaths(executionMap)).toEqual(["license", "privacy-policy", "terms-of-service"]);
    expect(registrationData.some((command) => command.name === "legal")).toBe(true);
  });

  it("keeps only the open-source license outside the hosted environment", async () => {
    setHostedEnvironment(false);
    resetCommandDataCache();

    const { executionMap, registrationData } = await loadCommandData();

    // The two policy leaves cite documents that bind the hosted instance alone, so a
    // self-hosted bot must not offer them; the license applies everywhere.
    expect(registeredLegalPaths(executionMap)).toEqual(["license"]);
    expect(registrationData.some((command) => command.name === "legal")).toBe(true);
  });

  it("keeps the license leaf reachable through the same gate it has always passed", async () => {
    setHostedEnvironment(false);
    resetCommandDataCache();

    const { executionMap } = await loadCommandData();

    // Asserting the routed execution key rather than the file name: `license.ts` is a filename
    // claim, and the key is what a client actually resolves.
    expect(typeof executionMap.get("legal")?.get("license")).toBe("function");
  });

  it("describes /legal by the leaves it actually registers", async () => {
    const rootDescription = async (): Promise<string> => {
      resetCommandDataCache();
      const { registrationData } = await loadCommandData();
      return registrationData.find((command) => command.name === "legal")?.description ?? "";
    };

    setHostedEnvironment(true);
    expect(await rootDescription()).toBe(localizer("en-US", "commands.legal.description"));

    setHostedEnvironment(false);
    const selfHostedDescription = await rootDescription();
    expect(selfHostedDescription).toBe(localizer("en-US", "commands.legal.license-only.description"));
    // The client renders this string beside a picker holding only `/legal license`, so naming
    // either policy document would advertise a leaf that is not there.
    expect(selfHostedDescription).not.toContain("Privacy Policy");
    expect(selfHostedDescription).not.toContain("terms of service");
  });

  it("resolves legal descriptions in both locales, not as raw keys", async () => {
    setHostedEnvironment(true);
    resetCommandDataCache();
    await loadCommandData();

    for (const leaf of ["terms-of-service", "privacy-policy", "license"]) {
      for (const locale of ["en-US", "ja"]) {
        const key = `commands.legal.${leaf}.description`;
        expect(localizer(locale, key)).not.toBe(key);
      }
    }
  });
});

describe("hosted policy notices", () => {
  it("renders the setup agreement notice in the help dashboard only when hosted", () => {
    const setupAgreement = localizer("en-US", "general.legal.setup_agreement");

    setHostedEnvironment(true);
    const hostedPayload = JSON.stringify(buildHelpDashboardPayload("en-US", "setup", "personal-profile"));
    expect(hostedPayload).toContain(setupAgreement);

    setHostedEnvironment(false);
    const selfHostedPayload = JSON.stringify(buildHelpDashboardPayload("en-US", "setup", "personal-profile"));
    expect(selfHostedPayload).not.toContain(setupAgreement);
    expect(selfHostedPayload).not.toContain("legal terms-of-service");
  });

  it("carries the guild welcome notice only when hosted", async () => {
    const { default: onGuildJoin } = await import("@/events/guildCreate/addBot");
    const policyReference = localizer("en-US", "general.legal.policy_reference");

    const guild = {
      id: "guild-1",
      name: "Test Guild",
      preferredLocale: "en-US",
      systemChannel: { name: "general" },
    } as unknown as Guild;

    const renderDescription = (): string => {
      const options = sentEmbeds[0];
      expect(options).toBeDefined();
      return localizer("en-US", options?.descriptionKey ?? "", options?.descriptionVars ?? {});
    };

    setHostedEnvironment(true);
    await onGuildJoin({} as unknown as Client, guild);
    expect(renderDescription()).toContain(policyReference);

    sentEmbeds.length = 0;
    setHostedEnvironment(false);
    await onGuildJoin({} as unknown as Client, guild);
    // The handler swallows a failed workspace read and sends the same embed, so the read count is
    // the only evidence that the controlled "no personas yet" answer is what produced this.
    expect(recordedServerIdReads()).toBeGreaterThan(0);
    expect(renderDescription()).toBe(localizer("en-US", "events.addBot.setup_prompt_description", { legalNotice: "" }));
  });
});
