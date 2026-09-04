---
title: "Prompt Snapshot"
---

The prompt-snapshot command produces a runtime-faithful dump of the exact prompt TomoriBot would send to the LLM for a given channel + persona combination. It's aimed at server admins and prompt engineers who want to debug or reproduce what the bot is "seeing" at any point in time.

## What it does

1. Takes a snapshot of the channel's recent message history (respecting the persona's `message_fetch_limit`).
2. Resolves the target persona (main or alter) via a modal picker.
3. Assembles the full context using the same `buildContext()` pipeline the live chat uses — preset routing, `/context-note` depth injection, conditioning logs, memories, documents, presence, everything.
4. Serializes the result to either a human-readable **text** format or a provider-native **JSON** format.
5. Sends the file to the invoking user via DM (or as an ephemeral attachment if DMs are closed).
6. Posts sampling / request config alongside the snapshot so users can reproduce the call parameters.

## Permission model

- Guild-only (cannot be used in DMs — no server context).
- `ManageGuild` always bypasses the gate.
- Non-admin access depends on `server_member_permissions_configs.prompt_snapshot_enabled` (default off).

## Faithfulness to runtime

The snapshot mirrors the real `messageCreate → tomoriChat` pipeline as closely as possible. The table below shows what it does and does not respect.

| Aspect | Respected? | Notes |
| --- | --- | --- |
| `/refresh` reset marker | ✅ | Uses `sliceMessagesAtResetMarker()` — history starts **after** the marker. |
| `/compact_refresh` marker | ✅ | Same slicer — history starts **at** the marker (compact summary becomes the new opener). |
| `FULL` privacy users filtered | ✅ | Skipped from history, matching `tomoriChat.ts`. |
| Reference-driven profiles | ✅ | Calls the same `prepareParticipantContext()` API as live chat. Equivalent sanitized visible authors, persona triggers, eligible user aliases/mentions, synthetic identities, and bridges produce the same ordered discovery plan and rendered participant item without changing response routing. Profiles are hydrated through the same required active-persona scope, including lineage memories, main/alter reminder filters, persona self-tasks, exposure policy, and triggerer snapshot fast paths. Snapshot keeps an independent request scope because it builds one selected persona. |
| Webhook persona attribution | ✅ | Webhooks whose username matches an alter persona are re-attributed. |
| System-produced embeds | ✅ | `memory_learning`, `reminder_set`, `system_injection`, `scene_directive`, `compact_summary`, `compact_refresh`, `reward`, `punish` are converted to `[System: …]` text blocks. |
| Link-preview embeds | ✅ | Twitter/YouTube/article cards from non-bot messages get text + image + thumbnail extraction via `processLinkEmbed`. |
| Stickers | ✅ | Included as PNG attachments. |
| YouTube URLs in message text | ✅ | Converted to video attachments. |
| SillyTavern preset routing | ✅ | `buildContext()` handles preset-aware reordering internally. |
| Random prompt macros | ✅ | Resolved by `buildContext()` before serialization, so snapshots show the rolled value the provider receives. |
| `/context-note` depth injection | ✅ | Applied by `buildContext()` — snapshot output carries the injected item inline. |
| Self-debug / Tomori-authored diagnostic embeds | ❌ | Not included — these are debug UI, not LLM prompt input. |
| Forwarded-message inline expansion | ⚠️ | Basic text is captured; full forwarded-body expansion used by tomoriChat is NOT replicated. |
| Reply-reference context annotation | ⚠️ | Reply threading isn't re-assembled — only the raw reply chain's content is visible. |
| Output prefill / speaker-guard stop strings | ✅ | Present in the sampling/config block for providers that use them. |
| Media capability resolution | ✅ | `buildContext()` emits capability-neutral `mediaDescriptors`; snapshot resolves them after context assembly with the routed answering model, including personal text-provider routing, before TXT serialization or provider-native JSON probe serialization. |

## Output formats

### Text (`format: Text`, default)

Flat-text, annotation-heavy. Each context block is prefixed with a locator header so a human reader can see which config command governs it:

```
=== Persona Attributes (`/config` > Persona > Identity & Personality) ===
...attribute list...

=== Channel Prompt (`/config` > Channels > Channel Overrides) ===
...per-channel append-mode prompt (only present when an append override applies to this channel)...

=== Server Memories (`/memory server`) ===
...server memory lines...

=== Conversation History (system-managed) ===
...messages...
```

Sub-section markers (`== Subtitle ==`) appear inside composite blocks like `KNOWLEDGE_USERS_IN_CONVERSATION` that pull from multiple sources.

> **Important:** The `=== === ` and `== ==` markers are annotations — they are NOT part of the prompt actually sent to the LLM. The DM body that ships with the file explicitly states this.

Tools are **omitted** from the TXT format — users are directed to re-run with `format: JSON` if they need them.

### JSON (`format: JSON`)

Provider-native shape, matching what each adapter's `logSanitizedRequest` would emit to terminal. Base64 image payloads are redacted with `[BASE64_HIDDEN]` / `[MEDIA_HIDDEN]` placeholders to keep file sizes manageable.

Shapes:

| Provider | JSON shape |
| --- | --- |
| `google`, `vertex`, `vertexexpress` | `{model, systemInstruction, contents[], generation_config, safety_settings, thinking_config?}` |
| `anthropic` | `{model, system, messages[], temperature?, top_p?, top_k?, max_tokens, stop_sequences, thinking?, output_config?}` |
| `openrouter`, `deepseek`, `zai`, `zaicoding`, `nvidia` | `{model, messages[], temperature?, top_p?, top_k?, frequency_penalty?, presence_penalty?, min_p?, max_tokens, stop, reasoning?/thinking?}` |
| `custom`, `novelai` (fallback) | `{model, messages[]}` + sampling params, OpenAI-vision array content form for media, optional `reasoning_effort` / `thinking_directive`, **one consolidated `role: "system"` entry** |

#### Custom fallback consolidation

OpenAI-compatible APIs accept only one `role: "system"` message, so the custom fallback path merges all system blocks (personality, rules, knowledge, etc.) into a single leading entry. The text parts are joined with `\n\n` in the order they appear in the context. Non-system items are mapped in turn, preserving order.

## Sampling / request config block

A provider-specific sampling block is shown in the DM body (both formats) and baked into the JSON file's top level (JSON format only). The values come UNFILTERED from the persona's config — the snapshot does not probe OpenRouter's `supportedParameters` list, so params the model may reject at runtime are still shown.

| Provider | Keys included |
| --- | --- |
| `google` | `generation_config.{temperature, top_k, top_p, frequency_penalty, presence_penalty, max_output_tokens, stop_sequences}`, `safety_settings[4]` (all `BLOCK_NONE`), provider-driven `thinking_config?` |
| `vertex`, `vertexexpress` | `generation_config.{temperature, top_k, top_p, max_output_tokens, stop_sequences}`, `safety_settings[4]` (all `BLOCK_NONE`), provider-driven `thinking_config?` |
| `anthropic` | `temperature?`, `top_p?` (coalesced via `selectAnthropicSamplingParams`), `top_k?`, `max_tokens`, `stop_sequences`, adaptive `thinking?`, `output_config?` |
| OpenAI-compat | `temperature?`, `top_p?`, `top_k?`, `frequency_penalty?`, `presence_penalty?`, `min_p?`, `max_tokens`, `stop`, provider-specific `reasoning?` / `thinking?` / `reasoning_effort?` / `thinking_directive?` |

`disabled_params` is appended when the persona has explicitly disabled sampling parameters. `tools_disabled: true` appears when the LLM has `has_tools: false`.

## `fetch_tools` option (JSON only)

Passing `fetch_tools: true` appends a top-level `tools` array to the JSON file containing the provider-formatted tool definitions that would be sent at runtime.

Internally this mirrors the tool-list assembly that each `<Provider>Provider.getTools` does, minus the `streamingContext` filter (which requires a live Discord channel not available for a snapshot). Behind the scenes:

1. `getAvailableToolsWithMCP(providerName, toolStateForContext)` — feature-flag gates built-in tools and surfaces MCP function names.
2. `selectToolAdapter(providerName)` — routes to the correct `MCPCapableToolAdapter`.
3. `adapter.getAllToolsInProviderFormat(builtInTools, serverId, mcpFunctionNames)` — returns the provider's native shape (OpenAI function spec, Gemini schema, Anthropic tool schema, etc.).

The `fetch_tools` option is intentionally ignored in the TXT format — a note in the DM body tells users to re-run as JSON if they need the tool list.

## Design decisions

### Why flatten metadata out of the file?

The file shouldn't contain anything that isn't faithful to what the LLM sees. Metadata (server ID, channel, persona name, preset, capture timestamp) moved to the DM body so the file stays pure payload. This keeps JSON valid for direct replay against an OpenAI-compat endpoint without stripping custom keys.

### Why extract embed classification / link-preview / reset-marker helpers?

The live chat pipeline in `tomoriChat.ts` has inline helpers for these. Rather than duplicate them (and risk drift), the shared primitives live in:

- `src/utils/discord/embedClassifier.ts` — `checkTargetEmbedTitle`, `processLinkEmbed`, `formatSystemProducedEmbedHint`
- `src/utils/discord/embedDetection.ts` — `classifyRefreshMarkerEmbed`, `sliceMessagesAtResetMarker`, `isRefreshMarkerEmbed`, `messageContainsRefreshMarker`
- `src/utils/discord/componentNoticeReader.ts` — `extractNoticeTextFromComponents`, which recovers `{title, description, footer}` from a Components V2 container

The CV2 reader is required for snapshot fidelity: memory-learning and
scheduled-task notices are sent as Components V2 containers with an **empty
`message.embeds` array**, so a snapshot that only walked `message.embeds` would
silently omit notices that live chat does include.

`tomoriChat.ts` still uses its inline versions (no functional change there), but future snapshot-like consumers should prefer the shared primitives.

## Related docs

- [`pipelines/context-build/`](../pipelines/context-build/) — how `buildContext()` orders, tags, and injects context items
- [`sillytavern/preset-system.md`](../integrations/sillytavern/preset-system) — preset-based reordering respected by snapshot
- [`tool-system.md`](/architecture/subsystems/tool-system/) — how tool registry + MCP integration feed `fetch_tools`

## Source

- Command: `src/commands/tool/prompt/snapshot.ts`
- Shared embed helpers: `src/utils/discord/embedClassifier.ts`, `src/utils/discord/embedDetection.ts`
- Sampling helper: `src/utils/provider/samplingControl.ts`
