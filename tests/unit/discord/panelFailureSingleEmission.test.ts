import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Client, ModalSubmitInteraction } from "discord.js";
import {
  createModerationInteractionRoute,
  type ModerationRouteDependencies,
} from "@/utils/discord/interactions/moderationRoutes";
import { buildQuotaModalFieldId } from "@/utils/discord/moderationPanelCatalog";
import { moderationOperations, type ModerationScopeData } from "@/utils/moderation/moderationOperations";
import { log } from "@/utils/misc/logger";
import { initializeLocalizer } from "@/utils/text/localizer";

await initializeLocalizer();

interface RecordedMetric {
  name: string;
  fields: Record<string, number | string>;
}

function captureMetrics(): { metrics: RecordedMetric[]; restore(): void } {
  const metrics: RecordedMetric[] = [];
  const original = log.metric;
  log.metric = (name: string, fields: Record<string, number | string>) => {
    metrics.push({ name, fields });
  };
  return { metrics, restore: () => Object.assign(log, { metric: original }) };
}

function createScopeData(overrides: Partial<ModerationScopeData> = {}): ModerationScopeData {
  return {
    guildId: "guild-1",
    serverId: 1,
    readStatus: "fresh",
    memberAccess: {
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    },
    serverModelAccess: { allowServerModels: true },
    userBlacklist: {
      personalizationUserIds: [],
      personaBlocks: [],
      personalMemoriesEnabled: true,
    },
    whitelist: {
      channels: [],
      personaChannels: [],
      roles: [],
      personaNames: new Map(),
    },
    quotas: {
      image: { daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 30 },
      text: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
      video: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
    },
    ...overrides,
  };
}

/**
 * Drives a real route rather than calling `deliverGuardedPanel` directly.
 *
 * The chokepoint contract is only meaningful end to end: a route that both emits its own metric and
 * then repaints with a receipt would double-count, and that is invisible to a test that starts at
 * the delivery layer.
 */
async function submitQuotaEdit(
  route: ReturnType<typeof createModerationInteractionRoute>,
  nonce: string,
): Promise<void> {
  const interaction = {
    id: `modal-${nonce}`,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: `moderation:v1:quota-edit-submit:en-US:text:${nonce}`,
    guildId: "guild-1",
    memberPermissions: { has: () => true },
    deferUpdate: async () => undefined,
    editReply: async () => undefined,
    update: async () => undefined,
    fields: {
      getTextInputValue: (fieldId: string) => {
        if (fieldId === buildQuotaModalFieldId(nonce, "daily_user_quota")) return "20";
        if (fieldId === buildQuotaModalFieldId(nonce, "serverwide_quota")) return "500";
        if (fieldId === buildQuotaModalFieldId(nonce, "serverwide_quota_resets_in")) return "14";
        return "";
      },
    },
  } as unknown as ModalSubmitInteraction;

  await route.execute({} as Client, interaction, {
    namespace: "moderation",
    version: "v1",
    segments: ["quota-edit-submit", "en-US", "text", nonce],
  });
}

function quotaFailureRoute(): ReturnType<typeof createModerationInteractionRoute> {
  const dependencies: Partial<ModerationRouteDependencies> = {
    resolveScope: async () => createScopeData(),
    operations: {
      ...moderationOperations,
      updateQuotaSettings: async () => ({ status: "failed", quotaType: "text", error: new Error("db down") }),
    },
  };
  return createModerationInteractionRoute(dependencies);
}

describe("panel failure emission is exactly once per failure", () => {
  it("counts one panel_failure for a failed quota write, not one per emitter", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await submitQuotaEdit(quotaFailureRoute(), "nonceonce");

      const counted = metrics.filter((entry) => entry.name === "panel_failure");
      // Counted once, under the explicit reason the receipt carries, so a query joining on reason
      // agrees with the total.
      expect(counted).toHaveLength(1);
      expect(counted[0]?.fields.reason).toBe("quota_edit_failed");
      expect(counted[0]?.fields.namespace).toBe("moderation");
      expect(counted[0]?.fields.tone).toBe("error");
    } finally {
      restore();
    }
  });

  it("emits no panel_failure at all when the quota write succeeds", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        operations: {
          ...moderationOperations,
          updateQuotaSettings: async (input) => ({
            status: "success",
            quotaType: input.quotaType,
            appliedFields: ["daily_user_quota"],
          }),
        },
      });
      await submitQuotaEdit(route, "noncegood");

      expect(metrics.filter((entry) => entry.name === "panel_failure")).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("panel_failure has exactly one emitter", () => {
  /**
   * The chokepoint is only a chokepoint while nothing else emits the same metric.
   *
   * A route that emits its own `panel_failure` and then repaints with a receipt counts one failure
   * twice, under two different reason keys, and no unit test over `deliverGuardedPanel` can see it.
   * Guarding the invariant by source means a future call site cannot quietly revoke it, and detail
   * that a receipt cannot carry belongs under `panel_failure_detail` instead.
   */
  it('declares log.metric("panel_failure") in interactionCore.ts only', () => {
    const root = join(import.meta.dir, "..", "..", "..", "src");
    const emitters: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (readFileSync(full, "utf8").includes('log.metric("panel_failure"')) {
          emitters.push(full.slice(root.length + 1).replaceAll("\\", "/"));
        }
      }
    };
    walk(root);

    expect(emitters).toEqual(["utils/discord/ui/interactionCore.ts"]);
  });
});
