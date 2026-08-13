type PromptConditionNamespace = "capability" | "tool" | "tool_family";

export interface PromptConditionPredicate {
  namespace: PromptConditionNamespace;
  name: string;
  inverted: boolean;
}

type PromptConditionalNode =
  | { type: "text"; text: string }
  | {
      type: "conditional";
      rawCondition: string;
      predicate: PromptConditionPredicate;
      truthy: PromptConditionalNode[];
      falsy: PromptConditionalNode[];
    };

interface ConditionalFrame {
  rawCondition: string;
  predicate: PromptConditionPredicate | null;
  truthy: PromptConditionalNode[];
  falsy: PromptConditionalNode[];
  activeBranch: "truthy" | "falsy";
  malformed: boolean;
}

export interface PromptConditionalRenderOptions {
  evaluate(predicate: PromptConditionPredicate): Promise<boolean | undefined> | boolean | undefined;
  warn(message: string): void;
}

const CONDITIONAL_DIRECTIVE_REGEX = /\{\{\s*(\/?if\b[^{}]*|else\b[^{}]*)\s*\}\}/gi;
const CONDITION_REGEX = /^(!)?(capability|tool|tool_family):([a-z0-9][a-z0-9_.-]*)$/i;

function parsePredicate(rawCondition: string): PromptConditionPredicate | null {
  const match = rawCondition.trim().match(CONDITION_REGEX);
  if (!match) return null;

  return {
    namespace: match[2].toLowerCase() as PromptConditionNamespace,
    name: match[3].toLowerCase(),
    inverted: match[1] === "!",
  };
}

function appendNode(root: PromptConditionalNode[], stack: ConditionalFrame[], node: PromptConditionalNode): void {
  const frame = stack.at(-1);
  if (!frame) {
    root.push(node);
    return;
  }

  frame[frame.activeBranch].push(node);
}

function parseConditionalNodes(text: string, warn: (message: string) => void): PromptConditionalNode[] {
  const root: PromptConditionalNode[] = [];
  const stack: ConditionalFrame[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CONDITIONAL_DIRECTIVE_REGEX)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      appendNode(root, stack, { type: "text", text: text.slice(cursor, index) });
    }

    const directive = match[1].trim();
    const lowerDirective = directive.toLowerCase();

    if (lowerDirective.startsWith("if")) {
      const rawCondition = directive.slice(2).trim();
      stack.push({
        rawCondition,
        predicate: parsePredicate(rawCondition),
        truthy: [],
        falsy: [],
        activeBranch: "truthy",
        malformed: rawCondition.length === 0,
      });
    } else if (lowerDirective.startsWith("else")) {
      const frame = stack.at(-1);
      if (!frame) {
        warn("Found {{else}} without a matching {{if}} block");
      } else if (lowerDirective !== "else" || frame.activeBranch === "falsy") {
        frame.malformed = true;
      } else {
        frame.activeBranch = "falsy";
      }
    } else {
      const frame = stack.pop();
      if (!frame) {
        warn("Found {{/if}} without a matching {{if}} block");
      } else if (lowerDirective !== "/if" || frame.malformed || !frame.predicate) {
        warn(`Omitted malformed prompt conditional: {{if ${frame.rawCondition}}}`);
      } else {
        appendNode(root, stack, {
          type: "conditional",
          rawCondition: frame.rawCondition,
          predicate: frame.predicate,
          truthy: frame.truthy,
          falsy: frame.falsy,
        });
      }
    }

    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    appendNode(root, stack, { type: "text", text: text.slice(cursor) });
  }

  for (const frame of stack) {
    warn(`Omitted unclosed prompt conditional: {{if ${frame.rawCondition}}}`);
  }

  return root;
}

const ENDS_WITH_BLANK_LINE = /\n[^\S\n]*\n[^\S\n]*$/;
const LEADING_BLANK_LINE = /^[^\S\n]*\n[^\S\n]*\n/;

async function renderNodes(nodes: PromptConditionalNode[], options: PromptConditionalRenderOptions): Promise<string> {
  let output = "";
  // A block authored as its own paragraph is wrapped in blank-line separators on
  // both sides. When it renders to nothing those separators meet and stack into
  // an empty paragraph, so one of them is dropped. Only the separator adjacent to
  // an emptied block is touched; text inside a selected branch stays verbatim.
  let dropLeadingBlankLine = false;

  for (const node of nodes) {
    if (node.type === "text") {
      output += dropLeadingBlankLine ? node.text.replace(LEADING_BLANK_LINE, "") : node.text;
      dropLeadingBlankLine = false;
      continue;
    }

    const evaluated = await options.evaluate(node.predicate);
    if (evaluated === undefined) {
      options.warn(`Unknown prompt condition: ${node.rawCondition}`);
    }
    const matches = evaluated === undefined ? false : node.predicate.inverted ? !evaluated : evaluated;
    const branch = await renderNodes(matches ? node.truthy : node.falsy, options);
    output += branch;
    dropLeadingBlankLine = branch === "" && ENDS_WITH_BLANK_LINE.test(output);
  }

  return output;
}

/**
 * Renders TomoriBot's scoped prompt conditionals while preserving selected branch
 * text verbatim. The one exception is the blank-line separator immediately after a
 * block that rendered to nothing, which is dropped so a disabled paragraph does not
 * leave an empty one behind.
 */
export async function renderPromptConditionals(text: string, options: PromptConditionalRenderOptions): Promise<string> {
  if (!text || /\{\{\s*#if\b/i.test(text) || !/\{\{\s*(?:\/?if\b|else\b)/i.test(text)) {
    return text;
  }

  return renderNodes(parseConditionalNodes(text, options.warn), options);
}
