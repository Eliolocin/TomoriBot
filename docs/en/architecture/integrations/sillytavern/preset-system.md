---
title: "SillyTavern Preset System"
---

> Import and use SillyTavern (ST) presets to control how TomoriBot assembles LLM prompts.

## Overview

SillyTavern presets are JSON files that define:

1. **Prompt node ordering** — where character info, instructions, chat history, etc. appear in the final prompt
2. **Custom prompt injection** — additional instructions, output format rules, task descriptions inserted at specific positions
3. **Depth-based insertion** — placing prompts relative to the end of chat history
4. **Template macros** — variables like `{{setvar::X::Y}}` / `{{getvar::X}}` for dynamic content
5. **Per-node enable/disable** — users toggle individual prompt nodes on or off

This is distinct from [SillyTavern Card Import](/architecture/integrations/sillytavern/card-support/), which imports character data (description, personality, sample dialogues). Presets control *how the prompt is structured*, not *what character data exists*.

## How It Works (User Perspective)

1. User imports an ST preset JSON via `/st-preset import`
2. The preset becomes active for that server
3. On every LLM call, the context builder detects the active preset and rearranges blocks accordingly
4. The `/sysprompt` and personality settings still apply — the preset controls *where* they appear, not *whether* they exist
5. If no preset is active, the system uses the native fixed context assembly (see [Context Assembly](../ai/context-assembly))
6. Removing or deactivating the preset reverts to native assembly instantly

## Current Status

- **Phase 1: Import & Visualization** — implemented
- **Phase 2: Template Engine** — implemented
- **Phase 3: Context Assembly Override** — implemented
- **Phase 4: Management Commands** — not yet implemented (`/st-preset activate`, `/st-preset deactivate`, `/st-preset delete`)

## Commands

For a user-facing explanation of behavior, surprises, and limitations in SillyTavern terms, open `/help`, choose **Integrations**, then **SillyTavern Presets**.

### `/st-preset import`

Imports a SillyTavern preset JSON file and stores it for the current server.

**Flow:**
1. User attaches a `.json` file to the slash command
2. Bot validates the file (format, size <= 2 MB, and a supported preset shape)
3. If the preset already has a Prompt Manager `prompts` array, parses `prompt_order` (prefers `character_id 100001`, falls back to `100000`) to determine node sequence and default enabled states
4. If the preset is an older text-completions export with `context.story_string` + `sysprompt.content`, converts that legacy layout into synthetic Prompt Manager-style nodes and markers
5. Normalizes legacy post-history fields carried by modern or converted presets into synthetic depth-injection nodes
6. Filters out comment-only nodes (content resolves to empty after macro stripping)
7. Stores preset metadata + raw JSON in `st_presets`, individual nodes in `st_preset_nodes`
8. Activates the preset for the server
9. Replies with an import summary (total nodes, markers, toggleable count, and warnings for enabled unsupported macros)

**Preset name:** Derived from the uploaded filename (minus `.json` extension), truncated to 100 chars. Must be unique per server.

**Legacy compatibility:** TomoriBot accepts modern Prompt Manager presets directly. It also accepts older text-completions presets when they provide `context.story_string` + `sysprompt.content`; those are converted best-effort into synthetic Prompt Manager-style nodes at import time. In both shapes, extra legacy `post_history` fields such as root `post_history`, `sysprompt.post_history`, or `context.post_history` are converted into synthetic depth-injection nodes instead of being ignored.

### `/st-preset node toggle`

Shows a modal with checkbox groups representing the preset's toggleable prompt nodes.

**Flow:**
1. Loads the active preset for the server (or falls back to the first available)
2. Queries `st_preset_nodes` for non-marker nodes ordered by `node_order`
3. Chunks nodes into up to 5 checkbox groups (10 options each, 50 max per modal)
4. If more than 50 nodes, shows page-selection buttons first (up to 9 pages)
5. Modal title = preset name (dynamic, truncated at 45 chars by Discord)
6. On submit, persists changed enabled states and invalidates the preset cache

### `/st-preset remove`

Deletes the currently active SillyTavern preset for this server, reverting context assembly to native fixed-block order.

