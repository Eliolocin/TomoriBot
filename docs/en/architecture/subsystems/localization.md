---
title: "Localization System"
---

TomoriBot localizes user-facing text through locale files in `src/locales/`.

## Supported Locales

Currently loaded from source:

- `en-US` (default fallback)
- `ja`

## Runtime Architecture

- Loader: `src/utils/text/localizer.ts`
- Locale structure: `src/locales/{locale}/` directories, one `.ts` file per category
- Categories: `general`, `commands`, `providers`, `tools`, `bridges`
- At boot, `initializeLocalizer()` scans each locale directory, imports all category slices, and merges them into a single tree via `Object.assign`
- Locale values are nested objects, accessed through dot-path keys

Example lookup:

```ts
localizer(locale, "commands.config.setup.description")
```

## Important Behaviors

- `initializeLocalizer()` must run during startup before lookups.
- Missing locale code falls back to `en-US`.
- Missing key falls back to `en-US` for that key alone (see below).
- Multi-line strings are dedented automatically on load.

## Key Resolution and the `en-US` Fallback

`localizer()` resolves in three steps, and the middle one is what keeps an incomplete locale
usable:

| Case | Result |
|---|---|
| Key present in the requested locale | That locale's string, with `{placeholder}` variables interpolated |
| Key missing from the requested locale but present in `en-US` | The `en-US` string, with the same interpolation applied, plus one `warn` log |
| Key missing from both | The key path itself, returned verbatim |

The per-key retry means a locale that is 99% translated renders English for the remaining 1%
instead of showing users a raw `commands.foo.bar_description` path. The `warn` fires once per
`locale:key` per process, so a gap stays visible in development without flooding a hot path.

`check-locales` stays strict: the fallback is a runtime safety net, not permission to ship
parity gaps.

Two consequences to keep in mind when writing new code:

- **Do not infer key existence from the returned string.** A miss now yields English, which is
  indistinguishable from a real translation. Use `hasLocaleKey(locale, key)` instead: it walks
  only the requested locale's tree and never falls back. `embedClassifier.ts` depends on this
  to decide which dynamically discovered reward and punish titles a locale actually defines.
- **The miss-everywhere case is unchanged**, so callers that detect an unknown key by comparing
  the result against the key still work. `openrouterStreamAdapter.ts` and
  `openaiCompatibleErrorFormatter.ts` use that comparison, and `st-preset/node/toggle.ts` relies
  on the verbatim echo to pass a dynamic label through `localizer()`.

`getLocaleSubKeys(locale, path)` deliberately enumerates only what the requested locale defines
and performs no fallback of any kind, so callers can pair it with `hasLocaleKey` to build a set
of keys that genuinely exist in one locale.

## Locale File Shape

Each locale exports a nested object (not a flat key-value map).

```ts
export default {
	commands: {
		config: {
			setup: {
				description: "...",
			},
		},
	},
};
```

## Slash Command Metadata Localization

`commandLoader.ts` auto-generates description/choice localizations from locale keys.

Recommended pattern in command files:

- set base metadata with `localizer("en-US", key)`
- do not hardcode localized `setDescriptionLocalizations(...)` per command

Key conventions:

- Subcommand description:
  - `commands.{category}.{path}.description`
- Option description:
  - `commands.{category}.{path}.{option_name}_description`
- Choice label:
  - `commands.{category}.{path}.{option_name}_choice_{choice_value}`

## Tip-item keys (`genai.tips.*`)

User-facing hints ("Tips") are stored as **atomic, single-sentence** keys under `genai.tips.*`
(defined in `providers.ts`, which exports the `genai` tree). Each key is one self-contained bullet —
never a multi-hint paragraph:

```ts
genai: {
  tips: {
    title: "💡 Tip",
    wait_and_retry: "Please wait a few minutes before trying again.",
    openrouter_models: "Browse the [OpenRouter model list](https://openrouter.ai/models) and switch models with `/providers`.",
    // ...one key per bullet
  },
}
```

Callers compose the bullet list by passing an ordered `tipKeys` array to `createTipEmbed()` (see
[Tip embeds](./utils.md#tip-embeds)), including or omitting keys per branch. This is why tips are
atomic: a conditional hint (e.g. an OpenRouter-only tip) is added by including its key in one branch,
not by duplicating a whole paragraph string. Descriptions render markdown and hyperlinks.

`genai.tips.support_server` is the one reserved key: `createTipEmbed()` appends it as the closing
bullet of every rendered tip embed so the Official Support Server link is always offered. Do not put
it in a caller's `tipKeys` array.

When adding a tip:

1. Add the atomic key under `genai.tips` in both `src/locales/en-US/providers.ts` and
   `src/locales/ja/providers.ts`.
2. Reference it by dot-path from the calling `tipKeys` array — do not inline hint text in code.
3. Run `bun run check-locales` for parity.

## User Language Preference

- User preference is stored in `users.language_pref`.
- Most interaction replies receive `locale`/`userData.language_pref` and should use that for response text.

## Adding or Changing Locale Keys

1. Update the appropriate category file under `src/locales/en-US/` (e.g. `commands.ts`, `general.ts`).
2. Mirror the same key structure in the corresponding `src/locales/ja/` file.
3. Run:

```bash
bun run check-locales
```

This validates cross-locale key parity and catches missing keys.

## Discord Length Limits

Discord silently truncates several text slots past their cap, so a separate strict gate
(`bun run check-locale-lengths`, also run as a fatal step in `bun run vl`) source-traces each
locale key to the Discord component it feeds and flags any value that overruns:

- Command descriptions — ≤100 chars
- Modal titles / input labels — ≤45 chars
- Modal placeholders / Label descriptions — ≤100 chars
- **Select / checkbox option `label` and `description`** — ≤100 chars (traced from
  `{ value, label: localizer(...), description: localizer(...) }` option literals)

Both the `en-US` and `ja` values must fit. Shorten the reported string rather than relying on
Discord's truncation — the cap is counted in characters (code points), so compact Japanese text
usually fits where English does not.

## Best Practices

- Localize all user-facing command/embed strings.
- Keep command metadata keys aligned with command path conventions.
- Avoid hardcoded strings in command implementations.
