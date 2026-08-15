---
title: "Code Comment Policy"
---

Comments should explain information that the code cannot express clearly: rationale,
constraints, invariants, compatibility behavior, security boundaries, or surprising
ordering requirements. Do not translate the next statement into English.

## Keep

Keep a comment when removing it would hide useful context, such as:

- why an operation must happen before or after another operation;
- a provider or platform quirk that the implementation works around;
- a security, cache, interaction-timing, or compatibility constraint;
- a non-obvious fallback and the condition that makes it safe;
- a suppression with a concrete reason; or
- an ordered JSDoc procedure whose order is part of the exported contract.

```ts
// Discord rejects a second acknowledgement, so modal branches return before deferral.
if (opensModal) return showModal();
```

## Remove or rewrite

Remove comments that only name the statement below them:

```ts
// Parse and validate composite-key format
const parsedKey = parseCompositeKey(compositeKey);
```

Prefer a clear function or variable name. If important context exists, state that context
instead of narrating the operation.

Also avoid:

- procedural labels such as `// 1. Parse the value` or `// 5c-2. Build the menu`;
- prompt-style scaffolding such as `// Rule 3: Validate input`;
- decorative section banners; and
- commented-out code.

Numbered JSDoc lists remain valid when they describe a genuinely ordered public contract.
Ordinary line comments should not carry step numbers.

## Dashes

Em dashes, en dashes, and spaced double hyphens are not allowed in authored prose. A dash hides
the relationship between the two halves of a sentence: replacing it forces you to name that
relationship, which is what the reader needed.

Pick the substitute by what the sentence is actually doing:

| Relationship | Use | Example |
|---|---|---|
| Second half explains the first | Colon | `Retirement is process-local: a restart refetches every guild's stickers.` |
| Causal | `, so` or `because` | `Discord rejects a second acknowledgement, so modal branches return early.` |
| Aside or gloss | Parentheses | `The probe caches its own failure (until the next restart).` |
| Two independent clauses | Period or semicolon | `The webhook send failed. The bot path is the fallback.` |
| Term and its definition | Colon | `` `large-v3`: ~4-5 GB VRAM `` |
| Numeric range | Plain hyphen | `1-5 minutes`, `50-100 messages` |

If none of these fit, the sentence is usually doing two things at once. Split it.

### Scope

This rule covers every string a human wrote, not only comments:

- code comments and JSDoc;
- documentation pages under `docs/`; and
- user-facing locale strings in `src/locales/`.

Locale strings are included because they are prose that ships to users, and a dash reads no more
clearly in an embed than in a comment. Japanese locale text takes the same rule with Japanese
punctuation: prefer `：` for a definition or explanation, `。` between independent clauses, and
`（）` for an aside. An em dash in a `ja` string is usually an artifact of translating the English
punctuation rather than the English meaning.

The restriction is on prose. A dash that is part of data the code must reproduce exactly stays:
a CLI flag (`--no-build-isolation`), Discord's subtext marker (`-# `), a URL, or quoted output
from another system. Record those in the exception file only if the checker actually flags them.

## No meta commentary

A comment states a constraint the reader must respect. It is not a record of the work that
produced the line. Keep out:

- **Incident and changelog narrative.** "this was the biggest consumer before we fixed it",
  "added after last quarter's outage". Git history already holds this, and the comment cannot be
  kept accurate.
- **Point-in-time measurements.** Concrete counts, sizes, or timings sampled once. They read as
  current facts and silently become false. State the constraint, not the sample.
- **Commentary about the comment.** "Two exclusions are load-bearing", "Note the following three
  points", "Important:". If the reader must count the parts, write fewer parts.
- **Justification aimed at a reviewer.** Arguing why a change is safe belongs in the PR
  description; a later maintainer only needs the rule that must hold.

Write the constraint that would still be true a year from now:

```ts
// Never sweep the client's own member: discord.js resolves permissions through it.
```

not the story of how it was found:

```ts
// While chasing a memory leak we measured this cache and it dominated the heap, so we added a
// sweeper. Note that two exclusions are load-bearing here, the first being that discord.js
// resolves permissions through the client's own member.
```

Length is the usual symptom. If a comment runs past two or three lines, the surplus is almost
always narrative rather than constraint.

