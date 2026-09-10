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
  options?: CommandOption[];
};

type Leaf = { path: string; option: CommandOption };

const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;
const ATTACHMENT_TYPE = 11;
const BOT_DM_CONTEXT = 1;

/** The four leaves the fixed Wave 7 product boundary names. */
const EXPECTED_PATHS = ["export config", "export personal config", "import config", "import personal config"];

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

let commandData: LoadCommandDataResult;

beforeAll(async () => {
  await initializeLocalizer();
  commandData = await loadCommandData();
});

describe("transfer command registration", () => {
  it("registers both roots with exactly the four portable config leaves", () => {
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

  it("requires the attachment on both import leaves and on neither export leaf", () => {
    const exportRoot = findRoot(commandData.registrationData, "export");
    const importRoot = findRoot(commandData.registrationData, "import");
    if (!exportRoot || !importRoot) throw new Error("Transfer roots are not registered");

    const importLeaves = collectLeaves(importRoot);
    const exportLeaves = collectLeaves(exportRoot);
    expect(importLeaves.map((leaf) => leaf.path).sort()).toEqual(["import config", "import personal config"]);

    for (const leaf of importLeaves) {
      expect({ path: leaf.path, options: leaf.option.options }).toEqual({
        path: leaf.path,
        options: [expect.objectContaining({ name: "file", type: ATTACHMENT_TYPE, required: true })],
      });
    }
    for (const leaf of exportLeaves) {
      expect({ path: leaf.path, options: leaf.option.options }).toEqual({ path: leaf.path, options: [] });
    }
  });

  it("maps both roots onto their execution keys", () => {
    const exportMap = commandData.executionMap.get("export");
    const importMap = commandData.executionMap.get("import");
    expect([...(exportMap?.keys() ?? [])].sort()).toEqual(["config", "personal.config"]);
    expect([...(importMap?.keys() ?? [])].sort()).toEqual(["config", "personal.config"]);
  });

  it("excludes both shared operation helpers from registration", async () => {
    const helperFiles = [
      { commandFile: "src/commands/export/configExportOperation.ts", categoryName: "export" },
      { commandFile: "src/commands/import/configImportOperation.ts", categoryName: "import" },
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
