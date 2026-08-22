/**
 * Quota settings moved from three `/server quota` leaves into the `/moderation` Quotas page.
 * This gate lives outside the implementation slices so a later change cannot quietly re-register
 * a second editor for the same settings, and so the surviving reset leaf keeps its own path until
 * the `/quota` work moves it deliberately.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("quota settings dissolution", () => {
  it("leaves reset as the only surviving /server quota leaf", async () => {
    const { executionMap } = await loadCommandData();
    const server = executionMap.get("server");

    expect(server).toBeDefined();
    if (!server) return;

    expect([...server.keys()].filter((key) => key.startsWith("quota.")).sort()).toEqual(["quota.reset"]);
  });

  it("keeps the Quotas page off the registered command surface", async () => {
    const { executionMap, registrationData } = await loadCommandData();
    const totalCommands = [...executionMap.values()].reduce((sum, leaves) => sum + leaves.size, 0);

    expect(registrationData.length).toBe(41);
    expect(totalCommands).toBe(213);
    expect(executionMap.get("moderation")?.size).toBe(1);
  });
});
