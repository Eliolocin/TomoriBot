---
title: "Command Reference"
sidebar:
  order: 6
---

<!--
  GENERATED FILE: do not edit by hand.
  Run `bun run generate-command-reference` from the repository root.
-->

Every slash command currently registered by TomoriBot, generated from the same command builders and English locale descriptions used for Discord registration.

Top-level command groups: **27**. Runnable slash commands: **240**.

## `/bot`

Bot commands.

| Command | Summary |
|---|---|
| `/bot generate image` | Generate a quick scene image from the ongoing channel context. |
| `/bot generate scene` | Generate a short scripted text scene between selected personas. |
| `/bot impersonate` | Impersonate personas, users, or inject system prompts. |
| `/bot kill` | Immediately stop the current stream and clear queued responses in this channel. |
| `/bot respond` | Manually trigger response to the latest message in this channel. |

## `/capabilities`

Manage tool use and specific features.

| Command | Summary |
|---|---|
| `/capabilities manage` | Configure which specific tools I can use on this server. |
| `/capabilities toggle` | Toggle whether I can use tools and function calls. |

## `/conditioning`

Manage persistent reward and punishment conditioning memories.

| Command | Summary |
|---|---|
| `/conditioning manage` | Manage injected conditioning history across all personas in this server. |
| `/conditioning punish bite` | Give me a playful bite! |
| `/conditioning punish bonk` | Give me a bonk on the head! |
| `/conditioning punish pinch` | Give me a pinch! |
| `/conditioning punish spank` | Give me a playful spank! |
| `/conditioning punish squeeze` | Give me a squeeze! |
| `/conditioning reward feed` | Feed me a delicious snack! |
| `/conditioning reward headpat` | Give me a headpat! |
| `/conditioning reward hug` | Give me a hug! |
| `/conditioning reward kiss` | Give me a kiss! |
| `/conditioning reward tickle` | Tickle me! |

## `/config`

Config commands.

| Command | Summary |
|---|---|
| `/config context-note set` | Set a short reminder injected at a specific depth in conversation history |
| `/config humanizer` | Set how 'human-like' my responses should be. For custom prompts, use /config system-prompt set. |
| `/config image-tags default-negative` | Set default negative image tags for unwanted appearance details and artifacts. |
| `/config image-tags default-positive` | Set default positive appearance/style image tags added to image generation prompts. |
| `/config message-fetch-limit` | Set recent messages fetched for context (20-100, default: 80). |
| `/config model-randomizer` | Toggle randomly picking which model leads each reply (anti-repetition). |
| `/config notice-embeds visibility` | Choose which notice embeds remain visible in chat. |
| `/config random-trigger add` | Add a probabilistic timer-based auto-trigger for a channel. |
| `/config random-trigger remove` | Remove an existing random trigger from this server. |
| `/config self-debug` | Toggle whether I load my own diagnostic embeds into context. |
| `/config send-limit` | Limit the number of messages I send per response (default: 0 = unlimited). |
| `/config setup` | Start the initial setup process. Configure AI provider and personality. |
| `/config system-prompt preset` | Apply a preset system prompt |
| `/config system-prompt remove` | Remove the custom system prompt and use the default prompt |
| `/config system-prompt set` | Set a custom system prompt to guide my behavior |
| `/config trigger-cascade-limit` | Manage how many additional persona triggers are allowed after the first (default: 3). |
| `/config trigger-match-limit` | Manage how many personas can match a single message (default: 3). |
| `/config workarounds` | Configure experimental compatibility workarounds. |

## `/contribute`

Contribute commands.

| Command | Summary |
|---|---|
| `/contribute github` | Get the GitHub repository link and learn how to contribute to TomoriBot. |

## `/donate`

Donate commands.

| Command | Summary |
|---|---|
| `/donate kofi` | Support TomoriBot development through Ko-fi donations. |

## `/generate`

Generate commands.

| Command | Summary |
|---|---|
| `/generate image` | Generate an AI image using Google Gemini or OpenRouter |
| `/generate video` | Generate an AI video using Google Veo, OpenRouter, or Z.ai |

## `/help`

Help commands.

