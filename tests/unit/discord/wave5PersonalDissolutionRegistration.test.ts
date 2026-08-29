import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

describe("Wave 5 personal command dissolution", () => {
  it("leaves only the accepted personal panel destinations", async () => {
    const { executionMap } = await loadCommandData();
    const personal = executionMap.get("personal");

    expect(personal).toBeDefined();
    if (!personal) return;

    expect([...personal.keys()].sort()).toEqual(["config", "memories", "providers"]);
  }, 30000);

  it("dissolves personal memory CRUD while retaining transfer compatibility", async () => {
    const { executionMap } = await loadCommandData();
    const memory = executionMap.get("memory");

    expect(memory).toBeDefined();
    if (!memory) return;

    expect(memory.has("personal.add")).toBe(false);
    expect(memory.has("personal.edit")).toBe(false);
    expect(memory.has("personal.remove")).toBe(false);
    expect(memory.has("personal.import")).toBe(true);
    expect(memory.has("personal.export")).toBe(true);
  }, 30000);
});
