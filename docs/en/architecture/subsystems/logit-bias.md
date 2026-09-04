---
title: "Logit Bias"
---

This document describes TomoriBot's `/config logit-bias` design and runtime behavior.

## Command Surface

- `/config logit-bias add`
- `/config logit-bias remove`
- `/config logit-bias upload`

The command family accepts plain text such as `sorry, hello, hi` plus a shared bias value like `-100`, and also accepts explicit numeric token IDs.

## Design Goals

- Keep the user-facing UX text-first.
- Preserve imported SillyTavern-style entries without forcing users to know token IDs.
- Avoid re-tokenizing on every generation request.
- Survive provider/model switches without throwing away the original text.

## Source Of Truth

Each saved entry keeps:

- `text`: the original user-provided term
- `value`: the bias value
- `kind`: `text` or `token_id`
- `tokenizations`: cached token-ID lists keyed by tokenizer family

Raw text is the canonical source of truth. Cached tokenizations are derived data.

This means a switch to a different model does not destroy the original entry. Tomori can recompute a new tokenizer-specific cache later.

## Runtime Model

At generation time, Tomori builds the OpenAI-style `logit_bias` map for the current model only.

- Explicit numeric token-ID entries are always passed through directly.
- Text entries only become runtime-ready when Tomori has a cached tokenization for the current tokenizer family.
- Unknown tokenizer families remain saved but inactive.

## Refresh Triggers

Tomori refreshes tokenizer caches when the effective text model changes or when new entries are added:

- `/config logit-bias add`
- `/config logit-bias upload`
- `/config` > Models > Switch Models
- `/config provider switch` when it changes or restores `llm_id`

Saved provider snapshots also preserve `llm_logit_biases`, so switching away and back keeps both the raw text and any previously-cached tokenizer data.

## Current Local Tokenizer Support

The current local resolver supports OpenAI BPE families via `gpt-tokenizer`:

- `o200k_base`
- `o200k_harmony`
- `cl100k_base`
- `p50k_base`
- `p50k_edit`
- `r50k_base`

It also supports local tokenizer-family assets under `tokenizers/` for:

- `deepseek_v3_r1`
- `qwen3_5`
- `mistral_small3`
- `glm_zai`
- `stepfun_step35`
- `kimi_k2`
- `gemma3`
- `nemotron3`

OpenRouter tokenizer metadata is read from the startup capability cache when available. Tomori also falls back to model-codename heuristics for both OpenAI BPE families and these local tokenizer families.

## Text Variant Expansion

Plain-text entries are approximated as token-level bias by expanding a small set of variants before tokenization:

- exact text
- leading-space text
- sentence-case text
- leading-space sentence-case text

This improves common cases like banning `sorry` in both `"sorry"` and `" sorry"` positions.

## Important Limitation

`logit_bias` is token-level, not word-level.

Biasing the tokens that make up a word can also affect other words that share those same tokens. The text-first UX is therefore an approximation layer on top of a token-ID API.

## Provider Gating

Tokenization support and request-parameter support are separate concerns.

- Tokenization decides whether Tomori can turn raw text into token IDs for a model family.
- Provider gating decides whether the runtime request actually sends `logit_bias`.

Tomori sends `logit_bias` on the following providers when active entries exist:

- **OpenRouter** — gated on the model's `supported_parameters` capability flag
- **DeepSeek** — sent unconditionally when entries are present
- **Z.ai** — sent unconditionally when entries are present
- **Z.ai Coding** — sent unconditionally when entries are present
- **NVIDIA NIM** — sent unconditionally when entries are present

Custom, NovelAI, and Google providers do not currently send `logit_bias`.

## Storage

Server-wide active config:

- `server_chat_configs.llm_logit_biases`

Per-provider saved snapshots:

- `saved_provider_configs.llm_logit_biases`

Both store the same entry shape so switching providers can restore the exact same logical entries and cached tokenizer results.

## Extension Path

To broaden text-first support beyond OpenAI BPE families, add tokenizer-family resolvers instead of per-model one-offs.

Use `src/db/seed/catalog/models.ts` to inventory the non-deprecated model families that need tokenizer assets. The practical target is one tokenizer implementation per family, not one tokenizer file per seeded row.

## Local Tokenizer Assets

Tomori expects local tokenizer assets at repo-root `tokenizers/` by default.

- Default asset root: `./tokenizers`
- Optional override: `TOKENIZER_ASSET_DIR`

Deployment must include this directory explicitly. The Docker image now copies repo-root `tokenizers/` into `/app/tokenizers` and sets `TOKENIZER_ASSET_DIR=./tokenizers`.