**Flow:**
1. Loads the active preset for the server
2. If no active preset, replies with "nothing to remove"
3. Deletes the preset (cascade deletes all nodes) and invalidates the preset cache
4. Replies with confirmation

### Missing Commands (Phase 4)

| Command | DB Function | Purpose |
|---------|-------------|---------|
| `/st-preset activate` | `setActivePreset()` | Switch between uploaded presets |
| `/st-preset list` | `loadPresetsForServer()` | Show all presets for the server |

## Template Engine (Phase 2)

The template engine resolves ST-specific macros in preset node content at context build time. Located in `src/utils/text/stPresetEngine.ts`.

### Two-Pass Variable Resolution

**Pass 1 — Collect vars**: Walk all enabled non-marker nodes in `node_order`, applying variable declarations into a shared `Map<string, string>`.

- `{{setvar::key::value}}` replaces the current value for the key
- `{{addvar::key::value}}` appends to the current value for the key

**Pass 2 — Resolve everything**: For each enabled non-marker node:
1. Strip `{{// comment }}` blocks
2. Remove `{{setvar::...}}` / `{{addvar::...}}` declarations (already collected)
3. Replace `{{getvar::key}}` from the variable map
4. Expand content macros (`{{personality}}`, `{{description}}`, `{{scenario}}`, `{{mesExamples}}`, `{{lastChatMessage}}`)
5. Evaluate `{{random: A, B, C}}` / `{{random::A::B::C}}` — pick a random item
6. Evaluate `{{roll: XdY}}` — sum X random [1..Y]
7. Process `{{trim}}` — trim whitespace; if empty, mark node as disabled
8. Detect HTML content — set `hasHtmlWarning` flag

After preset rearrangement, `buildContext()` also performs a final random-choice pass over assembled text parts and tail directives. This catches ST preset variants that use single braces, such as `{random::apple::banana}`, and ensures `/tool prompt snapshot` shows the same rolled text the provider receives.

### Identity Macros

`{{user}}`, `{{char}}`, and `{{bot}}` are intentionally **not** resolved by the template engine. They are left intact for downstream resolution by `convertMentions()` in the context builder, which applies the stable "User" placeholder optimization for system-role content.

### Content Macro Deduplication

The engine tracks which content macros were expanded with real (non-empty) data in a `Set<string>` called `expandedContentMacros`. This is used by the preset context builder to avoid duplication:

- If a custom node expanded `{{description}}`, the `charDescription` marker skips pulling the native persona prompt block
- If a custom node expanded `{{personality}}`, the `charPersonality` marker skips pulling the native personality block

### Macro Reference

| Macro | Replacement | Source |
|-------|-------------|--------|
| `{{user}}` | Triggerer's display name | *Deferred to convertMentions()* |
| `{{char}}` / `{{bot}}` | Bot's display name | *Deferred to convertMentions()* |
| `{{personality}}` | `tomoriAttributes.join("\n")` | Server personality settings |
| `{{description}}` | `personaPrompt` | Active persona's prompt |
| `{{scenario}}` | `""` (empty) | No TomoriBot equivalent |
| `{{mesExamples}}` | Formatted sample dialogues | `sample_dialogues_in/out` |
| `{{lastChatMessage}}` | Most recent user message | Conversation history |
| `{{setvar::key::value}}` | *(removed from output)* | Sets a variable |
| `{{addvar::key::value}}` | *(removed from output)* | Appends to an existing variable |
| `{{getvar::key}}` | Variable value or `""` | Reads a variable |
| `{{random: A, B, C}}` | Random pick from list | Runtime |
| `{{random::A::B::C}}` | Random pick from list | Runtime |
| `{random: A, B, C}` | Random pick from list | Runtime |
| `{random::A::B::C}` | Random pick from list | Runtime |
| `{{roll: XdY}}` | Dice roll sum | Runtime |
| `{{trim}}` | Trim whitespace | If empty after trim, node is disabled |
| `{{// comment }}` | *(removed)* | Stripped entirely |

### Compatibility Patches

Some presets use additional placeholder conventions that fall outside the official ST macro spec — often because they rely on ST's regex post-processing pipeline (which TomoriBot does not implement) to substitute these tokens. We resolve them directly instead.

