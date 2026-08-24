---
title: Stats Infographic
---

# Stats Infographic Subsystem

`/stats generate` renders one of three shareable PNG image cards using a **satori → resvg** pipeline.
The stat data itself reuses the same `StatRepository` read methods that power the Phase 2 text dashboard.

## Card types

| Type | Command choice | Gatherer | Renderer |
|---|---|---|---|
| Personal Wrapped | `personal` | `personalCardGatherer.ts` | `renderPersonalCard()` |
| Persona Affinity | `persona` | `personaCardGatherer.ts` | `renderPersonaCard()` |
| Server Leaderboard | `server` | `serverCardGatherer.ts` | `renderServerCard()` |

Cards are designed for Discord's inline image preview rather than full-resolution
inspection. The default width is `1080px`; important labels use at least `24px`
source text and values use `34px` or larger so they remain readable when Discord
scales the attachment down.

Height is content-aware:

- Personal Wrapped is a `9:16` portrait card (`1080×1920`). It gives the top
  favorite persona avatar visual priority, limits the ranked list to five
  text-only entries, and retains only total tokens and total spend.
- Persona Affinity is a `1080×1920` content-led portrait card for all-time data.
  Time-window cards omit the all-time-only long-term-memory row and use a shorter
  `1080×1800` frame; a no-data card is `1080×860`.
- Server Leaderboard is a content-aware portrait card: its height grows with the
  number of ranked persona (≤5), member (≤3), and model (≤3) rows via
  `getServerCardHeight`, so small servers stay compact and full ones never clip.
  The no-data card is `1080×980`.

- Personal Wrapped: a dominant #1 favorite-persona avatar, truncated vertical
  user name, up to five ranked personas with per-persona token/cost totals,
aggregate token/spend totals, and a monochrome Tomoricon stamp. The gatherer
derives its accessible light-mode palette from the #1 avatar: the most common
usable hue supplies the background and contrast-safe text color, while a
distinct saturated hue supplies the accent layers. The Tomoricon stamp is tinted
to the same contrast-safe text color. It falls back to a neutral palette if that
image is unavailable or undecodable.
- Persona Affinity: a centered, large stacked user/persona avatar pairing, then
  three scoped aggregate values (input tokens, output tokens, total spent),
  individual long-term-memory, reward/punishment, and favorite-emoji rows, and
  larger emotion/tool donut-chart rows with raw legend counts. The card frame
  and emotion chart use the selected persona's light-mode palette (falling back
  to the invoking user's avatar), while the tool chart uses a separately sampled
  palette from the invoking user's avatar. Long-term memory is hidden outside
  the all-time view.
- Server Leaderboard: a top header row (server icon + name + timeframe subtitle)
  followed by three consistent horizontal bar charts — "Top Personas" (≤5, by
  total tokens; `{tokens} | {cost}` inside, persona avatar + name at the tip, bar
  tinted to the persona avatar's accent), "Most Active Members" (≤3, by triggers;
  `{count} triggers made` inside, member avatar + name at the tip, bar tinted to
  the member avatar's accent), and "Top Models" (≤3, by total tokens;
  `{tokens} | {cost}` inside, model name at the tip — no avatar, bar uses
  `palette.accentSecondary`); then the server-wide total tokens and total spend.
  Its light-mode palette is derived from the server icon, mirroring how Personal
  Wrapped derives its palette from the #1 persona avatar.

`tokens_in` and `tokens_out` are daily counters. Per-persona costs are calculated
in one grouped query, applying the matched model's input/output pricing to each
persona lineage; no per-row database queries are issued during card generation.
Because an LLM codename can appear under more than one provider, pricing joins
first collapse to one rate per codename (`MAX` over the providers that publish
one). The collapse is what prevents duplicated join rows from inflating a
persona's token total beyond the card aggregate, but it is a genuine
approximation: `stat_counters.metric_key` records only the codename, never the
provider, so a codename carried by two providers at different rates cannot be
attributed correctly and bills at the higher one. Two NVIDIA rows currently share
a codename with a priced OpenRouter row (`moonshotai/kimi-k2.6`,
`google/gemma-4-31b-it`). Attributing these exactly requires the provider in the
stat key, which is a metric-shape change, not a query fix.

## Minimal infographic design guide

The current Personal Wrapped card is the **golden standard** for new compact
infographic work. Its purpose is not to show every metric; it establishes a
single visual narrative that remains legible in Discord's inline preview.

### Personal Wrapped: hierarchy and layout

The card is a `9:16` portrait image with four intentional zones, in order:

1. **Hero** — the #1 (highest-token) persona avatar takes most of the upper card.
   The invoking user's avatar and vertically set, truncated name appear in a
   narrow rail that ends with the hero, not the whole card.
2. **Ranked table** — the lower content width is unrestricted by the user rail.
   It presents at most five text-only persona rows with `Favorite Personas`,
   `Tokens`, and `Spent` columns, **ranked by total tokens (descending)** so the
   row order matches the visible Tokens column. The whole persona population is
   ranked before the top five are taken, so a heavy-token persona is never
   dropped for having fewer message triggers. Columns are aligned through fixed
   widths and flexible name space rather than visible vertical rules.
3. **Summary** — favorite model is a single row, followed by the two large
   aggregate values: `Total Tokens` and `Total Spent`.
4. **Signature** — the contrast-tinted Tomoricon and localized
   `PERSONAL WRAPPED (TIMEFRAME)` footer share one centered row at the bottom.

Use large source typography. At the default 1080px width, table labels are at
least 30px, row values 34px or greater, and aggregate values 76px. Do not trade
this hierarchy for denser secondary metrics; place those in a different card or
text dashboard instead.

### Palette and hero decoration

The palette + image helpers live in the shared gather-layer module
`cardColor.ts` (`extractCardPalette`, `extractAvatarAccentColor`,
`loadTomoriconDataUri`). Personal Wrapped feeds it the #1 persona avatar; Persona
Affinity feeds it the selected persona avatar (or the invoking user's avatar when
that is unavailable); Server Leaderboard feeds it the server icon. The renderer
never imports it — it stays pure. `personalCardGatherer.ts` re-exports
`extractPersonalCardPalette` as a backward-compatible alias of
`extractCardPalette`.

Persona avatar resolution for stats lives in `personaAvatar.ts`. A persona-owned
`webhook_avatar_url` wins; if a preset-pointer persona has no stored avatar (the
normal main-persona state, because Discord delivery uses the guild member
avatar), stats cards fall back to the preset's shared
`preset_avatar_shared_url`. This keeps the normal webhook/guild-avatar delivery
path unchanged while still giving image cards a stable avatar to embed.

The palette extractor samples the hero image at 64px after alpha filtering and
creates an accessible light-mode palette with two roles:

- The most common usable hue is the **base**: pale background/surface colors,
  dark contrast-safe ink, muted text, borders, and the secondary hero color.
- A sufficiently different saturated hue becomes the **accent**: table headings,
  hero border, avatar outlines, and primary decorative layer. This preserves
  meaningful details such as a red/magenta eye or hair accent when blue hair is
  the most common pixel color.

The gatherer tints the monochrome PNG stamp to `palette.ink`; retain the
high-resolution PNG rather than substituting the lower-resolution `.ico`. SVG is
appropriate only when the original vector artwork is available.

Personal Wrapped's hero is a **three-layer stacked-card silhouette** that floats
directly on the card background (no surface panel or border): three squares, each
the same size as the #1 avatar, staggered up-left — `palette.accent` (back) →
`palette.accentSecondary` (mid) → the avatar (front). The stagger goes up-left
because the avatar is anchored bottom-right and bleeds off, keeping the stack
clear of the lower zones.

The randomized `PersonalHeroDecor` hero-variant background has been **retired** —
no card uses it. Personal Wrapped now uses the deterministic stacked-square hero
above; Server Leaderboard uses no decorative backdrop. There is no `heroVariant`
field on any card data struct.

### Server Leaderboard: bar layout

The Server card is a header row + three uniform horizontal bar charts (Top
Personas, Most Active Members, Top Models) over bottom-aligned totals/signature.
Every bar uses the same `ServerBarRow`:

- **Bar tints come from the gatherer.** `extractAvatarAccentColor` distils one
  vivid hue per persona/member avatar (`ServerPersonaBar.accent`,
  `ServerMemberBar.accent`); the renderer fills each bar with it and picks
  black/white in-bar text via `readableInkOn` (WCAG luminance). Models have no
  avatar, so their bars use `palette.accentSecondary`.
- **Bars use the leader as the full-width reference.** Each width starts at
  `share × track`, where `share = value / leaderValue`; rank #1 therefore fills
  all available track space. A row keeps its full in-bar label when that fits.
  Otherwise it drops the `tokens` / `triggers made` unit and grows only to the
  compact-label floor. The floor is a last resort, not part of the percentage
  calculation. Model bars use the wider `SERVER_MODEL_TRACK_W` because their tip
  is a name rather than an avatar.
