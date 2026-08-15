import { describe, expect, it } from "bun:test";
import { inspectCommentPolicySource } from "./checkCommentPolicy";

describe("comment policy", () => {
  it("finds authored prose dashes without matching strings or regexes", () => {
    const source = [
      'const prose = "Keep — string";',
      "const matcher = /[—–]/u;",
      "const value = 1; // Keep rationale — callers depend on it",
      "",
    ].join("\n");

    const findings = inspectCommentPolicySource(source);

    expect(findings.map((finding) => finding.rule)).toEqual(["prose-dash"]);
  });

  it("finds prose dashes in locale strings, which ship to users as prose", () => {
    const source = ['export const ja = {', '  note: `ご注意 — TXTファイル`,', "};", ""].join("\n");

    const findings = inspectCommentPolicySource(source, "src/locales/ja/commands/tool.ts");

    expect(findings.map((finding) => finding.rule)).toEqual(["prose-dash"]);
  });

  it("reports the offending line inside a multi-line locale template", () => {
    const source = [
      "export const en = {",
      "  help: `First line",
      "Second line",
      "tiny — 0.5 GB`,",
      "};",
      "",
    ].join("\n");

    const findings = inspectCommentPolicySource(source, "src/locales/en-US/commands/help.ts");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
  });

  it("leaves non-locale string literals alone", () => {
    const source = ['const label = "Keep — string";', ""].join("\n");

    expect(inspectCommentPolicySource(source, "src/utils/misc/labels.ts")).toEqual([]);
  });

  it("parses TSX without treating rendered text as a comment", () => {
    const source = [
      "const View = () => (",
      '  <section title="Keep — rendered text">',
      "    {/* Keep rationale — callers depend on this boundary */}",
      "  </section>",
      ");",
    ].join("\n");

    const findings = inspectCommentPolicySource(source, "fixture.tsx");

    expect(findings.map((finding) => finding.rule)).toEqual(["prose-dash"]);
  });

  it("finds numbered narration but leaves JSDoc ordered lists alone", () => {
    const source = [
      "// 1. Parse the value",
      "const value = parseValue();",
      "/**",
      " * Resolution order:",
      " * 1. Cache",
      " * 2. Database",
      " */",
      "export function read(): string {",
      '  return "ok";',
      "}",
      "",
    ].join("\n");

    const findings = inspectCommentPolicySource(source);

    expect(findings.map((finding) => finding.rule)).toEqual(["numbered-narration"]);
  });

  it("finds compound, sub-indexed, and parenthesized narration", () => {
    const source = [
      "// 11a.2. Capture the avatar",
      "// 13.5 Check the fallback",
      "// 2) Process the result",
      "const value = true;",
      "",
    ].join("\n");

    const findings = inspectCommentPolicySource(source);

    expect(findings.filter((finding) => finding.rule === "numbered-narration")).toHaveLength(3);
  });

  it("finds prompt-style rule scaffolding", () => {
    const findings = inspectCommentPolicySource("// Rule 20: Constants at the top\nconst value = 1;\n");

    expect(findings.map((finding) => finding.rule)).toEqual(["rule-scaffolding"]);
  });

  it("reports obvious narration during audits", () => {
    const findings = inspectCommentPolicySource(
      "// Parse and validate composite-key format\nconst value = parseKey();\n",
      "fixture.ts",
      { auditNarration: true },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "obvious-narration",
        severity: "warning",
      }),
    ]);
  });

  it("promotes new narration to an error", () => {
    const changedLines = new Map([["fixture.ts", new Set([1])]]);
    const findings = inspectCommentPolicySource(
      "// Build the payload\nconst payload = buildPayload();\n",
      "fixture.ts",
      { changedLines },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "obvious-narration",
        severity: "error",
      }),
    ]);
  });

  it("does not flag action-headed rationale", () => {
    const findings = inspectCommentPolicySource(
      "// Set env vars before lazy imports so module constants see them.\nconst value = true;\n",
      "fixture.ts",
      { auditNarration: true },
    );

    expect(findings).toEqual([]);
  });

  it("reports section banners only when narration auditing is active", () => {
    const source = "// ---------- Helpers ----------\nconst value = true;\n";

    expect(inspectCommentPolicySource(source)).toEqual([]);
    expect(
      inspectCommentPolicySource(source, "fixture.ts", {
        auditNarration: true,
      }).map((finding) => finding.rule),
    ).toEqual(["obvious-narration"]);
  });

  it("finds JSDoc tags that only repeat the identifier or its type", () => {
    const source = [
      "/**",
      " * Resolve one request.",
      " * @param request - Provider native image generation request",
      " */",
      "export function resolve(request: ProviderNativeImageGenerationRequest): void {}",
      "/**",
      " * Find a server.",
      " * @returns Promise<string | null>",
      " */",
      "export function find(name: string): Promise<string | null> {",
      "  return Promise.resolve(name);",
      "}",
      "",
    ].join("\n");

    expect(inspectCommentPolicySource(source).map((finding) => finding.rule)).toEqual([
      "jsdoc-restatement",
      "jsdoc-restatement",
    ]);
  });

  it("reports a JSDoc summary that echoes the identifier only while auditing", () => {
    const source = [
      "/**",
      " * Build system prompt for LLM",
      " */",
      "export function buildSystemPrompt(): string {",
      '  return "";',
      "}",
      "",
    ].join("\n");

    expect(inspectCommentPolicySource(source)).toEqual([]);
    expect(
      inspectCommentPolicySource(source, "fixture.ts", { auditNarration: true }).map(
        (finding) => finding.rule,
      ),
    ).toEqual(["obvious-narration"]);
  });

  it("keeps a JSDoc summary that documents a side effect beyond the identifier", () => {
    const source = [
      "/**",
      " * Connect to a single guild MCP server and register it in the shared pool.",
      " */",
      "export function connectGuildMcpServer(): void {}",
      "",
    ].join("\n");

    expect(
      inspectCommentPolicySource(source, "fixture.ts", { auditNarration: true }),
    ).toEqual([]);
  });

  it("keeps JSDoc tags that add what the type cannot express", () => {
    const source = [
      "/**",
      " * Join supported modes.",
      " * @param modes - Empty when the provider reports no capabilities",
      " * @returns Comma-joined list, or empty string when no modes are supported",
      " */",
      "export function joinModes(modes: string[]): string {",
      '  return modes.join(",");',
      "}",
      "",
    ].join("\n");

    expect(inspectCommentPolicySource(source)).toEqual([]);
  });

  it("finds a continuation left without its opening comment", () => {
    const findings = inspectCommentPolicySource(
      "const value = true;\n//    because the deleted opener carried the subject.\n",
    );

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "orphaned-comment",
        severity: "error",
      }),
    ]);
  });

  it("allows an indented continuation when its opening line remains", () => {
    const source = [
      "// Keep the first line because it supplies the subject,",
      "//    and indent the continuation to make wrapping visible.",
      "const value = true;",
      "",
    ].join("\n");

    expect(inspectCommentPolicySource(source)).toEqual([]);
  });

  it("finds empty boundary comments but allows paragraph separators", () => {
    const orphaned = inspectCommentPolicySource("const value = true;\n//\n// Rationale remains.\n");
    expect(orphaned.map((finding) => finding.rule)).toEqual(["orphaned-comment"]);

    const paragraphBreak = "// First rationale paragraph.\n//\n// Second rationale paragraph.\nconst value = true;\n";
    expect(inspectCommentPolicySource(paragraphBreak)).toEqual([]);
  });

  it("finds empty JSDoc left after partial cleanup", () => {
    const findings = inspectCommentPolicySource("/**\n *\n */\nexport function value(): void {}\n");

    expect(findings.map((finding) => finding.rule)).toEqual(["orphaned-comment"]);
  });
});
