import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `initializeLocalizer()` scans `<cwd>/src/locales` once per process and latches, and the
 * repository's own `ja` tree is currently at full key parity with `en-US`, so no real key can
 * exercise the per-key fallback. These cases run against a synthetic two-locale tree in a
 * child process instead: real loader, real lookup, no module mocking and no shared state.
 */
type Probe = {
  hit: string;
  fallback: string;
  missEverywhere: string;
  hasKeyInPartialLocale: boolean;
  hasKeyInFallbackLocale: boolean;
  hasKeyInUnloadedLocale: boolean;
  warnedAboutFallback: boolean;
};

const LOCALIZER_PATH = resolve(import.meta.dir, "..", "..", "..", "src", "utils", "text", "localizer.ts");

let probe: Probe;
let workspace: string;

describe("localizer per-key en-US fallback", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tomori-localizer-"));
    await mkdir(join(workspace, "src", "locales", "en-US"), { recursive: true });
    await mkdir(join(workspace, "src", "locales", "partial"), { recursive: true });

    await writeFile(
      join(workspace, "src", "locales", "en-US", "general.ts"),
      "export default { probe: { shared: `English shared`, english_only: `Hello {name}` } };\n",
    );
    await writeFile(
      join(workspace, "src", "locales", "partial", "general.ts"),
      "export default { probe: { shared: `Partial shared` } };\n",
    );

    const script = join(workspace, "probe.ts");
    await writeFile(
      script,
      [
        `import { initializeLocalizer, localizer, hasLocaleKey } from ${JSON.stringify(pathToFileURL(LOCALIZER_PATH).href)};`,
        "await initializeLocalizer();",
        "console.log(`__PROBE__${JSON.stringify({",
        '  hit: localizer("partial", "probe.shared"),',
        '  fallback: localizer("partial", "probe.english_only", { name: "Sparrow" }),',
        '  missEverywhere: localizer("partial", "probe.absent"),',
        '  hasKeyInPartialLocale: hasLocaleKey("partial", "probe.english_only"),',
        '  hasKeyInFallbackLocale: hasLocaleKey("en-US", "probe.english_only"),',
        '  hasKeyInUnloadedLocale: hasLocaleKey("zz", "probe.shared"),',
        "})}`);",
      ].join("\n"),
    );

    const result = Bun.spawnSync({
      cmd: ["bun", "run", script],
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    const marker = output.split("__PROBE__")[1];
    if (!marker) throw new Error(`Localizer probe produced no result:\n${output}`);

    probe = {
      ...(JSON.parse(marker.split("\n")[0]) as Omit<Probe, "warnedAboutFallback">),
      warnedAboutFallback: output.includes("is missing key 'probe.english_only'"),
    };
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns the requested locale's own string when the key is present", () => {
    expect(probe.hit).toBe("Partial shared");
  });

  it("returns the en-US string, interpolated, when the key is missing from the requested locale", () => {
    expect(probe.fallback).toBe("Hello Sparrow");
  });

  it("warns once so a locale gap stays visible during development", () => {
    expect(probe.warnedAboutFallback).toBe(true);
  });

  it("still echoes the key back when it is missing from en-US too", () => {
    expect(probe.missEverywhere).toBe("probe.absent");
  });

  it("reports key existence per locale, without the fallback", () => {
    expect(probe.hasKeyInPartialLocale).toBe(false);
    expect(probe.hasKeyInFallbackLocale).toBe(true);
    expect(probe.hasKeyInUnloadedLocale).toBe(false);
  });
});
