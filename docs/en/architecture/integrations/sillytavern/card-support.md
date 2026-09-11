---
title: "SillyTavern Card Import Support"
---

This document describes how `/persona import` handles SillyTavern character cards from any of:

- PNG files with embedded `chara` / `char` metadata
- legacy v2-style root-level JSON cards
- `chara_card_v3`-style JSON exports
- Character Card V3 `.charx` archives

## Overview

TomoriBot supports four relevant import paths:

1. **Native Tomori preset path** (`TomoriPreset` metadata)  
2. **SillyTavern PNG fallback path** (`chara`/`char` metadata)
3. **SillyTavern JSON fallback path**:
   - legacy v2-style cards with root-level fields such as `name`, `description`, and `first_mes`
   - v3 cards with `spec: "chara_card_v3"` and a nested `data` object
4. **Character Card V3 archive path**: a `.charx` zip whose `card.json` is unwrapped and then
   handed to the same converter as path 3

If Tomori metadata is missing, or the uploaded file is a compatible SillyTavern v2/v3 JSON card, import proceeds through the same SillyTavern conversion flow.

## Extension Dispatch

Dispatch is by attachment extension, before any byte is read:

| Extension | Container handling |
|---|---|
| `.png` | Tomori metadata first, then `chara`/`char` metadata |
| `.json` | Parsed and validated directly; a bare V3 `card.json` lands here and converts as-is |
| `.charx` | Unwrapped by `src/utils/persona/charxArchive.ts`, then converted as a card |

Anything else is rejected with `commands.persona.import.invalid_file_type_*`. `.charx` carries its
own size bound (`MAX_CHARX_IMPORT_SIZE_MB`) because an archive's compressed size does not describe
what it expands to.

## `.charx` Archive Handling

A `.charx` file is a zip containing a Character Card V3 object as `card.json`, plus an `assets/`
tree referenced by `embeded://` URIs. The reader:

- loads the archive with `JSZip.loadAsync`, returning a typed failure rather than throwing;
- resolves `card.json` by exact path first, falling back to a case-insensitive basename search so a
  wrapping folder still works. The exact-path preference matters: without it a decoy
  `assets/card.json` would shadow the root card the specification mandates;
- checks the entry's **declared** uncompressed size before decompressing it, then measures the
  decompressed bytes. The declared-size check is the load-bearing one: an archive honestly
  declaring a huge card is refused before any decompression, while an entry that delivers more
  than it declared is refused by jszip's own consistency check;
- accepts a card with no `spec`, or any `spec` beginning with `chara_card`, and never rejects on
  `spec_version`. The converter owns card recognition and a root-level V2 card has no `spec` at
  all, so the container only refuses a card that names a different format;
- bounds the declared asset list by its raw length before examining any entry, then counts the
  assets the archive actually carries and sums their declared sizes from the zip central
  directory, refusing a hostile tree without opening a single asset entry.

Failure reasons are `invalid_zip`, `missing_card`, `invalid_card`, `not_character_card`,
`card_too_large`, and `assets_too_large`, each mapped to its own localized reply. The last two are
separate because they need different answers: an oversized card payload is a card the user cannot
import, while an oversized asset tree is a card they can import once it is exported without its
media.

### Assets Are Not Imported

Only `card.json` is decompressed. The asset tree is deliberately ignored in this pass, for two
reasons: it can carry audio, video, Live2D, 3D, model, font, and code payloads, so a partial read
would decompress the whole tree only to discard most of it; and TomoriBot's sprite pipeline is keyed
on `sprite_key` plus `usage_instructions`, while V3 `emotion` assets are bare images with no usage
guidance and no mapping onto that key.

An archive whose card declares one or more assets therefore imports successfully and states the
omission in the success embed (`commands.persona.import.charx_assets_ignored_description`), pointing
at `/server avatar` and `/config` > Persona > Sprites. The notice counts only assets the archive
actually carries: a remote URL or the specification's `ccdefault:` default is a reference rather
than bundled media, so a card that shipped nothing but its own text is not told its media was
dropped. This is a stated limitation rather than a silent one.

## Metadata Detection

PNG extraction supports text chunk variants:

- `tEXt`
- `zTXt`
- `iTXt`

Detected PNG metadata keys:

- `chara`
- `char`

Decoded PNG payloads can be:

- direct JSON text, or
- base64-encoded JSON text

## Conversion Flow

Converter: `presetRepository.convertSillyTavernJsonToPresetData`
(`src/utils/db/repositories/PresetRepository.ts`). PNG metadata goes through the thin
`convertSillyTavernMetadataToPresetData` wrapper, which forwards the already-parsed JSON.

Input:

- decoded SillyTavern PNG metadata JSON
- parsed SillyTavern JSON file
- the `card.json` object extracted from a `.charx` archive

Output:

- `PresetExportData` compatible with Tomori import pipeline

Validation:

- Tomori and converted SillyTavern imports both pass through the preset Zod schema before insert.
- The schema is the import safety boundary. Defaults are 5000 characters per imported string, 200 attributes, 200
  NovelAI tags, 100 sample dialogue entries per side, and 100 trigger words.
- Admins can tune those defaults with the `PRESET_MAX_*` env vars in `.env.optional.example`.
- Runtime memory environment limits such as `MAX_ATTRIBUTE_LENGTH` and `MAX_SAMPLE_DIALOGUE_LENGTH` apply to live
  slash-command edits, not preset imports.

Name handling:

- character name first letter is capitalized (e.g. `isaac` -> `Isaac`)

## Field Mapping

Imported into `personas` and `persona_configs`:

- `name` -> `persona_nickname`
- `description` -> `attribute_list` (no `"Description"` prefix)
- `personality` -> `attribute_list` (section-labeled)
- `scenario` -> `attribute_list` (section-labeled)
- `system_prompt` -> `attribute_list` (section-labeled)
- `post_history_instructions` -> `attribute_list` (section-labeled)
- `extensions.depth_prompt.prompt` -> `attribute_list` (section-labeled)
- `character_book.entries[].content` (enabled only) -> `attribute_list` (section-labeled)
- `mes_example`, `first_mes`, `alternate_greetings` -> sample dialogues
- generated default trigger words (from character name) -> `trigger_words`

Not imported:

- `creator_notes`
- `creatorcomment`
- `tags`
- `creator`
- `spec` / `spec_version`
- V3 `assets` (see the "Assets Are Not Imported" section above)
- V3 `nickname`, `creator_notes_multilingual`, `source`, `group_only_greetings`, `creation_date`,
  `modification_date`

The two V3 additions with no destination are handled per field rather than by inventing one:
`nickname` would rename a card whose `name` is already the display name, and `source` is a
provenance list with nowhere to live. `group_only_greetings` describes greetings for a group-chat
mode TomoriBot does not have, so folding it into sample dialogues would assert something false
about the card.

## Unpaired Sample Dialogue Handling

Many SillyTavern cards contain bot-only examples without a user turn.

Tomori stores paired arrays, so unpaired entries use an internal sentinel value:

- `__TOMORI_UNPAIRED_SAMPLE__`

Behavior at runtime (`src/utils/text/contextBuilder.ts`):

1. If input side is sentinel, Tomori **does not inject** a user sample turn.
2. It still injects the model sample response.
3. If any unpaired sample exists, Tomori inserts a spacer message before live conversation history:

`[System: Above are only examples of how {{char}} acts and talks. Use them as reference for a completely new scene that starts now.]`

## Placeholder Support

Tomori now supports both styles during template replacement:

- Single-brace: `{user}`, `{bot}`, `{char}`
- Double-brace: `{{user}}`, `{{char}}`, `{{bot}}`

So SillyTavern placeholders can be kept as-is.

## Failure / Debug Fallback

If SillyTavern card data is detected but conversion fails:

- `/persona import` returns an ephemeral warning embed naming where the payload came from
- attaches the decoded / parsed payload as `.txt` for inspection

All three card formats (PNG metadata, JSON, and `.charx` `card.json`) share one reply, one
attachment convention (`<format>-decode-<timestamp>.txt`), and one localized message. A `.charx`
that never reaches conversion, because the container itself is unreadable, replies through the
container's own failure reasons instead.

## Avatar Fallback for JSON and Archive Cards

SillyTavern JSON cards typically do not include an avatar image attachment, and `.charx` assets are
not imported, so both paths import without an avatar.

For `type: alter` imports without an avatar image:

- Tomori stores the current main persona avatar as the new alter's `webhook_avatar_url` fallback
- the public success embed explicitly says the fallback happened and why
- the embed also points users to `/server avatar` if they want to change it

For `type: main` imports without an avatar image:

- personality data is still imported normally
- nickname updates still run
- avatar changes are skipped and the current main persona avatar remains in place

This preserves the debug workflow for unsupported edge-card formats.

## Relevant Files

- `src/commands/persona/import.ts`
- `src/utils/persona/charxArchive.ts`
- `src/utils/zip/zipEntryGuards.ts`
- `src/utils/image/pngMetadata.ts`
- `src/utils/db/repositories/PresetRepository.ts` (`convertSillyTavernJsonToPresetData`)
- `src/utils/text/contextBuilder.ts`
- `src/utils/text/processors/mentionProcessor.ts`
- `src/types/preset/presetExport.ts`
