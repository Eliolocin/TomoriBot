import { describe, expect, it } from "bun:test";
import type { RecordStatInput } from "@/utils/db/repositories/StatRepository";
import {
  recordPanelActionStat,
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