- **Avatar-tipped bars** (personas, members) share the `ServerBarTip` helper:
  the persona/member avatar + truncated name sits at the bar's end. Model bars
  show just the model name at the tip.
- **Content-aware height** (`getServerCardHeight`) sums fixed section-height
  constants (`SERVER_HEADER_H`, `SERVER_BLOCK_TITLE_H`, `SERVER_BAR_ROW_H` ×
  rows, `SERVER_TOTALS_H`, `SERVER_FOOTER_H`) plus padding; a flex spacer before
  the totals absorbs any rounding slack and bottom-aligns the totals/signature.

### Persona Affinity: centered affinity layout

Persona Affinity deliberately does **not** reuse the left identity rail or
offset square hero from the other cards. It starts with the large, stacked user
and persona avatars and a centered `{user} X {persona}` label. The rest of the
card is ordered as a three-column token/cost block, individual statistic rows,
then two larger donut-chart rows: emotions left-aligned and tools right-aligned.
Keep the metrics as rows rather than compact tiles, include the raw count next
to each emotion/tool legend item, use the persona palette for emotions and the
user palette for tools, and retain the palette-tinted Tomoricon plus footer
label at the bottom; the chart segment alone is not enough information at
Discord preview size.

### Contributor checklist

When changing an infographic:

- Keep gathering, palette/image processing, and decorative variant selection in
  the gatherer; keep renderer functions pure.
- Add or update both locale files for every new visible label.
- Preserve a contrast-safe text/icon color; never place palette-colored text on
  a similarly colored background without checking the rendered PNG.
- Render EN and JA cards with `scripts/devtools/renderPersonalCardHarness.ts`
  and visually inspect the result at preview scale.
- Add a focused unit test for new palette or dimension behavior, then run
  `bun run check`, `bun run lint`, and `bun run check-locales` as applicable.

## Render pipeline

```
gatherXxxCardData()   ← DB + Discord API (async, sole touch-point)
        ↓
  renderXxxCard()     ← pure VNode tree (statsInfographic.tsx, no DB)
        ↓
  renderCardToPng()   ← satori (JSX→SVG) + resvg (SVG→PNG)
        ↓
  AttachmentBuilder   ← Discord PNG attachment
```

**Key constraints:**
- satori 0.26 cannot parse `conic-gradient()` — the `Donut` primitive embeds an SVG arc string as a `data:image/svg+xml;base64,…` `<img>` data URI instead; resvg rasterizes it fine.
- Fonts (`VF`-format crashes satori) are loaded once at module init as static instances via `readFileSync`. See `cardRenderer.ts`.
- Renderer and caller use the same `getXxxCardHeight(data)` helper. The footer
  follows the final section instead of being pushed to the canvas bottom.
- Layout dimensions and typography scale with `STATS_CARD_W`; changing the
  output resolution retains the same visual proportions.

## Gather / render split

All DB access is isolated to the gatherer layer. The renderer functions are pure functions of their data struct (`PersonalCardData`, `PersonaCardData`, `ServerCardData`) — no async, no DB, no Discord API. This split makes the renderers unit-testable without DB mocks.

## Privacy gate

Personal cards refuse fully-private users (`PrivacyLevel.FULL`) before deferring the interaction. Persona and server cards have no privacy gate (they show aggregate/persona data, not individual user data).

## Persona picker flow

For `type=persona`, the command uses `runPersonaPickerWorkflow(...)` with the
explicit `separate-public` delivery policy. The picker cards are private. After
selection, `selection.beginSeparatePublicReply(...)` updates that same private
message to the localized `{persona} has been selected` notice before any public
delivery occurs.

The returned public phase creates exactly one public PNG response. Its payload
cannot be ephemeral, and a second public reply raises a typed workflow error.
Observers therefore see the generated card but never the picker; the invoker
does not receive a second private status or card. Local persona avatar files are
read into the card renderer, while the public response attaches only the finished
PNG. Compacting the private picker clears its no-longer-referenced avatar
attachments.

## Env config

All card dimensions and theme colors are configurable. See `.env.optional.example` for the full list:

| Var | Default | Description |
|---|---|---|
| `STATS_CARD_W` | `1080` | Logical card width; typography, spacing, and data-dependent height scale with it |
| `STATS_CARD_THEME_BG` | `#1d100e` | Deep espresso card background |
| `STATS_CARD_THEME_SURFACE` | `#2c1815` | Dark espresso secondary surface |
| `STATS_CARD_THEME_ACCENT` | `#e7322a` | Primary red accent |
