import { join } from "node:path";
import { Glob } from "bun";

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  if (positionalArgs.length !== 2) {
    console.error("Usage: bun run rename-command-path <old> <new> [--apply]");
    process.exit(1);
  }

  const [oldPath, newPath] = positionalArgs;
  console.log(`Renaming command path: /${oldPath} -> /${newPath}`);
  console.log(apply ? "Mode: APPLY (writing changes)" : "Mode: DRY-RUN (no changes will be written)");

  // Both boundaries are load-bearing. Without the lookbehind, a single-word rename such as
  // "memory" to "memories" also rewrites the /memory segment inside documented source paths
  // (src/commands/memory/personal/export.ts) and inside URLs, because the following character
  // is a slash. A command mention in prose is only ever preceded by whitespace, a backtick,
  // a quote, or a bracket, never by an identifier character, a slash, or a dot.
  const oldPathRegex = new RegExp(`(?<![A-Za-z0-9_./-])(/${escapeRegExp(oldPath)})(?![a-zA-Z0-9_-])`, "g");

  const docGlobs = [
    { pattern: "**/*.ts", root: join(process.cwd(), "src", "locales"), prefix: "src/locales" },
    { pattern: "**/*.{md,mdx}", root: join(process.cwd(), "docs"), prefix: "docs" },
    { pattern: "**/*.md", root: join(process.cwd(), ".github"), prefix: ".github" },
    { pattern: "README.md", root: process.cwd(), prefix: "" },
  ];

  let totalReplacements = 0;
  let filesModified = 0;

  for (const { pattern, root, prefix } of docGlobs) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan(root)) {
      const displayPath = prefix ? join(prefix, file).replace(/\\/g, "/") : file;

      if (
        displayPath.includes(".deprecated/") ||
        displayPath.includes("src/db/migrations/") ||
        displayPath.includes(".github/release/")
      ) {
        continue;
      }

      const absolute = join(root, file);
      const fileBytes = await Bun.file(absolute).arrayBuffer();
      const buffer = Buffer.from(fileBytes);

      const hasBOM = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      const contentStr = hasBOM ? buffer.toString("utf8", 3) : buffer.toString("utf8");

      let fileReplacements = 0;
      const newContent = contentStr.replace(oldPathRegex, (match) => {
        fileReplacements++;
        return `/${newPath}`;
      });

      if (fileReplacements > 0) {
        totalReplacements += fileReplacements;
        filesModified++;
        console.log(`  ${displayPath}: ${fileReplacements} occurrence(s)`);

        if (apply) {
          const outBuffer = Buffer.from(newContent, "utf8");
          const finalBuffer = hasBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), outBuffer]) : outBuffer;
          await Bun.write(absolute, finalBuffer);
        }
      }
    }
  }

  console.log(`\nFound ${totalReplacements} occurrence(s) across ${filesModified} file(s).`);
  if (!apply && totalReplacements > 0) {
    console.log("Run with --apply to write changes.");
  }
}

main().catch((error) => {
  // A codemod that writes files must not report success after a partial failure.
  console.error(error);
  process.exit(1);
});
