---
title: "Data Handling"
sidebar:
  order: 4
---

TomoriBot is built to be transparent about your data. You can export, import, or delete
everything she stores, and this page spells out exactly what that is. For the legal text,
see `/legal privacy` and `/legal terms`.

:::note
This page covers the in-Discord, per-user controls. **Self-hosting your own instance?**
Whole-database backups and restores are a host-side operation — see
[Maintenance & Backups](/self-hosting/maintenance/).
:::

## What She Stores

**Stored:**

- Server and personal memories
- Her settings and persona data
- Server configuration
- Encrypted API keys

**Not stored:**

- Your Discord messages
- Chat history

**Sent to your AI provider:** whenever she's triggered, she fetches the **latest messages**
in the channel plus any **relevant memories** as context for the model. She does not monitor
or read messages outside of those triggers.

:::note
Your chosen AI provider (Google, OpenRouter, NovelAI, …) processes messages under *their own*
privacy policies. Never share sensitive personal information with any AI.
:::

## Export Your Data

Everything exportable is sent to your DMs as a JSON file:

- `/export config` — server configuration values (no API keys, credentials, or provider settings).
- `/export personal config` — your personal settings (profile, privacy, appearance, response modes).
- `/export memories` — server memories, scoped to the main persona, one selected persona, or every persona separately.
- `/export personal memories` — your personal memories, scoped globally, to one persona, or to every persona separately.
- `/persona export` — full persona definitions.

## Import Your Data

Attach a previously exported file to restore it:

- `/import config` — server configuration; requires **Manage Server**. Choose which detected sections to apply.
- `/import personal config` — your personal settings. Choose which detected sections to apply.
- `/import memories` — server memories; requires **Manage Server**. Merge or replace, and map each source persona if the file has more than one.
- `/import personal memories` — your personal memories. Merge or replace, and map each source persona if the file has more than one.
- `/persona import` — restore a persona. It also accepts PNG and JSON SillyTavern cards and
  `.charx` Character Card V3 archives, which import the character text only (see
  [SillyTavern Support](/features/integrations/sillytavern-support/)).

## Delete Your Data

These permanently remove or reset data - **they cannot be undone**:

- `/personal memories`, `/memories`
- `/reset config` - resets server configuration across the 29 configuration tables to database defaults.
  - **Singletons restored to DDL defaults (18 tables):** chat configs, model configs, member permissions, capabilities, notice embeds, nsfw configs, speech configs, auto-trigger configs, channel scope configs, trigger behavior configs, NovelAI image generation configs, BYOK configs, memory configs, short-term memory configs, welcome configs, image quota configs, text quota configs, and video quota configs.
  - **Preserved configuration (two sets):** active model IDs, credentials, and custom endpoint parameters in `server_model_configs` (`llm_id`, `embedding_model_id`, `diffusion_model_id`, `video_model_id`, `vision_llm_id`, `api_key`, `key_version`, `custom_endpoint_url`, `custom_model_name`, `custom_num_ctx`, `other_model_codename`, `other_model_capabilities`, `other_model_capabilities_fetched_at`), plus active NovelAI diffusion model identity (`nai_diffusion_model_id` in `server_novelai_imagegen_configs`).
  - **Cleared collections (11 tables):** `server_auto_trigger_persona_overrides`, `stm_categories`, `random_triggers`, `channel_llm_overrides`, `channel_prompt_overrides`, `channel_context_notes`, `personalization_blacklist`, `persona_user_blocks`, `channel_whitelist`, `role_whitelist`, and `channel_persona_whitelist`.
  - **Preserved domains:** Personas and persona settings, server memories, short-term memories, expressions (emojis and stickers), recorded quota consumption, saved provider configurations, and external integrations (Matrix and MCP).
  - **Context and permissions:** Requires Manage Server permission in guilds. Supported in direct messages (DMs) using the invoking user workspace snowflake.
- `/reset personal config` - resets user configuration and personal channel spotlights across all servers to database defaults.
  - **Reset fields:** Restores `users.language_pref` ('en-US') and `users.privacy_level` (0), restores all 13 columns in `user_personalization_configs` (nickname, cross-server opt-in, appearance tags, character reference URL, impersonation prompt, personal DTM, deliberate tool mode, timezone offset, prefix/suffix overrides, gender identity, pronouns, addressing style) to schema defaults, and deletes all `user_persona_naming_preferences`.
  - **Cleared collections:** Deletes all `personal_spotlights` for the user across workspaces, cascading to `personal_spotlight_personas`.
  - **Preserved personal domains:** User account identity, registration locale, personal memories, saved provider configurations (`user_saved_provider_configs`), custom endpoints, and scheduled tasks/reminders.
  - **Context:** Available to all users in both guilds and DMs.

## Opting Out

- `/personal config` — control your visibility to her, up to full invisibility (opt out of
  memory features entirely).
- `/config` > Permissions — server admins can turn off self-learning and other features.

See [Memory](/features/knowledge/memory/) for how memories work day to day.
