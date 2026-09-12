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

  // The legacy `/memory` root this Wave 5 slice partially dissolved (personal CRUD gone, transfer
  // leaves kept) is now gone outright: the transfer leaves it retained moved to /export and /import
  // in Wave 7, leaving no enabled subcommand behind. Full dissolution of a root is asserted once, for
  // every such root, by configRegistration.test.ts's DISSOLVED_ROOTS list, so this file no longer
  // restates it.
});
