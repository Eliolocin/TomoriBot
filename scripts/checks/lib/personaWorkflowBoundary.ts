/**
 * Shared persona-workflow boundary scanner.
 *
 * Command code must use the high-level persona workflow instead of reaching for
 * its low-level picker or recreating the old preservation/callback boilerplate.
 * This module is the single source of truth used by both the CLI validation
 * check and its unit tests.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ts } from "ts-morph";

const LOW_LEVEL_PICKER = "replyPaginatedPersonaChoicesV2";
const COMPETING_PERSONA_HELPER = "selectConditioningPersona";
const PRESERVE_SELECTED_INTERACTION = "preserveSelectedInteraction";
const PICKER_ON_SELECT = "onSelect";

/** Files allowed to implement or directly adapt the low-level picker. */
export const INTERNAL_PERSONA_WORKFLOW_PATHS = new Map<string, string>([
  ["src/utils/discord/ui/interactionCore.ts", "low-level Discord interaction primitive"],
  ["src/utils/discord/ui/personaWorkflow.ts", "command-facing persona workflow implementation"],
]);

/** Source roots covered by the boundary audit. */
export const PERSONA_WORKFLOW_AUDIT_DIRS = ["src"] as const;

export const PERSONA_WORKFLOW_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export type PersonaWorkflowViolationKind =
  | "low-level-picker-import"
  | "low-level-picker-call"
  | "low-level-picker-reference"
  | "preserved-selected-interaction"
  | "empty-picker-on-select"
  | "self-acknowledging-on-selected"
  | "competing-persona-helper";

/** One forbidden persona-picker pattern found in source. */
export interface PersonaWorkflowBoundaryViolation {
  /** Repo-relative path with POSIX separators. */
  file: string;
  /** 1-based source line. */
  line: number;
  /** 1-based source column. */
  column: number;
  kind: PersonaWorkflowViolationKind;
  symbol: string;
  message: string;
}

export interface PersonaWorkflowBoundaryAuditResult {
  violations: PersonaWorkflowBoundaryViolation[];
  scannedFiles: number;
}

/** Normalize a path for deterministic checks and output on every OS. */
export function normalizePersonaWorkflowPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }

  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isEmptyFunction(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) return false;
  return ts.isBlock(unwrapped.body) && unwrapped.body.statements.length === 0;
}

function isTrueLiteral(expression: ts.Expression): boolean {
  return unwrapExpression(expression).kind === ts.SyntaxKind.TrueKeyword;
}

function isRestrictedImportIdentifier(node: ts.Identifier): boolean {
  return (
    ts.isImportSpecifier(node.parent) ||
    ts.isExportSpecifier(node.parent) ||
    ts.isImportClause(node.parent) ||
    ts.isNamespaceImport(node.parent)
  );
}

function isCallTargetIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  return ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isCallExpression(parent.parent);
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node)
  );
}

function isLowLevelPickerCallee(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === LOW_LEVEL_PICKER || aliases.has(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === LOW_LEVEL_PICKER;
  }
  if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
    const argument = unwrapExpression(callee.argumentExpression);
    return ts.isStringLiteralLike(argument) && argument.text === LOW_LEVEL_PICKER;
  }
  return false;
}

function objectHasProperty(object: ts.ObjectLiteralExpression, propertyName: string): boolean {
  return object.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === propertyName;
    return ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName;
  });
}

function isDirectPickerOptionsObject(
  object: ts.ObjectLiteralExpression,
  lowLevelPickerAliases: ReadonlySet<string>,
): boolean {
  let expression: ts.Expression = object;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent)
  ) {
    expression = expression.parent;
  }

  const parent = expression.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => unwrapExpression(argument) === object) &&
    isLowLevelPickerCallee(parent.expression, lowLevelPickerAliases)
  );
}

function looksLikePickerOptions(
  object: ts.ObjectLiteralExpression,
  lowLevelPickerAliases: ReadonlySet<string>,
): boolean {
  return (
    isDirectPickerOptionsObject(object, lowLevelPickerAliases) ||
    objectHasProperty(object, "personas") ||
    objectHasProperty(object, PRESERVE_SELECTED_INTERACTION)
  );
}

