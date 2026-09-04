---
title: "SillyTavern Support"
# Keyword-rich <title> targeting "SillyTavern character cards in Discord"
# queries; replaces Starlight's default for this page only. H1 and sidebar
# keep the plain title.
head:
  - tag: title
    content: "TomoriBot | Use SillyTavern Character Cards in Discord"
# Hand-written search snippet; overrides the auto-derived description from
# routeData.ts middleware.
description: "Import SillyTavern character cards and prompt presets into Discord with TomoriBot. Bring your existing characters to your server."
sidebar:
  order: 2
---

TomoriBot can import two things from [SillyTavern](https://github.com/SillyTavern/SillyTavern)
that you may already have: **Prompt Manager presets** (how the prompt is laid out) and
**character cards** (the character itself). This is a niche feature for ST users — if you've
never used SillyTavern, you can skip this page.

## Character Card Import

Bring an existing SillyTavern character straight into Discord with `/persona import`. It
accepts:

- **PNG cards** with embedded `chara` / `char` metadata,
- **v2-style JSON** cards (root-level `name`, `description`, `first_mes`, …),
- **v3 JSON** cards (`spec: "chara_card_v3"` with a nested `data` object).

If the file has no TomoriBot metadata but is a valid ST v2/v3 card, import automatically runs
it through the SillyTavern conversion flow. You can also feed a card to `/persona generate` to
transform it into a fresh persona.

Imports pass through a validation schema before anything is saved (default caps: 5,000
characters per string, 200 attributes, 100 sample dialogues per side, 100 trigger words —
self-hosters can tune the `PRESET_MAX_*` env vars). For the exact conversion and field
mapping, see the [card-support architecture](/architecture/integrations/sillytavern/card-support/).

## Prompt Presets

A SillyTavern Prompt Manager preset controls the **layout** of the prompt. Use `/st-presets`
to import presets, inspect enabled nodes, switch between presets, or return to the normal layout.

### What a Preset Controls

- Prompt order and marker placement
- Custom prompt nodes
- Post-history / depth-injection nodes
- Which imported nodes start enabled or disabled

### What It Does *Not* Replace

A preset owns the *layout*, not every source of text. These still exist alongside it:

- Your system/persona blocks: `/config` > Engine > General, `/config` > Persona > Advanced,
  the attribute and sample-dialogue actions on `/config` > Persona > Identity & Personality.
- Live chat history and retrieved document context.
- TomoriBot's automatic context: server memory, emoji/sticker context, users-in-conversation,
  short-term memory, conditioning, and similar blocks.

### How Native Blocks Map

- `main` → the current system prompt (`/config` > Engine > General, else the built-in fallback)
- `charDescription` → `/config` > Persona > Advanced
- `charPersonality` → `/config` > Persona > Identity & Personality
- `dialogueExamples` → `/config` > Persona > Identity & Personality
- `chatHistory` → live channel history
- `worldInfoBefore` / `worldInfoAfter` → retrieved document context (not ST lorebooks)

### System Prompt Rule

While a preset is active, the built-in fallback system prompt is removed — but if *you* set
your own with `/config` > Engine > General, it's still sent.

### Compatibility Notes

Common surprises when a preset seems ignored:

- Imported ≠ sent: nodes disabled in `prompt_order` stay off until you enable them with
  `/st-presets`. Comment-only and empty nodes are never sent; unknown markers are
  skipped.
- Order is literal — placing `chatHistory` before `dialogueExamples` sends live chat first.
- Post-history/depth injections merge into existing chat-history entries rather than becoming
  standalone messages; multiple nodes at the same depth are batched.
- Regex post-processing, preset-side temperature/top-p/model overrides, and layered presets
  are not supported. Legacy text-completion presets import through a best-effort path that
  drops ST-only blocks (scenario, anchors, stop strings, …).

In `/help`, choose **Integrations**, then **SillyTavern Presets**, for the in-Discord reference. For the import engine internals, see
the [preset-system architecture](/architecture/integrations/sillytavern/preset-system/).
