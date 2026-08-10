import { escapeRegExp } from "./regexUtils";
import { resolvePersonaMentionHandle } from "@/utils/text/personaMentionHandles";
import { normalizeParticipantAlias } from "@/utils/text/participants/aliases";

/**
 * Strips curly braces from unknown template placeholders in text, leaving only the inner word.
 * Valid identity placeholders and their double-brace variants are preserved.
 * This prevents LLM-generated `{username}` artifacts from appearing literally in stored
 * memories or Discord messages when the model incorrectly imitates the `{user}` convention.
 * @param text - Text that may contain erroneous `{word}` placeholders
 */
export function sanitizeUnknownTemplatePlaceholders(text: string): string {
  const result = text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, inner: string) =>
    /^(user|user_formatted|user_term|bot|char)$/i.test(inner) ? `{{${inner}}}` : inner,
  );
  return result.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, inner: string) =>
    /^(user|user_formatted|user_term|bot|char)$/i.test(inner) ? `{${inner}}` : inner,
  );
}

/**
 * Replaces template variables in a text string with their corresponding values.
 * Supports both `{name}` and `{{name}}` syntaxes, and normalises `char` as an alias for `bot`.
 * @param text - The template string containing placeholders to be replaced
 */
export function replaceTemplateVariables(text: string, variables: Record<string, string | undefined>): string {
  let result = text;
  const normalizedVariables: Record<string, string | undefined> = {
    ...variables,
    char: variables.char ?? variables.bot,
  };

  for (const [placeholder, value] of Object.entries(normalizedVariables)) {
    if (!value) continue;

    const escapedPlaceholder = escapeRegExp(placeholder);
    const doubleBraceRegex = new RegExp(`\\{\\{\\s*${escapedPlaceholder}\\s*\\}\\}`, "gi");
    const singleBraceRegex = new RegExp(`\\{\\s*${escapedPlaceholder}\\s*\\}`, "gi");
    result = result.replace(doubleBraceRegex, value);
    result = result.replace(singleBraceRegex, value);
  }

  return result;
}

/**
 * Normalizes custom Discord emoji tags into :name: for LLM context.
 * Skips code blocks and inline code to preserve literal examples.
 * @param text - Raw message content from Discord
 */
