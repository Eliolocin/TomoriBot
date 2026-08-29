/**
 * `/memories` absorbs leaves from two roots with opposite registration shapes, and the resulting
 * permission is the one thing an implementation summary can describe correctly while being wrong.
 * `memory server add` is reachable to non-managers today under `server_memteaching_enabled`, while
 * `server stm manage` is manager-only purely because it sits under the `server` category. The three
 * sibling panels this slice mirrors (`/providers`, `/mcps`, `/st-presets`) all export
 * `managerOnly = true`, so copying one of them would silently remove teaching from every non-manager
 * in every guild with nothing failing. This gate lives outside the implementation slice for that
 * reason: the manager check for the Short-Term category belongs in the route layer, not in the
 * command's registration.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

describe("Wave 5 /memories registration restrictions", () => {
  it("registers /memories with no manager default and no context restriction", async () => {
    const { registrationData } = await loadCommandData();
    const memories = findRegistration(registrationData, "memories");

    expect(memories).toBeDefined();
    if (!memories) return;

    expect(memories.default_member_permissions).toBeUndefined();
    expect(memories.contexts).toBeUndefined();
  }, 30000);

  it("keeps /memories a bare root", async () => {
    const { executionMap } = await loadCommandData();

    expect([...(executionMap.get("memories")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
  }, 30000);

  it("leaves the legacy workspace memory leaves reachable while the panel coexists", async () => {
    const { executionMap } = await loadCommandData();
    const memory = executionMap.get("memory");
    const server = executionMap.get("server");

    expect(memory).toBeDefined();
    expect(server).toBeDefined();
    if (!memory || !server) return;

    for (const key of ["server.add", "server.edit", "server.remove", "server.vectorize"]) {
      expect(memory.has(key)).toBe(true);
    }
    for (const key of ["document.add", "document.remove", "document.view", "history.remove"]) {
      expect(memory.has(key)).toBe(true);
    }
    expect(server.has("stm.manage")).toBe(true);
  }, 30000);
});
