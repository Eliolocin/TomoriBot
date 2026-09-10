import { beforeAll, describe, expect, it } from "bun:test";
import type { ApplicationCommandData } from "discord.js";
import {
  isCommandModuleEnabledForRegistration,
  loadCommandData,
  type LoadCommandDataResult,
} from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

type CommandOption = {
  name?: string;
  type?: number;
  required?: boolean;
  autocomplete?: boolean;
  choices?: Array<{ name?: string; value?: string }>;
  options?: CommandOption[];
};

type Leaf = { path: string; option: CommandOption };

const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;
const STRING_TYPE = 3;
const ATTACHMENT_TYPE = 11;
const BOT_DM_CONTEXT = 1;

/** The eight leaves the fixed Wave 7 product boundary names. */
const EXPECTED_PATHS = [
  "export config",
  "export memories",
  "export personal config",
  "export personal memories",
  "import config",
  "import memories",
  "import personal config",
  "import personal memories",
];

function findRoot(registrationData: ApplicationCommandData[], name: string): ApplicationCommandData | undefined {
  return registrationData.find((command) => command.name === name);
}

function collectLeaves(root: ApplicationCommandData): Leaf[] {
  const leaves: Leaf[] = [];
  for (const option of (root.options ?? []) as CommandOption[]) {
    if (option.type === SUBCOMMAND_TYPE && option.name) {
      leaves.push({ path: `${root.name} ${option.name}`, option });
      continue;
    }
    if (option.type !== SUBCOMMAND_GROUP_TYPE || !option.name) continue;
    for (const subcommand of option.options ?? []) {
      if (subcommand.type !== SUBCOMMAND_TYPE || !subcommand.name) continue;
      leaves.push({ path: `${root.name} ${option.name} ${subcommand.name}`, option: subcommand });
    }
  }
  return leaves;
}

function findLeaf(leaves: Leaf[], path: string): Leaf {
  const leaf = leaves.find((candidate) => candidate.path === path);
  if (!leaf) throw new Error(`Leaf ${path} is not registered`);
  return leaf;
}

let commandData: LoadCommandDataResult;

beforeAll(async () => {
  await initializeLocalizer();
  commandData = await loadCommandData();
});