function collectImportedAliases(sourceFile: ts.SourceFile, importedName: string): Set<string> {
  const aliases = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      const originalName = element.propertyName?.text ?? element.name.text;
      if (originalName === importedName) aliases.add(element.name.text);
    }
  }

  return aliases;
}

/**
 * Calls that acknowledge an interaction outright, as opposed to the in-place update and
 * defer-update the workflow performs on the anchor message. A selection callback that makes one
 * of these claims an interaction the anchor already owns, and Discord answers it as a failure.
 *
 * `deferReply` is only ever an interaction acknowledgement, so it is forbidden whatever it is
 * called on. `reply` is not: the workflow hands the callback a `beginSeparatePublicReply()` phase
 * whose whole purpose is to post a second message, so that call is legitimate and is identified by
 * the phase type in `isPublicReplyPhaseReceiver` rather than by its method name.
 */
const SELF_ACKNOWLEDGEMENT_CALLS = new Set(["deferReply"]);
const PUBLIC_REPLY_METHOD = "reply";

/** Calls returning the workflow's separate-public-message phase rather than an acknowledgement. */
const PUBLIC_REPLY_PHASE_FACTORIES = new Set(["beginSeparatePublicReply"]);

/** Type names carrying a `reply` that posts the workflow's separate public message. */
const PUBLIC_REPLY_PHASE_TYPES = new Set(["PersonaWorkflowPublicReplyPhase"]);

/**
 * Names the type behind a receiver by resolving its declaration in the same body. Both the annotated
 * `const phase: T = ...` and the inferred `const phase = selection.beginSeparatePublicReply(...)`
 * shapes resolve, because the workflow documents the second and commands use it. A receiver that
 * resolves to nothing stays subject to the rule rather than being excused by an unresolvable name.
 *
 * Resolution is by name within the nearest enclosing function: the receiver is a sibling reference to
 * the declaration, not a descendant of it, so walking ancestors alone never reaches it.
 */
function resolvedTypeName(receiver: ts.Expression): string | null {
  const unwrapped = unwrapExpression(receiver);
  if (!ts.isIdentifier(unwrapped)) return null;
  const name = unwrapped.text;

  let scope: ts.Node | undefined = unwrapped;
  while (scope && !ts.isSourceFile(scope)) {
    if (ts.isFunctionLike(scope)) break;
    scope = scope.parent;
  }
  if (!scope) return null;

  let found: string | null = null;
  const search = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const type = node.type;
      if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        found = type.typeName.text;
        return;
      }
      // Awaited here rather than in the shared `unwrapExpression`, whose other callers reason about
      // empty functions and boolean literals where an awaited value is not the same expression.
      let initializer = node.initializer;
      while (initializer && ts.isAwaitExpression(initializer)) initializer = initializer.expression;
      if (initializer) {
        const call = unwrapExpression(initializer);
        if (ts.isCallExpression(call)) {
          const callee = unwrapExpression(call.expression);
          if (ts.isPropertyAccessExpression(callee)) found = callee.name.text;
          else if (ts.isIdentifier(callee)) found = callee.text;
        }
      }
      return;
    }
    ts.forEachChild(node, search);
  };
  search(scope);
  return found;
}

function isPublicReplyPhaseReceiver(receiver: ts.Expression): boolean {
  const typeName = resolvedTypeName(receiver);
  return typeName !== null && (PUBLIC_REPLY_PHASE_TYPES.has(typeName) || PUBLIC_REPLY_PHASE_FACTORIES.has(typeName));
}

/** The callback whose body must not acknowledge, named as the workflow's options declare it. */
const WORKFLOW_ON_SELECTED = "onSelected";

/**
 * Every function expression or declaration a property initializer can present as a callback.
 * Returns more than one entry only for a conditional or logical expression, where either branch
 * is still a callback body and so both are scanned.
 */