| Command | Summary |
|---|---|
| `/help api-key` | Learn how to set up API keys for AI providers |
| `/help custom-endpoint` | Learn how custom endpoints work. |
| `/help customization` | Learn how to customize TomoriBot's personality and behavior |
| `/help data` | Learn about data management and privacy |
| `/help deliberate-tool-mode` | Learn how deliberate tool mode changes tool availability |
| `/help deliberate-trigger-mode` | Learn how deliberate trigger mode changes message triggering |
| `/help features` | Shows what TomoriBot can do |
| `/help matrix` | Learn how to set up and use the Matrix bridge |
| `/help mcp` | Learn how to add and manage MCP tool servers |
| `/help memory` | Learn about TomoriBot's memory system |
| `/help memory-tagging` | Learn how memory keyword and channel tagging works |
| `/help nsfw` | Learn how to enable age-restricted (NSFW) commands |
| `/help personal-provider` | Learn how personal providers work. |
| `/help setup` | Learn how to set up TomoriBot for the first time |
| `/help speech` | Learn how speech generation works. |
| `/help spotlight` | Learn what personal spotlight does and how to use it |
| `/help st-preset` | Learn how SillyTavern presets behave here |
| `/help stm` | Learn how to customize my short-term memory (server admins) |
| `/help transcription` | Learn how audio transcription works. |

## `/legal`

Legal commands.

| Command | Summary |
|---|---|
| `/legal license` | View TomoriBot's open-source license |
| `/legal privacy` | View TomoriBot's Privacy Policy |
| `/legal terms` | View TomoriBot's Terms of Service |

## `/mcp`

Manage remote MCP (Model Context Protocol) tool servers

| Command | Summary |
|---|---|
| `/mcp add` | Register a new remote MCP server for this guild. Use /help mcp for a setup guide. |
| `/mcp list` | List all registered MCP servers for this guild. |
| `/mcp remove` | Remove a registered MCP server from this guild. |
| `/mcp toggle` | Enable or disable a registered MCP server. |

## `/memory`

Manage stored memories and documents.

| Command | Summary |
|---|---|
| `/memory document add` | Add a document to memory. |
| `/memory document remove` | Remove a document from memory. |
| `/memory document view` | Browse a stored document chunk by chunk, allowing you to edit or delete each chunk as well. |
| `/memory history import` | Extract knowledge from this channel's message history using AI. |
| `/memory history remove` | Remove a history-extracted document from memory. |
| `/memory personal add` | Add a personal memory. |
| `/memory personal edit` | Edit a personal memory. |
| `/memory personal export` | Export personal memories to JSON. |
| `/memory personal import` | Import personal memories from JSON. |
| `/memory personal remove` | Remove a personal memory. |
| `/memory server add` | Add a server memory. |
| `/memory server edit` | Edit a server memory. |
| `/memory server export` | Export server memories to JSON. |
| `/memory server import` | Import server memories from JSON. |
| `/memory server remove` | Remove a server memory. |
| `/memory server vectorize` | Convert a server memory into a searchable document. |
| `/memory tagging set` | Switch to tagged memory mode |

## `/model`

Manage this server's default AI models.

| Command | Summary |
|---|---|
| `/model embedding` | Change this server's embedding model used for document retrieval. |
| `/model fallback` | Set this server's backup text models, or clear slots with None. |
| `/model image` | Change this server's image generation model. |
| `/model logit-bias add` | Add comma-separated logit bias entries with one shared bias value. |
| `/model logit-bias remove` | Remove saved logit bias entries. |
| `/model logit-bias upload` | Upload SillyTavern-style logit bias JSON entries. |
| `/model override remove` | Remove channel and persona model overrides. |
| `/model parameters` | Update this server's saved sampler settings for a provider. |
| `/model speech` | Choose this server's active speech endpoint. |
| `/model stop-strings add` | Add server-wide stop strings. |
| `/model stop-strings manage` | Manage server-wide stop strings and the speaker-pattern stop behavior. |
| `/model text` | Change this server's default text model. |
| `/model transcription` | Choose this server's active transcription endpoint. |
| `/model video` | Change this server's video generation model. |
| `/model vision` | Set this server's vision model for when its chat model can't see images. |

## `/novelai`

Novelai commands.

