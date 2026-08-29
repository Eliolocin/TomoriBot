---
title: "Thinking Level"
---

This page describes how TomoriBot's provider-scoped `thinking_level` preference works today.

Use this page to verify:

- the default
- what each level means
- how Tomori maps the general levels to provider-specific request fields
- which providers currently ignore the setting

## Scope

`thinking_level` is a **provider-scoped saved preference** controlled by:

- `/model parameters thinking_level:<value>` — for a server saved provider (you pick which
  saved provider via the interactive picker after running the command)
- `/personal config` — for your personal saved provider

Current values:

- `auto`
- `none`
- `low`
- `medium`
- `high`

Default:

- `auto`

Storage:

- `saved_provider_configs.thinking_level`
- `server_model_configs.thinking_level` (deprecated Phase 1.5 mirror; drop scheduled for step #14.5)

That means the active value is:

- visible in `/tool status`
- reflected in `/tool prompt snapshot`
- preserved in provider snapshots and restored by `/config provider switch`

## Important Rule

`thinking_level` is a **provider-agnostic preference**, not a guaranteed vendor feature.

Tomori only applies it when the active provider/model exposes a verified request-side reasoning or thinking control.

If a provider/model does not support a stable request-side control in Tomori, the setting is ignored for that request.

## Shared Semantics

These are the meanings Tomori uses before mapping to vendor-specific fields:

| Level | Meaning |
| --- | --- |
| `auto` | Let the provider/model use its default or automatic behavior. |
| `none` | Disable thinking if possible, otherwise use the provider's lowest safe setting. |
| `low` | Ask for light reasoning effort. |
| `medium` | Ask for balanced reasoning effort. |
| `high` | Ask for the strongest available reasoning effort. |

## Current-Turn Override

Tomori already has a per-turn `forceReason` flag used by some flows.

Current implementation rule:

- if `forceReason = true` and stored `thinking_level` is `auto` or `none`, Tomori upgrades the effective level for that request to `high`
- this does **not** rewrite the stored config

## Numeric Budget Defaults

When a provider accepts a numeric reasoning budget, Tomori maps `low` / `medium` / `high` using these env vars:

- `THINKING_LEVEL_BUDGET_LOW_TOKENS=1024`
- `THINKING_LEVEL_BUDGET_MEDIUM_TOKENS=4096`
- `THINKING_LEVEL_BUDGET_HIGH_TOKENS=8192`

These are Tomori defaults, not vendor defaults.

## Provider Mapping

This section describes the mapping implemented in `src/utils/provider/thinkingControl.ts`.

### Google / Vertex / Vertex Express

Tomori splits Gemini behavior by model family:

- Gemini 2.5 family: uses numeric `thinking_budget`
- Gemini 3 / 3.1 family: uses enum-like `thinking_level`

Tomori behavior:

| Model family | `auto` | `none` | `low` / `medium` / `high` |
| --- | --- | --- | --- |
| Gemini 2.5 | `thinkingBudget: -1` | Flash/Flash-Lite: `0`; Pro: `128` | uses env budget defaults, clamped to vendor minimums |
| Gemini 3 / 3.1 | omit thinking config | Flash: `MINIMAL`; Pro: `LOW` | `LOW` / `MEDIUM` / `HIGH` |

Important implementation notes:

- Gemini 2.5 Pro cannot be fully disabled, so Tomori maps `none` to the minimum safe budget instead of pretending it can turn thinking off.
- Gemini 2.5 Flash-Lite has a higher positive minimum than Flash, so Tomori clamps upward when needed.
- Gemini 3 Pro does not get a true disable path in Tomori; `none` becomes the lowest supported level.

### Anthropic

Tomori uses adaptive thinking for supported Claude 4.6 / 4.7 models.

Currently mapped:

- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `claude-opus-4-7`

Tomori behavior:

| Level | Anthropic request |
| --- | --- |
| `auto` | `thinking: { type: "adaptive" }` |
| `none` | `thinking: { type: "disabled" }` |
| `low` | `thinking: { type: "adaptive" }` + `output_config: { effort: "low" }` |
| `medium` | `thinking: { type: "adaptive" }` + `output_config: { effort: "medium" }` |
| `high` | `thinking: { type: "adaptive" }` + `output_config: { effort: "high" }` |

Additional behavior:

- when adaptive thinking is active, Tomori omits sampling params that Anthropic rejects in that mode
- unsupported Anthropic models currently ignore `thinking_level`

### OpenRouter

Tomori maps `thinking_level` to OpenRouter's reasoning-effort control.

Tomori behavior:

| Level | OpenRouter request |
| --- | --- |
| `auto` | omit `reasoning` |
| `none` | `reasoning: { effort: "none" }` |
| `low` | `reasoning: { effort: "low" }` |
| `medium` | `reasoning: { effort: "medium" }` |
| `high` | `reasoning: { effort: "high" }` |

Tomori does not currently send numeric reasoning budgets through OpenRouter.

### DeepSeek

Tomori treats DeepSeek chat model modes differently:

- `deepseek-v4-flash` (default) and `deepseek-chat` (deprecated codename, same behavior): optional
  request-side thinking enable
- `deepseek-reasoner` (deprecated): reasoning model by identity

`deepseek-v4-pro` is DeepSeek's higher tier general model; it is not part of the thinking-toggle
special case and receives no extra toggle handling.

Tomori behavior:

| Model | `auto` / `none` | `low` / `medium` / `high` |
| --- | --- | --- |
| `deepseek-v4-flash` / `deepseek-chat` | omit thinking flag | `thinking: { type: "enabled" }` |
| `deepseek-reasoner` | no extra toggle; model stays reasoning-oriented | no extra toggle; model stays reasoning-oriented |

Additional behavior:

- when DeepSeek thinking is active, Tomori removes incompatible sampling fields
- Tomori does not currently expose a numeric DeepSeek reasoning budget because no verified stable budget field is wired here

#### reasoning_content round-trip (thinking mode)

With `thinking: { type: "enabled" }` on `deepseek-v4-flash` (or the deprecated `deepseek-chat`
codename), DeepSeek rejects any replayed assistant tool-call turn that omits `reasoning_content`:

```
HTTP 400: The `reasoning_content` in the thinking mode must be passed back to the API.
```

Verified endpoint behavior:

| Shape | Result |
| --- | --- |
| tool-call turn with `reasoning_content` (any string) | accepted |
| tool-call turn with `reasoning_content: ""` | accepted |
| tool-call turn with the key omitted | 400 |
| plain history assistant turns without the key | accepted |

The validator checks presence, not content. `deepseek-reasoner` and non-thinking `deepseek-v4-flash`
(or `deepseek-chat`) do not enforce it.

Tomori therefore always emits the key on tool-call turns for DeepSeek
(`requiresReasoningContentReplay`), falling back to an empty string when the reply carried no
reasoning. Two protections back this up:

- `mandatoryBodyKeys: ["thinking"]` keeps the parameter-degradation ladder from generating a
  `probe_drop_thinking` rung. That rung kept `tools` while dropping `thinking`, so its reply had no
  reasoning to capture, and the next request in the same tool loop ran at full strength and could
  not replay the turn it had just stored.
- the empty-string fallback keeps the request legal even if some other path leaves the capture empty.

Other reasoning-capable OpenAI-compatible endpoints keep capture-only behavior: they receive
`reasoning_content` only when the stream actually produced it.

### Z.ai / Z.ai Coding

Tomori maps `thinking_level` to Z.ai's documented thinking enable/disable flag.

Tomori behavior:

| Level | Z.ai request |
| --- | --- |
| `auto` | omit `thinking` |
| `none` | `thinking: { type: "disabled" }` |
| `low` / `medium` / `high` | `thinking: { type: "enabled" }` |

Additional behavior:

- when Z.ai thinking is active, Tomori removes `temperature`, `top_p`, `frequency_penalty`, and `presence_penalty`
- Tomori does not currently send a numeric Z.ai thinking budget

### Custom Endpoint

Tomori only auto-maps `thinking_level` for **Ollama-style OpenAI endpoints** in the custom provider path.

Detection heuristic:

- endpoint hostname contains `ollama`, or
- endpoint port is `11434`

Tomori behavior for detected Ollama endpoints:

| Level | Custom request |
| --- | --- |
| `auto` | omit `reasoning_effort` |
| `none` | `reasoning_effort: "none"` |
| `low` | `reasoning_effort: "low"` |
| `medium` | `reasoning_effort: "medium"` |
| `high` | `reasoning_effort: "high"` |

#### Gemma 4 thinking on KoboldCPP

Tomori's `thinking_level` has **no effect** on Gemma 4 thinking over a custom endpoint. Thinking activation is controlled entirely at the KoboldCPP launch level — not at the request level via the OpenAI-compatible API.

**To enable Gemma 4 thinking in KoboldCPP:**

1. Use a Jinja chat template for Gemma 4 (enable "Use Jinja" and "Jinja for Tools" in the KoboldCPP UI).
2. Launch KoboldCPP with `--jinja_kwargs='{"enable_thinking":true}'` to pass `enable_thinking=true` into the template engine. Without this flag the template defaults `enable_thinking` to `false` and no thinking tokens are emitted regardless of the template file.
3. For 26B/31B hybrid models, alternatively hardcode `{%- set enable_thinking = true -%}` at the top of the Jinja template file.

**Response-side parsing:**

KoboldCPP v1.111.2+ automatically converts Gemma 4's `<|channel>thought…<channel|>` thinking tokens into the standard `reasoning_content` field for pure-text responses. Tomori's base adapter reads `reasoning_content` and routes it to the thought log channel automatically.

When a tool call immediately follows the thinking block, KoboldCPP does not split the chunk and the raw tokens appear in `delta.content` instead. Tomori's `GemmaThinkingParser` (`src/providers/custom/customGemmaThinkingParser.ts`) handles this case — it strips the thinking block and routes it to thoughts before `GemmaToolCallParser` processes the tool call. Set `CUSTOM_GEMMA_THINKING_PARSER_ENABLED=false` to disable if a non-Gemma model unexpectedly produces similar token strings.

**Thought log suppression:**

Thought logs are suppressed for private channels (channels listed under `/server private-channels`) regardless of model or provider. Test thought log routing in a non-private channel.

### NovelAI GLM

Tomori maps `thinking_level` to the GLM prompt directive:

| Level | Prompt directive |
| --- | --- |
| `auto` | follow `NAI_GLM_THINKING_ENABLED` env behavior |
| `none` | `/nothink` |
| `low` / `medium` / `high` | `<think></think>` |

This is a prompt-format control, not a numeric reasoning budget.

## Currently Not Auto-Mapped

Tomori intentionally does **not** auto-send a generic request-side thinking control for:

- KoboldCPP (see Gemma 4 section above for response-side parsing)
- llama.cpp
- generic vLLM custom endpoints

Reason:

- These backends expose thinking via startup flags, Jinja template variables, or GUI settings — not via a stable, universally-supported OpenAI-compatible request field.
- Injecting unrecognised fields into the request body can cause 400/422 errors on servers that validate strictly.

So the current implementation is conservative: configure thinking at the server level, not from Tomori's `thinking_level` preference.

## Future Provider Requirement

When adding a new provider, the implementation should now explicitly decide one of these:

1. map `thinking_level` to the vendor's verified request-side reasoning control
2. intentionally no-op and document why the provider does not use it

Do not silently ignore the feature without documenting the decision.

See also:

- [`contributing/adding-new-provider.md`](../../contributing/adding-new-provider)

## Official Source Links

These are the vendor docs used for the current mapping:

- Google / Vertex / Vertex Express thinking: <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking>
- Anthropic adaptive thinking: <https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking>
- Anthropic effort: <https://platform.claude.com/docs/en/build-with-claude/effort>
- Anthropic extended thinking: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- OpenRouter reasoning tokens: <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- DeepSeek thinking mode: <https://api-docs.deepseek.com/guides/thinking_mode>
- Z.ai thinking mode: <https://docs.z.ai/guides/capabilities/thinking-mode>
- Ollama OpenAI compatibility: <https://docs.ollama.com/openai>
- Ollama thinking: <https://docs.ollama.com/capabilities/thinking>
- vLLM reasoning outputs: <https://docs.vllm.ai/en/latest/features/reasoning_outputs.html>

## Notes on Inference

Some vendor docs describe capabilities and constraints, but not Tomori's exact five-level mapping.

Where that happened, Tomori makes a conservative implementation choice:

- prefer vendor-documented request fields
- clamp to documented minimums instead of inventing unsupported disables
- avoid sending undocumented generic fields to local/custom backends
