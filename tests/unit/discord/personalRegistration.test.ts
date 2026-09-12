import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("/personal registration", () => {
  it("leaves only the accepted personal leaves", async () => {
    const { executionMap } = await loadCommandData();
    const personal = executionMap.get("personal");

    expect(personal).toBeDefined();
    if (!personal) return;

    // `nuke` is the erasure route the Privacy Policy names, so it must stay registered.
    expect([...personal.keys()].sort()).toEqual(["config", "memories", "nuke", "providers"]);
  }, 30000);

  // `/memory` is dissolved outright: its transfer leaves moved to /export and /import, leaving no
  // enabled subcommand behind. Dissolution is asserted by root in configRegistration's DISSOLVED_ROOTS,
  // so this file does not restate it.
});
