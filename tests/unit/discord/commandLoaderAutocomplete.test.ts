/**
 * The loader registers `autocomplete` exports into a map parallel to `executionMap`. The two are
 * built at the same three sites from the same execution-key derivation, so the risk this covers is
 * them drifting apart: a command whose handler is reachable but whose autocomplete is not, or a key
 * registered under a path Discord will never send.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

let commandDataCache: Awaited<ReturnType<typeof loadCommandData>> | null = null;
async function getLoadedCommandData() {
  if (!commandDataCache) {
    commandDataCache = await loadCommandData();
  }
  return commandDataCache;
}

const PUNISH_ACTIONS = ["bite", "bonk", "pinch", "spank", "squeeze"];
const REWARD_ACTIONS = ["feed", "headpat", "hug", "kiss", "tickle"];

describe("commandLoader autocomplete registration", () => {
  it("registers an autocomplete handler for every conditioning action", async () => {
    const { autocompleteMap } = await getLoadedCommandData();

    const punishHandlers = autocompleteMap.get("punish");
    const rewardHandlers = autocompleteMap.get("reward");

    expect(punishHandlers).toBeDefined();
    expect(rewardHandlers).toBeDefined();
    if (!punishHandlers || !rewardHandlers) return;

    for (const action of PUNISH_ACTIONS) {
      expect(typeof punishHandlers.get(action)).toBe("function");
    }
    for (const action of REWARD_ACTIONS) {
      expect(typeof rewardHandlers.get(action)).toBe("function");
    }
  });

  it("keys autocomplete handlers identically to their execute handlers", async () => {
    const { autocompleteMap, executionMap } = await getLoadedCommandData();

    for (const [categoryName, handlers] of autocompleteMap) {
      const executionHandlers = executionMap.get(categoryName);
      expect(executionHandlers).toBeDefined();
      if (!executionHandlers) continue;

      for (const executionKey of handlers.keys()) {
        expect(executionHandlers.has(executionKey)).toBe(true);
      }
    }
  });

  it("omits commands that export no autocomplete handler", async () => {
    const { autocompleteMap, executionMap } = await getLoadedCommandData();

    // The loader mirrors executionMap's category structure, so the meaningful assertion is that
    // a command declaring no autocomplete export contributes no handler.
    expect(executionMap.has("ping")).toBe(true);
    expect(autocompleteMap.get("ping")?.size ?? 0).toBe(0);
  });
});

describe("conditioning persona option registration", () => {
  it("declares an optional autocomplete persona option on every conditioning leaf", async () => {
    const { registrationData } = await getLoadedCommandData();

    type OptionPayload = { name?: string; required?: boolean; autocomplete?: boolean };
    type SubcommandPayload = { name?: string; options?: OptionPayload[] };

    for (const [root, actions] of [
      ["punish", PUNISH_ACTIONS],
      ["reward", REWARD_ACTIONS],
    ] as const) {
      const command = registrationData.find((entry) => entry.name === root) as unknown as
        | { options?: SubcommandPayload[] }
        | undefined;
      expect(command).toBeDefined();
      if (!command) continue;

      for (const action of actions) {
        const subcommand = command.options?.find((option) => option.name === action);
        expect(subcommand).toBeDefined();

        const personaOption = subcommand?.options?.find((option) => option.name === "persona");
        expect(personaOption).toBeDefined();
        expect(personaOption?.required ?? false).toBe(false);
        expect(personaOption?.autocomplete).toBe(true);
      }
    }
  });
});

describe("stats persona option and autocomplete registration", () => {
  it("registers an autocomplete handler at stats/persona reachable via autocompleteMap", async () => {
    const { autocompleteMap } = await getLoadedCommandData();

    const statsHandlers = autocompleteMap.get("stats");
    expect(statsHandlers).toBeDefined();
    expect(typeof statsHandlers?.get("persona")).toBe("function");
  });

  it("declares required autocomplete persona first and optional timeframe second", async () => {
    const { registrationData } = await getLoadedCommandData();

    type OptionPayload = { name?: string; required?: boolean; autocomplete?: boolean };
    type SubcommandPayload = { name?: string; options?: OptionPayload[] };

    const statsCommand = registrationData.find((entry) => entry.name === "stats") as unknown as
      | { options?: SubcommandPayload[] }
      | undefined;
    expect(statsCommand).toBeDefined();

    const personaSubcommand = statsCommand?.options?.find((option) => option.name === "persona");
    expect(personaSubcommand).toBeDefined();

    const options = personaSubcommand?.options ?? [];
    expect(options.length).toBe(2);

    const [firstOption, secondOption] = options;
    expect(firstOption.name).toBe("persona");
    expect(firstOption.required).toBe(true);
    expect(firstOption.autocomplete).toBe(true);

    expect(secondOption.name).toBe("timeframe");
    expect(secondOption.required ?? false).toBe(false);
  });
});
