import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "bun";

describe("rename-command-path", () => {
  const tmpDir = join(process.cwd(), "tests", "unit", "checks", "tmp-rename");
  const scriptPath = join(process.cwd(), "scripts", "devtools", "renameCommandPath.ts");

  beforeAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("replaces bare form, code-span form, escaped-backtick form, and preserves BOM", async () => {
    // The script hardcodes search directories to src/locales, docs, .github, README.md relative to process.cwd()
    // To test it without altering the real repo, we spawn it with cwd set to our tmpDir
    // And create the expected folders there.

    await mkdir(join(tmpDir, "docs"), { recursive: true });
    await mkdir(join(tmpDir, ".github", "release"), { recursive: true });
    await mkdir(join(tmpDir, "src", "locales"), { recursive: true });

    // File 1: docs/test.md (UTF-8)
    const docsContent = "Here is a bare /config setup command.\nAnd a code-span `/config setup` form.";
    await writeFile(join(tmpDir, "docs", "test.md"), docsContent, "utf8");

    // File 2: src/locales/en-US.ts (UTF-8 with BOM)
    const localeContent = "export default { desc: `Use \\`/config setup\\` now.` };";
    const bomLocaleContent = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(localeContent, "utf8")]);
    await Bun.write(join(tmpDir, "src", "locales", "en-US.ts"), bomLocaleContent);

    // File 3: .github/release/skipped.md (Excluded directory)
    const skippedContent = "`/config setup` should not change here.";
    await writeFile(join(tmpDir, ".github", "release", "skipped.md"), skippedContent, "utf8");

    // Dry-run
    const procDry = spawn(["bun", "run", scriptPath, "config setup", "setup"], { cwd: tmpDir, stdout: "pipe" });
    await procDry.exited;

    const docsAfterDry = await readFile(join(tmpDir, "docs", "test.md"), "utf8");
    expect(docsAfterDry).toContain("/config setup");

    const procApply = spawn(["bun", "run", scriptPath, "config setup", "setup", "--apply"], {
      cwd: tmpDir,
      stdout: "pipe",
    });
    await procApply.exited;

    const docsAfterApply = await readFile(join(tmpDir, "docs", "test.md"), "utf8");
    expect(docsAfterApply).toBe("Here is a bare /setup command.\nAnd a code-span `/setup` form.");

    const localeAfterApplyBuffer = await Bun.file(join(tmpDir, "src", "locales", "en-US.ts")).arrayBuffer();
    const localeBytes = new Uint8Array(localeAfterApplyBuffer);
    expect(localeBytes[0]).toBe(0xef);
    expect(localeBytes[1]).toBe(0xbb);
    expect(localeBytes[2]).toBe(0xbf);

    const localeString = Buffer.from(localeAfterApplyBuffer).toString("utf8");
    expect(localeString).toContain("`Use \\`/setup\\` now.`");

    const skippedAfterApply = await readFile(join(tmpDir, ".github", "release", "skipped.md"), "utf8");
    expect(skippedAfterApply).toBe("`/config setup` should not change here.");
  });

  it("leaves a single-word path alone inside source paths and URLs", async () => {
    // A multi-word path cannot appear in a path or URL, so `config setup` above cannot detect a
    // missing left boundary. Waves 4 through 6 rename single-word roots, where /memory matches as
    // a segment of src/commands/memory/... and of any docs URL unless the boundary holds.
    await mkdir(join(tmpDir, "docs"), { recursive: true });

    const content = [
      "The `/memory` command stores things.",
      "Implemented in `src/commands/memory/personal/export.ts`.",
      "See https://docs.tomoribot.app/en/memory for details.",
      "Bare /memory mention.",
      "Do not touch /memoryleak or `/memory-bank`.",
    ].join(String.fromCharCode(10));
    await writeFile(join(tmpDir, "docs", "boundary.md"), content, "utf8");

    const proc = spawn(["bun", "run", scriptPath, "memory", "memories", "--apply"], {
      cwd: tmpDir,
      stdout: "pipe",
    });
    await proc.exited;

    const after = await readFile(join(tmpDir, "docs", "boundary.md"), "utf8");

    expect(after).toContain("The `/memories` command");
    expect(after).toContain("Bare /memories mention.");

    expect(after).toContain("src/commands/memory/personal/export.ts");
    expect(after).toContain("https://docs.tomoribot.app/en/memory for details");
    expect(after).toContain("/memoryleak");
    expect(after).toContain("`/memory-bank`");
  });
});
