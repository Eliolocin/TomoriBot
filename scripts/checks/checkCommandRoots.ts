import { join } from "node:path";

export const COMMAND_SYSTEM_DOC_PATH = join(
  process.cwd(),
  "docs",
  "en",
  "architecture",
  "subsystems",
  "command-system.md",
);

export function parseDocumentedRoots(markdown: string): string[] {
  const sectionHeading = "## Current Top-Level Categories";
  const sectionIndex = markdown.indexOf(sectionHeading);
  if (sectionIndex === -1) {
    return [];
  }

  const afterSection = markdown.slice(sectionIndex + sectionHeading.length);
  const nextHeadingIndex = afterSection.search(/\n##\s/);
  const sectionContent = nextHeadingIndex !== -1 ? afterSection.slice(0, nextHeadingIndex) : afterSection;

  const roots: string[] = [];
  for (const line of sectionContent.split(/\r?\n/)) {
    const match = line.match(/^-\s+`([^`]+)`/);
    if (match) {
      roots.push(match[1]);
    }
  }

  return roots;
}

export function compareRoots(
  documentedRoots: readonly string[],
  runtimeRoots: readonly string[],
): {
  ok: boolean;
  missingInDoc: string[];
  unexpectedInDoc: string[];
  outOfOrder: boolean;
} {
  const documentedSet = new Set(documentedRoots);
  const runtimeSet = new Set(runtimeRoots);

  const missingInDoc = runtimeRoots.filter((root) => !documentedSet.has(root));
  const unexpectedInDoc = documentedRoots.filter((root) => !runtimeSet.has(root));

  let outOfOrder = false;
  if (missingInDoc.length === 0 && unexpectedInDoc.length === 0) {
    for (let index = 0; index < runtimeRoots.length; index++) {
      if (documentedRoots[index] !== runtimeRoots[index]) {
        outOfOrder = true;
        break;
      }
    }
  }

  const ok = missingInDoc.length === 0 && unexpectedInDoc.length === 0 && !outOfOrder;
  return { ok, missingInDoc, unexpectedInDoc, outOfOrder };
}

export async function collectRuntimeRoots(): Promise<string[]> {
  const { collectValidCommandPaths } = await import("../lib/commandReference");
  const paths = await collectValidCommandPaths();
  const roots = new Set<string>();

  for (const path of paths) {
    const root = path.split(" ")[0];
    if (root) {
      roots.add(root);
    }
  }

  return [...roots].sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  process.env.RUN_ENV = "production";

  const currentDoc = await Bun.file(COMMAND_SYSTEM_DOC_PATH).text();
  const documentedRoots = parseDocumentedRoots(currentDoc);
  const runtimeRoots = await collectRuntimeRoots();

  const comparison = compareRoots(documentedRoots, runtimeRoots);

  if (comparison.ok) {
    console.log(`Command roots documentation OK (${runtimeRoots.length} roots match runtime registration)`);
    // Loading the command graph leaves an open handle, so a run that falls off the end of main() never
    // exits. The failure branch exits explicitly, and the success branch must too to prevent runner hangs.
    process.exit(0);
  }

  console.error(
    "Command roots documented in docs/en/architecture/subsystems/command-system.md drifted from runtime registration.",
  );
  if (comparison.missingInDoc.length > 0) {
    console.error(`  Missing from docs (${comparison.missingInDoc.length}): ${comparison.missingInDoc.join(", ")}`);
  }
  if (comparison.unexpectedInDoc.length > 0) {
    console.error(`  Unexpected in docs (${comparison.unexpectedInDoc.length}): ${comparison.unexpectedInDoc.join(", ")}`);
  }
  if (comparison.outOfOrder) {
    console.error("  Documented roots are not in alphabetical order matching registration.");
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