function callbackBodies(initializer: ts.Expression): ts.FunctionLikeDeclaration[] {
  const unwrapped = unwrapExpression(initializer);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return [unwrapped];
  if (ts.isConditionalExpression(unwrapped)) {
    return [...callbackBodies(unwrapped.whenTrue), ...callbackBodies(unwrapped.whenFalse)];
  }
  if (ts.isBinaryExpression(unwrapped)) {
    return [...callbackBodies(unwrapped.left), ...callbackBodies(unwrapped.right)];
  }
  return [];
}

function scriptKindForPath(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Scan one TypeScript source string for forbidden persona-workflow patterns.
 * Comments and string contents are ignored naturally by the TypeScript AST.
 */
export function scanPersonaWorkflowSource(
  content: string,
  file = "src/unknown.ts",
): PersonaWorkflowBoundaryViolation[] {
  const normalizedFile = normalizePersonaWorkflowPath(file);
  if (INTERNAL_PERSONA_WORKFLOW_PATHS.has(normalizedFile)) return [];

  const sourceFile = ts.createSourceFile(
    normalizedFile,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(normalizedFile),
  );
  const lowLevelPickerAliases = collectImportedAliases(sourceFile, LOW_LEVEL_PICKER);
  const competingHelperAliases = collectImportedAliases(sourceFile, COMPETING_PERSONA_HELPER);
  const violations: PersonaWorkflowBoundaryViolation[] = [];
  const seen = new Set<string>();

  const addViolation = (
    node: ts.Node,
    kind: PersonaWorkflowViolationKind,
    symbol: string,
    message: string,
  ): void => {
    const start = node.getStart(sourceFile);
    const key = `${kind}:${start}`;
    if (seen.has(key)) return;
    seen.add(key);

    const location = sourceFile.getLineAndCharacterOfPosition(start);
    violations.push({
      file: normalizedFile,
      line: location.line + 1,
      column: location.character + 1,
      kind,
      symbol,
      message,
    });
  };

  /**
   * Scans one callback body for an acknowledgement call on the interaction. The workflow's own
   * acknowledgement is not visible here: it happens through the message controller's in-place
   * methods, which are not named like Discord's interaction acknowledgement methods.
   */
  const walkForSelfAcknowledgement = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const isAcknowledgement =
          SELF_ACKNOWLEDGEMENT_CALLS.has(method) ||
          (method === PUBLIC_REPLY_METHOD && !isPublicReplyPhaseReceiver(callee.expression));
        if (isAcknowledgement) {
          addViolation(
            callee.name,
            "self-acknowledging-on-selected",
            method,
            `A selection callback must not call ${method}() on the interaction; the anchor workflow owns acknowledgement.`,
          );
        }
      }
    }
    ts.forEachChild(node, walkForSelfAcknowledgement);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === LOW_LEVEL_PICKER) {
      if (isRestrictedImportIdentifier(node)) {
        addViolation(
          node,
          "low-level-picker-import",
          LOW_LEVEL_PICKER,
          "Import the command-facing persona workflow instead of the low-level picker.",
        );
      } else if (isCallTargetIdentifier(node)) {
        addViolation(
          node,
          "low-level-picker-call",
          LOW_LEVEL_PICKER,
          "Invoke the command-facing persona workflow instead of the low-level picker.",
        );
      } else {
        addViolation(
          node,
          "low-level-picker-reference",
          LOW_LEVEL_PICKER,
          "Do not expose or retain references to the low-level picker outside its internal boundary.",
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const isAliasedLowLevelCall = ts.isIdentifier(callee) && lowLevelPickerAliases.has(callee.text);
      const isStringIndexedLowLevelCall =
        ts.isElementAccessExpression(callee) &&
        Boolean(callee.argumentExpression) &&
        ts.isStringLiteralLike(unwrapExpression(callee.argumentExpression!)) &&
        (unwrapExpression(callee.argumentExpression!) as ts.StringLiteralLike).text === LOW_LEVEL_PICKER;

      if (isAliasedLowLevelCall || isStringIndexedLowLevelCall) {
        addViolation(
          callee,
          "low-level-picker-call",
          LOW_LEVEL_PICKER,
          "Invoke the command-facing persona workflow instead of the low-level picker.",
        );
      }

      if (ts.isIdentifier(callee) && competingHelperAliases.has(callee.text)) {
        addViolation(
          callee,
          "competing-persona-helper",
          COMPETING_PERSONA_HELPER,
          "Remove the competing persona-selection helper and use the anchor workflow.",
        );
      }
    }

    if (ts.isIdentifier(node) && node.text === COMPETING_PERSONA_HELPER) {
      const location = isRestrictedImportIdentifier(node)
        ? "import"
        : isCallTargetIdentifier(node)
          ? "call"
          : isDeclarationIdentifier(node)
            ? "declaration"
            : "reference";
      addViolation(
        node,
        "competing-persona-helper",
        COMPETING_PERSONA_HELPER,
        `Remove this competing persona-selection helper ${location} and use the anchor workflow.`,
      );
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (name === PRESERVE_SELECTED_INTERACTION && isTrueLiteral(node.initializer)) {
        addViolation(
          node,
          "preserved-selected-interaction",
          PRESERVE_SELECTED_INTERACTION,
          "The persona workflow owns selected-interaction preservation.",
        );
      }

      if (
        name === PICKER_ON_SELECT &&
        isEmptyFunction(node.initializer) &&
        ts.isObjectLiteralExpression(node.parent) &&
        looksLikePickerOptions(node.parent, lowLevelPickerAliases)
      ) {
        addViolation(
          node,
          "empty-picker-on-select",
          PICKER_ON_SELECT,
          "Remove the empty picker callback; selection is returned by the persona workflow.",
        );
      }

      if (name === WORKFLOW_ON_SELECTED) {
        for (const callback of callbackBodies(node.initializer)) {
          if (!callback.body) continue;
          walkForSelfAcknowledgement(callback.body);
        }
      }
    }

    if (
      ts.isMethodDeclaration(node) &&
      propertyNameText(node.name) === PICKER_ON_SELECT &&
      node.body?.statements.length === 0 &&
      ts.isObjectLiteralExpression(node.parent) &&
      looksLikePickerOptions(node.parent, lowLevelPickerAliases)
    ) {
      addViolation(
        node,
        "empty-picker-on-select",
        PICKER_ON_SELECT,
        "Remove the empty picker callback; selection is returned by the persona workflow.",
      );
    }

    if (ts.isMethodDeclaration(node) && propertyNameText(node.name) === WORKFLOW_ON_SELECTED && node.body) {
      walkForSelfAcknowledgement(node.body);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations.sort((a, b) => a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const absolute = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : Promise.resolve([absolute]);
    }),
  );
  return files.flat();
}

/** Audit the real repository source tree using the same scanner as the unit tests. */
export async function auditPersonaWorkflowBoundary(): Promise<PersonaWorkflowBoundaryAuditResult> {
  const candidates: string[] = [];
  for (const directory of PERSONA_WORKFLOW_AUDIT_DIRS) {
    const files = await listFiles(resolve(PERSONA_WORKFLOW_REPO_ROOT, directory));
    candidates.push(...files.filter((file) => /\.(?:[cm]?ts|tsx)$/.test(file)));
  }

  candidates.sort((a, b) => a.localeCompare(b));
  const violations: PersonaWorkflowBoundaryViolation[] = [];
  let scannedFiles = 0;

  for (const absolute of candidates) {
    const relativePath = normalizePersonaWorkflowPath(relative(PERSONA_WORKFLOW_REPO_ROOT, absolute));
    if (INTERNAL_PERSONA_WORKFLOW_PATHS.has(relativePath)) continue;
    scannedFiles++;
    violations.push(...scanPersonaWorkflowSource(await readFile(absolute, "utf8"), relativePath));
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind),
  );
  return { violations, scannedFiles };
}
