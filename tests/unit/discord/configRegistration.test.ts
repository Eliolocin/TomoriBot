/**
 * `/config` registers as a bare executable root with no default member permission, so every
 * absorbed operation is authorized by its panel route alone. The loader skips a root file while a
 * same-named directory owns the definition, which is why the registration and the directory
 * dissolution had to land together.
 *
 * Dissolution is asserted per former root and key. A whole-tree command count would fail on every
 * unrelated wave and pressure a later slice into editing a gate it does not own.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: unknown[];
};

/** Executable keys absorbed into the panel, grouped by the root that used to expose them. */
const ABSORBED_KEYS_BY_ROOT: Record<string, readonly string[]> = {
  persona: [
    "avatar",
    "rename",
    "naming-habits",
    "swap",
    "image-tags",
    "attribute.add",
    "attribute.edit",
    "attribute.remove",
    "sample-dialogue.add",
    "sample-dialogue.edit",
    "sample-dialogue.remove",
    "trigger.add",
    "trigger.remove",
    "stm.view",
    "stm.edit",
    "prompt.set",
    "prompt.remove",
    "sprites.add",
    "sprites.edit",
    "sprites.import",
    "sprites.export",
    "sprites.remove",
  ],
  model: [
    "text",
    "vision",
    "embedding",
    "image",
    "video",
    "parameters",
    "fallback",
    "speech",
    "transcription",
    "stop-strings.add",
    "stop-strings.manage",
    "logit-bias.add",
    "logit-bias.remove",
    "logit-bias.upload",
  ],
  server: [
    "always-reply",
    "timezone",
    "channel-prompt",
    "crosschannel-blocklist",
    "private-channels",
    "rp-channels",
    "thought-logs-channel",
    "deliberate-trigger-mode",
    "deliberate-tool-mode",
    "deliberate-tool-context",
    "deliberate-tool-trigger",
    "auto-trigger.channels",
    "auto-trigger.threshold",
    "cooldown.triggers",
    "stm.parameters",
    "stm.categories-edit",
    "stm.prompt-edit",
    "stm.privacy-bypass",
    "welcome-channel.set",
    "welcome-channel.remove",
    "config.remove",
  ],
  memory: ["tagging.set"],
  speech: ["transcripts"],
  novelai: ["attg", "character-reference", "image.parameters"],
  tool: ["status"],
};

/** Roots the cutover removed outright, rather than reducing to a retained remainder. */
const DISSOLVED_ROOTS = ["capabilities", "speech"];

/** Explicitly retained leaves, including the aggregate views the panel deliberately does not absorb. */
const RETAINED_KEYS_BY_ROOT: Record<string, readonly string[]> = {
  persona: ["create", "default", "export", "generate", "import", "remove"],
  model: ["override.remove"],
  server: ["config.export", "config.import"],
  conditioning: ["manage", "remove"],
  tool: ["delete.turn", "estimate.cost", "prompt.snapshot", "visualize"],
  memory: ["personal.export", "personal.import", "server.export", "server.import"],
  novelai: ["generate.image", "preset.text"],
};

describe("Config command registration", () => {
  it("retains /model override remove with its manager permission", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const modelCommand = registrationData.find((command) => command.name === "model") as unknown as
      | RegistrationPayload
      | undefined;

    expect(modelCommand).toBeDefined();
    if (!modelCommand) return;

    expect(modelCommand.contexts).toBeUndefined();
    expect(modelCommand.default_member_permissions).toBe("32");
    expect([...(executionMap.get("model") ?? new Map()).keys()]).toContain("override.remove");
  });

  it("registers /config as a bare root with no contexts and no default member permission", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    const configCommand = registrationData.find((command) => command.name === "config") as unknown as
      | RegistrationPayload
      | undefined;

    expect(configCommand).toBeDefined();
    if (!configCommand) return;

    // Undefined rather than "0": the panel filters per actor, so Discord must show the command to
    // every member and let the routes decide. A blanket permission would hide the member surface.
    expect(configCommand.default_member_permissions).toBeUndefined();
    // Undefined contexts keeps the DM-backed workspace reachable.
    expect(configCommand.contexts).toBeUndefined();
    expect(configCommand.options ?? []).toHaveLength(0);

    expect([...(executionMap.get("config") ?? new Map()).keys()]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
  });

  it("keeps the discovery vocabulary in the bare root description", async () => {
    const { registrationData } = await loadCommandData();
    const description = (
      registrationData.find((command) => command.name === "config") as unknown as { description?: string } | undefined
    )?.description?.toLowerCase();

    expect(description).toBeDefined();
    for (const term of ["config", "setting", "persona", "behavior", "channel", "permission", "model"]) {
      expect(description).toContain(term);
    }
  });

  it("removes every absorbed key from its former root", async () => {
    const { executionMap } = await loadCommandData();

    for (const [root, keys] of Object.entries(ABSORBED_KEYS_BY_ROOT)) {
      const present = [...(executionMap.get(root) ?? new Map()).keys()];
      expect({ root, survivors: keys.filter((key) => present.includes(key)) }).toEqual({ root, survivors: [] });
    }
  });

  it("removes the roots the cutover dissolved outright", async () => {
    const { executionMap, registrationData } = await loadCommandData();

    for (const root of DISSOLVED_ROOTS) {
      expect(executionMap.has(root)).toBe(false);
      expect(registrationData.some((command) => command.name === root)).toBe(false);
    }
  });

  it("preserves every retained key, including the aggregate views", async () => {
    const { executionMap } = await loadCommandData();

    for (const [root, keys] of Object.entries(RETAINED_KEYS_BY_ROOT)) {
      const present = [...(executionMap.get(root) ?? new Map()).keys()];
      expect({ root, missing: keys.filter((key) => !present.includes(key)) }).toEqual({ root, missing: [] });
    }
  });
});