All compatibility patches are in one location in `stPresetEngine.ts` for easy auditing.

| Placeholder | Replacement | Observed in |
|-------------|-------------|-------------|
| `<USER>` | Triggerer's display name | Marinara's Spaghetti Recipe |
| `<BOT>` | Bot/persona display name | Marinara's Spaghetti Recipe |

These are case-sensitive (uppercase only) to avoid false positives with lowercase HTML tags.

## Context Assembly Override (Phase 3)

When an active preset exists, the context builder uses a **Build-Then-Rearrange** strategy instead of the fixed native order. Located in `src/utils/text/presetContextBuilder.ts`.

### Transformation Example

To understand what the preset system does, here's a concrete before/after comparison.

**Native assembly (no preset):**
```text
 1. System prompt (/sysprompt)                     [SYSTEM_HUMANIZER_RULES]
 2. Persona prompt (/persona)                      [SYSTEM_HUMANIZER_RULES]
 3. Personality attributes                          [SYSTEM_PERSONALITY]
 4. Server info                                     [KNOWLEDGE_SERVER_INFO]
 5. Server memories                                 [KNOWLEDGE_SERVER_MEMORIES]
 6. Emojis                                          [KNOWLEDGE_SERVER_EMOJIS]
 7. Stickers                                        [KNOWLEDGE_SERVER_STICKERS]
 8. Users in conversation                           [KNOWLEDGE_USERS_IN_CONVERSATION]
 9. STM                                             [KNOWLEDGE_SHORT_TERM_MEMORY]
10. RAG documents                                   [KNOWLEDGE_SERVER_DOCUMENTS]
11. Conditioning guidance                           [KNOWLEDGE_SERVER_CONDITIONING]
12. Sample dialogues                                [DIALOGUE_SAMPLE]
13. Conversation history                            [DIALOGUE_HISTORY]
```

**Same blocks after a preset rearranges them** (example preset node order):
```text
 1. [main marker]           → System prompt          ← pulled from SYSTEM_HUMANIZER_RULES
 2. ★ Custom node: "You are a creative writing assistant. Always use vivid language."
 3. [charDescription marker] → Persona prompt         ← pulled from SYSTEM_HUMANIZER_RULES
 4. [charPersonality marker] → Personality attributes  ← pulled from SYSTEM_PERSONALITY
    ↳ FLUSH: Server info, memories, emojis, stickers  ← TomoriBot-only blocks injected here
 5. ★ Custom node: "{{setvar::style::narrative}}"     ← (removed from output, variable stored)
 6. [worldInfoBefore marker] → RAG documents           ← pulled from KNOWLEDGE_SERVER_DOCUMENTS
 7. ★ Custom node: "Write in {{getvar::style}} style." ← resolved to "Write in narrative style."
 8. [dialogueExamples marker]                          ← pulled from DIALOGUE_SAMPLE
    ↳ PRE-FLUSH: Users in conversation, STM, conditioning
                                                       ← TomoriBot-only blocks injected here
 9. [chatHistory marker]    → Conversation history     ← pulled from DIALOGUE_HISTORY
    ↳ Depth injection at depth 0: "Remember to stay in character."  ← merged into last history item
```

Key observations:
- The `/sysprompt` content still appears — it's just at the `main` marker position instead of always being first
- Custom nodes (marked with ★) are new content from the preset, inserted between native blocks
- TomoriBot-only blocks (server info, emojis, etc.) have no ST marker, so they're auto-flushed at anchor points
- `{{setvar}}`/`{{getvar}}` are resolved at build time, not stored in the prompt
- Depth injections merge into existing history items rather than creating new messages
- Marker order is literal: if a preset places `chatHistory` before `dialogueExamples`, the sample dialogues will appear after live history
- If `dialogueExamples` becomes the terminal block, TomoriBot appends a short user-side separator note so strict providers do not treat the final sample assistant turn as the active prompt

### Why Build-Then-Rearrange?

The native `buildContextNative()` remains the fixed-order orchestrator for TomoriBot context blocks, with responsibility-specific helpers extracted under `src/utils/text/context/` for memories, RAG, template/conditioning blocks, and history/media formatting. The preset system still treats native output as tagged buckets and does not duplicate those block builders.