| Command | Summary |
|---|---|
| `/novelai attg` | Configure Author/Title/Tags/Genre/Stars metadata for NovelAI Kayra and Erato prompts. |
| `/novelai character-reference` | Upload or clear a NovelAI character reference image for yourself or a persona. |
| `/novelai image generate` | Generate a NovelAI image using imageboard-style tags and an optional character reference. |
| `/novelai image parameters` | Override NovelAI image generation sampler and quality settings for this server. |
| `/novelai preset text` | Apply a NovelAI sampling preset to this server's text generation settings. |
| `/novelai usage` | Show this server's NovelAI Opus generation usage meter (Manage Server required). |

## `/nsfw`

Age-restricted commands and settings.

| Command | Summary |
|---|---|
| `/nsfw jailbreaks` | Manage optional jailbreak behaviors for my prompts on this server. |

## `/openrouter`

Manage OpenRouter-specific models and settings.

| Command | Summary |
|---|---|
| `/openrouter model add` | Register an OpenRouter model codename for this server. |
| `/openrouter model remove` | Remove registered OpenRouter models from this server. |

## `/optional-key`

Manage optional service API keys

| Command | Summary |
|---|---|
| `/optional-key brave remove` | Remove the currently configured Brave Search API key. |
| `/optional-key brave set` | Set the Brave Search API key for this server. |

## `/persona`

Manage personality presets

| Command | Summary |
|---|---|
| `/persona attribute add` | Add an attribute to a persona. |
| `/persona attribute edit` | Edit an attribute on a persona. |
| `/persona attribute remove` | Remove an attribute from a persona. |
| `/persona avatar` | Set or remove avatar for a selected persona on this server. |
| `/persona create` | Create a simple personality preset manually |
| `/persona default` | Apply a preset personality configuration |
| `/persona export` | Export current personality as a shareable PNG file |
| `/persona generate` | AI-powered personality generation (requires a compatible provider) |
| `/persona image-tags` | Set comma-separated image tags for a persona's physical appearance to assist image generation. |
| `/persona import` | Import a persona from a PNG or JSON file |
| `/persona prompt remove` | Remove a persona prompt. |
| `/persona prompt set` | Set a persona prompt. |
| `/persona remove` | Remove an alter persona from the server |
| `/persona rename` | Change my name on this server. |
| `/persona sample-dialogue add` | Add a sample user/bot dialogue pair to as an example for how I should respond. |
| `/persona sample-dialogue edit` | Edit a sample user/bot dialogue pair. |
| `/persona sample-dialogue remove` | Remove a sample user/bot dialogue pair from my memory. |
| `/persona sprites add` | Add or replace a persona sprite avatar. |
| `/persona sprites edit` | Edit a persona sprite's name, image, instructions, or identity. |
| `/persona sprites export` | Export a persona's sprites as a shareable .zip file. |
| `/persona sprites import` | Import a persona's sprites from a .zip file. |
| `/persona sprites remove` | Remove persona sprite avatars. |
| `/persona stm edit` | Hand-edit a persona's short-term memory for this channel. |
| `/persona stm view` | View a persona's short-term memory for this channel (read-only). |
| `/persona swap` | Swap the main persona with an alter persona |
| `/persona trigger add` | Add trigger words for a persona. |
| `/persona trigger remove` | Remove a word that makes me respond when mentioned. |

## `/personal`

Manage your personal settings