The same restraint applies to this page and every other doc: examples of bad comments should be
illustrative, not transcribed from production. Deployment sizes, record counts, and host details do
not belong in a public repository. See
[Docs Authoring](/contributing/docs-authoring/) ("Audience: Guide or Runbook").

## JSDoc tags

JSDoc predates TypeScript, where `@param {string} name` was the only way to state a type.
The signature carries that now, so a tag that repeats the parameter name or its type adds
nothing and goes stale independently of the code.

Remove tags that restate the signature:

```ts
/**
 * Extract image URLs from a Brave image search response.
 * @param response - Image search API response   // the type already says this
 * @returns Promise<string[]>                    // so does the return type
 */
```

Keep tags that carry what the type cannot:

```ts
/**
 * @param modes - Empty when the provider reports no capabilities
 * @returns Comma-joined list, or empty string when no modes are supported
 * @throws {NvidiaImageModelUnavailableError} When the codename has no registered spec
 */
```

Units, ranges, valid values, nullability the type does not encode, failure behavior,
ordering and lifecycle guarantees, side effects, and cancellation or idempotency
expectations all earn a tag.

A partial tag list is the expected result, not an oversight. Documenting one parameter and
leaving two undocumented means those two were self-explanatory. Do not "complete" a block by
adding tags that restate the signature, and do not delete a documented tag because its
neighbours have none.

The same rule applies to the summary line above the tags. `Build system prompt for LLM` over
`buildSystemPrompt()` is the identifier in English, so the block goes. Keep it when it
defines a word the name leaves ambiguous:

```ts
/**
 * Finds the most active text channel that's accessible to the bot
 */
export async function findBestChannel(guild: Guild, client: Client): Promise<TextChannel | null>
```

`findBestChannel` never says what "best" measures. The summary names the ranking metric and
the filter, so it stays.

`checkCommentPolicy.ts` enforces the exact tag case as `jsdoc-restatement`, comparing only
after normalization and never on substrings. Summary echoes are heuristic and surface under
`obvious-narration`: a warning during a full audit, an error once the line is in your diff.
Judgment cases stay with review.

## Treat findings as review prompts

The audit is a heuristic reviewer, not a deletion checklist. A zero-warning result is useful
only when the remaining code still explains its non-obvious constraints. Do not make the
counter reach zero by deleting rationale, truncating a multi-line explanation, adding broad
exceptions, or leaving an empty JSDoc block.

For every finding:

1. Read the complete comment or JSDoc block and the code it describes.
2. Remove the comment only when the code already expresses everything it says.
3. Rewrite the block when it mixes narration with rationale, keeping the constraint,
   compatibility behavior, security boundary, or ordering requirement.
4. Re-read the surrounding paragraph after editing. Remove vacated divider lines and JSDoc
   gaps, and make sure no continuation became a sentence fragment.
5. Review the final diff as prose before running the audit again.

`orphaned-comment` catches provable partial-cleanup damage such as an indented continuation
without an opening line, a bare divider remnant, or a completely empty JSDoc block. It cannot
decide whether deleted context was valuable, so human diff review remains required.

## Maintainer audit

```bash
bun run audit-comments
```

`audit-comments` reports subjective narration candidates across the existing tree without
failing. The deterministic rules, `prose-dash` included, fail regardless of audit mode; under
`src/locales/` `prose-dash` reads string literals rather than comments, since the prose there is
the shipped text. It runs as a non-blocking warning under the Documentation section of `bun run vl`,
so contributors can see policy drift without needing to resolve heuristic findings as part
of unrelated work. It remains separate from the normal test runner.

Maintainers can invoke `scripts/checks/checkCommentPolicy.ts` directly for deterministic
checks or pass `--staged` or `--base <ref>` to focus the narration heuristic on changed
lines. The command prints this policy guide before its findings so contributors have the
editing criteria beside the report. Its focused self-test is also manual:

```bash
bun test ./scripts/checks/commentPolicy.test.ts
```

## Exceptions

Literal syntax and live-rule references sometimes contain text that resembles a violation.
Record only those narrow cases in
`scripts/checks/comment-policy-exceptions.json`, including the exact comment and a reason.
The checker reports an exception as stale once the matching comment disappears.

Do not use the exception file as a catalogue of comments removed in past cleanups. Git
history is the durable record for those edits; the exception list exists only for current,
intentional violations.
