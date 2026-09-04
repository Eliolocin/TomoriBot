---
title: "02.7b: Verbatim Tool Definitions"
---

In-band JSON dump of the resolved tool schemas, emitted only when the
verbatim tool-calling workaround is enabled.

**File:** `src/utils/text/context/toolDefinitions.ts`

## Mission

The verbatim tool-calling workaround (`/config` > Behavior > Experimental) exists for
endpoints that accept the native `tools` field but ignore it — typically
local / custom OpenAI-compatible servers. In that mode the model never
reliably "sees" the tool schemas, so the
[`CustomStreamAdapter`](../../provider/03-chunk-normalization) parses tool
calls out of the model's *text* instead. This contributor closes the loop:
when the workaround is on, it serializes the exact tool set the provider
would send and embeds it in the prompt body so the model can read the names
and parameter schemas in-band.

This is the *schema* half of the workaround. The *behavioral* half — the
instruction on how to emit a verbatim call — is the
`VERBATIM_TOOL_CALLING_NUDGE` injected near the dialogue tail (stage 11,
[`11-dialogue-history.md`](/architecture/pipelines/context-build/02-native-assembly/11-dialogue-history/)). Both are gated by the
same predicate so they always switch on together.

## Input

- `tomoriConfig` — provides `verbatim_tool_calling_enabled` (the toggle).
- `tomoriState` — provides the active `llm` (provider, capabilities),
  `server_id`, persona voice fields, and feature-flag config used to gate
  tool availability.

## Output

`Promise<StructuredContextItem | null>` — `null` when the workaround is off,
the model is not tool-capable, state is missing, or no tools resolve.
Otherwise one `user`-role item tagged
`KNOWLEDGE_VERBATIM_TOOL_DEFINITIONS`.

Content shape: a short instructional header followed by a fenced ```json
block containing the provider-native tool array (`{ type: "function",
function: { name, description, parameters } }` per tool).

## How the JSON is built

Mirrors the recipe used by `/tool prompt snapshot` (`fetchProviderTools`)
and by `<Provider>Provider.getTools`:

1. Assemble a minimal `ToolStateForContext` from the live persona state
   (voice assignment, model capability flags, feature-flag config).
2. `getAvailableToolsWithMCP(provider, state)` — registry returns the
   feature-flag-gated built-in tools plus the allowed MCP function names.
3. `new OpenAICompatibleToolAdapter(provider).getAllToolsInProviderFormat(
   builtInTools, server_id, mcpFunctionNames)` — serializes full native
   schemas for built-in **+ global MCP + guild MCP** tools, exactly matching
   what lands in `config.tools`.

## Invariants

After this stage runs:

- Gated identically to the verbatim nudge via
  `shouldInjectVerbatimToolCallingNudge(tomoriConfig, tomoriState)` —
  requires `verbatim_tool_calling_enabled === true` **and**
  `tomoriState.llm.has_tools === true`.
- Placed in the stable reference zone (right before RAG documents) so the
  schema block stays inside the prompt-cache-friendly prefix rather than
  churning next to live dialogue.
- Tools are resolved *fresh* each turn (no caching here) — the same resolve
  runs again later in the provider when it builds `config.tools`. Accepted
  cost for an opt-in workaround.
- Errors are logged and return `null` — a failure never blocks the rest of
  the build.

## Configuration

| Source | Field | Effect |
|---|---|---|
| `tomoriConfig` | `verbatim_tool_calling_enabled` | Master toggle (set via `/config` > Behavior > Experimental) |
| `tomoriState.llm` | `has_tools` | Must be true; otherwise no tools to dump |

## Extension points

| Surface | Plugin-relevance |
|---|---|
| Tool resolution (`getAvailableToolsWithMCP`) | Shared with every provider's `getTools`; a plugin adding tools is picked up here automatically. |
| Serialization adapter (`OpenAICompatibleToolAdapter`) | Hard-wired to OpenAI-compatible shape because the verbatim parser only runs in `CustomStreamAdapter`. A future non-OpenAI verbatim parser would select a different adapter here. |
| Gating predicate (`shouldInjectVerbatimToolCallingNudge`) | Single source of truth shared with the nudge; changing the gate changes both halves of the workaround. |

## Related docs

- Verbatim nudge (behavioral half): → [`11-dialogue-history.md`](/architecture/pipelines/context-build/02-native-assembly/11-dialogue-history/)
- Verbatim parsing at stream time: → [`provider/03-chunk-normalization.md`](../../provider/03-chunk-normalization)
- Provider tool assembly reference: → `/tool prompt snapshot` (`src/commands/tool/prompt/snapshot.ts`)
- Workaround config plumbing: → `src/utils/discord/workaroundConfigMapping.ts`
