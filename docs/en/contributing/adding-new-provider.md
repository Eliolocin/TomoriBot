---
title: "Add a New AI Provider"
---

This is the current implementation guide for adding a provider to TomoriBot.

Read [`docs/en/architecture/pipelines/provider/`](../pipelines/provider/) first if you need the architecture overview.
Use this guide when you are actually wiring a new provider into the codebase.

## Mental Model

TomoriBot has a real provider abstraction for core chat behavior, but provider integration is not "drop a folder and you're done".

Today, adding a provider usually means all of the following:

1. Add the provider implementation under `src/providers/{providerName}/`.
2. Add static provider metadata in `providerInfo.ts`.
3. Seed provider model inventory in the database.
4. If the provider supports app-level runtime features beyond core chat, implement the relevant optional capability interfaces on the provider class.

Important rules:

- `ProviderFactory` auto-discovers provider classes.
- `providerInfoRegistry` auto-discovers `src/providers/*/providerInfo.ts` metadata and provider-owned feature implementation declarations.
- Text model defaults come from the database/cache, not from hardcoded model arrays in provider code.
- If a command only needs to know whether a provider supports a feature, use `providerSupportsFeature()`.
- If a command needs provider-specific runtime execution, resolve a provider-owned capability instead of hardcoding `provider === "google"` style checks.

## 1. Decide Scope First

Before you write code, decide whether the new provider is:

- chat-only
- chat + tool calling
- full parity with other providers for images, embeddings, structured output, compaction, preset generation, or history extraction

Do not mark features as supported unless they work end-to-end in the app.

The source of truth for those app-level capabilities is `ProviderInfo.featureSupport` in `src/types/provider/interfaces.ts`.

## 2. Create the Provider Folder

Create:

- `src/providers/{providerName}/providerInfo.ts`
- `src/providers/{providerName}/{providerName}Provider.ts`
- `src/providers/{providerName}/{providerName}StreamAdapter.ts`
- `src/providers/{providerName}/{providerName}ToolAdapter.ts`

You can add extra helper files in the same folder as needed.

Use existing providers as references:

- `src/providers/google/`
- `src/providers/openrouter/`
- `src/providers/novelai/`
- `src/providers/custom/`