Instead, the preset builder:
1. Calls native `buildContextNative()` to produce **all** blocks (tagged with `metadataTag`)
2. Groups items by tag into consumable "buckets"
3. Walks the preset's node order, pulling from the right bucket at each marker
4. Inserts custom preset nodes at their declared positions

The trade-off: blocks that a preset might not use are still built (minor wasted work). The safety and simplicity gains are massive.

### Routing

At the top of `buildContext()` (the exported entry point):

```text
1. Is user impersonation? → Skip preset, use native (presets are character-centric)
2. Does this server have an active preset? → Check in-memory cache
3. If preset found → build native → rearrange via preset
4. If no preset → use native directly
```

The check uses the preset cache (`getCachedActivePreset()`), which avoids a DB query on every call.

### Marker-to-Tag Mapping

When the preset walker encounters a marker node, it pulls items from the corresponding native bucket:

| ST Marker | ContextItemTag | Native Block | Typical TomoriBot Source |
|-----------|---------------|--------------|--------------------------|
| `main` | `SYSTEM_HUMANIZER_RULES` (first item only), then `SYSTEM_CHANNEL_PROMPT` | System prompt + per-channel append prompt | `/config system-prompt set` (or fallback), plus `/server channel-prompt` in append mode |
| `charDescription` | `SYSTEM_PERSONA_PROMPT` | Persona prompt | `/persona prompt set` |
| `charPersonality` | `SYSTEM_PERSONALITY` | Personality attributes | `/persona attribute add` |
| `dialogueExamples` | `DIALOGUE_SAMPLE` | Sample dialogues | `/persona sample-dialogue add` |
| `chatHistory` | `DIALOGUE_HISTORY` | Conversation history | Live channel message history |
| `worldInfoBefore` | `KNOWLEDGE_SERVER_DOCUMENTS` | RAG documents | Retrieved document context / uploaded docs |
| `worldInfoAfter` | `KNOWLEDGE_SERVER_DOCUMENTS` | RAG documents | Retrieved document context / uploaded docs |

**Special case: `main`** — The `main` marker pulls the first `SYSTEM_HUMANIZER_RULES` item (the system prompt) and then the `SYSTEM_CHANNEL_PROMPT` item if present, keeping a per-channel append prompt directly after the system prompt. In `replace` mode there is no separate channel block — the channel prompt has already taken over the `SYSTEM_HUMANIZER_RULES` content upstream. The persona prompt is carried by `SYSTEM_PERSONA_PROMPT` and pulled by `charDescription`.

These marker-controlled blocks are usually **moved, not removed**. The real suppressions are narrow:
- The built-in fallback system prompt is removed only when a preset is active and the user has not set `/config system-prompt set`
- The native `charDescription` block is skipped only if a custom preset node already expands `{{description}}`
- The native `charPersonality` block is skipped only if a custom preset node already expands `{{personality}}`

### TomoriBot-Only Block Flushing

These blocks have no ST marker equivalent. They are flushed at anchor points during the node walk:

| Blocks | Flushed at | Timing | Notes |
|--------|-----------|--------|-------|
| Server info, memories, emojis, stickers | `charPersonality`, `charDescription`, or `main` marker | After the marker's items | TomoriBot-only automatic context; no ST marker equivalent |
| Users in conversation, STM, conditioning, remaining RAG | `dialogueExamples` or `chatHistory` marker | Before the marker's items | TomoriBot-only automatic context; still included even if the preset omits explicit ST markers |

If the preset doesn't include these anchor markers, remaining blocks are appended at the end before dialogue history.

### Depth Injection (Critical Design)

Nodes with `injection_position: 1` are depth-injected — they target a specific position counting from the end of the conversation history.

**Key constraint:** Depth-injected content is **merged into existing dialogue history items**, not inserted as new standalone messages. This prevents role-alternation violations that would break providers with strict role ordering (Gemini, Anthropic).

```text
depth 0 = append to last history item (closest to model's response)
depth 1 = append to second-to-last item
depth N = append to Nth-from-last item (clamped to first if exceeds length)
```

Multiple injections at the same depth are ordered by `injection_order` (ascending).

#### Batched Injection

