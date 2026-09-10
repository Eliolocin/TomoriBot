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

Top-level command groups: **39**. Runnable slash commands: **76**.

## `/comment`

Send a comment embed visible in chat but invisible in context.

| Command | Summary |
|---|---|
| `/comment` | Send a comment embed visible in chat but invisible in context. |

## `/compact`

Summarize the recent conversation into a compact system memory.

| Command | Summary |
|---|---|
| `/compact` | Summarize the recent conversation into a compact system memory. |

## `/conditioning`

Manage persistent reward and punishment conditioning memories.

| Command | Summary |
|---|---|
| `/conditioning manage` | Manage injected conditioning history across all personas in this server. |
| `/conditioning remove` | Remove conditioning entries across every persona in this server. |

## `/config`

Configure persona, behavior, channel, permission, and model settings.

| Command | Summary |
|---|---|
| `/config` | Configure persona, behavior, channel, permission, and model settings. |

## `/contribute`

Find the source code and ways to help build TomoriBot.

| Command | Summary |
|---|---|
| `/contribute github` | Get the GitHub repository link and learn how to contribute to TomoriBot. |

## `/donate`

Support TomoriBot's development and hosting costs.

| Command | Summary |
|---|---|
| `/donate kofi` | Support TomoriBot development through Ko-fi donations. |

## `/expressions`

Teach TomoriBot when to use this server's custom emojis and stickers.

| Command | Summary |
|---|---|
| `/expressions edit` | Edit the emotion and usage instructions of a single emoji or sticker |
| `/expressions initialize` | Analyze and classify all custom emojis and stickers using AI vision |

## `/generate`

Generate AI images, videos, and voice messages.

| Command | Summary |
|---|---|
| `/generate image` | Generate an AI image from your own prompt or the current channel scene |
| `/generate scene` | Generate a short scripted text scene between selected personas. |
| `/generate video` | Generate an AI video using Google Veo, OpenRouter, or Z.ai |
| `/generate voice-message` | Speak a message with a voice you pick |

## `/help`

Browse setup, features, providers, memory, behavior, tools, media, and integration guides.

| Command | Summary |
|---|---|
| `/help` | Browse setup, features, providers, memory, behavior, tools, media, and integration guides. |

## `/impersonate`

Impersonate personas, users, or inject system prompts.

| Command | Summary |
|---|---|
| `/impersonate persona` | Send a message as one of this server's personas. |
| `/impersonate system` | Inject a system message into the conversation context. |
| `/impersonate user` | Have the bot write and send a message as if it were that member. |

## `/kill`

Immediately stop the current stream and clear queued responses in this channel.

| Command | Summary |
|---|---|
| `/kill` | Immediately stop the current stream and clear queued responses in this channel. |

## `/learn`

Learn, extract, and ingest conversation history into memory.

| Command | Summary |
|---|---|
| `/learn history` | Extract knowledge from this channel's message history using AI. |

## `/legal`

View TomoriBot's terms of service, privacy policy, and license.

| Command | Summary |
|---|---|
| `/legal license` | View TomoriBot's open-source license |
| `/legal privacy` | View TomoriBot's Privacy Policy |
| `/legal terms` | View TomoriBot's Terms of Service |

## `/matrix`

Link Discord channels to Matrix rooms for bidirectional relay.

| Command | Summary |
|---|---|
| `/matrix link` | Link a Discord channel to a Matrix room for bidirectional relay |
| `/matrix unlink` | Remove the Matrix bridge link from a Discord channel |

## `/memories`

Inspect and manage server memories, documents, and short-term memory.

| Command | Summary |
|---|---|
| `/memories` | Inspect and manage server memories, documents, and short-term memory. |

## `/memory`

Manage stored memories and documents.

| Command | Summary |
|---|---|
| `/memory personal export` | Export personal memories to JSON. |
| `/memory personal import` | Import personal memories from JSON. |
| `/memory server export` | Export server memories to JSON. |
| `/memory server import` | Import server memories from JSON. |

## `/model`

Manage this server's default AI models.

| Command | Summary |
|---|---|
| `/model override remove` | Remove channel and persona model overrides. |

## `/moderation`

Manage member permissions, blacklist, channel and role whitelist, and quota settings.

| Command | Summary |
|---|---|
| `/moderation` | Manage member permissions, blacklist, channel and role whitelist, and quota settings. |

## `/novelai`

Configure NovelAI text and image generation for this server.

| Command | Summary |
|---|---|
| `/novelai generate image` | Generate a NovelAI image using imageboard-style tags and an optional character reference. |

## `/nsfw`

Age-restricted commands and settings.

