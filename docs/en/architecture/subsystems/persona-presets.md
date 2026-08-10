---
title: "Persona Presets"
---

Official persona presets are seeded from the typed catalog in `src/db/seed/catalog/personas.ts` into `persona_presets`. They are the canonical definitions for bundled characters such as Tomori/Rose, Temari, Aphel, Lilya, and Nerine.

This page covers how official preset text/config content is applied and kept current through the copy-on-write pointer model. Avatar media is applied as a one-time Discord/storage operation and is called out separately below.

## Data Model

### `persona_presets`

Official preset rows carry a stable `preset_lineage_id`.

- Reuse the same `preset_lineage_id` across locale variants of the same character.
- Do not change a character's `preset_lineage_id` just because text, triggers, sample dialogue, or avatar art changed.
- New official characters need a new stable `preset_lineage_id`.
- `(preset_lineage_id, preset_language)` is the catalog upsert key, so the display name (`persona_preset_name`) is freely renamable: edit the catalog `name` field and the existing row is relabeled in place on the next boot. Renaming a character does **not** need a new lineage or a migration.

`preset_lineage_id` is related to, but not the same operational concern as `personas.persona_lineage_id`:

- `preset_lineage_id` identifies the official preset family (which character a preset is).
- `persona_lineage_id` scopes memory/conditioning identity.
- Applying a preset usually stamps the preset lineage onto the persona's `persona_lineage_id`, so personas derived from the same official character share memory scope.
- Legacy bootstrapping does not rewrite an existing `persona_lineage_id`, because that would move memory scope.
- Import with fork identity can intentionally allocate a fresh `persona_lineage_id` while still pointing at the same official preset.

### `personas` preset pointer columns

Personas can point at live official preset rows instead of storing an independent copy:

- `is_pointer` marks a persona as a live preset pointer.
- `preset_lineage_id` and `preset_language` identify the `persona_presets` row to resolve.
- `persona_lineage_id` remains the memory/conditioning identity and is preserved when the pointer materializes.

When `is_pointer = true`, runtime reads resolve the persona's preset-backed content from `persona_presets`:

- attributes and public flags
- sample dialogues
- trigger words
- persona prompt

The persona row and normalized child rows still carry copied values for compatibility with older surfaces, but live preset data is authoritative while the persona is a pointer.

Trigger words are the one preset-resolved field that is further post-processed: because every preset bundles the shared base word (`tomori`), `loadAllForServer` collapses contested words to a single owner after resolving them (main persona wins base words; alters keep only what no higher-priority persona already claimed). See `docs/en/architecture/subsystems/multi-persona.md` → *Single-owner trigger resolution*. The de-duped result, not the raw preset list, is what routes messages.

Avatars sync too, but the mechanism depends on the **delivery channel**, not on "avatar vs sprite":

- **Alter avatars** are delivered per-message as a webhook `avatarURL`, exactly like sprites, so they live-resolve from one shared image. The seed uploads each preset avatar once to the immutable `presets/{lineage}/{language}/avatar-{hash}.png` prefix and records the URL + content hash on `persona_presets.preset_avatar_shared_url` / `preset_avatar_hash`. An unforked pointer alter with a NULL `personas.webhook_avatar_url` resolves the shared URL at state-load time (`PersonaRepository.resolvePointerAlterAvatarUrl`), so catalog avatar edits fan out to it on the next reseed — and materialization copies it by reference. No per-server upload occurs.
- **Main persona avatars** are the bot's Discord guild member avatar — Discord-owned state that cannot live-resolve per message. They are fanned out by a throttled, best-effort, resumable background reconciler (see *Main avatar fan-out* below).

`persona_presets.preset_avatar_path` remains the local catalog source asset the seed reads to build the shared upload; `preset_avatar_shared_url` is the runtime-resolved field.

### `preset_sprites` (shared, live-resolved)

Sprites — unlike avatars — **do** fan out to pointer personas. A sprite image is fetched on demand by URL at webhook-send time (it never becomes an external Discord resource), so it can be a shared reference resolved live, exactly like attributes/dialogues/triggers.