| Command | Summary |
|---|---|
| `/personal config export` | Export your personal settings, excluding server settings, personas, and memories. |
| `/personal config import` | Import your personal settings only. Does not import server settings or memories. |
| `/personal config remove` | Reset your personal configuration. |
| `/personal custom-endpoint add` | Register a model under a personal custom endpoint label (reuse the label to add more). |
| `/personal custom-endpoint edit` | Edit fields on a registered personal custom endpoint. |
| `/personal custom-endpoint remove` | Remove selected capabilities from personal custom endpoints. |
| `/personal deliberate-tool-mode` | Set your personal deliberate tool mode preference. |
| `/personal deliberate-trigger-mode` | Set your personal deliberate trigger mode (DTM) preference. |
| `/personal image-tags` | Set comma-separated image tags for your physical appearance to assist image generation. |
| `/personal impersonate prompt` | Set a reusable prompt that tells me how to impersonate you. |
| `/personal language` | Set your preferred language for my interface. |
| `/personal model fallback` | Set fallback models for your personal text override, or clear slots with None. |
| `/personal nickname` | Change the name I use to refer to you. |
| `/personal openrouter-model add` | Register an OpenRouter model codename for your personal provider list. |
| `/personal openrouter-model remove` | Remove registered OpenRouter models from your personal provider list. |
| `/personal parameters` | Adjust sampler settings for your personal providers, not this server's. |
| `/personal privacy` | Control personal memory storage and privacy settings |
| `/personal provider add` | Save your API key and enable its default personal text model everywhere. |
| `/personal provider model-embedding` | Select and enable your personal embedding model, used in every server. |
| `/personal provider model-image` | Select and enable your personal image model, used in every server. |
| `/personal provider model-text` | Select and enable your personal text model, used in every server. |
| `/personal provider model-video` | Select and enable your personal video model, used in every server. |
| `/personal provider model-vision` | Select and enable your personal vision model, used in every server. |
| `/personal provider remove` | Remove one of your cross-server personal provider configurations. |
| `/personal provider toggle-models` | Choose which capabilities use your personal provider instead of the server's. |
| `/personal spotlight manage` | Remove your active personal spotlights. Use /help spotlight to learn more. |
| `/personal spotlight set` | Set a personal persona spotlight for one channel. Use /help spotlight to learn more. |
| `/personal stm` | Configure STM (short-term memory) settings |
| `/personal timezone` | Set your personal timezone offset from UTC. |

## `/provider`

Manage this server's shared AI providers.

| Command | Summary |
|---|---|
| `/provider add` | Save credentials for this server and activate its saved text model. |
| `/provider api-key rotation` | Manage API key rotation for load balancing and failover. |
| `/provider custom-endpoint add` | Register a model under a custom endpoint label (reuse the label to add more). |
| `/provider custom-endpoint edit` | Edit fields on a registered custom endpoint. |
| `/provider custom-endpoint remove` | Remove selected capabilities from labeled custom endpoints. |
| `/provider remove` | Remove a saved provider configuration from this server. |

## `/scheduled-task`

Manage scheduled tasks and reminders.

| Command | Summary |
|---|---|
| `/scheduled-task edit` | Edit a scheduled task or reminder. |
| `/scheduled-task remove` | Remove a scheduled task or reminder. |

## `/server`

Server commands.

