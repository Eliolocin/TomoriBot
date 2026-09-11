import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as ts from "typescript";
import { isVerboseOutput } from "./lib/gateOutput";

const DEFAULT_PATHS = ["src", "scripts", "tests", "apps"];
const DEFAULT_EXCEPTIONS_PATH = "scripts/checks/comment-policy-exceptions.json";
const POLICY_DOC_PATH = "docs/en/contributing/comment-policy.md";
const DASH_PATTERN = /—|–| -- /;
const DASH_SCAN_PATTERN = /—|–| -- /g;
const LOCALE_PATH_PATTERN = /(?:^|\/)src\/locales\//;
const NUMBERED_PREFIX_PATTERNS = [
  String.raw`\d+[a-z]?(?:\.\d+[a-z]?)*(?:-\d+[a-z]?)*\.`,
  String.raw`\d+\.\d+[a-z]?`,
  String.raw`\d+[a-z]?(?:\.\d+[a-z]?)*(?:-\d+[a-z]?)*\)`,
];
const NUMBERED_LINE_PATTERN = new RegExp(
  String.raw`^//\s*(?:${NUMBERED_PREFIX_PATTERNS.join("|")})\s+(?=[A-Z])`,
);
const RULE_HEAD_PATTERN =
  /^(?:\/\/|\*)\s*Rule\s*\d+(?:\s*(?:,|&|and)\s*\d+)*\s*[:,]?/;
const ACTION_HEADS = [
  "Get",
  "Set",
  "Check",
  "Return",
  "Create",
  "Delete",
  "Update",
  "Load",
  "Fetch",
  "Build",
  "Initialize",
  "Validate",
  "Parse",
  "Call",
  "Send",
  "Add",
  "Remove",
  "Convert",
  "Apply",
  "Start",
  "Stop",
  "Handle",
  "Process",
  "Try",
  "Query",
  "Fallback",
  "Exercise",
];
const ACTION_HEAD_PATTERN = new RegExp(
  String.raw`^//\s*(?:${ACTION_HEADS.join("|")})\b`,
);
const RATIONALE_SIGNALS = [
  "after",
  "before",
  "because",
  "cannot",
  "compatibility",
  "fallback",
  "invariant",
  "must",
  "only",
  "otherwise",
  "prevent",
  "requires?",
  "so",
  "unless",
  "until",
  "when",
  "without",
  "workaround",
];
const RATIONALE_PATTERN = new RegExp(
  String.raw`\b(?:${RATIONALE_SIGNALS.join("|")})\b|[:(]`,
  "i",
);
const SUMMARY_STOPWORDS = new Set([
  "all",
  "and",
  "any",
  "are",
  "for",
  "from",
  "given",
  "his",
  "into",
  "its",
  "not",
  "specific",
  "the",
  "their",
  "this",
  "was",
  "with",
]);
const SUMMARY_ADDED_WORD_LIMIT = 2;
const SECTION_DIVIDER_PATTERN =
  /^\/\/\s*(?:[-=─]{3,}|[-=─]{2,}\s*[^-=─]+\s*[-=─]{2,})\s*$/;
const LICENSE_HEADER_PATTERN =
  /\bCopyright(?:\s+\(c\))?|\bSPDX-License-Identifier\s*:|\bLicensed under the\b|\bPermission is hereby granted\b/i;

export type CommentPolicyRule =
  | "orphaned-comment"
  | "jsdoc-restatement"
  | "numbered-narration"
  | "obvious-narration"
  | "prose-dash"
  | "rule-scaffolding"
  | "stale-exception";

export interface CommentPolicyFinding {
  file: string;
  line: number;
  message: string;
  rule: CommentPolicyRule;
  severity: "error" | "warning";
  text: string;
}

export interface CommentPolicyException {
  file: string;
  reason: string;
  rule: Exclude<CommentPolicyRule, "obvious-narration" | "stale-exception">;
  text: string;
}

export interface CommentPolicyOptions {
  auditNarration?: boolean;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  exceptionPath?: string;
  paths?: string[];
  repoRoot?: string;
}

export interface CommentPolicyResult {
  filesChecked: number;
  findings: CommentPolicyFinding[];
  usedExceptions: CommentPolicyException[];
}

