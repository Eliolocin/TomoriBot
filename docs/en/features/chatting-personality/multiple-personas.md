---
title: "Multiple Personas"
# Keyword-rich <title> targeting "AI companion Discord" queries; replaces
# Starlight's default "{title} | TomoriBot" for this page only. H1 and sidebar
# keep the plain title. The homepage title bets on "AI agent" + "roleplay" —
# this page carries the "companion" keyword instead.
head:
  - tag: title
    content: "TomoriBot | AI Companions & Personas for Your Discord Server"
# Hand-written search snippet; overrides the auto-derived description from
# routeData.ts middleware.
description: "Run multiple AI companions in one Discord server. Custom personas with their own avatars, triggers, and speaking styles."
sidebar:
  order: 2
---

TomoriBot's personality lives in a **persona**: her name, avatar, traits, speaking style, and
behavior. You can run several personas at once, each a distinct character with its own
triggers and webhook avatar. This page is about *how she behaves* — for *what she knows*
(facts and memories), see [Memory](/features/knowledge/memory/).

## Creating a Persona

- `/persona create` — build a custom personality from scratch.
- `/persona generate` — have the AI generate a personality from a description and an image.
  Requires a provider that supports structured output. You can also upload an existing
  TomoriBot preset or a SillyTavern card here to transform an existing character (see
  [SillyTavern Support](/features/integrations/sillytavern-support/)).
- `/persona default` — switch to one of the built-in default personalities as a foundation.
- `/persona export` / `/persona import` — share or back up a persona as a file. Import
  supports bringing a persona in as an **alter** with its own triggers and webhook avatar.
- `/persona remove` — remove an alter persona.

A good starting workflow: pick a default or generate one, then refine it with attributes
and sample dialogues below.

## Alter Personas

Alter personas let multiple characters coexist in one server:

- Each alter has its own personality, trigger words, and **webhook avatar** — so different
  characters appear with different names and pictures in the same channel.
- Multiple alters can respond to a single message, up to the `/config trigger-match-limit`
  limit.
- **Replying to a webhook message** continues the conversation as that persona.
- Add alters via `/persona import` (alter option); manage them with `/persona` and
  `/persona remove`.

This is what makes group roleplay and multi-character servers possible. For the runtime
details of how triggers route to personas and how webhook identities work, see the
architecture reference on [multi-persona behavior](/architecture/subsystems/multi-persona/).

## Shaping Personality

Two commands do most of the work of teaching her how to talk and act:

### Attributes

`/persona attribute add` adds personality traits or physical characteristics — for example
`friendly`, `red hair`, or `ends sentences with *Nya~*`. Remove them with
`/persona attribute remove`.

### Sample Dialogues

`/persona sample-dialogue add` teaches her *how she speaks* by example. Use the `{user}` and
`{bot}` placeholders so dialogues work for everyone (and when you share the persona):

- `{user}` — replaced with the actual user's name/nickname
- `{bot}` — replaced with her current name

```text
{user}: What's your favorite hobby?
{bot}: Fufu~ I like knitting tiny clothes for tiny plushies~♥
```

Tips for effective sample dialogues:

- Write natural, conversational exchanges.
- Bake in the attributes and traits you want her to exhibit.
- Demonstrate the tone you're after, and add variety so she generalizes.

Remove examples with `/persona sample-dialogue remove`.

### Name and Avatar

- `/persona rename` — set what she calls herself.
- `/persona avatar` (or `/server avatar`) — set her profile picture for this server.

You can also set a custom system prompt with `/config system-prompt set` to further shape
behavior — see [Behavior Tweaking](/features/chatting-personality/behavior-tweaking/).

## Sprites (Emotion Avatars)

Sprites are alternate avatar images a persona can switch to mid-conversation to express an
emotion or situation — think of them as her facial expressions. Each sprite is a labeled
image (for example `happy`, `mad`, `embarrassed`) that she displays in place of her normal
avatar when it fits the moment.

How she uses them: the available sprites and their usage notes are given to the model each
turn. To show one, she starts a reply line with `PersonaName (label):`; that line is then
delivered with the matching sprite image. If no sprite fits, she replies normally.

Manage a persona's sprites with the `/persona sprites` command group (adding and removing
require the **Manage Server** permission):

- `/persona sprites add` — add or replace a sprite: pick the persona, give it a **label**,
  upload the **image** (PNG, JPG, or GIF), and optionally add **usage instructions** telling
  her when to use it. Reusing a label replaces that sprite. Each persona has a maximum sprite
  count.
- `/persona sprites edit` — change an existing sprite's name, image, instructions, or
  identity toggle.
- `/persona sprites remove` — delete sprites from a persona.
- `/persona sprites import` / `/persona sprites export` — back up or share a persona's whole
  sprite set as a file.

The **identity** toggle decorates the message name as `Label (Persona)` in Discord, which is
especially useful for [alter personas](#alter-personas) that speak as distinct characters.

## Per-Channel Persona Picks

Want to control which persona answers *you* in a specific channel without changing the
server-wide setup? That's Personal Spotlight — see
[Personalization](/features/knowledge/personalization/#personal-spotlight).

## Persona-specific ways of addressing people

Server managers can use `/persona naming-habits` to give each persona independent masculine,
feminine, and neutral prefixes, suffixes, and standalone address terms. A user's own
persona-scoped override is keyed by stable persona lineage, so two personas may call Sparrow
different names in the same multi-persona response while both still target the same Discord
user. Editing an official pointer first creates an independent copy; it never changes the
shared catalog or another server's persona.
