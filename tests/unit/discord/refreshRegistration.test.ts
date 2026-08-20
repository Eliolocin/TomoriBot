/**
 * `/tool refresh` became the bare root `/refresh`. `tool` sits in neither restriction list, so the
 * move must add no restriction, and the old leaf must be gone rather than coexisting.
 *
 * The reset marker is the reason this move is not cosmetic: three subsystems compare a live embed
 * title against `commands.refresh.title`, so the key must resolve and its text must be unchanged.
 * `embedClassifier.test.ts` covers the classification itself; this file covers registration.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  description?: string;
  contexts?: number[];
  default_member_permissions?: string;
};

describe("/refresh registration", () => {
  it("registers as an unrestricted bare root", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const refreshCommand = registrationData.find((cmd) => cmd.name === "refresh") as unknown as
      | RegistrationPayload
      | undefined;

    expect(refreshCommand).toBeDefined();
    if (!refreshCommand) return;

    expect(refreshCommand.contexts).toBeUndefined();
    expect(refreshCommand.default_member_permissions).toBeUndefined();
    expect(executionMap.get("refresh")?.has(ROOT_COMMAND_EXECUTION_KEY)).toBe(true);
  });

  it("removes the old /tool refresh leaf while /tool keeps its other members", async () => {
    const { executionMap } = await loadCommandData();

    const toolCommands = executionMap.get("tool");
    expect(toolCommands).toBeDefined();
    if (!toolCommands) return;

    expect(toolCommands.has("refresh")).toBe(false);
    expect(toolCommands.size).toBeGreaterThan(0);
  });

  it("keeps the reset-marker title resolvable in both locales", async () => {
    // Three subsystems compare a stored embed title against this string. An unresolved key would
    // return the key path itself, which matches no historical embed and silently stops resets.
    for (const locale of ["en-US", "ja"]) {
      const title = localizer(locale, "commands.refresh.title");
      expect(title).not.toBe("commands.refresh.title");
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
