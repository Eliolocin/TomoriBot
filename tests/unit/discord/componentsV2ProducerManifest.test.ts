import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

type ProducerCoverage = { kind: "suite"; suites: string[] } | { kind: "delivery"; note: string };

export interface FixturedProducerManifestEntry {
  modulePath: string;
  builderName: string;
  coverage: ProducerCoverage;
}

export interface DeclaredProducerManifestEntry {
  modulePath: string;
  reason: string;
  coverage: ProducerCoverage;
}

export type ProducerManifestEntry = FixturedProducerManifestEntry | DeclaredProducerManifestEntry;

/**
 * Manifest of all modules producing Discord Components V2 payloads.
 *
 * Tier 1: Fixtured tier (the nine composed payload builders).
 * Tier 2: Declared tier (all other producers with explicit architectural reasons).
 */
export const COMPONENTS_V2_PRODUCER_MANIFEST: readonly ProducerManifestEntry[] = [
  {
    modulePath: "src/utils/discord/ui/configPanel.ts",
    builderName: "buildConfigPanelPayload",
    coverage: {
      kind: "suite",
      suites: ["tests/unit/discord/configPanel.test.ts", "tests/unit/discord/configPanelTextBudget.test.ts"],
    },
  },
  {
    modulePath: "src/utils/discord/ui/mcpsPanel.ts",
    builderName: "buildMcpsPanelPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/mcpsPanelLimits.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/memoriesPanel.ts",
    builderName: "buildMemoriesPanelPayload",
    coverage: {
      kind: "suite",
      suites: ["tests/unit/discord/memoriesPanelLimits.test.ts"],
    },
  },
  {
    modulePath: "src/utils/discord/ui/moderationPanel.ts",
    builderName: "buildModerationPanelPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/moderationPanelLimits.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/personalConfigPanel.ts",
    builderName: "buildPersonalConfigPanelPayload",
    coverage: {
      kind: "suite",
      suites: ["tests/unit/discord/personalConfigPanelLimits.test.ts"],
    },
  },
  {
    modulePath: "src/utils/discord/ui/personalMemoriesPanel.ts",
    builderName: "buildPersonalMemoriesPanelPayload",
    coverage: {
      kind: "suite",
      suites: ["tests/unit/discord/personalMemoriesPanelLimits.test.ts"],
    },
  },
  {
    modulePath: "src/utils/discord/ui/providersPanel.ts",
    builderName: "buildProvidersPanelPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/providersPanelLimits.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/stPresetsPanel.ts",
    builderName: "buildStPresetsPanelPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/stPresetsPanelLimits.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/helpDashboard.ts",
    builderName: "buildHelpDashboardPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/helpDashboardLimits.test.ts"] },
  },

  // --- Tier 2: Declared tier (19 non-panel or one-shot producers) ---
  {
    modulePath: "src/commands/persona/create.ts",
    reason: "Terminal persona creation flow message",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload; the private buildCreateResultPayload helper is not exported, so the command exports no payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/commands/persona/generate.ts",
    reason: "Terminal persona generation progress and result message",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload; the private buildGenerateResultPayload and status helpers are not exported, so the command exports no payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/expandableEmbedNotice.ts",
    reason: "One-shot expandable notice ephemeral message",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload; the notice builders and delivery payloads are private, so no exported payload builder is available to fixture.",
    },
  },
  {
    modulePath: "src/utils/discord/generatedImageMessage.ts",
    reason: "One-shot generated image action message",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/generatedVideoMessage.ts",
    reason: "One-shot generated video action message",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/interactions/configRouteContext.ts",
    reason: "Route context ephemeral notice and error messages for config",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/interactions/mcpsRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for MCPs",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/interactions/memoriesRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for memories",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/interactions/moderationRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for moderation",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/interactions/personalConfigRouteContext.ts",
    reason: "Route context ephemeral notice and error messages for personal config",
    builderName: "terminalPayload",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/interactions/personalMemoriesRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for personal memories",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/interactions/providersRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for providers",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/interactions/stPresetsRoutes.ts",
    reason: "Route ephemeral acknowledgement and notice messages for ST presets",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in terminalPayload; the route exports no terminal payload builder for a fixture to drive.",
    },
  },
  {
    modulePath: "src/utils/discord/ui/anchorModelFlow.ts",
    reason: "Anchor model setup flow step messages",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/interactionCore.ts",
    reason: "Core interaction error notices and terminal fallbacks",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/discord/ui/personaWorkflow.ts",
    reason: "Interactive persona workflow step messages",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
  {
    modulePath: "src/utils/metrics/status/personaPages.ts",
    reason: "Persona status metrics pages",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload in buildPersonaStatusPayload; the builder is private, so no exported payload builder is available to fixture.",
    },
  },
  {
    modulePath: "src/utils/persona/importNowButton.ts",
    reason: "One-shot import confirmation button message",
    coverage: {
      kind: "delivery",
      note: "Payloads are validated at construction by validateAndFallbackPanelPayload; collector payloads are assembled inline by attachImportNowCollector, so the module exports no payload builder.",
    },
  },
  {
    modulePath: "src/utils/stats/statsDashboard.ts",
    reason: "Stats dashboard message builder",
    coverage: { kind: "suite", suites: ["tests/unit/discord/componentsV2DeclaredProducerSmoke.test.ts"] },
  },
];