describe("transfer command registration", () => {
  it("registers both roots with exactly the eight portable transfer leaves", () => {
    const exportRoot = findRoot(commandData.registrationData, "export");
    const importRoot = findRoot(commandData.registrationData, "import");
    expect(exportRoot).toBeDefined();
    expect(importRoot).toBeDefined();
    if (!exportRoot || !importRoot) throw new Error("Transfer roots are not registered");

    const paths = [...collectLeaves(exportRoot), ...collectLeaves(importRoot)].map((leaf) => leaf.path).sort();
    expect(paths).toEqual([...EXPECTED_PATHS].sort());
  });

  it("carries no blanket Manage Server permission and stays reachable from a DM", () => {
    for (const rootName of ["export", "import"]) {
      const root = findRoot(commandData.registrationData, rootName);
      if (!root) throw new Error(`/${rootName} is not registered`);
      // Both roots host a user-owned personal group, so a root-level Manage Server default would hide it from the
      // members who own it. Each workspace leaf performs its own runtime authorization instead.
      expect({ rootName, permissions: root.default_member_permissions }).toEqual({
        rootName,
        permissions: undefined,
      });
      const contexts = (root as { contexts?: number[] }).contexts;
      expect({ rootName, allowsDm: contexts === undefined || contexts.includes(BOT_DM_CONTEXT) }).toEqual({
        rootName,
        allowsDm: true,
      });
    }
  });

  it("requires the attachment on every import leaf and on neither export config leaf", () => {
    const exportRoot = findRoot(commandData.registrationData, "export");
    const importRoot = findRoot(commandData.registrationData, "import");
    if (!exportRoot || !importRoot) throw new Error("Transfer roots are not registered");

    const exportLeaves = collectLeaves(exportRoot);
    const importLeaves = collectLeaves(importRoot);

    for (const leaf of importLeaves) {
      expect({ path: leaf.path, options: leaf.option.options }).toEqual({
        path: leaf.path,
        options: [expect.objectContaining({ name: "file", type: ATTACHMENT_TYPE, required: true })],
      });
    }
    for (const path of ["export config", "export personal config"]) {
      expect({ path, options: findLeaf(exportLeaves, path).option.options }).toEqual({ path, options: [] });
    }
  });

  it("declares a required scope choice and an optional autocomplete persona on both memory export leaves", () => {
    const exportRoot = findRoot(commandData.registrationData, "export");
    if (!exportRoot) throw new Error("/export is not registered");
    const leaves = collectLeaves(exportRoot);

    const expectedChoiceValues: Record<string, string[]> = {
      "export memories": ["main", "persona", "all"],
      "export personal memories": ["global", "persona", "all"],
    };

    for (const [path, choiceValues] of Object.entries(expectedChoiceValues)) {
      const options = findLeaf(leaves, path).option.options ?? [];
      expect({ path, options: options.map((option) => option.name) }).toEqual({ path, options: ["scope", "persona"] });

      const [scopeOption, personaOption] = options;
      expect({ path, type: scopeOption?.type, required: scopeOption?.required }).toEqual({
        path,
        type: STRING_TYPE,
        required: true,
      });
      expect({ path, choices: (scopeOption?.choices ?? []).map((choice) => choice.value) }).toEqual({
        path,
        choices: choiceValues,
      });
      // A missing choice label would register the locale key itself as the option's name.
      for (const choice of scopeOption?.choices ?? []) {
        expect({ path, value: choice.value, unresolved: choice.name?.startsWith("commands.") ?? false }).toEqual({
          path,
          value: choice.value,
          unresolved: false,
        });
      }
      expect({ path, type: personaOption?.type, required: personaOption?.required ?? false }).toEqual({
        path,
        type: STRING_TYPE,
        required: false,
      });
      expect({ path, autocomplete: personaOption?.autocomplete }).toEqual({ path, autocomplete: true });
    }
  });

  it("maps both roots onto their execution keys", () => {
    const exportMap = commandData.executionMap.get("export");
    const importMap = commandData.executionMap.get("import");
    expect([...(exportMap?.keys() ?? [])].sort()).toEqual([
      "config",
      "memories",
      "personal.config",
      "personal.memories",
    ]);
    expect([...(importMap?.keys() ?? [])].sort()).toEqual([
      "config",
      "memories",
      "personal.config",
      "personal.memories",
    ]);
  });

  it("registers the persona autocomplete handler under both memory export leaves", () => {
    const exportHandlers = commandData.autocompleteMap.get("export");
    expect(exportHandlers).toBeDefined();
    expect(typeof exportHandlers?.get("memories")).toBe("function");
    expect(typeof exportHandlers?.get("personal.memories")).toBe("function");
    // The config leaves declare no autocomplete option, so a handler there would be unreachable wiring.
    expect(exportHandlers?.get("config")).toBeUndefined();
    expect(exportHandlers?.get("personal.config")).toBeUndefined();
  });

  it("excludes every shared operation helper from registration", async () => {
    const helperFiles = [
      { commandFile: "src/commands/export/configExportOperation.ts", categoryName: "export" },
      { commandFile: "src/commands/export/memoriesExportOperation.ts", categoryName: "export" },
      { commandFile: "src/commands/import/configImportOperation.ts", categoryName: "import" },
      { commandFile: "src/commands/import/memoriesImportOperation.ts", categoryName: "import" },
    ];

    for (const helper of helperFiles) {
      const loadedModule = await import(`@/${helper.commandFile.replace("src/", "")}`);
      // Asserted through the loader's own gate rather than by re-reading the module: without this flag the loader
      // logs "missing required exports" for a helper that is intentionally not a leaf.
      const enabled = await isCommandModuleEnabledForRegistration(loadedModule, {
        commandFile: helper.commandFile,
        commandKind: "flat",
        categoryName: helper.categoryName,
      });
      expect({ helper: helper.commandFile, enabled }).toEqual({ helper: helper.commandFile, enabled: false });
    }
  });
});
