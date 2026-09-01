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
- Give every settings subsection a short plain-text sentence that explains its purpose or
  effect before its values or controls. A label alone should not require the reader to infer
  what the setting changes.
- Keep a quote row immediately adjacent to the explanation, label, or control it qualifies.
  Do not insert a blank line between them. Use blank lines to separate sibling subsections.
- Subdued `-#` lines for live cross-command directions and footer-like qualifications.
- A real Components V2 separator between the top category controls and the page body.
- A populated list section explains what its entries mean before rendering rows.
- Whole ```markdown``` code blocks for big dynamic content (like memories)
- A direct state control renders its heading and explanation first, its mutually exclusive
  choice buttons second, and the selected choice's effective behavior in a quote row below.
  The result then reads as belonging to the choice that produces it.
- A persona-scoped page places its persona selector before the heading, thumbnail, and details that
  it controls. When only one page is persona-scoped, the order is category, page, persona, content.
  When Persona is itself a category with nested pages, the order is category, persona, page,
  content. Omit the thumbnail only when neither a public URL nor a readable local avatar is
  available. Local avatars use `attachment://` media and must be reattached while old message
  attachments are cleared on every repaint.

Prefer first-person `I` and `me` when the bot is the speaker.

## Defaults and effective values

**Put the authoritative current or effective value in the panel.** When a built-in,
inherited, provider, or server default changes how that value should be understood, show the
default and its source there too. Opening an editor must not be required just to discover the
effective behavior.

Prefill the stored value in a modal when Discord supports it. Modal field descriptions repeat
only guidance needed while editing, such as the valid range and what clearing or resetting
restores. They supplement the panel rather than becoming the only place a default is explained.

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
- Cap options at 25 and paginate the select in place when more records exist. Put a button row
  immediately below it in this order: Previous, a disabled `Page <current> of <total>`
  indicator, then Next. Disable Previous and Next at their respective boundaries.
- Do not replace the panel body with a range chooser or merely report hidden selectable rows.
  Keep the selected stable identity and the page body while moving between slices.
- An add action inside a select is its first option on every page. It consumes one of Discord's
  25 option slots, leaving 24 record options. Omit the pagination row when one page is enough.
- **Pagination buttons carry a direction arrow: `← Previous` and `Next →`.** The arrow leads on the
  way back and trails on the way forward, so the pair reads as a line the reader moves along. Use
  `←` (U+2190) and `→` (U+2192), never `<`/`>`, which are comparison operators, and never `◀`/`▶`,
  which have emoji presentations and can render as coloured emoji instead of text. The page
  indicator between them stays plain: `Page 2 of 7`.

## Naming a button

A button names the object it acts on, not the internal category that object came from. `/memories`
stores ordinary uploads and captured chat history in the same document table, and both render through
the same panel row, so both remove buttons read `Remove Document`. The two removal routes still differ
underneath, and the confirmation that follows can name the difference where it matters.

The same rule rejects a label that names its own styling, such as `Danger: Remove`. Say what the
button does; let colour, the confirmation, and the surrounding prose supply the rest.

## Button colour

Colour carries a small set of structural meanings rather than decorating important actions.

- **Blue (`Primary`) marks the active category or the selected choice in a direct state-control
  row.** A selected state button is disabled Primary. Available alternatives are enabled
  Secondary, while an unavailable alternative is disabled Secondary.
- **A state-control row contains mutually exclusive stored states or scopes.** Examples are
  `[Off] [On]`, `[Off] [Follow Server] [On]`, and `[Server-wide] [Persona]`. Do not apply this
  treatment to pagination, transient navigation, confirmation, or ordinary action rows.
- **Place effective behavior below the state-control buttons.** Do not repeat the choice with an
  `(On)` or `(Off)` suffix, a coloured-circle status, or a separate `State:` row. The button label,
  disabled selection, and behavior sentence communicate the state without relying on colour alone.
- **Grey (`Secondary`) is the default for actions and red (`Danger`) is destructive.** Green
  (`Success`) is not a button style in this codebase. Coloured circles remain useful in compact
  read-only summaries whose several statuses are edited together elsewhere, such as a modal.
- **Red marks the destructive choice, never the safe one.** In a confirmation pair the action being
  confirmed carries `Danger` where it destroys something, and Cancel stays `Secondary`. A grey
  confirm beside a red Cancel reads as though backing out were the dangerous move.
- **A label never names its own colour.** Write `Remove Prompt`, not `Danger: Remove Prompt`. The red
  already carries the warning, and the label should spend its width on what the button does.

These colour rules cover every Discord surface this bot renders, not only panels: the legacy
confirmation and pagination helpers and the buttons built inline in `src/commands/` follow them too.
`tests/unit/discord/panelButtonColour.test.ts` enforces them by scanning source text, so it reads
style assignments and deliberately skips type annotations and comments. A property type that names a
banned colour is a declaration, not a use; narrow such a union rather than widening it to pass.

## Localization

These rules apply to `src/locales/` prose the same as to any other authored text, including
the dash policy in [`comment-policy.md`](./comment-policy). Prefer literal locale keys:
`check-locales` only matches literal dot-notation strings, so a key composed at runtime can go
missing and still pass every gate, rendering the raw key to the user.