| Command | Summary |
|---|---|
| `/server always-reply` | Toggle always-reply mode for the main persona. |
| `/server auto-trigger channels` | Manage auto-trigger channels and optional per-channel persona assignment. |
| `/server auto-trigger threshold` | Set the shared auto-chat range for configured auto-chat channels. |
| `/server channel-prompt` | Set a system prompt scoped to one channel (appends to or replaces the server prompt there). |
| `/server config export` | Export this server's settings, excluding memories, personas, and personal settings. |
| `/server config import` | Import server settings. Does not import memories, personas, or personal settings. |
| `/server config remove` | Reset this server's configuration. |
| `/server cooldown triggers` | Set cooldown type and duration for triggers and /bot (defaults: off, 5s). |
| `/server crosschannel-blocklist` | Manage the channel blocklist for tool-driven cross-channel messages |
| `/server deliberate-tool-context` | Set how many following turns keep recently used tools available. |
| `/server deliberate-tool-mode` | Toggle deliberate tool mode for this server. |
| `/server deliberate-tool-trigger` | Manage custom trigger phrases for deliberate tool mode. |
| `/server deliberate-trigger-mode` | Toggle deliberate trigger mode (DTM) for this server. |
| `/server expressions edit` | Edit the emotion and usage instructions of a single emoji or sticker |
| `/server expressions initialize` | Analyze and classify all custom emojis and stickers using AI vision |
| `/server matrix link` | Link a Discord channel to a Matrix room for bidirectional relay |
| `/server matrix unlink` | Remove the Matrix bridge link from a Discord channel |
| `/server member-permissions` | Configure what non-admin members can teach me. |
| `/server nuke` | Completely wipe all server data. Requires re-running /setup afterwards. |
| `/server private-channels` | Manage private channels where STMs are isolated and thought logs are suppressed |
| `/server quota image-generation` | Configure daily image generation quotas for this server. |
| `/server quota reset` | Reset a quota pool for image, text, or video generation. |
| `/server quota text-generation` | Configure text generation trigger quotas for this server. |
| `/server quota video-generation` | Configure video generation quotas for this server. |
| `/server rp-channels` | Manage channels where emojis and stickers are always suppressed and `/delete turn` is available |
| `/server stm categories-edit` | Define up to 5 labeled STM categories the bot fills via tool calls. |
| `/server stm manage` | Review and clear active server-shared STMs across personas. |
| `/server stm parameters` | Tune the STM refresh cadence, render mode, crude-message count, nudge depth, and content depth. |
| `/server stm privacy-bypass` | Toggle whether private-channel STMs can leak into non-private channels. |
| `/server stm prompt-edit` | Customize the STM tool description and the unified refresh nudge. |
| `/server thought-logs-channel` | Set or clear the server's thought-log channel. |
| `/server timezone` | Set your server's timezone offset from UTC (default: 0 / UTC). |
| `/server user-blacklist add` | Add a member to the personalization blacklist. |
| `/server user-blacklist remove` | Review user blacklist entries and persona blocks; uncheck entries to remove. |
| `/server user-byok toggle` | Toggle whether user-triggered messages require a member's personal provider. |
| `/server welcome-channel remove` | Remove the configured welcome channel and stop automated greetings. |
| `/server welcome-channel set` | Set the channel used for automated welcome greetings. |
| `/server whitelist channel` | Add a channel to the whitelist, optionally overriding the global cooldown |
| `/server whitelist persona` | Restrict which channels a persona can trigger in |
| `/server whitelist remove` | Remove personas, channels, or roles from whitelist |
| `/server whitelist role` | Add or remove whitelisted roles that can trigger the bot |

## `/speech`

Manage speech voices and samples.

| Command | Summary |
|---|---|
| `/speech chatterbox parameters` | Tune Chatterbox Turbo and standard-model speech generation. |
| `/speech elevenlabs` | Connect ElevenLabs speech and transcription. |
| `/speech transcripts` | Toggle visible transcript posting for voice messages. |
| `/speech voice-add` | Upload a local TTS reference voice sample. |
| `/speech voice-assign` | Assign a speech voice to a persona. |
| `/speech voice-design remove` | Remove a persona's voice design prompt. |
| `/speech voice-design set` | Set a voice design prompt for a persona. |
| `/speech voice-remove` | Remove a local TTS voice sample from this server. |

## `/st-preset`

Manage SillyTavern presets. Use /help st-preset.

| Command | Summary |
|---|---|
| `/st-preset import` | Import a SillyTavern preset JSON file. Use /help st-preset. |
| `/st-preset node toggle` | Toggle preset prompt nodes on or off |
| `/st-preset remove` | Remove imported SillyTavern presets |
| `/st-preset switch` | Switch the active SillyTavern preset |

## `/stats`

View usage statistics

| Command | Summary |
|---|---|
| `/stats generate` | Generate a shareable stats image card. |
| `/stats persona` | View a persona's usage statistics on this server. |
| `/stats personal` | View your own usage statistics. |
| `/stats server` | View server-wide usage statistics. |

## `/support`

Support commands.

| Command | Summary |
|---|---|
| `/support discord` | Get the official Discord server link for bug reports, feedback, and community chat. |

## `/tool`

Tool commands.

| Command | Summary |
|---|---|
| `/tool comment` | Send a comment embed visible in chat but invisible in context. |
| `/tool compact` | Summarize the recent conversation into a compact system memory. |
| `/tool delete turn` | Delete the last persona's turn from the channel. |
| `/tool estimate cost` | Estimate API costs for paid AI providers |
| `/tool ping` | Check the bot's latency. |
| `/tool prompt snapshot` | Dump the exact LLM prompt for a persona to a file for debugging. |
| `/tool refresh` | Clear conversation history (this channel only). |
| `/tool status` | Show current personal, server, or persona status. |

## `/update`

View the latest TomoriBot release notes

| Command | Summary |
|---|---|
| `/update` | View the latest TomoriBot release notes |