If the vendor exposes an OpenAI-style chat/completions API, read the [OpenAI-Compatible Providers](#openai-compatible-providers) section below before cloning provider code.

## 3. Define Static Provider Metadata

Create `providerInfo.ts` and export a `ProviderInfo` object.

Example:

```ts
import type { ProviderInfo } from "@/types/provider/interfaces";

export const exampleProviderInfo: ProviderInfo = {
	name: "example",
	displayName: "Example AI",
	aliases: ["ex"],
	supportedModels: [],
	requiresApiKey: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsImages: true,
	supportsVideos: false,
	apiFamily: "openai-compatible",
	featureSupport: {
		imageGeneration: "none",
		videoGeneration: "none",
		embeddings: false,
		structuredOutput: false,
		presetGeneration: false,
		expressionInitialization: false,
		liveTokenCounting: false,
		conversationCompaction: false,
		historyExtraction: false,
	},
	supportedParams: ["temperature", "topP"] as const,
};
```

Notes:

- `supportedModels` is usually `[]` because the database is the source of truth for model inventory.
- `apiFamily` should describe the underlying API surface, not the marketing name.
- `featureSupport` should reflect app-level support, not just raw vendor API capability.
- `featureImplementations` is optional. Use it only when this provider routes a shared runtime feature through an existing implementation key, such as `imageGeneration`, `videoGeneration`, or `liveTokenCounting`.
- `usageCostMode: "none"` is optional metadata for providers where `/tool estimate cost` should not report per-token usage charges.

## 4. Implement the Provider Class

Implement `{ProviderName}Provider` by extending `BaseLLMProvider`.

Required methods live in `src/types/provider/interfaces.ts`:

- `getInfo()`
- `validateApiKey()`
- `formatErrorDescription()`
- `getTools()`
- `createConfig()`
- `streamToDiscord()`
- `getDefaultModel()`

Recommended pattern:

- import and return the object from `providerInfo.ts` inside `getInfo()`
- keep provider-specific API key validation and user-facing error formatting inside the provider
- keep config conversion inside `createConfig()`
- keep streaming behavior inside the provider stream adapter
- assemble the runtime `StreamContext` with the shared `buildStreamContext()` helper
  (`src/utils/provider/streamContext.ts`) instead of hand-building the object literal. Pass only
  the values your `streamToDiscord()` already has in scope plus your `provider` name; the helper
  owns every common copy-through field (locale fallback, suppress/prefill/reply-notice flags,
  webhook/persona identity, forced mentions, abort signal, message ID map, NAI continuation). This
  keeps all backends in lock-step when a new cross-cutting stream field is introduced.

`formatErrorDescription()` is important. Provider-specific error formatting should stay inside the provider abstraction instead of being reimplemented in commands.

## 5. Implement Stream and Tool Adapters

Your stream adapter should normalize provider responses into TomoriBot's streaming pipeline.

Your tool adapter should convert TomoriBot tool schemas and tool results into the provider's function-calling format.

Use the existing adapters as the implementation pattern:

- `src/providers/google/googleStreamAdapter.ts`
- `src/providers/google/googleToolAdapter.ts`
- `src/providers/openrouter/openrouterStreamAdapter.ts`
- `src/providers/openrouter/openrouterToolAdapter.ts`

Important:

- provider tool conversion is not fully generic across vendors
- if you add nested tool-schema support or other serializer behavior, update all provider tool adapters consistently
- **image/video placeholder contract** — do not silently skip image or video
  parts when `seesImages`/`seesVideos` is false. The context pipeline may
  embed media parts even for non-vision primary models when a fallback model
  in the chain supports that media type. When your adapter encounters a part
  it cannot render, push a `{ type: "text", text: "[System: An image/video is
  attached to this message that this model cannot process.]" }` entry so the
  model is still aware the media exists. See
  `openaiCompatibleMessageBuilder.ts` and `openrouterStreamAdapter.ts` for
  the reference pattern.

### Reasoning output contract

If your provider exposes human-displayable reasoning, emit it through the normalized streaming contract instead of leaking it into visible reply text.

- Put displayable reasoning on `ProcessedChunk.thoughts`
- use `kind: "summary"` for concise provider-supplied summaries
- use `kind: "raw"` for raw but human-readable reasoning text
- if the provider hides reasoning inside tags such as `<think>...</think>`, strip it from visible output and surface the inner text as `raw` thoughts

Keep replay-only continuity fields internal:

- Gemini `thoughtSignature`
- OpenRouter `reasoning_details`
- DeepSeek continuation `reasoning_content`
- any vendor-specific hidden token block that is needed only for tool-call continuation

Those fields may still need to be preserved in provider-specific tool replay payloads, but they must not be exposed through thought-log output or normal Discord message flushing.

## 5.5 Register the MCP Tool Adapter

If your provider supports tool calling, you **must** register its tool adapter with
`registerMCPAdapter()` in `src/events/clientReady/02_registerMCPs.ts`.

Example:

```ts
import { getExampleToolAdapter } from "../../providers/example/exampleToolAdapter";

const exampleAdapter = getExampleToolAdapter();
registerMCPAdapter(exampleAdapter);
log.info("Registered Example tool adapter with MCP capabilities");
```

Why this matters:

- Tool **definitions** are built by `getAvailableToolsWithMCP()`, which queries the
  `mcpManager` directly. This works for any provider regardless of adapter registration.
- Tool **execution** goes through `executeTool()` → `isMCPFunction(name, provider)`,
  which looks up the provider's adapter in `ToolRegistry.mcpAdapters`.
- If the adapter is not registered, MCP tools (e.g. `fetch`, `web-search`) will appear
  in the LLM's tool list but fail at execution time with "Tool not found in registry".
  Built-in tools still work because they resolve through a separate code path.

This is easy to miss because the provider will appear to work for built-in tool calls.
The failure only surfaces when the LLM calls an MCP-backed tool.

### Guild MCP Tools

In addition to global MCP tools, each guild can register its own remote MCP servers
via the `/mcps` panel. Your tool adapter's `getAllToolsIn*Format()` method **must**
also inject guild MCP tools by calling `getGuildMcpManager().getGuildMCPTools(serverId)`.

The pattern (used by Google, OpenRouter, and OpenAI-compatible adapters):

1. After adding global MCP tools, check `if (serverId && allowedMCPFunctions)`
2. Call `guildMcpManager.getGuildMCPTools(serverId)` to get per-guild `CallableTool`s
3. Filter declarations against `allowedMCPFunctions` (pre-approved by `toolRegistry`)
4. Convert to your provider's format and append

If this step is missing, guild-registered MCP tools will be discovered and logged
but never sent to the LLM — the model won't know they exist.

## 6. Verify Provider Metadata Discovery

`ProviderFactory` auto-discovers `{providerName}Provider.ts`, and `providerInfoRegistry` auto-discovers `providerInfo.ts`.

The metadata registry powers:

- alias normalization
- capability checks via `providerSupportsFeature()`
- temporary runtime execution routing via `resolveProviderFeatureImplementation()`

If `providerInfo.ts` is missing or does not export a valid `ProviderInfo` object, the provider may stream chat successfully but still behave as unsupported in feature-gated commands.

## 7. Implement Optional Runtime Capabilities When Needed

Some app features execute outside the main chat streaming path.

Current capability entry points:

- `src/types/provider/featureInterfaces.ts`
- `src/utils/provider/providerCapabilityResolver.ts`
- `src/providers/utils/providerFeatureExecutors.ts`

Current provider-owned examples include:

- embeddings
- structured output execution
- preset generation
- conversation compaction
- roleplay compaction
- expression initialization
- history extraction

Use this rule:

- If `featureSupport.{feature}` is `false`, no extra wiring is needed.
- If `featureSupport.{feature}` is `true` and the app executes that feature at runtime, implement the matching optional capability on the provider class.
- If a helper is truly generic, keep it in a shared utility. If it contains provider-specific HTTP calls, prompt shaping, or response parsing, keep it in `src/providers/{providerName}/`.

Do not scatter exact provider-name checks across commands. Put routing in the provider capability layer.

## 8. Seed Model Inventory

Models live in a **typed catalog** and are seeded into the database directly from
it at startup — there is no model seed `.sql` file. Add the provider's rows to
`src/db/seed/catalog/models.ts` as named-field objects (every capability flag is
optional and defaults to `false`, so you only list the ones that are `true`). That
is the whole change — nothing to regenerate or compile.

```ts
// src/db/seed/catalog/models.ts
{ provider: "google", codename: "gemini-3.5-flash-lite", isDefault: true, hasTools: true,
  seesImages: true, seesVideos: true, seesYoutube: true, supportsStructoutput: true,
  desc: "Balanced model…", ja: "汎用…" },
```

How it runs: `seedModelsFromCatalog()` (in `src/db/seed/catalog/modelSeed.ts`) renders
each section into one `INSERT … ON CONFLICT` per table and executes it during
database initialization, before the persona, system prompt, and NovelAI preset
catalog seeders. Seeding is an idempotent upsert on every
startup, exactly as the old `01_models.sql` was. To deprecate a model, set
`isDeprecated: true` on its row; to remove one, delete its row.

Tables currently modeled in the catalog:

- `llmSections` → `llms` for text/chat models
- `imageSections` → `image_diffusion_models` for native image generation models
- `videoSections` → `video_generation_models` for native video generation models
- `embeddingSections` → `embedding_models` for embedding providers/models

Use the tables that match the features you actually support.

Examples:

- a chat-only provider needs `llms`
- a provider with native image generation also needs `image_diffusion_models`
- a provider with embeddings also needs `embedding_models`

Do not hardcode default models in provider code when the app already resolves them from the database/cache.
Shared feature helpers must receive the invoking provider's resolved default explicitly, so providers with a
common wire protocol do not silently inherit another provider's model inventory.

### Invariants (validated at startup and by `bun run check-seed-catalogs`)

`seedModelsFromCatalog()` validates the catalog and **throws before any DB write**
if an invariant is violated, so a malformed catalog fails fast on boot. The same
check is available offline via `bun run check-seed-catalogs`, which now validates every
typed seed catalog (models, personas, system prompts, and NovelAI presets):

- exactly one `isDefault` per provider, and that default is not deprecated;
- at least one `isSmartest` per provider in `llms`, with at least one not deprecated;
- unique `(provider, codename)` within each table.

The `custom` provider is exempt (its `custom/bootstrap` row is configured per-server).

## 8.5 Update User-Facing Help

When adding a provider, update the user-facing setup/help copy in the same change.

Minimum reminders:

- update the `/help` API Keys provider catalog in `src/utils/discord/helpProviderGuides.ts`
- add localized API Keys copy in both locale trees (`src/locales/en-US/` and `src/locales/ja/`)
- review the `/config params` success embed strings in both locale trees
- keep those `/config params` provider lists accurate per parameter; do not add a provider unless that exact saved setting is wired through the provider runtime
- if the provider changes onboarding guidance, also review Setup Step 1 in `src/utils/discord/helpCatalog.ts`
- if the provider changes pricing guidance or model-tag expectations, review `/tool estimate cost` and any related help text

## 9. Keep New Logic Inside the Provider Layer

When integrating provider-specific behavior:

- prefer `providerInfo.ts`
- prefer provider class capability methods
- prefer `providerCapabilityResolver.ts` and thin shared wrappers such as `providerFeatureExecutors.ts`
- keep provider helpers inside `src/providers/{providerName}/`
- use shared provider utilities only for code that is genuinely cross-provider

Current structured-output examples:

- `src/providers/google/googleStructuredOutput.ts`
- `src/providers/openrouter/openrouterStructuredOutput.ts`
- `src/providers/deepseek/deepseekStructuredOutput.ts`
- `src/providers/zai/zaiStructuredOutput.ts`

Avoid adding new command-level checks like:

```ts
if (providerName === "example") {
	// ...
}
```

Prefer:

- `providerSupportsFeature(providerName, "structuredOutput")`
- `resolveProviderCapability(providerName, "presetGeneration")`
- provider-local code paths behind shared executor helpers

Literal provider names are still correct when the behavior is truly vendor-specific, such as an optional credential that only exists for one vendor integration.

## 10. Verify Vendor Capability Contracts

Before you mark a feature as supported, verify the vendor's exact request/response contract instead of relying on the provider being "OpenAI-compatible".

Checklist:

- tool calling:
  - confirm which seeded models actually support tools
  - confirm the assistant/tool loop shape matches TomoriBot's runtime
- reasoning or thinking mode:
  - check for continuation-only fields that must be replayed within the same turn
  - decide explicitly how the `thinking_level` option in `/model parameters` behaves for the provider: map it, or document a deliberate no-op
  - DeepSeek example: preserve `reasoning_content` across tool sub-turns, but do not treat it as normal cross-turn chat history
  - Z.ai example: the `thinking_level` option in `/model parameters` maps to `thinking: { type: "enabled" | "disabled" }`; active thinking removes temperature / top_p / frequency_penalty / presence_penalty
- structured output:
  - determine whether the provider offers strict schema mode or only JSON-object mode
  - implement provider-owned `callStructuredJSON()` for the contract the vendor actually supports
  - only seed `supports_structoutput = true` after end-to-end validation
- assistant prefill or prefix completion:
  - if TomoriBot uses assistant prefills, verify whether the vendor requires a beta endpoint, a trailing assistant message, or a message flag such as `prefix: true`
- live cost estimation:
  - if `/tool estimate cost` should support the provider, add a minimal non-streaming token probe
  - parse prompt token usage from the vendor response
  - add env-backed pricing defaults and document where those defaults came from
- unsupported parameters:
  - check whether reasoning models ignore or reject parameters like `temperature`, `top_p`, or logprob settings
  - strip or avoid unsupported parameters inside the provider layer

Rule:

- vendor capability claims are not the same thing as TomoriBot app-level support
- `ProviderInfo.featureSupport` should describe the runtime TomoriBot has actually implemented

## 11. Capability Implementation Reminders

Use this as the last pass before you call a provider integration "done".

### Tool Calling

- seed `llms.has_tools` conservatively per model instead of assuming all chat models support tools
- implement or reuse the provider tool adapter and confirm schema serialization matches the vendor contract
- verify the full assistant -> tool call -> tool result -> assistant continuation loop, not just first-turn tool emission
- if the vendor has special reasoning-mode tool requirements, keep that logic in the provider layer
- if strict tool-schema mode exists, treat it as optional follow-up work unless the runtime is fully validated

### Structured Output

- determine whether the vendor supports strict schema mode, JSON-object mode, or only prompt-steered JSON
- implement provider-owned `callStructuredJSON()` for the actual supported contract

### Thinking Level

- if the vendor has a verified request-side reasoning control, map the `thinking_level` option from `/model parameters` in the provider layer
- if the vendor only supports startup flags, GUI toggles, or backend-template-specific reasoning controls, do not invent a generic request field
- document the result in `docs/en/architecture/subsystems/thinking-level.md` and the provider notes
- if the provider only guarantees JSON objects, inject the required prompt guidance and validate locally with Zod
- seed `llms.supports_structoutput` only for models validated end-to-end in TomoriBot
- if history extraction depends on structured output, do not enable `featureSupport.historyExtraction` until that path works

### Live Cost Estimation

- if the provider should support `/tool estimate cost`, add a minimal non-streaming prompt-token probe
- parse prompt token usage from the vendor response instead of estimating locally when the API exposes usage
- keep pricing source explicit:
  - use live/cached provider pricing when available
  - otherwise use env-backed defaults with documented provenance
- do not quietly hardcode marketing-page assumptions without making them overrideable
- document any caveats such as cache-hit vs cache-miss pricing, account-default models, or unsupported token-count endpoints

### Native Image Generation

- only implement this if the app already has a native image-generation path for the provider
- implement the provider-owned image-generation capability instead of faking it through text chat
- seed `image_diffusion_models` only for models that are actually wired and tested
- confirm `/model image` and any image-generation commands use the provider cleanly
- if the provider has no native image generation, leave `featureSupport.imageGeneration = "none"` and do not seed image rows

### Embedding Models

- only implement embeddings if the provider has a real embedding API path wired into TomoriBot
- implement the provider-owned embedding capability and seed `embedding_models`
- verify any provider-specific dimensionality, batching, or input limits
- confirm embedding selection/config flows behave correctly for the provider
- if embeddings are not implemented, leave `featureSupport.embeddings = false` and do not seed embedding rows

### Conversation Compaction

- create `src/providers/{providerName}/compactGenerator.ts` with two exports:
  - `generateConversationSummary{Provider}(request)` — plain text POST to the provider chat endpoint
  - `generateRoleplaySummary{Provider}(request)` — structured output POST using the provider's `callStructuredJSON()` helper
- import `buildRoleplaySchema()` and `CompactRoleplaySummarySchema` from `src/providers/utils/compactCommon.ts` instead of duplicating them
- for plain text summary: omit `response_format`; just request a text completion using the provider's chat completions endpoint
- for reasoning-model providers that reject `temperature`, guard the parameter before sending (e.g. DeepSeek-reasoner, ZAI GLM reasoning models)
- implement `SupportsConversationCompaction` on the provider class and wire both methods
- set `featureSupport.conversationCompaction: true` in `providerInfo.ts`
- if the provider needs image preprocessing before sending to the compaction endpoint (e.g. NVIDIA), apply it inside `generateConversationSummary{Provider}()`

### Preset Generation

- create `src/providers/{providerName}/presetGenerator.ts` with one export:
  - `generatePresetFromPrompt{Provider}(apiKey, params, locale, options)` — structured output POST with an optional tool-calling loop
- import `buildPresetResponseSchema()`, `buildPresetPrompt()`, `buildToolErrorResult()`, and the shared types (`PresetContentPart`, `PresetMessage`, `PresetToolCall`) from `src/providers/utils/presetCommon.ts`
- choose the right structured output mode for the vendor:
  - **strict schema** (`json_schema` response format): preferred when the vendor supports it (e.g. OpenRouter, NVIDIA); validate the response shape locally if needed
  - **JSON object mode** (`json_object` response format): required for vendors that only support JSON-mode (e.g. DeepSeek, ZAI); inject the JSON schema into the system prompt via a helper like `build{Provider}PresetSystemPrompt()` and run Zod validation locally
  - **schema fallback** (try strict, retry with JSON object on 400/422): useful when strict schema support is model-dependent (e.g. NVIDIA)
- implement the tool-calling loop:
  - build tool definitions via `getPresetGenerationTools()` (private helper that calls `getAvailableToolsWithMCP()` and `isBraveSearchAvailable()`)
  - if the model returns `tool_calls`, execute each tool, append results, and loop up to `options.maxToolRounds`
  - use `buildToolErrorResult()` for failed tool executions
- for reasoning-model providers that reject `temperature`, guard the parameter before sending
- implement `SupportsPresetGeneration` on the provider class and wire `generatePreset()`
- set `featureSupport.presetGeneration: true` in `providerInfo.ts`
- if two providers share an endpoint family (e.g. ZAI and ZAI Coding), parameterize the generator by `endpointUrl?` and `toolAdapter?` so the secondary provider can delegate without code duplication

## 12. Test the Integration

Minimum test checklist:

- provider is auto-discovered at startup
- aliases resolve correctly
- `/config provider add` and `/config provider switch` validation work
- `/setup` and provider-specific error formatting work
- `/model text` shows the provider's seeded models
- normal chat streaming works
- tool calling works if supported
- structured output works if supported
- history extraction works if supported
- reasoning-mode tool continuation works if the vendor requires replay fields
- assistant-prefill behavior works if the provider supports native prefix completion
- `/tool estimate cost` works if `featureSupport.liveTokenCounting = true`
- unsupported features fail cleanly instead of throwing deep runtime errors
- feature-gated commands behave correctly for your `featureSupport` values

Validation commands:

```bash
bun run check
bun run lint
```

Run `bun run check-locales` only if you changed locale files or command metadata.

## Common Mistakes

- Forgetting `providerInfo.ts` and trying to keep metadata only inside `getInfo()`
- Marking a feature as supported without wiring its shared executor path
- Marking a feature as supported without implementing the matching provider capability
- Assuming provider-folder auto-discovery also handles static metadata registration
- Hardcoding model lists in code instead of using the database-backed inventory
- Adding new provider checks directly in commands instead of the provider capability layer
- Treating vendor API capability as the same thing as app-level support
- Forgetting to register the tool adapter with `registerMCPAdapter()` in `02_registerMCPs.ts` — MCP tools will be sent to the LLM but fail at execution time (see step 5.5)

## Related Files

- `docs/en/architecture/pipelines/provider/` (provider pipeline architecture reference)
- `src/types/provider/interfaces.ts`
- `src/types/provider/featureInterfaces.ts`
- `src/utils/provider/providerFactory.ts`
- `src/utils/provider/providerInfoRegistry.ts`
- `src/utils/provider/providerCapabilityResolver.ts`
- `src/providers/utils/providerFeatureExecutors.ts`
- `src/events/clientReady/02_registerMCPs.ts`
- `src/db/seed/catalog/models.ts` (typed model catalog — edit this)
- `src/db/seed/catalog/types.ts` (catalog input types)
- `src/db/seed/catalog/modelSeed.ts` (renders + validates the catalog and seeds it at startup)
- `scripts/checks/checkSeedCatalogs.ts` (`bun run check-seed-catalogs` — offline seed-catalog invariant check)

---

## OpenAI-Compatible Providers

This section is the concrete refactor blueprint for adding multiple new providers that expose an OpenAI-style chat API.

### Why This Exists

TomoriBot already has one practical OpenAI-compatible provider: `src/providers/custom/`. It also has another provider that speaks an OpenAI-like message shape but is not a good generic base: `src/providers/openrouter/`.

`custom` is the highest-ROI extraction starting point for vendors such as DeepSeek, Z.ai, and some NVIDIA NIM chat endpoints.

It is **not** the right base for:

- Vertex AI — auth/config is Google Cloud-oriented rather than simple API-key + base URL
- Codex CLI — better treated as a local tool/client integration than an `LLMProvider`

### Current Reality

The useful split in TomoriBot is:

- `ProviderInfo.featureSupport`: app-level feature support
- `llms` rows: per-model chat/runtime capability flags (`has_tools`, `sees_images`, `supports_structoutput`)
- `image_diffusion_models`: native image generation inventory
- `embedding_models`: embedding inventory

A provider can be chat-only, chat + tools, chat + tools + vision, chat + embeddings, or chat + native image generation without pretending it supports everything.

Important existing behavior: setup/provider switching already tolerates providers with no image models or embedding models by storing `NULL` in `server_model_configs.diffusion_model_id` and `server_model_configs.embedding_model_id`.

### Refactor Goal

The goal is **not** to make every new provider inherit `custom` directly. The goal is to extract a reusable OpenAI-compatible family layer from `custom`, then let multiple concrete providers consume it.

First target consumers: `custom`, `deepseek`, `zai`, `nvidia`.

Deferred or separate work: `openrouter` migration into the shared family, `vertex` provider, `codex-cli` integration.

### Non-Goals

Do not try to solve all of this in the first extraction:

- OpenRouter capability probing and parameter-drop retry logic
- OpenRouter reasoning block preservation
- OpenRouter assistant-image role workaround
- Google/Vertex auth flows
- cross-provider native image generation routing

### Recommended Extraction Boundary

Extract the **stream/tool/message-format** layer first. Do **not** start by forcing a single abstract provider class for everything.

The high-value shared pieces are:

- OpenAI-style message assembly from `StructuredContextItem[]`
- OpenAI-style tool schema conversion
- OpenAI-style SSE stream parsing
- streamed tool-call accumulation
- shared image-part conversion for providers that accept `image_url`
- shared sanitized request logging
- baseline OpenAI-compatible HTTP error parsing

Keep these provider-owned: `providerInfo.ts`, base URL, auth header shape, API key validation strategy, provider display name/aliases, provider-specific locale namespace, request parameter policy, feature flags in `ProviderInfo.featureSupport`, optional runtime capability implementations, and provider-specific structured-output/image-generation/embedding/cost helpers that make vendor-specific HTTP requests.

User-facing reminder: when adding a new provider in this family, also update the `/help` API Keys choices and localized provider instructions.

### File Layout

Recommended new shared folder:

```text
src/providers/openaiCompatible/
  openaiCompatibleTypes.ts
  openaiCompatibleMessageBuilder.ts
  openaiCompatibleSse.ts
  openaiCompatibleErrorFormatter.ts
  openaiCompatibleStreamAdapter.ts
  openaiCompatibleToolAdapter.ts
```

Responsibility split:

- `openaiCompatibleTypes.ts` — shared chunk/tool types; provider-family options (`providerName`, `endpointUrl`, `supportsVision`, `supportsVideos`)
- `openaiCompatibleMessageBuilder.ts` — convert Tomori context into OpenAI chat messages, handle image parts, sanitized logging helper
- `openaiCompatibleSse.ts` — read SSE lines, parse `data:` payloads, normalize `[DONE]`
- `openaiCompatibleErrorFormatter.ts` — baseline HTTP/OpenAI-style error parsing, retryable vs non-retryable helpers
- `openaiCompatibleStreamAdapter.ts` — shared `StreamProvider` implementation, tool-call accumulation, finish-reason handling
- `openaiCompatibleToolAdapter.ts` — generic OpenAI function schema conversion, global and guild MCP tool injection

Concrete providers then stay small:

```text
src/providers/custom/
  customProvider.ts  customStreamAdapter.ts  customToolAdapter.ts  providerInfo.ts

src/providers/deepseek/
  deepseekProvider.ts  deepseekStreamAdapter.ts  deepseekToolAdapter.ts  providerInfo.ts

src/providers/zai/
  zaiProvider.ts  zaiStreamAdapter.ts  zaiToolAdapter.ts  providerInfo.ts
```

### What To Extract From `custom`

Good first extraction candidates from `customStreamAdapter.ts`: OpenAI chunk type definitions, SSE parsing loop, message assembly, tool-call accumulation, finish-reason handling, sanitized request logging, shared image-to-`image_url` conversion.

Good first extraction candidates from `customToolAdapter.ts`: OpenAI function declaration shape, generic schema cloning, tools array conversion, MCP function export path, common tool-result formatting.

### What Not To Extract From `openrouter` Yet

`src/providers/openrouter/` is useful as a reference but remains a separate adapter family. It has
provider-specific capability cache usage, `reasoning_details` preservation, assistant-turn image
role rewriting, and stricter request shaping for upstream vendors. Parameter degradation is shared
through `src/providers/utils/paramDegradation.ts`; providers extending
`OpenAICompatibleStreamAdapter` inherit the fetch-time and pre-commit SSE retry ladder automatically.

### Capability Rules For New Providers

When a vendor lacks a feature, do not emulate support unless the app path is actually wired:

- No native image generation → `featureSupport.nativeImageGeneration = false`, no `image_diffusion_models` rows
- No embeddings → `featureSupport.embeddings = false`, no `embedding_models` rows
- Only some models support tools/vision/structured output → keep provider-level flags broad only when true in principle; gate at `llms` per-model flags
- Vendor API capability but no TomoriBot runtime path → keep `featureSupport` flag `false`

### Provider Mapping

**DeepSeek** — chat streaming, tool calling (where seeded), thinking-mode tool continuation if `reasoning_content` replay is wired, JSON structured output only if validated. Do not assume embeddings or native image generation.

**Z.ai** — chat streaming, tool calling, vision if seeded models support it, structured output if validated. Possible second pass: embeddings, native image generation.

**NVIDIA NIM** — curated text/chat models only; tool calling and vision on seeded rows only; structured output on validated NVIDIA subset; provider-owned embeddings via `nv-embed-v1`; native image generation via NVIDIA's Stability endpoint. Keep treating NVIDIA as a curated catalog, not a blanket claim.

**Vertex AI** — do not place in this family. Even with Vertex's OpenAI-compatible endpoint, the project needs a Google Cloud auth/config story that doesn't fit TomoriBot's current credential model.

**Codex CLI** — do not implement as an `LLMProvider`. If pursued: local tool integration, MCP server bridge, or separate OpenAI API provider for coding models.

### Rollout Order

**Phase 1: Extract Shared Family Helpers** — create `src/providers/openaiCompatible/`, move common helpers, keep behavior identical for `custom`.

**Phase 2: Migrate `custom`** — make `custom` the first consumer; verify no behavior change.

**Phase 3: Add `deepseek`** — provider folder, static `providerInfo.ts`, registry registration, `llms` seed rows, chat streaming, tool calling.

MVP constraints: chat streaming only through shared layer; tool calling only for models seeded with `has_tools = true`; preserve `reasoning_content` only within same tool loop turn; `featureSupport.nativeImageGeneration = false`; `featureSupport.embeddings = false`; enable `structuredOutput` and `historyExtraction` only if validated end-to-end; implement DeepSeek beta prefix completion for assistant prefills; no image/embedding rows unless implemented; if `/tool estimate cost` should support DeepSeek, add minimal non-streaming prompt-token probe.

Recommended provider-local files:

```text
src/providers/deepseek/
  providerInfo.ts  deepseekProvider.ts  deepseekStreamAdapter.ts  deepseekToolAdapter.ts
```

Seed scope: one default general chat model; optionally one reasoning model; per-model flags set conservatively from validated behavior, not vendor marketing copy.

**Phase 4: Add `zai`** — same pattern as `deepseek`; enable only features confirmed by seeded models and runtime wiring.

**Phase 5: Add `nvidia`** — keep supported model set small and curated; wire provider-owned embeddings and native image generation only when exact NVIDIA endpoint contract is implemented.

**Phase 6: Optional Embedding Decoupling** — allow `/model embedding` to choose from any seeded embedding provider; stop coupling embedding selection to the active chat provider.

### Capability Checklist For Future OpenAI-Compatible Providers

When adding the next vendor in this family, verify these areas explicitly:

- **Tool calls**: confirm per-model support before seeding `has_tools = true`; verify the exact assistant/tool message format
- **Structured output**: confirm whether the provider supports strict schema mode or only JSON-object mode; implement prompt shaping + local validation for JSON-object-only providers
- **Reasoning/thinking mode**: check for replay-only fields like DeepSeek `reasoning_content`; preserve only where vendor requires; map `thinking_level` or document deliberate no-op
- **Assistant prefills**: check whether native prefix completion requires a beta endpoint or message flag like `prefix: true`
- **Live cost estimation**: prefer API-reported prompt token usage; use provider-specific pricing sources; document any cache-hit/miss caveats
- **Image generation and embeddings**: only seed rows if the app runtime path is actually implemented; leave feature flags off otherwise
- **Media placeholder contract**: when your stream adapter encounters an image or video part but `seesImages`/`seesVideos` is false, emit a text placeholder — never silently skip. Context may include media parts for fallback models even when the primary cannot render them.

### Acceptance Criteria For The Refactor

The extraction is successful when:

- `custom` still works without behavior regression
- new OpenAI-compatible providers can be added without cloning large stream/tool files
- unsupported provider features fail cleanly
- provider metadata remains the source of truth for app-level feature gating
- per-model DB flags remain the source of truth for chat-model capability gating

The combined extraction + DeepSeek slice is successful when `custom` still works, `deepseek` is auto-discovered, setup/switch/validation commands work, chat streaming and tool calling work for seeded models, structured output and history extraction work only for validated models, `deepseek-reasoner` tool continuation preserves `reasoning_content` within the same turn, assistant prefills use DeepSeek beta prefix completion, and `/tool estimate cost` returns a live estimate.

### Files To Keep In View

- `src/providers/custom/customProvider.ts`
- `src/providers/custom/customStreamAdapter.ts`
- `src/providers/custom/customToolAdapter.ts`
- `src/providers/openrouter/openrouterStreamAdapter.ts`
- `src/utils/provider/providerInfoRegistry.ts`
- `src/utils/provider/providerCapabilityResolver.ts`
- `src/providers/utils/providerFeatureExecutors.ts`
- `src/commands/config/api-key/set.ts`
- `src/commands/model/image.ts`
- `src/commands/model/embedding.ts`
- `src/utils/db/repositories/LlmRepository.ts`

### Practical Recommendation

If you want the fastest route to shipping new vendors:

1. Extract the shared OpenAI-compatible stream/tool/message layer.
2. Migrate `custom` first.
3. Add `deepseek`.
4. Add `zai`.
5. Add `nvidia` with a curated model inventory and provider-owned embedding/image helpers.

Do **not** block that work on Vertex AI or Codex CLI.

### Handoff Scope

If you want another agent to implement this in one pass, give it this bounded scope:

1. Implement Phase 1 and Phase 2.
2. Implement only the DeepSeek MVP described in Phase 3.
3. Do not start Z.ai, Vertex AI, or Codex CLI.
4. Preserve current `custom` behavior.
5. Run `bun run check` and `bun run lint`.

Recommended handoff prompt:

```text
Implement Phase 1 and Phase 2 from the OpenAI-Compatible Providers section in docs/en/contributing/adding-new-provider.md, then implement only the bounded DeepSeek MVP from the same guide.

Constraints:
- preserve current custom-provider behavior
- keep OpenRouter untouched unless a tiny shared extraction is unavoidable
- seed DeepSeek text models conservatively
- do not implement DeepSeek embeddings or native image generation
- do not start Z.ai, Vertex AI, or Codex CLI

Validation:
- bun run check
- bun run lint
```
