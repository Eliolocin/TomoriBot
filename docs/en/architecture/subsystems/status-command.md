---
title: "Status Command"
---

`/status` is the read-only snapshot command for durable personal, server, and persona state.

It exists so users can inspect current configuration without reopening every management command.

## Implementation Boundary

- Slash command registration and routing live in `src/commands/status.ts`.
- `/tool status` remains a temporary compatibility leaf in `src/commands/tool/status.ts` and uses the same coordinator.
- The status coordinator lives in `src/utils/metrics/status/command.ts`.
- Status page implementation lives under `src/utils/metrics/status/`:
  - `personalPages.ts` builds personal settings/provider pages.
  - `personaPages.ts` handles persona selection and persona detail pages.
  - `serverModelPages.ts`, `serverConfigPages.ts`, and `serverChannelPages.ts` build the server status scopes.
  - `channelFormatters.ts`, `providerConfigFormatters.ts`, and `sharedFormatters.ts` own reusable redaction and display formatting.
- `/compact` routing lives in `src/commands/compact.ts`; the public coordinator lives in `src/utils/compaction/compactOrchestrator.ts`, with implementation under `src/utils/compaction/compact/`.

## Scope Coverage

### Personal

- user nickname
- language preference
- privacy mode
- impersonation prompt
- reminder count
- deliberate trigger mode
- cross-server STM opt-in
- NovelAI personal character tags/reference
- global personal memories

### Persona

- persona identity and trigger words
- model override
- avatar / voice / NovelAI reference presence
- conditioning toggles
- attributes
- sample dialogues
- persona-scoped personal memories
- persona-lineage server memories
- persona prompt
- NovelAI tags and ATTG metadata
- persona author's note

### Server

Server status is split across multiple pages so durable state stays visible without exceeding Discord embed limits.

- Model and sampling:
  - active text model
  - `None (User BYOK)` when the server intentionally has no server text provider
  - real OpenRouter `other-model` codename
  - vision / fallback / image / video / embedding models
  - custom endpoint presence
- Behavior:
  - timezone
  - fetch / send / cooldown / trigger limits
  - member BYOK mode status
- Channels and automation:
  - auto-chat, RP, private, cross-channel blocklist
  - welcome channel and welcome prompt presence
  - whitelists
  - random trigger advanced fields
- Features and moderation:
  - feature toggles
  - experimental workaround toggles
  - moderation flags
  - blacklist state
- Prompt pages:
  - system prompt
  - server author's note
- Overrides:
  - channel and persona model overrides
- Quotas:
  - image, text, and video quota config
- NovelAI image config:
  - preset, sampler, steps, scale, noise schedule, tags
- Integrations and access:
  - API key rotation pool status
  - optional API key coverage
  - saved provider configs
  - MCP registrations
  - Matrix link coverage
  - hidden notice embeds
  - active SillyTavern preset and node state

## Privacy Rules

`/status` must not expose raw secrets or private external endpoints.

Redacted surfaces:

- API keys: show presence or counts only
- API key rotation: show counts/status only
- optional API keys: show configured services only
- saved provider configs: show provider names only
- MCP auth tokens: never show token contents
- custom endpoint URLs: show configured/not configured only
- Matrix room IDs: do not show room IDs; show linked Discord channels/count only
- welcome/random-trigger custom prompts: show configured/not configured only

Existing prompt preview pages remain intentionally visible because they are first-party editable bot instructions already owned by the requester.

## Maintenance Rule

When a new durable config surface is added:

1. update the owning management command
2. surface the resulting state in `/status`
3. keep this document in sync
4. preserve the redaction rules above for any secret-bearing fields
