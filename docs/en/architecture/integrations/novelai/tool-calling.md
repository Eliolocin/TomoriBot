---
title: "NovelAI GLM 4.6 Tool Calling"
---

## Overview

NovelAI's GLM 4.6 model uses **prompt-based tool calling** — tools are defined in the system prompt, and the model generates structured XML blocks when it decides to use a tool. This is fundamentally different from providers like Google Gemini or OpenRouter that have native function calling APIs.

The implementation lives primarily in `src/providers/novelai/novelaiStreamAdapter.ts`.

## Image Generation State

- `generate_image_nai` now requires an explicit `server_novelai_imagegen_configs.nai_diffusion_model_id`. When that dedicated slot is `NULL`, the tool stays hidden and NovelAI image generation remains disabled until `/config` > Models > Switch Models sets a NovelAI model again.
- `/config` > Models > Switch Models now also handles the dedicated NovelAI image slot when the selected provider is NovelAI.
- `generate_image_nai` now resolves its sampler, steps, scale, noise schedule, and `cfg_rescale` from `server_novelai_imagegen_configs` first, falling back to the `NAI_IMAGE_*` / `NAI_CFG_RESCALE` env values when the server override is `NULL`.
- `/novelai image params` is the admin-facing command for those parameter overrides.
- Image tag profile commands are provider-neutral: `/config` > Persona > Appearance, `/personal config`, and the default positive and negative tag fields on `/config` > Models > ImageGen Defaults.
- `/novelai generate image` is the slash-command image generation entrypoint for direct tag-based NAI image creation, and now opens a modal for prompt, extra negative tags, optional character reference, and orientation selection.
- `/config` > Persona > Appearance persists persona reference images through `src/utils/storage/charrefStorage.ts`; `/personal config` owns the separate user reference.
- `generate_image_nai` now supports a structured `characters[]` array for V4 models.
- `generate_image_nai` now uses a simpler active character schema: each `characters[]` item is one visible character instance, and `characters[].tags` must contain that character's full appearance plus their role in the scene. Profile-driven autofill by `id` and `remove_tags` suppression are currently disabled in the active schema/runtime. If known persona/user Physical Appearance tags are available in conversation context, the model is expected to copy the relevant tags into `characters[].tags` directly. For erotic scenes, clothing tags can be omitted and the intended nude state can be stated directly in `tags`.
- Saved persona character references are persisted by `/config` > Persona > Appearance, but the current active `generate_image_nai` character prompting flow does not inject profile-driven refs or profile-driven Physical Appearance tags.
- Multi-character generations intentionally skip saved reference images and rely on per-character tags only, because NovelAI still treats Director/Precise Reference as whole-image guidance rather than strict per-character binding.
- Character placement now populates both top-level `characterPrompts[]` and `v4_prompt.caption.char_captions[]` from the inline `characters[].tags` only. Coordinate mode is enabled when two or more characters are present.
- Context building now surfaces saved Physical Appearance tags inline on the relevant conversation entries instead of a separate `# Image Profiles` block, so identity and image appearance guidance stay together in one place.
- Nested tool schemas are now preserved recursively by the provider adapters, so structured array/object params such as `characters[]` survive tool conversion instead of being flattened to `items.type`.

## Architecture

### Pipeline Flow

```
1. Tool definitions registered at stream start
   └─ normalizeToolDefinitions() → NormalizedToolDefinition[]

2. Tool guide injected into system prompt
   └─ buildToolCallingGuide() → <tools> XML block + format instructions

3. Tool history from previous calls injected into conversation
   └─ buildToolHistoryGlm() → <|assistant|>/<|observation|> turns

4. Model generates response (may include tool calls)
   └─ Streamed via NovelAI's OpenAI-compatible completions API

5. Stream tokens processed through tool-aware pipeline
   └─ processTokenWithToolParsing() → decides: text vs tool_call

6. Tool call parsed and returned to orchestrator
   └─ parseToolCallBlock() → FunctionCall object

7. On stream end without closing tag, recovery attempted
   └─ Synthesize </tool_call> and parse accumulated buffer
```

### Token Processing Modes

The adapter uses a state machine (`toolCallMode`) with four states:

| State | Description | Transitions |
|-------|-------------|-------------|
| `disabled` | Tools not available — pass tokens to `processVisibleText()` directly | — |
| `undecided` | Accumulating initial tokens to decide if the model is generating text or a tool call | → `text` or `tool_call` |
| `text` | Model is generating visible text; scan for `<tool_call>` mid-stream | → `tool_call` (if tag found) |
| `tool_call` | Accumulating tool call XML until `</tool_call>` is found | → parsed `FunctionCall` |

### Decision Logic (`decideToolCallMode`)

When in `undecided` mode, each token is appended to `toolPreludeBuffer` and analyzed:

1. **`<think>...</think>` blocks** — consumed silently (thinking content stripped)
2. **`<tool_call>` tag** — switch to `tool_call` mode (properly wrapped call)
3. **Known tool name** — if the first line matches a registered tool name (with underscore/hyphen normalization), wait for `<arg_key>` to confirm, then wrap in `<tool_call>` and switch to `tool_call` mode
4. **Anything else** — switch to `text` mode

## Tool Call Format

### What the Model Should Generate (per system prompt instructions)

```xml
<tool_call>web_search
<arg_key>query</arg_key>
<arg_value>live performances Japan February 2026</arg_value>
<arg_key>category</arg_key>
<arg_value>text</arg_value>
</tool_call>
```