interface CommentLine {
  file: string;
  kind: "block" | "line";
  line: number;
  standalone: boolean;
  text: string;
}

interface CommentToken {
  kind: "block" | "line";
  line: number;
  standalone: boolean;
  text: string;
}

interface ParsedArguments {
  auditNarration: boolean;
  baseRef?: string;
  verboseOutput: boolean;
  paths: string[];
  staged: boolean;
}

interface RawExceptionFile {
  exceptions?: unknown;
}

/**
 * Audits repository comments against TomoriBot's deterministic policy and optional narration ratchet.
 */
export async function checkCommentPolicy(
  options: CommentPolicyOptions = {},
): Promise<CommentPolicyResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const paths = options.paths?.length ? options.paths : DEFAULT_PATHS;
  const exceptionPath = resolve(
    repoRoot,
    options.exceptionPath ?? DEFAULT_EXCEPTIONS_PATH,
  );
  const exceptions = await loadExceptions(exceptionPath);
  const files = await discoverTypeScriptFiles(repoRoot, paths);
  const scannedFiles = new Set(
    files.map((file) => normalizePath(relative(repoRoot, file))),
  );
  const findings: CommentPolicyFinding[] = [];
  const usedExceptionKeys = new Set<string>();

  for (const absolutePath of files) {
    const file = normalizePath(relative(repoRoot, absolutePath));
    const source = await Bun.file(absolutePath).text();
    assertParseable(source, file);
    const fileFindings = [
      ...collectCommentLines(source, file).flatMap((line) => inspectCommentLine(line, options)),
      ...collectStructuralCommentFindings(source, file),
      ...collectJsDocFindings(source, file, options),
      ...collectLocaleStringFindings(source, file),
    ];

    for (const finding of fileFindings) {
      const exception = exceptions.find(
        (entry) => exceptionKey(entry) === findingKey(finding),
      );
      if (exception) {
        usedExceptionKeys.add(exceptionKey(exception));
        continue;
      }
      findings.push(finding);
    }
  }

  for (const exception of exceptions) {
    if (
      scannedFiles.has(normalizePath(exception.file)) &&
      !usedExceptionKeys.has(exceptionKey(exception))
    ) {
      findings.push({
        file: exception.file,
        line: 0,
        message: `Exception no longer matches a violation: ${exception.reason}`,
        rule: "stale-exception",
        severity: "error",
        text: exception.text,
      });
    }
  }

  return {
    filesChecked: files.length,
    findings: findings.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule),
    ),
    usedExceptions: exceptions.filter((entry) =>
      usedExceptionKeys.has(exceptionKey(entry)),
    ),
  };
}

/**
 * Inspects one TypeScript source without loading repository exceptions.
 */
export function inspectCommentPolicySource(
  source: string,
  file = "fixture.ts",
  options: Pick<CommentPolicyOptions, "auditNarration" | "changedLines"> = {},
): CommentPolicyFinding[] {
  assertParseable(source, file);
  return [
    ...collectLocaleStringFindings(source, file),
    ...collectCommentLines(source, file).flatMap((line) => inspectCommentLine(line, options)),
    ...collectStructuralCommentFindings(source, file),
    ...collectJsDocFindings(source, file, options),
  ];
}

async function loadExceptions(path: string): Promise<CommentPolicyException[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as RawExceptionFile;
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error(`${path}: exceptions must be an array`);
  }

  const exceptions = parsed.exceptions.map((entry, index) => {
    if (!isCommentPolicyException(entry)) {
      throw new Error(`${path}: invalid exception at index ${index}`);
    }
    return entry;
  });
  const keys = new Set<string>();
  for (const exception of exceptions) {
    const key = exceptionKey(exception);
    if (keys.has(key)) {
      throw new Error(`${path}: duplicate exception for ${exception.file}`);
    }
    keys.add(key);
  }
  return exceptions;
}

function isCommentPolicyException(
  value: unknown,
): value is CommentPolicyException {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.file === "string" &&
    typeof entry.reason === "string" &&
    typeof entry.text === "string" &&
    (entry.rule === "jsdoc-restatement" ||
      entry.rule === "orphaned-comment" ||
      entry.rule === "numbered-narration" ||
      entry.rule === "prose-dash" ||
      entry.rule === "rule-scaffolding")
  );
}