/**
 * Excluded from the producer manifest:
 * `src/utils/discord/ui/componentsV2Limits.ts` is the protocol validator asserting limits on
 * Components V2 payloads, not a producer of messages.
 */
const VALIDATOR_MODULE_PATH = "src/utils/discord/ui/componentsV2Limits.ts";

function scanComponentsV2Producers(dir: string): string[] {
  const results: string[] = [];
  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes("MessageFlags.IsComponentsV2")) {
          const relativePosix = fullPath
            .replace(process.cwd(), "")
            .replace(/^[/\\]+/, "")
            .replace(/\\/g, "/");
          results.push(relativePosix);
        }
      }
    }
  }
  walk(dir);
  return results;
}

describe("Components V2 Producer Manifest", () => {
  it("covers every module emitting MessageFlags.IsComponentsV2 with exact set equality", () => {
    const srcDir = join(process.cwd(), "src");
    const scannedModules = scanComponentsV2Producers(srcDir);

    // Subtract the validator module by name
    const producerScannedSet = new Set(scannedModules.filter((mod) => mod !== VALIDATOR_MODULE_PATH));
    const manifestSet = new Set(COMPONENTS_V2_PRODUCER_MANIFEST.map((entry) => entry.modulePath));

    // Wiring verification: assert a known module is present to prevent vacuous comparisons
    expect(producerScannedSet.has("src/utils/discord/ui/configPanel.ts")).toBe(true);
    expect(manifestSet.has("src/utils/discord/ui/configPanel.ts")).toBe(true);

    const extraInScan = [...producerScannedSet].filter((mod) => !manifestSet.has(mod));
    const extraInManifest = [...manifestSet].filter((mod) => !producerScannedSet.has(mod));

    expect(extraInScan).toEqual([]);
    expect(extraInManifest).toEqual([]);
  });

  it("ensures all named test suites exist on disk", async () => {
    for (const entry of COMPONENTS_V2_PRODUCER_MANIFEST) {
      if (entry.coverage.kind === "suite") {
        for (const suitePath of entry.coverage.suites) {
          const exists = await Bun.file(suitePath).exists();
          expect({ suitePath, exists }).toEqual({ suitePath, exists: true });
        }
      }
    }
  });

  it("requires suites for every fixtured producer", () => {
    const fixturedEntries = COMPONENTS_V2_PRODUCER_MANIFEST.filter(
      (entry): entry is FixturedProducerManifestEntry => "builderName" in entry,
    );
    expect(fixturedEntries.every((entry) => entry.coverage.kind === "suite")).toBe(true);
  });

  it("requires every delivery entry to explain its boundary", () => {
    const deliveryEntries = COMPONENTS_V2_PRODUCER_MANIFEST.filter((entry) => entry.coverage.kind === "delivery");
    expect(deliveryEntries.every((entry) => entry.coverage.note.trim().length > 0)).toBe(true);
  });
});