### What the Model Actually Generates (common GLM behavior)

GLM 4.6 frequently **omits the `<tool_call>` wrapper tag** and outputs the function name directly:

```
web_search
<arg_key>query</arg_key>
<arg_value>live performances Japan February 2026</arg_value>
<arg_key>category</arg_key>
<arg_value>text</arg_value>
```

The adapter handles this via **unwrapped tool call detection** — checking if the first line of the prelude matches a known tool name (with underscore/hyphen normalization via `normalizeToolName()`).

### Tool Name Normalization

MCP tools are sometimes registered with hyphens (e.g., `web-search`) but the model outputs underscores (e.g., `web_search`). The `normalizeToolName()` method tries:

1. Exact match
2. Underscores → hyphens
3. Hyphens → underscores

This normalization is used in both:
- `decideToolCallMode()` — for detecting unwrapped tool calls
- `parseToolCallBlock()` — for resolving the final function name

## Tool History Format (GLM Chat Template)

Previous tool calls and their results are formatted using GLM's role tag structure:

```
<|assistant|>
<think></think>
<tool_call>web_search
<arg_key>query</arg_key>
<arg_value>...</arg_value>
<arg_key>category</arg_key>
<arg_value>text</arg_value>
</tool_call>
<|observation|>
<tool_response>
{"results": [...]}
</tool_response>
```

Built by `buildToolHistoryGlm()` and inserted into the prompt between dialogue turns and the generation prompt.

## System Prompt Tool Guide

Built by `buildToolCallingGuide()`, injected into the `<|system|>` block:

```
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"name":"web_search","description":"...","parameters":{...}}
{"name":"create_task","description":"...","parameters":{...}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
...
</tool_call>
```

## Truncation Recovery

NAI's ~150-token hard cap (or 600 max_length budget) often cuts the model off mid-tool-call before it generates `</tool_call>`. Two recovery mechanisms handle this on stream end:

### 1. `tool_call` mode recovery
If the stream ends while in `tool_call` mode with accumulated buffer:
- Synthesize `</tool_call>` closing tag
- Attempt to parse the patched block
- If successful, return the `FunctionCall` to the orchestrator

### 2. `undecided` mode recovery
If the stream ends while still in `undecided` mode with a prelude buffer:
- Check if the first line matches a known tool name
- If `<arg_key>` is present, wrap in `<tool_call>...</tool_call>` and parse

## Debris Detection and Suppression

The adapter includes three layers of debris detection to handle GLM's tendency to generate garbage after valid output:

### 1. `</think>` Debris Detection (RESOLVED)
The model sometimes generates stray `</think>` tags mid-response followed by garbage text (e.g., `"oggers:</think>\nTomori I'll kill you"`).

**Solution**: `processVisibleText()` checks for `</think>` during the visible text phase. When found, the stream stops immediately — only clean text before the tag is emitted, everything after is discarded.

### 2. Stray Tool Calls After Text (RESOLVED)
The model may generate a complete text response, then attempt a tool call (e.g., `select_sticker_for_response`) at the very end without arguments.

**Solution**: A `hasEmittedVisibleText` flag tracks whether any visible text has been sent to the user. When set, all subsequent tool call detections are suppressed:
- `processTokenWithToolParsing()` — ignores `undecided` → `tool_call` transitions
- `processTextWithToolScan()` — ignores both `<tool_call>` tags and unwrapped function names
- `processChunk()` final-chunk recovery — skips truncation recovery for both `tool_call` and `undecided` modes

### 3. Mid-Text Unwrapped Tool Call Detection (RESOLVED)
When the model starts with text then switches to an unwrapped tool call (bare function name without `<tool_call>` wrapper), the previous code only scanned for `<tool_call>` XML tags.

**Solution**: `detectUnwrappedToolCallInText()` scans the text buffer for bare function names (matching registered tools via `normalizeToolName()`) followed by `<arg_key>` tags. If found after visible text, they're suppressed as debris. If found before any visible text, they're wrapped in `<tool_call>` tags for standard parsing.

## Known Limitations

### 1. Token Budget vs Thinking
With `/nothink` removed (to enable reasoning for tool use), the model may use tokens on internal reasoning. Combined with NAI's token budget, this can result in:
- Truncated tool calls (handled by recovery)
- Thinking consuming entire budget (empty response)
- Model choosing to respond with text instead of tool calls

### 2. Tool Call Arguments Truncation
If the token cap hits mid-`<arg_value>`, the last argument is incomplete. The truncation recovery synthesizes `</tool_call>` but the incomplete argument may be lost.

### 3. URL Fetch Tool Disabled

`fetch_url` is not exposed to NovelAI initially. It is a built-in tool for other providers, but fetched-page payloads can be large enough to destabilize GLM's prompt/tool budget. Re-enable only after validating realistic fetched-page results against NovelAI's system-prompt and tool-history limits.

## File References

| File | Purpose |
|------|---------|
| `src/providers/novelai/novelaiStreamAdapter.ts` | Stream adapter with all tool parsing logic |
| `src/providers/novelai/novelaiService.ts` | API communication, parameter conversion |
| `src/providers/novelai/novelaiProvider.ts` | Provider interface, stream config setup |
| `references/glm_46_chat_template.jinja.txt` | Official GLM 4.6 Jinja template (source of truth) |
