---
title: "Status Command"
---

`/status` is the read-only snapshot command for durable personal, server, and persona state.

It exists so users can inspect current configuration without reopening every management command.

## Implementation Boundary

- Slash command registration and routing live in `src/commands/status.ts`.
- The status coordinator lives in `src/utils/metrics/status/command.ts`.
- Status page implementation lives under `src/utils/metrics/status/`:
  - `personalPages.ts` builds personal settings/provider pages.
  - `personaPages.ts` handles persona selection and persona detail pages.
  - `serverModelPages.ts`, `serverConfigPages.ts`, and `serverChannelPages.ts` build the server status scopes.
  - `channelFormatters.ts`, `providerConfigFormatters.ts`, and `sharedFormatters.ts` own reusable redaction and display formatting.
- `/compact` routing lives in `src/commands/compact.ts`; the public coordinator lives in `src/utils/compaction/compactOrchestrator.ts`, with implementation under `src/utils/compaction/compact/`.

## Scope Coverage

`/status` provides five ordered categories: Persona, Behavior, Models, Access, and Personal. Every resulting dashboard displays all five category buttons at the top, regardless of initial slash scope, allowing readers to navigate among all five without re-running the command.

Persona additionally provides its real persona selector/picker-backed workflow with private delivery and ownership scoping, while keeping Personal and the three server categories reachable from that same surface.

Category page counts:
- Persona: 5 pages (Identity, Attributes, Sample Dialogues, Memories, Prompt and Tags)
- Behavior: 3 pages (General Behavior, Channels and Automation, Thought Logs & Matrix)
- Models: 4 pages (Models and Sampling, Overrides, Integrations and Endpoints, NAI Image)
- Access: 3 pages (System Prompt, Capabilities & Moderation, Quotas)
- Personal: 2 pages (Personal Status, Providers and Endpoints)

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

### Server Categories

Status is rendered as a private Components V2 dashboard. Category buttons are placed above the page selector and
page body, so readers can move between categories without re-running the command. The renderer reserves four of
Discord's 40 components for future controls and bounds Text Display output to Discord's 4,000-codepoint limit.

- Behavior: general behavior, system prompt, channels, and automation.
- Models: model and sampling, overrides, NAI image configuration, integrations, and endpoints.
- Access: capabilities, moderation, member access, and image, text, and video quotas.

Each page identifies the management command that owns its settings, so a status reader can return to the editor.

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
