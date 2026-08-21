---
title: "Adding a Persona Preset"
---

This guide covers how to add a new official persona preset to TomoriBot's seed data.

## Steps

1. Create a new folder under `src/db/seed/catalog/personas/<name>/` and add one locale file per language variant (e.g. `en-US.ts`, `ja.ts`). Export a single named `persona` constant of type `PersonaInput` from each file, then import and register it in `src/db/seed/catalog/personas/index.ts`. Required fields:
   - `preset_lineage_id` — a stable identity anchor for this character. Reuse the same lineage ID
     across locale variants of the same character so they are treated as one canonical identity,
     and so applying the preset can stamp a consistent `persona_lineage_id` (memory scope) onto
     the persona.
   - `name`, `desc`, `attributes`, paired `sampleDialoguesIn` / `sampleDialoguesOut`,
     `language`, `avatarPath`, and `triggerWords`.
   - `preset_attribute_public_flags` is not authored in the row. The bundled official
     lineages derive it in the preserved `official_attribute_flags` update inside
     `src/db/seed/catalog/personaSeed.ts`: the first attribute is public and the rest
     are private. Pointer personas resolve these from the live preset row, and materialized
     copies store them in `persona_attributes.is_public`.

2. Place an avatar image (PNG recommended) inside the persona folder (e.g. `src/db/seed/catalog/personas/<name>/avatar.png`). Set `avatarPath` in the locale file to the folder path without a filename — the runtime auto-discovers the first image alphabetically, so the filename does not need to match any preset name. The avatar seed (`seedPersonaAvatarsFromCatalog`) uploads this image **once** to the immutable `presets/` prefix and records `preset_avatar_shared_url` + `preset_avatar_hash`. Both delivery channels then **sync** when you edit the art: pointer **alters** live-resolve the shared URL (fan out on the next boot, no per-server upload), and each still-pointer **main** persona's Discord guild avatar is re-PATCHed by the background reconciler, gated on the content hash. Later `/server avatar` edits are deliberate customization and materialize the persona before changing or resetting its avatar.

3. (Optional) Give the preset an official **sprite set**. Add the sprite images under the persona folder (e.g. `src/db/seed/catalog/personas/<name>/sprites/mad.png`) and author a `sprites` array on the `PersonaInput`:

   ```ts
   sprites: [
     { name: "mad", file: "sprites/mad.png", usageInstructions: "Use when angry or annoyed." },
     { name: "shy", file: "sprites/shy.png", isIdentity: false },
   ],
   ```

   - `name` is the render label (normalized to a `sprite_key`); `file` is relative to `avatarPath`.
   - `usageInstructions` (optional) is prompt guidance; `isIdentity` (optional) renders the decorated `sprite (Persona)` name.
   - Author `sprites` per locale file (instructions can be localized). Sprites seed into the shared `preset_sprites` table: each image uploads **once** to the immutable `presets/` storage prefix and is resolved live by every server's pointer persona. Editing the array fans out on the next boot; removing a sprite removes it from pointer personas. Omitting `sprites` entirely is a graceful no-op (the persona simply has no default sprites). See [persona-presets](../subsystems/persona-presets) → *`preset_sprites`*.

4. Add or edit reusable system prompt presets in `src/db/seed/catalog/systemPrompts.ts`.
   System prompts are split from personas but seed immediately after persona presets at startup.

5. Run `bun run check-seed-catalogs` to validate all seed catalogs offline. It checks persona name
   uniqueness, paired sample-dialogue arrays, required official attributes, sprite name/file
   validity, non-empty system prompt text, and NovelAI default uniqueness.

6. Validate via `/setup`, `/persona default`, `/persona export`, and `/persona import`.
   Pointer personas should resolve the seeded values, reflect later seed edits after cache
   invalidation, and materialize on the first local content edit.

## Applying vs. Syncing

Applying an official preset is a **copy-on-write pointer** when the preset has
`preset_lineage_id`: setup/`/persona default` store `personas.is_pointer = true` plus
`preset_lineage_id`/`preset_language`, and runtime reads resolve preset-backed text/config content
from the live `persona_presets` row.

Avatars now sync too, by delivery channel. `preset_avatar_path` is the catalog source image the
seed reads to build one shared upload (`preset_avatar_shared_url` + `preset_avatar_hash`). Pointer
**alters** live-resolve that shared URL into their cached state, so editing the seed avatar fans out
to them on the next boot exactly like text/sprites. Pointer **main** personas deliver via the bot's
Discord guild-member avatar, which the `reconcilePresetMainAvatars` background reconciler re-PATCHes
per guild, gated on `applied_avatar_hash != preset_avatar_hash`. Materialized (forked) copies do not
change.

The first local content edit materializes that persona into an independent copy while preserving
`persona_id` and `persona_lineage_id`. Memory/runtime writes do not materialize. Re-running
`/persona default` re-establishes the pointer and discards local preset-backed changes.

Native exports of pointer personas are self-contained copies that stamp `preset_lineage_id`.
Import re-links to an official pointer only when the exported content exactly matches a seeded
preset with the same lineage; customized files import as independent copies.

## Quality Gate

```bash
bun run check-seed-catalogs # seed catalog invariants
bun run check-media-size    # avatar/sprite art must be under 1 MiB (ships to Discord)
bun run check        # TypeScript strict mode
bun run lint         # Biome formatting
```

Persona avatars and sprites are uploaded to Discord at seed time, so keep each
image under the `check-media-size` budget (default 1 MiB, `MEDIA_SIZE_LIMIT_BYTES`).
Run `bun run compress-media` to fix oversized art automatically: it re-encodes
losslessly and downscales (long-edge cap `MEDIA_MAX_DIMENSION`, default 768px) only
when lossless alone cannot fit. `bun run vl` rejects oversized files, so run the
compressor before committing new art.

Then run a local seed against a dev database and verify the preset appears correctly under `/persona`.

## Related Docs

- [`docs/en/architecture/subsystems/persona-presets.md`](../subsystems/persona-presets) — preset identity and pointer behavior
- [`docs/en/architecture/pipelines/memory/`](../pipelines/memory/) — how persona conditioning flows into context