/** Finds objective damage left by deleting only part of a comment block. */
function collectStructuralCommentFindings(source: string, file: string): CommentPolicyFinding[] {
  const sourceLines = source.split(/\r?\n/);
  const findings: CommentPolicyFinding[] = [];
  const record = (line: number, message: string, text: string): void => {
    findings.push({
      file,
      line,
      message,
      rule: "orphaned-comment",
      severity: "error",
      text: text.trim(),
    });
  };

  for (let index = 0; index < sourceLines.length; index++) {
    const line = sourceLines[index] ?? "";
    const previousIsLineComment = index > 0 && /^\s*\/\//.test(sourceLines[index - 1] ?? "");
    const nextIsLineComment = index + 1 < sourceLines.length && /^\s*\/\//.test(sourceLines[index + 1] ?? "");

    if (/^\s*\/\/[ \t]{2,}\S/.test(line) && !previousIsLineComment) {
      record(
        index + 1,
        "This looks like a continuation whose opening line was removed; restore, rewrite, or normalize the paragraph.",
        line,
      );
    }

    if (/^\s*\/\/\s*$/.test(line) && !(previousIsLineComment && nextIsLineComment)) {
      record(index + 1, "Remove the empty comment left at the boundary of a deleted section banner.", line);
    }
  }

  for (const token of collectCommentTokens(source, file)) {
    if (token.kind !== "block" || !token.text.startsWith("/**")) {
      continue;
    }
    const content = token.text
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean);
    if (content.length === 0) {
      record(token.line, "Remove the empty JSDoc block left after deleting its summary or tags.", token.text);
    }
  }

  return findings;
}

/**
 * Applies the dash rule to locale string literals, which ship to users as prose and so carry the
 * same restriction as comments. Scanning raw source text rather than the cooked literal value
 * keeps the reported line accurate inside the multi-line templates the help locales are built
 * from, where one literal can span a hundred lines.
 */
