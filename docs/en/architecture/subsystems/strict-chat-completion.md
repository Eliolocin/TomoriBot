---
title: "Strict Chat-Completion Compatibility"
---

# Strict Chat-Completion Compatibility

Some provider APIs require message shapes that others merely tolerate. TomoriBot normalizes three
of these behind one shared seam so any provider path — built-in or a custom-endpoint proxy — can
front a strict backend (e.g. Claude behind an OpenAI-shaped proxy, or a DeepSeek/Z.ai-style
"continue this turn" backend).

The shared helpers live in [`src/providers/utils/strictChatCompat.ts`](../../src/providers/utils/strictChatCompat.ts).

## The three normalizations

| Normalization | Toggle? | What it does |
|---|---|---|
| **Role alternation** | `strict_role_alternation` | Merge consecutive same-role turns into one, and prepend a synthetic leading `user` turn when the first dialogue turn is `assistant`. Tool-bearing turns (top-level `tool_calls`/`tool_call_id`) act as merge boundaries so their wiring is never dropped. |
| **Prefix completion** | `supports_prefix_completion` | Set `prefix: true` on the trailing assistant prefill turn so the backend continues it (DeepSeek / Z.ai vendor extension). |
| **Media relocation** | *(always-on, not a toggle)* | Peel media off `assistant` turns into a following `[System: …]` `user` turn with sender attribution — the `assistant` role cannot carry media in input history across OpenAI/Anthropic/Gemini-shaped APIs. |

### Orthogonality (why two toggles, not one)

Role alternation and prefix completion pull in opposite directions and must stay independent:

- A **Claude-via-proxy** backend wants role alternation **ON**, prefix completion **OFF** (it does
  not understand `prefix: true` and may hard-error on it).
- A **DeepSeek/Z.ai/vLLM-style continue** backend wants prefix completion **ON**, and usually does
  not need role alternation.

A single bundled "strict mode" boolean would force the wrong combination on one group.

### Media relocation is always-on

Media relocation runs unconditionally in every provider path, regardless of either toggle — a
custom endpoint with both toggles OFF still gets it. It was already unconditional before this
seam existed; do not gate it. The canonical wording is shared across all providers:

```
[System: The following image was sent by {name}.]
[System: The following images were sent by {name}.]
```

When no sender is available, the fallback is the same canonical sentence without the name:

```
[System: The following image was sent]
[System: The following images were sent]
```

The sender comes from `StructuredContextItem.sender`, populated from each
`SimplifiedMessageForContext` row's `personaName` / `authorName` before provider serialization.
Relocation runs on that neutral representation first, so multi-persona histories can attribute
each relocated image to the persona that actually sent it, including image-only turns where parsing
a leading `{Name}:` text label would fail.

When relocation clones or splits a structured item, it also preserves hidden participant metadata,
including `conversationUsers` and `participantTargetIndex`. Provider normalization never reparses
participant prompt prose to recover mention, tool-target, or copied-identity candidates.

Anthropic and OpenRouter previously used a single per-request name
(`[System: This image was sent by {botName}.]`) for every relocated image. That could mislabel
images sent earlier by other personas. The OpenAI-compatible family previously used the generic
`[System: The previous assistant message included ...]` wording. The current wording intentionally
supersedes the plan-07 byte-identical golden-body bar for the media notice only; role alternation
and prefix-completion goldens remain unchanged.

## Resolution: column-is-truth (D4)

Both flags are stored as boolean columns on **`llms`** and **`custom_endpoints`**
([`src/types/db/schema.ts`](../../src/types/db/schema.ts), [`src/db/schema.sql`](../../src/db/schema.sql)).
At request time the active model's `llms` row is the source of truth — the adapter reads
`context.tomoriState.llm.strict_role_alternation` / `.supports_prefix_completion`:

- **Built-in providers** are seeded with the required flag in the typed catalog
  ([`src/db/seed/catalog/models.ts`](../../src/db/seed/catalog/models.ts)): anthropic →
  alternation; deepseek/zai/zaicoding → prefix.
- **Custom endpoints** carry the user's toggle choices on the `custom_endpoints` row, synced to the
  endpoint's **synthetic `llms` row** (`upsertSyntheticCustomLlm`), so the runtime reads them the
  same way as built-ins.

A small request-time **safety net** — `providerRequiresAlternation` / `providerRequiresPrefixCompletion`
in `strictChatCompat.ts` — OR-combines with the column so a mis-seeded row can never make a
built-in emit an invalid body:

```ts
const enforceAlternation =
  providerRequiresAlternation(provider) || (llm?.strict_role_alternation ?? false);
const enablePrefix =
  providerRequiresPrefixCompletion(provider) || (llm?.supports_prefix_completion ?? false);
```

### Enforced by check-seed-catalogs (no UI guard)

Built-in `llms` rows have no capability-editing command surface, so there is no write/UI guard.
Instead the per-provider required-flag invariant runs at boot and in CI via
[`bun run check-seed-catalogs`](../../scripts/checks/checkSeedCatalogs.ts) → `collectStrictChatFlagViolations`
in [`modelSeed.ts`](../../src/db/seed/catalog/modelSeed.ts). It fails if any anthropic model lacks
`strictRoleAlternation`, or any deepseek/zai/zaicoding model lacks `supportsPrefixCompletion`. Keep
the `REQUIRED_*_PROVIDERS` sets in `modelSeed.ts` in lockstep with `providerRequires*` in
`strictChatCompat.ts`.

## Configuring a custom endpoint

The two toggles appear in the Text model modal opened through **Add or Edit a Model** in
`/providers` and `/personal providers`.

- **Strict Role Alternation** — enable when your proxy fronts a backend that requires strict
  user/assistant alternation and a leading user turn (e.g. **Claude behind an OpenAI-shaped proxy**).
- **Prefix Completion** — enable when your proxy fronts a backend that supports continuing a partial
  assistant turn (e.g. **DeepSeek / Z.ai-style** `prefix: true`, or vLLM/SGLang continue modes).

Both default OFF. With both OFF a custom endpoint behaves exactly as before (media relocation still
applies; no alternation merge; no `prefix: true`).

## Migration

`025_strict_chat_compat_flags` adds the two columns to both tables (defaulting OFF) and backfills
the built-in requirements: `strict_role_alternation = true` for `anthropic`, and
`supports_prefix_completion = true` for `deepseek`/`zai`/`zaicoding`. Fresh installs get the same
values from the seed catalog + `schema.sql`.
