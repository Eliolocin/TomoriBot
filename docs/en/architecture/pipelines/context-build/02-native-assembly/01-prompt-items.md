---
title: "02.1: Prompt Items"
---

The top of the context list — the LLM's identity framing.

**File:** `src/utils/text/context/templates.ts:94-197`

## Mission

Emit the `system`-role items that frame the LLM's identity for this
turn: the humanizer block (base behavioral rules), an optional per-channel
prompt block, the persona prompt (the persona's distinctive instructions), and
the tomori-attributes block (the personality bullets). For impersonation turns,
emits a single impersonated-user prompt instead. Other personas' public profile
data belongs to stage 06 participants, not this prompt-item stage.

### Per-channel prompt override (`/config` > Channels > Channel Overrides)

When `channelPromptOverride` is set for the active channel, it modifies only the
system-prompt slot — persona prompt and attributes are never affected:

- **`append`** — the server system prompt (or `DEFAULT_SYSTEM_PROMPT`) stays in
  the `SYSTEM_HUMANIZER_RULES` block, and the channel prompt is emitted as a
  distinct `SYSTEM_CHANNEL_PROMPT` block immediately after it.
- **`replace`** — the channel prompt's text takes over the `SYSTEM_HUMANIZER_RULES`
  block content (no separate channel block is emitted).

The override is resolved at each call site (`contextPipeline.ts`, `cost.ts`,
`snapshot.ts`, `hiddenImageTurn.ts`) via `getCachedChannelPrompt(serverId, channelId)`
and threaded in as `BuildContextParams.channelPromptOverride`. Under an active
SillyTavern preset, `SYSTEM_CHANNEL_PROMPT` rides with the `main` marker so it
stays directly after the system prompt.

## Input

Subset of `BuildContextParams` plus carried state — see signature in
`templates.ts:94-108`. Notable fields:

- `botName`, `tomoriAttributes`, `personaPrompt`
- `tomoriConfig.system_prompt`, `tomoriConfig.personal_memories_enabled`
- `channelPromptOverride` — `{ prompt, mode }` for the active channel, or null
- `isUserImpersonation`, `impersonatedIdentityName`, `impersonatedUserPrompt`
- `suppressDefaultSystemPrompt` — set by the routing wrapper when a preset
  is active and `system_prompt` is empty (preset fully controls the prompt)
- `toolPromptMacroResolver`, `convertMentions` (shared helpers)

## Output

`Promise<StructuredContextItem[]>` — up to four items:

| Condition | Item | Metadata tag |
|---|---|---|
| Not impersonation, `replace` override | Channel prompt (occupies the system-prompt slot) | `SYSTEM_HUMANIZER_RULES` |
| Not impersonation, no replace override, `system_prompt` present OR `!suppressDefaultSystemPrompt` | Humanizer (system prompt or `DEFAULT_SYSTEM_PROMPT`) | `SYSTEM_HUMANIZER_RULES` |
| Not impersonation, `append` override | Channel prompt (distinct block after the humanizer) | `SYSTEM_CHANNEL_PROMPT` |
| Not impersonation, `personaPrompt` present | Persona prompt | `SYSTEM_PERSONA_PROMPT` |
| Impersonation, `impersonatedUserPrompt` present | Impersonated user prompt | `SYSTEM_HUMANIZER_RULES` |
| Not impersonation | `tomoriAttributes.join("\n")` | `SYSTEM_PERSONALITY` |

All emitted items are `role: "system"`.

## Side effects

- **Conditional and tool-macro expansion** — every emitted text passes through
  `toolPromptMacroResolver.expand(...)`. It first removes inactive
  `{{if capability:...}}` / `{{if tool:...}}` branches, then resolves
  `{short_term_memory_tool}` and related names. Text that becomes blank emits no item.
- **Mention conversion** — every emitted text passes through
  `convertMentions(...)` for `<@id>` / `<#id>` / `{bot}` / `{user}`
  resolution. The `triggererName` argument is hardcoded to `"User"` here
  (the prompt items are persona-facing, not user-facing).

## Invariants

After this stage runs:

- For non-impersonation turns with a non-empty `system_prompt` or attributes,
  at least one item is emitted.
- For impersonation turns, *only* the impersonated-user prompt is emitted
  (no persona prompt, no attributes, no humanizer fallback) — keeping the
  prompt strictly about the impersonated identity.
- When `suppressDefaultSystemPrompt` is true and `system_prompt` is empty,
  no humanizer item is emitted — the preset's reassembly is expected to
  provide the system framing.

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `DEFAULT_SYSTEM_PROMPT` constant | Internal — exported from `templates.ts` for callers that need to know what the fallback is, but not user-configurable directly. The `system_prompt` config column is the user-facing surface. |
| Tag emission (`SYSTEM_HUMANIZER_RULES`, `SYSTEM_PERSONA_PROMPT`, `SYSTEM_PERSONALITY`) | The tag scheme is the seam — preset reassembly relies on these tags to slot items into preset blocks. A plugin adding a new prompt-item kind would add a new `ContextItemTag` and document its slot ordering. |
| Impersonation prompt handling | Tightly coupled to chat pipeline's impersonation flow. A plugin adding a new "alternate identity" mode would extend here + chat pipeline stage 02. |

## Configuration

| Source | Field | Effect |
|---|---|---|
| `tomoriConfig` | `system_prompt` | Overrides `DEFAULT_SYSTEM_PROMPT` when present |
| `channelPromptOverride` | `{ prompt, mode }` | `append` adds a `SYSTEM_CHANNEL_PROMPT` block after the system prompt; `replace` substitutes the system-prompt slot content. Set per channel via `/config` > Channels > Channel Overrides. |
| `tomoriConfig` | `personal_memories_enabled` | Passed to `convertMentions` for blacklist/privacy behavior |
| `tomoriConfig` capability flags | `*_enabled` fields exposed through stable prompt names | Resolve `capability:` predicates without exposing database column names |
| `BuildContextParams` | `deliberateToolAllowedNames` | Narrows `tool:` predicates to the current Deliberate Tool Mode scope |
| Tool-family availability | Bundled and guild MCP function names | Resolves `tool_family:url_fetch` without coupling prompt text to one URL-fetch implementation |
| `tomoriState` | `persona_prompt` | The persona's distinctive prompt |
| `tomoriState` | `attribute_list` | Personality bullets (joined with `\n`) |

## Related docs

- Tool-prompt macros: covered in
  [native-assembly README](/architecture/pipelines/context-build/02-native-assembly/#shared-helpers-used-across-contributors).
- Mention conversion: covered in
  [native-assembly README](/architecture/pipelines/context-build/02-native-assembly/#shared-helpers-used-across-contributors).
- SillyTavern preset reassembly: → preset-routing stage
  [`01-preset-routing.md`](../01-preset-routing)