| Command | Summary |
|---|---|
| `/nsfw jailbreaks` | Manage optional jailbreak behaviors for my prompts on this server. |

## `/nuke`

Completely wipe all server data. Requires re-running /setup afterwards.

| Command | Summary |
|---|---|
| `/nuke` | Completely wipe all server data. Requires re-running /setup afterwards. |

## `/persona`

Manage personality presets

| Command | Summary |
|---|---|
| `/persona create` | Create a simple personality preset manually |
| `/persona default` | Apply a preset personality configuration |
| `/persona export` | Export current personality as a shareable PNG file |
| `/persona generate` | AI-powered personality generation (requires a compatible provider) |
| `/persona import` | Import a persona from a PNG or JSON file |
| `/persona remove` | Remove an alter persona from the server |

## `/personal`

Manage your personal settings

| Command | Summary |
|---|---|
| `/personal config` | Manage your personal preferences, privacy, models, and profile. |
| `/personal memories` | Manage your personal long-term memories and short-term conversational context. |
| `/personal providers` | Manage your personal provider credentials, endpoints, and model catalogs. |

## `/ping`

Check the bot's latency.

| Command | Summary |
|---|---|
| `/ping` | Check the bot's latency. |

## `/providers`

Add, view, edit, and remove provider credentials, endpoints, and model catalogs.

| Command | Summary |
|---|---|
| `/providers` | Add, view, edit, and remove provider credentials, endpoints, and model catalogs. |

## `/punish`

Punish me with playful interactions.

| Command | Summary |
|---|---|
| `/punish bite` | Give me a playful bite! |
| `/punish bonk` | Give me a bonk on the head! |
| `/punish pinch` | Give me a pinch! |
| `/punish spank` | Give me a playful spank! |
| `/punish squeeze` | Give me a squeeze! |

## `/quota`

Manage generation quota resets.

| Command | Summary |
|---|---|
| `/quota reset global` | Reset the server-wide generation quota pool. |
| `/quota reset user` | Reset daily quota usage for a user. |

## `/refresh`

Clear conversation history (this channel only).

| Command | Summary |
|---|---|
| `/refresh` | Clear conversation history (this channel only). |

## `/reset`

Reset server or personal configuration to defaults.

| Command | Summary |
|---|---|
| `/reset config` | Reset this server's configuration to database defaults. |
| `/reset personal config` | Reset your personal configuration to database defaults. |

## `/respond`

Manually trigger response to the latest message in this channel.

| Command | Summary |
|---|---|
| `/respond` | Manually trigger response to the latest message in this channel. |

## `/reward`

Reward me with fun interactions.

| Command | Summary |
|---|---|
| `/reward feed` | Feed me a delicious snack! |
| `/reward headpat` | Give me a headpat! |
| `/reward hug` | Give me a hug! |
| `/reward kiss` | Give me a kiss! |
| `/reward tickle` | Tickle me! |

## `/scheduled-task`

Manage scheduled tasks and reminders.

| Command | Summary |
|---|---|
| `/scheduled-task edit` | Edit a scheduled task or reminder. |
| `/scheduled-task remove` | Remove a scheduled task or reminder. |

## `/server`

Manage server-wide settings, channels, permissions, and integrations.

| Command | Summary |
|---|---|
| `/server config export` | Export this server's settings, excluding memories, personas, and personal settings. |
| `/server config import` | Import server settings. Does not import memories, personas, or personal settings. |

## `/setup`

Start the initial setup process. Configure AI provider and personality.

| Command | Summary |
|---|---|
| `/setup` | Start the initial setup process. Configure AI provider and personality. |

## `/stats`

View usage statistics

| Command | Summary |
|---|---|
| `/stats generate` | Generate a shareable stats image card. |
| `/stats persona` | View a persona's usage statistics on this server. |
| `/stats personal` | View your own usage statistics. |
| `/stats server` | View server-wide usage statistics. |

## `/status`

Show current personal, server, or persona status.

| Command | Summary |
|---|---|
| `/status` | Show current personal, server, or persona status. |

## `/support`

Get help, report bugs, and join the TomoriBot community.

| Command | Summary |
|---|---|
| `/support discord` | Get the official Discord server link for bug reports, feedback, and community chat. |

## `/tool`

Utility actions for conversation context, prompts, and diagnostics.

| Command | Summary |
|---|---|
| `/tool delete turn` | Delete the last persona's turn from the channel. |
| `/tool estimate cost` | Estimate API costs for paid AI providers |
| `/tool prompt snapshot` | Dump the exact LLM prompt for a persona to a file for debugging. |

## `/update`

View the latest TomoriBot release notes

| Command | Summary |
|---|---|
| `/update` | View the latest TomoriBot release notes |
