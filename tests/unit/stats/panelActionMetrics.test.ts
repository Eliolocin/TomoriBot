import { beforeEach, describe, expect, it } from "bun:test";
import type { RecordStatInput } from "@/utils/db/repositories/StatRepository";
import { log } from "@/utils/misc/logger";
import {
  recordPanelActionStat,
  resetPanelActionFailureReporting,
  type PanelActionMetricsDependencies,
  type RecordPanelActionInput,
} from "@/utils/stats/panelActionMetrics";

describe("recordPanelActionStat", () => {
  it("skips recording when serverId or userDiscId is missing", async () => {
    let loadCalled = false;
    let recordCalled = false;

    const deps: PanelActionMetricsDependencies = {
      loadUserRow: async () => {
        loadCalled = true;
        return { user_id: 10 };
      },
      record: () => {
        recordCalled = true;
      },
    };

    await recordPanelActionStat({ action: "mcps.workspace.server.add", serverId: 0, userDiscId: "123" }, deps);
    expect(loadCalled).toBe(false);
    expect(recordCalled).toBe(false);

    await recordPanelActionStat({ action: "mcps.workspace.server.add", serverId: 1, userDiscId: "" }, deps);
    expect(loadCalled).toBe(false);
    expect(recordCalled).toBe(false);
  });

  it("skips recording when user cannot be resolved from cache or database", async () => {
    let recordedInput: RecordStatInput | null = null;

    const deps: PanelActionMetricsDependencies = {
      loadUserRow: async () => null,
      record: (input) => {
        recordedInput = input;
      },
    };

    await recordPanelActionStat(
      { action: "providers.workspace.provider.add", serverId: 2, userDiscId: "unknown-user" },
      deps,
    );

    expect(recordedInput).toBeNull();

    const depsMissingUserId: PanelActionMetricsDependencies = {
      loadUserRow: async () => ({ user_id: undefined }),
      record: (input) => {
        recordedInput = input;
      },
    };

    await recordPanelActionStat(
      { action: "providers.workspace.provider.add", serverId: 2, userDiscId: "user-no-id" },
      depsMissingUserId,
    );

    expect(recordedInput).toBeNull();
  });

  it("records panel_action stat with resolved user id and action key", async () => {
    let recordedInput: RecordStatInput | null = null;

    const deps: PanelActionMetricsDependencies = {
      loadUserRow: async (discId) => (discId === "user-snowflake-1" ? { user_id: 42 } : null),
      record: (input) => {
        recordedInput = input;
      },
    };

    const input: RecordPanelActionInput = {
      action: "moderation.workspace.member-access.set",
      serverId: 7,
      userDiscId: "user-snowflake-1",
    };

    await recordPanelActionStat(input, deps);

    expect(recordedInput).toEqual({
      serverId: 7,
      userId: 42,
      metric: "panel_action",
      metricKey: "moderation.workspace.member-access.set",
    });
  });

  it("never throws or rejects when recording dependency raises an error", async () => {
    const deps: PanelActionMetricsDependencies = {
      loadUserRow: async () => {
        throw new Error("Simulated database failure");
      },
      record: () => {},
    };

    expect(
      recordPanelActionStat({ action: "st-presets.workspace.preset.add", serverId: 1, userDiscId: "user-1" }, deps),
    ).resolves.toBeUndefined();
  });
});

describe("panel_action failure reporting", () => {
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

  const failingDeps: PanelActionMetricsDependencies = {
    loadUserRow: async () => {
      throw new Error("pool retired");
    },
    record: () => {},
  };

  const action = "moderation.workspace.member-access.set";

  beforeEach(() => {
    resetPanelActionFailureReporting();
  });

  it("reports a failed counter write where production can see it", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await recordPanelActionStat({ action, serverId: 1, userDiscId: "user-1" }, failingDeps);

      // Not log.warn, which production's level: "error" pin drops before either sink. A silently
      // dead success counter previously left no trace anywhere.
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.name).toBe("panel_action_failure");
      expect(metrics[0]?.fields.reason).toBe("panel_action_stat_write_failed");
      expect(metrics[0]?.fields.action).toBe(action);
    } finally {
      restore();
    }
  });

  it("reports once per outage rather than once per panel action", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      for (let index = 0; index < 5; index++) {
        await recordPanelActionStat({ action, serverId: 1, userDiscId: "user-1" }, failingDeps);
      }
      expect(metrics).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("re-arms reporting after a write gets far enough to be recorded", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await recordPanelActionStat({ action, serverId: 1, userDiscId: "user-1" }, failingDeps);
      expect(metrics).toHaveLength(1);

      // A second outage after a recovery is a new incident and must be reported again.
      await recordPanelActionStat(
        { action, serverId: 1, userDiscId: "user-1" },
        { loadUserRow: async () => ({ user_id: 9 }), record: () => {} },
      );
      await recordPanelActionStat({ action, serverId: 1, userDiscId: "user-1" }, failingDeps);

      expect(metrics).toHaveLength(2);
    } finally {
      restore();
    }
  });
});