`preset_sprites` holds the official sprite set keyed by `(preset_lineage_id, preset_language, sprite_key)`. Each image is uploaded **once** to the immutable shared `presets/{lineage}/{language}/sprites/{key}-{hash}.png` storage prefix (content-addressed filename), so N servers cost one stored copy. The catalog authors sprites via the optional `PersonaInput.sprites` array (image files live under the persona's `avatarPath` directory); `seedPersonaSpritesFromCatalog()` uploads each once (idempotent: same content → same filename → skipped) and reconciles removed sprites. See [adding-persona-preset](../../contributing/adding-persona-preset).

Resolution is centralized in `PersonaSpriteRepository.listForPersona()`: for a pointer persona it returns the shared `preset_sprites` set (shaped as `PersonaSpriteRow`); for a materialized persona it returns the persona's own `persona_sprites` rows. Every downstream consumer (prompt context builder, render-modifier resolver, `/persona sprites export`) reads through that one method, so they are pointer-agnostic. Editing the catalog sprite set fans out to all still-pointer personas on the next boot.

The shared `presets/` images are **immutable and never deleted** by per-persona paths — `deletePersonaAvatarFromStorage` refuses any reference under that prefix (`isSharedPresetAssetReference`), so one server replacing/removing a sprite, or re-running `/persona default`, can never delete art other servers rely on. The guard covers both shared asset layouts: sprites (`presets/{lineage}/{language}/sprites/...`) and avatars (`presets/{lineage}/{language}/avatar-{hash}.png`).

### Avatar syncing (alter live-resolve + main fan-out)

`seedPersonaAvatarsFromCatalog()` runs right after the sprite seed. It reads each persona's catalog avatar (`PersonaInput.avatarPath`), normalizes it to PNG, content-addresses it, uploads it **once** to `presets/{lineage}/{language}/avatar-{hash}.png` (idempotent: same art → same filename → skipped), and stamps `persona_presets.preset_avatar_shared_url` + `preset_avatar_hash`.

- **Alter avatars (live-resolve).** A pointer alter stores NULL in `personas.webhook_avatar_url`; `PersonaRepository` resolves the shared URL into the cached `TomoriState` at load time, so every avatar consumer (webhook identity, render-modifier resolver, avatar tool) reads it transparently. The existing pointer-state cache invalidation refreshes it after a reseed, so editing catalog avatar art fans out to all still-pointer alters on the next boot. Materialization copies the shared URL by reference into `webhook_avatar_url` (no byte duplication; the delete guard still protects it).
- **Main avatars (fan-out reconciler).** The bot's guild member avatar is Discord-owned and cannot live-resolve, so `reconcilePresetMainAvatars()` (in `src/utils/persona/presetAvatarReconciler.ts`) PATCHes it per guild. Every PATCH is gated on a real byte change via `personas.applied_avatar_hash != persona_presets.preset_avatar_hash`, making the run idempotent and resumable: a rate-limited or interrupted run resumes on the next boot, and materialized (non-pointer) mains are skipped automatically. It runs as fire-and-forget background work after `clientReady` (never blocking startup), processes guilds sequentially with a delay to stay under Discord's bot-wide global limit, caches each shared image per URL, and backs off on 429. Knobs (all in `.env.optional.example`): `PRESET_AVATAR_SYNC_ENABLED` (kill switch, default on), `PRESET_AVATAR_SYNC_DELAY_MS`, `PRESET_AVATAR_SYNC_API_TIMEOUT_MS`, `PRESET_AVATAR_SYNC_MAX_PER_RUN` (0 = unlimited).

### `persona_presets.preset_attribute_public_flags`

A `BOOLEAN[]` aligned 1:1 with `preset_attribute_list`. Pointer personas resolve these flags from the live preset row; materialized copies store them in `persona_attributes.is_public`. Official Tomori presets mark their first appearance-style attribute public; public attributes can be shown in another persona's participant profile when the persona spoke in visible history, is a co-responder, or is referenced by trigger text. All other seeded attributes are private.

The flags are still derived at seed time, not authored in each catalog row. `seedPersonasFromCatalog()` runs the preserved `official_attribute_flags` update after the persona upsert for lineage IDs `4`, `716`, `1770`, `3585`, and `50`.

## Applying Presets

Applying an official preset creates a **copy-on-write pointer** when the preset has a `preset_lineage_id`. The persona follows the live `persona_presets` row until the first local content edit materializes it into an independent copy.

### `/config setup`

Setup creates the main persona as a pointer to the selected official preset, stamps `persona_lineage_id` from the preset lineage, and applies the preset avatar to the bot's Discord guild avatar when running in a guild.

### `/persona default`

For the main/default target, `/persona default` re-points the main persona to the selected official preset and patches the bot's Discord guild avatar. Re-running it after customization discards local preset-backed content by establishing a fresh pointer. This also **resets sprites**: the persona's own `persona_sprites` rows are dropped (server-owned sprite images are deleted; shared `presets/` images are kept) so the persona resolves the official preset sprite set live again.

For the main/default target, re-pointing also **resets the avatar**: `applyPresetPointerToPersona` clears `webhook_avatar_url` (a fresh pointer) and the command deletes the old server-owned image (shared `presets/` images are skipped by the delete guard). The guild member avatar is patched immediately for UX, and the main-avatar reconciler keeps it in sync thereafter.

For `type=alter`, `/persona default` creates an alter pointer from the preset and leaves `personas.webhook_avatar_url` NULL — **no per-server upload**. The alter live-resolves the shared preset avatar (`preset_avatar_shared_url`) at load time, so N servers share one image and catalog avatar edits fan out on the next reseed.

Preset-application avatar writes for the main persona are one-time operational Discord updates and do not materialize a pointer: `/config setup`, `/persona default`, and `/persona import` can establish or preserve the pointer while patching the guild avatar. Direct `/server avatar` edits are different; setting or resetting a persona avatar is deliberate customization and materializes a pointer before the avatar write.

All main-persona avatar uploads are re-encoded to PNG before the guild-member PATCH, same as alter avatars. Discord returns 200 OK for structurally corrupt image files but stores an unservable asset (the CDN returns 415 and clients silently keep the old avatar), so raw user bytes are never sent as-is.

## Materialization

The first local content edit forks a pointer into an independent copy. Materialization preserves `persona_id` and `persona_lineage_id`, copies the current live preset content into `personas`, `persona_attributes`, `persona_configs`, and `persona_sprites`, then sets `is_pointer = false`. Preset sprites are copied **by reference** — the new `persona_sprites` rows reuse the shared `presets/` image URL (no byte duplication), so the immutable-delete guard still protects them. A sprite edit (`/persona sprites add|edit|remove|import`) forks through this same path, so the user keeps the default sprite set and layers their changes on top. An alter's avatar is likewise copied by reference: if a forking alter had no avatar of its own (`webhook_avatar_url` NULL), materialization stamps it with `preset_avatar_shared_url` so it keeps the same shared image after forking.

This fork is binary per persona, not field-level: after any content edit, future seed updates no longer change that persona's preset-backed content. Re-running `/persona default` is the supported way to opt back into the live official preset.

Memory and runtime-state writes do not materialize pointers. Server memories, personal memories, conditioning history, autochat runtime counters, cooldowns, and similar runtime rows continue to use `persona_lineage_id`/`persona_id` normally.

## Import/export cards

Native Tomori preset exports include `attribute_public_flags`, aligned 1:1 with `attribute_list`. Older Tomori preset files that do not have this field remain valid; import normalizes them to all-private flags before writing `persona_attributes`.

Exports materialize pointer personas into self-contained preset files by reading the current live preset content. When the source persona is or was derived from an official preset, export stamps `preset_lineage_id` in the native Tomori preset payload.

Import re-links to an official preset pointer only when all of these are true:

- The file has `preset_lineage_id`.
- A seeded `persona_presets` row with that lineage exists.
- Attributes, public flags, sample dialogues, trigger words, and persona prompt exactly match that official preset.
- The file does not carry persona-specific NovelAI/custom fields that are not part of official presets.

If any exact-match check fails, import creates an independent copy with `is_pointer = false`. The imported `preset_lineage_id` is kept as provenance when present, but `preset_language` remains null.

`/persona generate` emits the canonical six generated attributes and marks only the generated Appearance attribute public. `/persona create` emits an explicit all-private flag array because its single freeform description is not guaranteed to be an appearance-only field. SillyTavern card conversion also defaults converted attributes to private because ST cards do not carry Tomori public visibility metadata.

### Import Now button

The `/persona generate` and `/persona create` success messages are rendered as Discord [Components V2](https://discord.com/developers/docs/components/reference) containers (`buildPersonaResultContainer` in `src/utils/discord/ui/interactionCore.ts`) rather than classic embeds: the generated PNG is surfaced through a single-item `MediaGallery`, the old embed color maps to the container `accentColor`, and an action button can live inside the same card.

`/persona generate` also renders its processing state and post-processing error states as Components V2. This keeps the original interaction reply in one message mode for its full lifecycle; Discord rejects edits that combine `MessageFlags.IsComponentsV2` with legacy `embeds` or `content`, and an earlier processing embed can otherwise make the final V2 success edit fail. When an error response preserves `preset_generation_input.txt`, the file is referenced through a Components V2 `File` component.

In guild contexts that card carries a manager-only **Import Now** button. Because the success message is public, the restriction is enforced on click (`ManageGuild`), not by visibility. Pressing it imports the freshly generated persona **as an alter** — it never replaces the existing main persona — using the same `importAlterPreset` core (`src/utils/persona/importAlterPreset.ts`) that backs `/persona import type=alter`. The in-memory preset and PNG buffer are reused, so no re-upload or re-download occurs. Wiring lives in `src/utils/persona/importNowButton.ts`.

The button is one-shot (a successful import disables it and relabels it "Imported"; a failure re-arms it) and driven by a per-message collector — DMs never receive it because alter import is guild-only. Collector lifetime is capped below Discord's 15-minute interaction-token window so the timeout teardown can still edit the original reply, and is configurable via `PERSONA_IMPORT_NOW_BUTTON_TIMEOUT_MS` (default 14 minutes).

## Editing Official Presets

Editing seeded text/config fields in `src/db/seed/catalog/personas/**` changes live pointer personas and future applications after the next startup seed. Editing a persona's avatar art now also fans out: the avatar seed re-uploads the changed image (new content hash → new `preset_avatar_shared_url` and `preset_avatar_hash`), pointer **alters** pick it up live on the next boot, and the main-avatar reconciler re-PATCHes each still-pointer **main** persona's guild avatar (gated on the hash change). Independent (materialized) copies do not change. Startup invalidates cached Tomori state for servers that have pointer personas after schema/catalog-seed/migration work, so long-lived cache entries do not keep stale preset content after seed updates.

System prompt presets are authored separately in `src/db/seed/catalog/systemPrompts.ts` and seeded by `seedSystemPromptsFromCatalog()` immediately after persona presets.

## Migration behavior

The previous seed-time 3-way rebase sync design has been removed. It used a per-persona baseline and attempted to merge official updates into local copies, but it was fragile and never shipped to production.

Migration `020_persona_preset_pointers.sql` adds the pointer columns and converts only exact matches into pointers. The original production pass was too narrow for older setup rows because many of them used generated `persona_lineage_id` values rather than the official `preset_lineage_id`, so they stayed independent copies.

Migration `026_repair_legacy_persona_preset_pointers.sql` is the follow-up repair pass. It recognizes known official preset copy fingerprints from historical seed shapes, including the legacy form that stored `"{bot}'s Description: ..."` as the first attribute, and marks exact copies as pointers even when their memory lineage is custom/generated. It preserves `persona_lineage_id` so existing memories and conditioning stay in their original scope, and it does not rewrite avatars, nicknames, or copied child rows. Customized personas that do not match an official historical fingerprint stay independent copies.

If a pointer references a missing official preset row, materialization fails closed by logging an error and refusing the fork. Runtime reads are more resilient: they log a warning and fall back to the persona's last copied snapshot instead of failing the whole state load.

## Naming maps

Every official language variant declares prefix, suffix, and standalone address-term maps for
masculine, feminine, and neutral addressing styles. Empty maps are explicit and valid. A
gendered address term requires a neutral fallback, and authored `{user_term}` content also
requires a neutral term. `{user_formatted}` is used for user-vocative names in samples.

Pointer personas read `preset_naming_config` live. `/persona naming-habits` materializes a
pointer before saving a custom `persona_naming_configs` row, so other servers remain on the
shared preset. Export emits the naming map; older imports default it to empty. Official-preset
matching includes the map, preventing a customized persona from collapsing back into a pointer.