function collectLocaleStringFindings(source: string, file: string): CommentPolicyFinding[] {
  if (!LOCALE_PATH_PATTERN.test(file)) {
    return [];
  }

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sourceLines = source.split(/\r?\n/);
  const flaggedLines = new Map<number, string>();

  const record = (node: ts.Node): void => {
    const raw = node.getText(sourceFile);
    const start = node.getStart(sourceFile);
    for (const match of raw.matchAll(DASH_SCAN_PATTERN)) {
      if (match.index === undefined) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(start + match.index);
      flaggedLines.set(line + 1, (sourceLines[line] ?? "").trim());
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return Array.from(flaggedLines, ([line, text]) => ({
    file,
    line,
    message: "Replace prose dashes in locale text with punctuation that states the relationship.",
    rule: "prose-dash" as const,
    severity: "error" as const,
    text,
  }));
}

function inspectCommentLine(
  comment: CommentLine,
  options: Pick<CommentPolicyOptions, "auditNarration" | "changedLines">,
): CommentPolicyFinding[] {
  if (comment.line <= 10 && LICENSE_HEADER_PATTERN.test(comment.text)) {
    return [];
  }

  const findings: CommentPolicyFinding[] = [];
  if (DASH_PATTERN.test(comment.text)) {
    findings.push({
      file: comment.file,
      line: comment.line,
      message: "Replace prose dashes with punctuation that states the relationship.",
      rule: "prose-dash",
      severity: "error",
      text: comment.text.trim(),
    });
  }

  if (
    comment.kind === "line" &&
    comment.standalone &&
    NUMBERED_LINE_PATTERN.test(comment.text)
  ) {
    findings.push({
      file: comment.file,
      line: comment.line,
      message: "Remove procedural numbering; keep only rationale the code cannot express.",
      rule: "numbered-narration",
      severity: "error",
      text: comment.text.trim(),
    });
  }

  if (RULE_HEAD_PATTERN.test(comment.text.trim())) {
    findings.push({
      file: comment.file,
      line: comment.line,
      message: "Remove prompt-style Rule N scaffolding.",
      rule: "rule-scaffolding",
      severity: "error",
      text: comment.text.trim(),
    });
  }

  if (isNarrationCandidate(comment)) {
    const changed = options.changedLines
      ?.get(comment.file)
      ?.has(comment.line);
    if (options.auditNarration || changed) {
      findings.push({
        file: comment.file,
        line: comment.line,
        message: SECTION_DIVIDER_PATTERN.test(comment.text)
          ? "Replace the section banner with a named function or remove it."
          : "This reads like a translation of the next statement; add rationale or remove it.",
        rule: "obvious-narration",
        severity: changed ? "error" : "warning",
        text: comment.text.trim(),
      });
    }
  }

  return findings;
}

/**
 * Flags `@param`/`@returns` text that only repeats the identifier or the TypeScript
 * type beside it.
 *
 * This class needs its own pass because the line rules cannot see it: the tag text
 * carries no dash, no ordinal, and no action head, so it reads as ordinary prose.
 * It is also the highest-recurrence policy miss, since JSDoc predates TypeScript and
 * a complete `@param` list per parameter is the dominant convention in the corpus
 * models learn from.
 *
 * Matching is exact after normalization, never substring: a description that merely
 * contains the type name usually goes on to add units, nullability, or failure
 * behavior, and those are the tags the policy keeps.
 */
function collectJsDocFindings(
  source: string,
  file: string,
  options: Pick<CommentPolicyOptions, "auditNarration" | "changedLines">,
): CommentPolicyFinding[] {
  const scriptKind = file.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const sourceLines = source.split(/\r?\n/);
  const findings: CommentPolicyFinding[] = [];

  const record = (tag: ts.JSDocTag, message: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(tag.getStart(sourceFile)).line;
    findings.push({
      file,
      line: line + 1,
      message,
      rule: "jsdoc-restatement",
      severity: "error",
      text: (sourceLines[line] ?? "").trim(),
    });
  };

  const recordSummaryEcho = (block: ts.JSDoc, summary: string): void => {
    const start = sourceFile.getLineAndCharacterOfPosition(block.getStart(sourceFile)).line;
    const end = sourceFile.getLineAndCharacterOfPosition(block.getEnd()).line;
    let line = start;
    for (let index = start; index <= end; index++) {
      if (stripJsDocDecoration(sourceLines[index] ?? "")) {
        line = index;
        break;
      }
    }

    const changed = options.changedLines?.get(file)?.has(line + 1);
    if (!options.auditNarration && !changed) {
      return;
    }

    findings.push({
      file,
      line: line + 1,
      message: `This summary restates "${summary}" back from the identifier; add rationale or remove the block.`,
      rule: "obvious-narration",
      severity: changed ? "error" : "warning",
      text: (sourceLines[line] ?? "").trim(),
    });
  };

  const visit = (node: ts.Node): void => {
    const documented = node as ts.Node & { jsDoc?: ts.JSDoc[]; name?: ts.Node };
    const block = documented.jsDoc?.[0];
    if (ts.isFunctionLike(node) && block && documented.name) {
      const identifier = documented.name.getText(sourceFile);
      const summary = (ts.getTextOfJSDocComment(block.comment) ?? "").split(/\r?\n/)[0]?.trim() ?? "";
      if (summary && !RATIONALE_PATTERN.test(summary) && echoesIdentifier(identifier, summary)) {
        recordSummaryEcho(block, identifier);
      }
    }

    if (ts.isFunctionLike(node)) {
      for (const tag of ts.getAllJSDocTags(node, ts.isJSDocParameterTag)) {
        const described = normalizeJsDocPhrase(ts.getTextOfJSDocComment(tag.comment));
        if (!described) {
          continue;
        }

        const parameterName = tag.name.getText(sourceFile);
        const declared = node.parameters.find(
          (parameter) => parameter.name.getText(sourceFile) === parameterName,
        );
        const declaredType = declared?.type ? normalizeJsDocPhrase(declared.type.getText(sourceFile)) : "";

        if (described === normalizeJsDocPhrase(parameterName)) {
          record(tag, `@param ${parameterName} only restates the parameter name; drop the tag.`);
        } else if (declaredType && described === declaredType) {
          record(tag, `@param ${parameterName} only restates its TypeScript type; drop the tag.`);
        }
      }

      for (const tag of ts.getAllJSDocTags(node, ts.isJSDocReturnTag)) {
        const described = normalizeJsDocPhrase(ts.getTextOfJSDocComment(tag.comment));
        const returnType = node.type ? normalizeJsDocPhrase(node.type.getText(sourceFile)) : "";
        if (described && returnType && described === returnType) {
          record(tag, "@returns only restates the return type; drop the tag.");
        }
      }
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return findings;
}

/**
 * True when the summary repeats every meaningful word of the identifier and adds none of
 * its own signal, which is the JSDoc form of translating a name into English.
 *
 * Stemming is crude on purpose: `Count`/`Counts`/`Counting` must collapse together, and a
 * real stemmer would buy nothing at warning severity.
 */
function echoesIdentifier(identifier: string, summary: string): boolean {
  const tokens = splitIdentifierWords(identifier);
  if (tokens.length < 2) {
    return false;
  }

  const words = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !SUMMARY_STOPWORDS.has(word))
    .map(stemWord);
  if (!tokens.every((token) => words.includes(token))) {
    return false;
  }

  // A summary that echoes the name AND carries several words of its own is usually
  // documenting a side effect or an ordering guarantee, which the policy keeps.
  const added = words.filter((word) => !tokens.includes(word));
  return new Set(added).size <= SUMMARY_ADDED_WORD_LIMIT;
}

function splitIdentifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .map(stemWord);
}

function stemWord(word: string): string {
  return word.replace(/(?:es|s|ing|ed)$/, "");
}

/** Removes JSDoc framing so a line yields its prose, or an empty string when it has none. */
function stripJsDocDecoration(line: string): string {
  return line.replace(/^\s*\/?\*+\/?/, "").replace(/\*\/\s*$/, "").trim();
}

/** Reduces tag text to comparable form: leading article dropped, then letters and digits only. */
function normalizeJsDocPhrase(value: string | undefined): string {
  return (value ?? "")
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isNarrationCandidate(comment: CommentLine): boolean {
  if (
    comment.kind !== "line" ||
    !comment.standalone ||
    /biome-ignore|@ts-expect-error/.test(comment.text)
  ) {
    return false;
  }
  if (SECTION_DIVIDER_PATTERN.test(comment.text)) {
    return true;
  }
  return (
    ACTION_HEAD_PATTERN.test(comment.text) &&
    !RATIONALE_PATTERN.test(comment.text)
  );
}

function exceptionKey(exception: CommentPolicyException): string {
  return `${exception.rule}\0${normalizePath(exception.file)}\0${exception.text.trim()}`;
}

function findingKey(finding: CommentPolicyFinding): string {
  return `${finding.rule}\0${normalizePath(finding.file)}\0${finding.text.trim()}`;
}

function assertParseable(source: string, file: string): void {
  try {
    const loader = file.toLowerCase().endsWith(".tsx") ? "tsx" : "ts";
    new Bun.Transpiler({ loader }).transformSync(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: TypeScript parse failed: ${message}`);
  }
}

function collectCommentLines(source: string, file: string): CommentLine[] {
  const tokens = collectCommentTokens(source, file);
  return tokens.flatMap((token) => {
    if (token.kind === "line") {
      return [
        {
          file,
          kind: token.kind,
          line: token.line,
          standalone: token.standalone,
          text: token.text,
        },
      ];
    }
    return token.text.split(/\r?\n/).map((text, offset) => ({
      file,
      kind: token.kind,
      line: token.line + offset,
      standalone: token.standalone,
      text: text.trimStart(),
    }));
  });
}

function collectCommentTokens(source: string, file: string): CommentToken[] {
  const scriptKind = file.toLowerCase().endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const ranges = new Map<string, ts.CommentRange>();

  const addRanges = (found: ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
  };
  const addStandaloneMatches = (
    pattern: RegExp,
    kind:
      | ts.SyntaxKind.MultiLineCommentTrivia
      | ts.SyntaxKind.SingleLineCommentTrivia,
  ): void => {
    for (const match of source.matchAll(pattern)) {
      const text = match[1];
      if (match.index === undefined || text === undefined) {
        continue;
      }
      const pos = match.index + match[0].indexOf(text);
      const end = pos + text.length;
      ranges.set(`${pos}:${end}`, {
        end,
        hasTrailingNewLine: true,
        kind,
        pos,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    addRanges(ts.getLeadingCommentRanges(source, node.getFullStart()));
    addRanges(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };

  visit(sourceFile);
  addRanges(ts.getLeadingCommentRanges(source, sourceFile.end));
  addStandaloneMatches(
    /^[\t ]*(\/\/[^\r\n]*)/gm,
    ts.SyntaxKind.SingleLineCommentTrivia,
  );
  addStandaloneMatches(
    /^[\t ]*(\/\*(?!\*)[^\r\n]*\*\/)[\t ]*$/gm,
    ts.SyntaxKind.MultiLineCommentTrivia,
  );
  addStandaloneMatches(
    /^[\t ]*(\/\*\*[\s\S]*?\*\/)/gm,
    ts.SyntaxKind.MultiLineCommentTrivia,
  );

  return [...ranges.values()]
    .map((range) => normalizeCommentRange(source, range))
    .filter((range): range is ts.CommentRange => range !== undefined)
    .sort((left, right) => left.pos - right.pos)
    .map((range) => {
      const startLocation = sourceFile.getLineAndCharacterOfPosition(range.pos);
      const lineStart =
        source.lastIndexOf("\n", Math.max(0, range.pos - 1)) + 1;
      const prefix = source.slice(lineStart, range.pos);
      return {
        kind:
          range.kind === ts.SyntaxKind.SingleLineCommentTrivia
            ? "line"
            : "block",
        line: startLocation.line + 1,
        standalone: prefix.trim().length === 0,
        text: source.slice(range.pos, range.end),
      };
    });
}

function normalizeCommentRange(
  source: string,
  range: ts.CommentRange,
): ts.CommentRange | undefined {
  const text = source.slice(range.pos, range.end);
  if (
    (range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      text.startsWith("//")) ||
    (range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      text.startsWith("/*"))
  ) {
    return range;
  }

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const expectedMarker =
    range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "//" : "/*";
  for (
    let tokenKind = scanner.scan();
    tokenKind !== ts.SyntaxKind.EndOfFileToken;
    tokenKind = scanner.scan()
  ) {
    if (scanner.getTokenText().startsWith(expectedMarker)) {
      return {
        ...range,
        end: range.pos + scanner.getTextPos(),
        pos: range.pos + scanner.getTokenPos(),
      };
    }
  }
  return undefined;
}

async function discoverTypeScriptFiles(
  repoRoot: string,
  paths: string[],
): Promise<string[]> {
  const discovered = new Set<string>();
  for (const input of paths) {
    const absoluteInput = isAbsolute(input)
      ? input
      : resolve(repoRoot, input);
    const inputStat = await stat(absoluteInput).catch(() => undefined);

    if (inputStat?.isFile()) {
      if (isTypeScriptPath(absoluteInput)) {
        discovered.add(resolve(absoluteInput));
      }
      continue;
    }
    if (inputStat?.isDirectory()) {
      const glob = new Bun.Glob("**/*.ts");
      for await (const path of glob.scan({
        absolute: true,
        cwd: absoluteInput,
        onlyFiles: true,
      })) {
        if (isTypeScriptPath(path) && !isExcludedPath(path)) {
          discovered.add(resolve(path));
        }
      }
      continue;
    }

    const glob = new Bun.Glob(normalizePath(input));
    for await (const path of glob.scan({
      absolute: true,
      cwd: repoRoot,
      onlyFiles: true,
    })) {
      if (isTypeScriptPath(path) && !isExcludedPath(path)) {
        discovered.add(resolve(path));
      }
    }
  }
  return filterGitIgnoredFiles(repoRoot, [...discovered].sort());
}

function isTypeScriptPath(path: string): boolean {
  return /\.tsx?$/i.test(path) && !/\.d\.ts$/i.test(path);
}

function isExcludedPath(path: string): boolean {
  return /(?:^|[\\/])(?:\.git|dist|node_modules)(?:[\\/]|$)/.test(path);
}

async function filterGitIgnoredFiles(
  repoRoot: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) {
    return paths;
  }
  const relativePaths = paths.map((path) =>
    normalizePath(relative(repoRoot, path)),
  );
  const process = Bun.spawn({
    cmd: ["git", "check-ignore", "--stdin", "-z"],
    cwd: repoRoot,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  process.stdin.write(`${relativePaths.join("\0")}\0`);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode === 128) {
    return paths;
  }
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`git check-ignore failed: ${stderr.trim()}`);
  }
  const ignored = new Set(stdout.split("\0").filter(Boolean));
  return paths.filter((_, index) => !ignored.has(relativePaths[index]));
}

async function collectChangedLines(
  repoRoot: string,
  mode: { baseRef?: string; staged: boolean },
  paths: string[],
): Promise<Map<string, Set<number>>> {
  const args = ["git", "diff", "--unified=0", "--no-color"];
  if (mode.staged) {
    args.push("--cached");
  } else if (mode.baseRef) {
    args.push(`${mode.baseRef}...HEAD`);
  }
  args.push("--", ...paths);

  const process = Bun.spawn({
    cmd: args,
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed: ${stderr.trim()}`);
  }

  const changed = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      file = normalizePath(line.slice(6));
      continue;
    }
    if (!file || !line.startsWith("@@")) {
      continue;
    }
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) {
      continue;
    }
    const start = Number.parseInt(match[1], 10);
    const count = match[2] ? Number.parseInt(match[2], 10) : 1;
    const lines = changed.get(file) ?? new Set<number>();
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
    changed.set(file, lines);
  }
  return changed;
}

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    auditNarration: false,
    verboseOutput: isVerboseOutput(),
    paths: [],
    staged: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--audit") {
      parsed.auditNarration = true;
      continue;
    }
    // Detail level, shared with the other gates so `vl` can forward one flag. Any other
    // dash-prefixed value is a mistake, and accepting it as a path would silently
    // replace the default roots with a nonexistent one and scan nothing at all.
    if (value === "--verbose" || value === "--no-verbose") {
      parsed.verboseOutput = value === "--verbose";
      continue;
    }
    if (value === "--staged") {
      parsed.staged = true;
      continue;
    }
    if (value === "--base") {
      const baseRef = args[index + 1];
      if (!baseRef) {
        throw new Error("--base requires a Git ref");
      }
      parsed.baseRef = baseRef;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new Error(`Unknown flag: ${value}`);
    }
    parsed.paths.push(value);
  }
  if (parsed.baseRef && parsed.staged) {
    throw new Error("Use either --base or --staged, not both");
  }
  return parsed;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const args = parseArguments(process.argv.slice(2));
  const paths = args.paths.length ? args.paths : DEFAULT_PATHS;
  const changedLines =
    args.baseRef || args.staged
      ? await collectChangedLines(
          repoRoot,
          { baseRef: args.baseRef, staged: args.staged },
          paths,
        )
      : undefined;
  const result = await checkCommentPolicy({
    auditNarration: args.auditNarration,
    changedLines,
    paths,
    repoRoot,
  });

  const errors = result.findings.filter(
    (finding) => finding.severity === "error",
  );
  const warnings = result.findings.length - errors.length;

  // Errors print in full under either mode: they are why anyone runs this. Warnings do
  // not change the exit code, so under quiet mode their count is the whole report and
  // the per-finding listing would be detail nobody can act on yet.
  const printsDetail = errors.length > 0 || warnings === 0 || args.verboseOutput;
  if (printsDetail) {
    console.log(`Comment policy guide: ${POLICY_DOC_PATH}`);

    for (const finding of result.findings) {
      const label = finding.severity === "error" ? "ERROR" : "WARN";
      console.log(
        `${label} ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`,
      );
      console.log(`  ${finding.text}`);
    }
  }

  if (errors.length > 0) {
    console.error(
      `Comment policy failed: ${errors.length} error(s), ` +
        `${warnings} warning(s), ${result.filesChecked} file(s) checked.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Comment policy passed: ${result.filesChecked} file(s), ` +
      `${result.usedExceptions.length} exception(s), ${warnings} warning(s).` +
      (warnings > 0 && !args.verboseOutput
        ? ` Re-run with \`bun run audit-comments --verbose\` to list them.`
        : ""),
  );
}

if (import.meta.main) {
  await main();
}