export function normalizeCustomEmojisForLlm(text: string): string {
  if (!text) return text;

  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let processedText = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  processedText = processedText.replace(/`[^`]*`/g, (match) => {
    inlineCode.push(match);
    return `__INLINE_CODE_${inlineCode.length - 1}__`;
  });

  processedText = processedText.replace(/<(a?):([^:>]+):\d{17,20}>/g, (_match, _animated, name) => `:${name}:`);

  for (let i = inlineCode.length - 1; i >= 0; i--) {
    processedText = processedText.replace(`__INLINE_CODE_${i}__`, inlineCode[i]);
  }
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    processedText = processedText.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  return processedText;
}

/**
 * Converts @{name} mention handles into Discord mentions using a provided lookup.
 * Also handles the LLM hallucination variants @(name) and @[name].
 * Skips code blocks and inline code to preserve literal examples.
 * @param text - Raw text from LLM output
 * @param mentionIdSet - Set of known user IDs for disambiguation
 */
export function replaceMentionHandles(
  text: string,
  mentionMap?: Map<string, string[]>,
  mentionIdSet?: Set<string>,
  personaMentionMap?: ReadonlyMap<string, string>,
): string {
  if (!text || ((!mentionMap || mentionMap.size === 0) && (!personaMentionMap || personaMentionMap.size === 0))) {
    return text;
  }

  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let processedText = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  processedText = processedText.replace(/`[^`]*`/g, (match) => {
    inlineCode.push(match);
    return `__INLINE_CODE_${inlineCode.length - 1}__`;
  });

  function resolveHandle(handle: string, match: string): string {
    if (!handle) return match;

    const pipeIndex = handle.lastIndexOf("|");
    if (pipeIndex > -1) {
      const idPart = handle.slice(pipeIndex + 1).trim();
      const namePart = handle.slice(0, pipeIndex).trim();
      if (/^\d{17,20}$/.test(idPart) && mentionIdSet?.has(idPart)) return `<@${idPart}>`;
      const personaMention = resolvePersonaMentionHandle(namePart, personaMentionMap);
      if (personaMention) return personaMention;
    }

    if (/^\d{17,20}$/.test(handle) && mentionIdSet?.has(handle)) return `<@${handle}>`;

    const normalizedHandle = normalizeParticipantAlias(handle);
    const ids = mentionMap?.get(normalizedHandle);
    if (!ids || ids.length !== 1) {
      const personaMention = resolvePersonaMentionHandle(handle, personaMentionMap);
      if (personaMention) return personaMention;
    }
    if (!ids || ids.length !== 1) return handle;
    return `<@${ids[0]}>`;
  }

  processedText = processedText.replace(/@\{([^}]+)\}/g, (match, rawHandle) =>
    resolveHandle((rawHandle as string).trim(), match),
  );

  processedText = processedText.replace(/@\(([^)]+)\)/g, (match, rawHandle) =>
    resolveHandle((rawHandle as string).trim(), match),
  );

  processedText = processedText.replace(/@\[([^\]]+)\]/g, (match, rawHandle) =>
    resolveHandle((rawHandle as string).trim(), match),
  );

  if (personaMentionMap && personaMentionMap.size > 0) {
    const multiWordAliases = [...personaMentionMap.keys()]
      .filter((alias) => /\s/.test(alias))
      .sort((a, b) => b.length - a.length);

    for (const alias of multiWordAliases) {
      const canonicalTrigger = personaMentionMap.get(alias);
      if (!canonicalTrigger) continue;
      const aliasPattern = alias.split(/\s+/).map(escapeRegExp).join("\\s+");
      processedText = processedText.replace(
        new RegExp(`(^|[^\\p{L}\\p{N}_<])@${aliasPattern}(?=$|[^\\p{L}\\p{N}_-])`, "giu"),
        (_match, prefix) => `${prefix}@${canonicalTrigger}`,
      );
    }
  }

  processedText = processedText.replace(
    /(^|[^\p{L}\p{N}_<])@([\p{L}\p{N}_][\p{L}\p{N}_ -]*)\|(\d{17,20})/giu,
    (_match, prefix, rawHandle, idPart) => {
      if (mentionIdSet?.has(idPart)) return `${prefix}<@${idPart}>`;
      const personaMention = resolvePersonaMentionHandle((rawHandle as string).trim(), personaMentionMap);
      if (personaMention) return `${prefix}${personaMention}`;
      return `${prefix}${rawHandle}|${idPart}`;
    },
  );

  processedText = processedText.replace(
    /(^|[^\p{L}\p{N}_<])@(?!(?:\{|everyone\b|here\b))([\p{L}\p{N}_][\p{L}\p{N}_-]{0,31})/giu,
    (match, prefix, rawHandle) => {
      const handle = (rawHandle as string).trim();
      if (!handle) return match;
      const normalizedHandle = normalizeParticipantAlias(handle);
      const ids = mentionMap?.get(normalizedHandle);
      if (!ids || ids.length !== 1) {
        const personaMention = resolvePersonaMentionHandle(handle, personaMentionMap);
        if (personaMention) return `${prefix}${personaMention}`;
      }
      if (!ids || ids.length !== 1) return `${prefix}${handle}`;
      return `${prefix}<@${ids[0]}>`;
    },
  );

  for (let i = inlineCode.length - 1; i >= 0; i--) {
    processedText = processedText.replace(`__INLINE_CODE_${i}__`, inlineCode[i]);
  }
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    processedText = processedText.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  return processedText;
}
