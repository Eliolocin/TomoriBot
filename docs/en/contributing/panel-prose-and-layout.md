---
title: "Panel Prose and Layout"
---

Rules for text and component arrangement inside a Components V2 panel, the writable
ephemeral surfaces built from `src/utils/discord/ui/*Panel.ts`. Discord renders these
differently from an embed, so several habits that are harmless elsewhere are defects here.

Every rule below has a failure it prevents. Where a gate enforces one, the gate is named.

## Line width

**Keep every authored line at or under 65 rendered characters, and break longer prose with
`\n` yourself.**

A Components V2 container sizes itself to its widest line. One long paragraph therefore
stretches the whole panel wider than the select menus under it, and the page stops reading as
a single column. Discord does wrap, but only at the width it chose, which is not the width of
the controls.

Break at a clause boundary rather than at exactly 65 characters:

```ts
// Renders as one over-wide block.
fallbacks_description: `Fallbacks are tried in order when your personal primary text model cannot complete a request.`,

// Matches the width of the selects beneath it.
fallbacks_description: `Fallbacks are tried in order when your personal primary\ntext model cannot complete a request.`,
```

**Beside a thumbnail the budget is 40, not 65.** A `Thumbnail` accessory takes its width from
the same row as the text in its Section, so prose next to one wraps sooner and pushes the
container back out past the selects. Roughly a third of the row is gone, so a heading and its
description sharing a Section with an avatar wrap at 40:

```ts
// 65 is fine in the body, but this Section also carries an avatar.
persona_description: `These memories apply only when this persona is talking\nin a conversation you're participating in.`,

// Fits beside the thumbnail.
persona_description: `These memories apply only when this\npersona is talking in a conversation\nyou're participating in.`,
```

**Gate:** `tests/unit/discord/panelProseWidth.test.ts` collects every locale key rendered into
a `TextDisplay` body across all panel builders and fails on any authored line over the budget.

The two budgets are checked differently, because which budget applies is a runtime fact. The
65 rule is a static scan of every panel builder. The 40 rule needs a **built payload**, walked
to find each `TextDisplay` that sits in a Section carrying a `Thumbnail`. A panel builder that
mentions `ComponentType.Thumbnail` must therefore appear in that test's coverage set and have a
payload walked there; adding a thumbnail without one fails the build rather than silently
falling back to the wider budget.

Both numbers are measured, not specified. Components V2 exposes no width, margin, or padding
field on any component: the only sizing fields in the whole specification sit on media items and
files, and Discord marks each of them "ignored and provided by the API as part of the response".
Content is therefore the only input to layout, which is why authored line breaks are the fix
rather than a workaround for a setting somebody forgot. If the client's rendering changes, retune
the constants in the gate and re-run it: the failures name every string to rewrap.

Width is measured **as rendered**, not as stored: a link's URL and the markers around bold,
italic, strikethrough, and inline code occupy no width on screen and are stripped before
counting. Runtime content is out of scope, because its length is not an authoring decision:
a memory preview, a model codename, or a user-supplied label may be any length and is bounded
by `safeSelectOptionText` instead.

## Per-line markers

**`-#` and `>` apply to one line each.** A multi-line string behind a single leading marker
renders only its first line styled, and the rest falls back to body text. Use
`withLinePrefix` from `src/utils/discord/ui/panel.ts`:

```ts
content: withLinePrefix("-# ", localizer(locale, "commands.providers.stale_warning")),
```

This interacts directly with the width rule: wrapping a string that sits behind a marker is
what exposes the bug, so the two rules are always applied together.

## Structure

- `###` for a page or major section heading.
- **Bold** for a nested subsection label.
- Plain text for short explanations and empty states.
- Quote rows (`>`) for current values, statuses, and entities.
- Subdued `-#` lines for live cross-command directions and footer-like qualifications.
- A real Components V2 separator between the top category controls and the page body.
- A populated list section explains what its entries mean before rendering rows.
- Whole ```markdown``` code blocks for big dynamic content (like memories)
- A persona-scoped page renders its page selector, a heading and description beside the selected
  persona's thumbnail, the persona selector, and then the selected entity's details. Omit the
  thumbnail when no public avatar is available; do not reorder the remaining controls.

Prefer first-person `I` and `me` when the bot is the speaker.

## Content blocks

**Render stored user content as a fenced `markdown` block, not as a quote row.** A quote row
reads as panel chrome; a fence reads as the thing the user saved, which is what a memory or a
prompt body is.

Do not markdown-escape text inside a fence: escapes render literally there. Instead make the
content fence-safe, because a value containing its own triple backtick would close the fence
early and spill the rest of the panel into the block. `renderMemoryBlock` in
`personalMemoriesPanel.ts` is the worked example.

## Jargon

**Link a product term to its documentation the first time a panel names it.** Terms like
Short-Term Memory, spotlight, or lineage read as invented vocabulary to a new user, and a
panel has no room to define them:

```ts
stm_title: `[Short-Term Memory](https://docs.tomoribot.app/en/features/knowledge/memory/#short-term-memory-stm)`,
```

Keep the `/en/` locale segment, matching every other documentation link in `src/locales/`.
A link inside a heading is fine: its URL costs no rendered width.

## Selectors

- Say what the select does above it, and say that adding happens there too when the first
  option is an add action: `Select or add a personal memory below:`. The add affordance lives
  inside the dropdown, so a user who is not told will not look for it.
- Option values must be unique. Discord rejects the entire payload with
  `COMPONENT_OPTION_VALUE_DUPLICATED`, and no static gate catches it, so deduplicate whenever
  the value is a key that several rows can share.
- Cap options at 25 and say how many are hidden. An uncapped list fails at the API boundary
  once real data grows.

## Button colour

Colour carries one meaning per panel, so it stays reserved rather than decorative.

- **Blue (`Primary`) belongs to the category row only.** It marks which category is open, and a
  second blue elsewhere on the page competes with that signal.
- **Everything else inside the panel is grey (`Secondary`) or red (`Danger`).** Red is for a
  destructive action; grey is for everything else, including the primary action of a section.
- **Do not use colour to show which option in a group is selected.** A segmented control that
  paints the active choice blue reads as four call-to-action buttons. Put the state in the label
  or in the prose above the row, where a screen reader also reaches it.

## Localization

These rules apply to `src/locales/` prose the same as to any other authored text, including
the dash policy in [`comment-policy.md`](./comment-policy). Prefer literal locale keys:
`check-locales` only matches literal dot-notation strings, so a key composed at runtime can go
missing and still pass every gate, rendering the raw key to the user.