All injections targeting the same depth are **batched into a single `[System: ...]` text part** rather than creating one `[System: ...]` per node. This reduces token waste and closely matches SillyTavern's contiguous injection behavior.

For example, a preset with 5 depth-0 nodes (XML wrappers + instructions) produces:

```text
# Before (unbatched — each node gets its own wrapper):
\n[System: </chat_history>]
\n[System: <task>]
\n[System: Write the next response.]
\n[System: </task>]
\n[System: <output_format>]

# After (batched — one wrapper per depth target):
\n[System: </chat_history>
<task>
Write the next response.
</task>
<output_format>]
```

This batching is transparent — the LLM sees the same instructions, just without repeated `[System: ` prefixes.

### Role Mapping

| ST Role | TomoriBot Role |
|---------|---------------|
| `system` | `system` |
| `user` | `user` |
| `assistant` | `model` |

## Preset Caching

Active presets are cached in-memory to avoid a DB query on every `buildContext()` call. Located in `src/utils/cache/stPresetCache.ts`.

| Feature | Detail |
|---------|--------|
| **Cache key** | `server_id` (numeric) |
| **Cached data** | `{ preset: StPresetRow, nodes: StPresetNodeRow[] }` or `null` (no active preset) |
| **TTL** | Configurable via `ST_PRESET_CACHE_TTL_MINUTES` env var (default: 10 minutes) |
| **Invalidation** | On preset activate, deactivate, node toggle, or preset delete |
| **Graceful fallback** | Returns stale cache on DB error |
| **Negative caching** | `null` result is cached to avoid repeated "no preset" queries |

Cache invalidation is called from `stPresetDb.ts` after every successful write operation. The `serverId` parameter is required (not optional) on all write functions to ensure invalidation cannot be accidentally skipped.

## Database Schema

### `st_presets` table

| Column | Type | Description |
|--------|------|-------------|
| preset_id | SERIAL PK | Auto-incrementing primary key |
| server_id | INT FK | References `servers(server_id)`, CASCADE on delete |
| preset_name | TEXT | Display name (unique per server) |
| raw_json | JSONB | Complete original ST preset JSON for re-parsing |
| is_active | BOOLEAN | Whether this is the active preset (one per server) |
| created_at | TIMESTAMP | Import timestamp |
| updated_at | TIMESTAMP | Last modification timestamp |

**Unique constraint:** `(server_id, preset_name)`

### `st_preset_nodes` table

| Column | Type | Description |
|--------|------|-------------|
| node_id | SERIAL PK | Auto-incrementing primary key |
| preset_id | INT FK | References `st_presets(preset_id)`, CASCADE on delete |
| identifier | TEXT | ST node identifier (UUID or well-known name) |
| name | TEXT | Display name from the preset |
| role | TEXT | Message role: `system`, `user`, or `assistant` |
| content | TEXT | Raw prompt text (with unresolved ST macros) |
| is_marker | BOOLEAN | Structural anchor (charDescription, chatHistory, etc.) |
| is_enabled | BOOLEAN | User-togglable enabled state |
| node_order | INT | Position in the preset's prompt_order sequence |
| injection_position | INT | 0 = relative to system prompt, 1 = relative to chat end |
| injection_depth | INT | Messages from end for depth-based insertion |
| injection_order | INT | Priority for tie-breaking at same position+depth |

**Unique constraint:** `(preset_id, identifier)`

## ST Preset Anatomy

### Node Types

When parsing a preset's `prompts` array, nodes fall into three categories:

| Category | Detection | Stored? | Toggleable? |
|----------|-----------|---------|-------------|
| Comment-only | Content is purely `{{// ... }}{{trim}}` | No | No |
| Marker | `marker: true` (structural anchor) | Yes | No |
| Content node | Has real content after macro stripping | Yes | Yes |

### Comment-Only Detection

A node is comment-only if its content matches: `^(\s*\{\{\/\/[^}]*\}\}\s*|\s*\{\{trim\}\}\s*)+$`

Examples of comment-only content:
- `{{// Empty for card override. }}{{trim}}`
- `{{// Choose the narration style. }}{{trim}}`
- `{{// Enable only one out of the list below. }}{{trim}}`

### Well-Known Markers

| Identifier | ST Purpose | TomoriBot Equivalent |
|------------|-----------|---------------------|
| `main` | Main system prompt | System humanizer rules |
| `charDescription` | Character description | Persona description |
| `charPersonality` | Character personality | Personality attributes |
| `scenario` | Scenario text | *(no direct equivalent)* |
| `personaDescription` | User persona | *(no direct equivalent)* |
| `dialogueExamples` | Example dialogues | Sample dialogues |
| `chatHistory` | Conversation log | Conversation history |
| `worldInfoBefore` | World info (before char data) | RAG documents |
| `worldInfoAfter` | World info (after char data) | RAG documents |

Unrecognized markers are logged as warnings and skipped.

### Prompt Order

ST presets have a `prompt_order` array with entries for two scopes:

- **`character_id: 100000`** — System prompt order (well-known markers only)
- **`character_id: 100001`** — User prompt order (custom nodes + markers, preferred when present)

Each entry has `{ identifier, enabled }`. The array order defines the rendering sequence.
TomoriBot prefers the `100001` entry and falls back to `100000` only if `100001` is missing.

## Parity with SillyTavern

This section documents what our implementation supports versus what native SillyTavern does, organized by category.

### Supported Macros

| Macro | Status | Notes |
|-------|--------|-------|
| `{{user}}` | Supported | Deferred to `convertMentions()` |
| `{{char}}` / `{{bot}}` | Supported | Deferred to `convertMentions()` |
| `{{personality}}` | Supported | Maps to `/persona attribute add` values |
| `{{description}}` | Supported | Maps to persona prompt |
| `{{mesExamples}}` | Supported | Maps to sample dialogues |
| `{{lastChatMessage}}` | Supported | Most recent user message |
| `{{scenario}}` | Supported (empty) | Always resolves to `""` — no TomoriBot equivalent |
| `{{setvar::key::value}}` | Supported | Replaces the variable value |
| `{{addvar::key::value}}` | Supported | Appends to the variable value in node order |
| `{{getvar::key}}` | Supported | Unknown keys resolve to `""` |
| `{{random: A, B, C}}` | Supported | Random pick from comma-separated list |
| `{{random::A::B::C}}` | Supported | Legacy random choice syntax |
| `{random: A, B, C}` | Supported | Single-brace random choice syntax resolved by `buildContext()` |
| `{random::A::B::C}` | Supported | Single-brace legacy random choice syntax resolved by `buildContext()` |
| `{{roll: XdY}}` | Supported | Capped at 100 dice, 1000 sides |
| `{{trim}}` | Supported | Node disabled if result is empty |
| `{{// comment}}` | Supported | Stripped from output |
| `{{if capability:name}}...{{else}}...{{/if}}` | Supported | Tests an effective TomoriBot capability setting; `{{else}}` is optional |
| `{{if tool:function_name}}...{{/if}}` | Supported | Tests runtime tool availability, including Deliberate Tool Mode filtering |
| `{{if !capability:name}}...{{/if}}` | Supported | `!` inverts either supported predicate namespace; blocks may be nested |

### Unsupported Macros

| Macro | ST Purpose | Why Not Supported |
|-------|-----------|-------------------|
| `{{summary}}` | Short-term memory summary text | TomoriBot has STM but doesn't expose it as a macro. STM is injected as its own context block instead. |
| `{{group}}` | Multi-character group RP names | TomoriBot is single-character-per-context. Fundamental design difference. |
| `{{persona}}` | User persona description | No user persona system in TomoriBot. |
| `{{input}}` | User-provided text for ST frontend helper prompts | Not available in TomoriBot's preset runtime. |
| `{{mesExamplesRaw}}` | Raw example dialogue block | TomoriBot only exposes formatted `{{mesExamples}}`. |
| `{{#if ...}}` / `{{/if}}` | Legacy conditional template blocks | Not implemented inside modern prompt nodes. Older text-completions presets are converted at import time instead of running these blocks directly. |
| `{{time}}`, `{{date}}`, `{{weekday}}`, `{{isotime}}`, `{{isodate}}` | Date/time formatting | Time/channel info is embedded in the Users in Conversation block automatically, not exposed as macros. |
| `{{idle_duration}}` | Time since last message | Not tracked. |
| `{{maxPrompt}}` | Max token budget | TomoriBot doesn't expose token limits to preset macros. |
| `{{exampleSeparator}}`, `{{chatStart}}` | Dialogue formatting tokens | Sample dialogues use their own formatting. |
| `{{banned_tokens}}`, `{{bias}}` | Logit bias control | Logit bias is controlled separately via `/config`, not from presets. |
| Nested/recursive macros | e.g., `{{getvar::{{getvar::key}}}}` | Only single-level resolution. |

### Unsupported Features

| Feature | ST Behavior | TomoriBot Behavior |
|---------|-----------|-------------------|
| **Regex post-processing** | Find/replace rules applied to generated output | Not implemented. Output is sent as-is. Presets that rely on regex formatting (e.g., stripping XML tags, reformatting narration) will look different. |
| **Legacy text-completions presets** | Old ST preset shape using `context.story_string` + `sysprompt.content` | Best-effort imported by converting the story layout into Prompt Manager-style nodes. Main system prompt, story layout, and post-history map over; ST-only blocks such as `persona`, `scenario`, anchors, stop strings, and old backend settings are still ignored. |
| **Preset settings import** | Temperature, top_p, frequency_penalty, model overrides embedded in preset JSON | Ignored. These remain server-level settings via `/config`. |
| **World Info / Lorebook** | Static knowledge entries with activation keywords, inserted at `worldInfoBefore`/`worldInfoAfter` markers | TomoriBot uses dynamic RAG instead. The `worldInfo` markers pull RAG results, not static lorebook entries. Content may differ significantly. |
| **Token budgeting** | Per-node token limits, total prompt budget management | Not implemented. All enabled nodes are included regardless of token count. Context may exceed provider limits if many large nodes are enabled. |
| **Multiple active presets** | Some ST setups layer presets | One preset per server. By design. |
| **HTML rendering** | ST frontend renders HTML in chat | Discord cannot render HTML. Nodes with HTML are flagged (`hasHtmlWarning`) but not auto-stripped. |
| **Assistant prefill** | `model`-role nodes at end of context force the AI to start with specific text | Passed through, but provider-dependent. Works on some providers (Anthropic), ignored by others (Gemini). |

### Architectural Differences

| Area | SillyTavern | TomoriBot |
|------|------------|-----------|
| **Depth injection** | Inserts new standalone messages at target depth | Merges into existing messages as `[System: ...]` text parts. Same-depth injections are batched into a single `[System: ...]` block for token efficiency. This prevents role-alternation violations on Gemini/Anthropic but may not match exact ST positioning. |
| **TomoriBot-only blocks** | N/A | Server info, server memories, emojis, stickers, user list, STM, and conditioning have no ST markers. They are always included and auto-flushed at anchor points. Users cannot reorder or disable them via the preset. |
| **Variable scope** | May support scoped/local variables | All `{{setvar}}` / `{{addvar}}` variables are global across enabled nodes. No scoping. |
| **`prompt_order` parsing** | Both `character_id: 100000` (system) and `100001` (user) | TomoriBot prefers `100001` and falls back to `100000` only when `100001` is missing. |
| **Character-specific ordering** | Different prompt orders per character card | TomoriBot uses one preset per server regardless of active persona. |

## File Map

| File | Purpose |
|------|---------|
| `src/db/schema_stpreset.sql` | Database table definitions |
| `src/types/db/schema.ts` | `StPresetRow` and `StPresetNodeRow` type definitions |
| `src/utils/db/stPresetDb.ts` | CRUD operations + cache invalidation hooks |
| `src/utils/cache/stPresetCache.ts` | In-memory preset cache with TTL |
| `src/utils/text/stPresetEngine.ts` | Template macro engine (two-pass resolution) |
| `src/utils/text/presetContextBuilder.ts` | Preset-driven context rearrangement |
| `src/utils/text/contextBuilder.ts` | Routing wrapper + native context assembly |
| `src/commands/st-preset/import.ts` | `/st-preset import` command |
| `src/commands/st-preset/remove.ts` | `/st-preset remove` command |
| `src/commands/st-preset/node/toggle.ts` | `/st-preset node toggle` command |
