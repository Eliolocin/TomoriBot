---
title: Privacy Policy
description: How the official hosted TomoriBot instance collects, stores, and deletes your data.
aiGenerated: false
---

Last updated: 2026-01-25

This Privacy Policy explains how the official hosted TomoriBot instance handles data. If you self-host TomoriBot from this repository, you control your own data; this document is a reference template and does not govern your self-hosted deployment. 

Terms like "Server," "Memories," "Persona/Preset," "Provider," "Trigger," and "API Key" are defined in our [Terms of Service](/legal/terms-of-service/). Please refer to that document for definitions.

## 1) What We Collect and How Long We Keep It

### 1.1) Data Stored Persistently
The following data is stored in our database until you delete it using TomoriBot's slash commands:
- **Discord identifiers and preferences:** User IDs, server IDs, nicknames, language/locale preferences, and privacy opt-out status to route commands and localize responses.
- **Server configuration and persona data:** TomoriBot nicknames, persona attributes, sample dialogues, trigger words, LLM/provider selections, timezone offsets, and feature toggles configured per server.
- **Server emoji and sticker metadata:** Discord IDs, names, descriptions, and format flags for custom emojis/stickers configured for emotional expressions. The actual image files are NOT stored; only metadata is retained to identify and use them.
- **Memories and content you provide through commands:** Personal memories, server memories, and text you submit via commands. These may reference Discord users and message content you supply.
- **Reminders:** Reminder text, target user/channel, scheduled time, recurrence settings, and timezone information stored when you create reminders via bot commands.
- **API keys:** Provider keys (e.g., AI or search) you choose to store. Keys are encrypted at rest.
- **Persona avatar images:** Images you upload for persona avatars are stored in cloud storage to enable the bot to use them when rendering personas across conversations.
- **Operational logs:** Error logs containing interaction IDs, user/server IDs, command names, error types, and stack traces for debugging. No message content or personal conversations are logged. Routine successful operations are not logged.

### 1.2) Data Processed Ephemerally (Not Stored)
The following data is accessed temporarily during Trigger processing (as defined in the Terms of Service) and is NOT stored in our database:
- **Discord messages:** Latest content (typically last 80 messages) in the triggered Discord text channel are read in-memory to build conversation context and sent to your configured Provider for AI responses. This data is immediately discarded after the response is generated.
- **Attachments and media:** Message video/image attachments or profile picture analysis (e.g., `/peek profile_picture`) are processed in-memory and sent to your configured AI provider if needed, but are NOT stored by TomoriBot. Once processing completes, these files are discarded. Note: Persona avatar images are stored persistently (see Section 1.1).
- **Server asset URLs:** When emojis/stickers are used in AI responses, their image URLs are fetched fresh from Discord each time and may be sent to AI providers as conversation context. These URLs are not stored.
- **Server and channel metadata:** Server names, descriptions, channel names, and channel descriptions are fetched in real-time during conversations to provide contextual understanding. This metadata is processed in-memory and is NOT stored in our database.
- **User presence information:** Current user activities (e.g., what you're listening to, playing, or custom status) may be accessed during conversations to provide contextual awareness. This presence data is processed in-memory and is NOT stored.

## 2) How We Use Data
- Operate and improve bot functionality, including localization, persona rendering, safety checks, and permission gating.
- Store and recall memories/persona data to keep conversations contextual.
- Send your prompts, relevant context, and optional attachments to the AI/search Providers you select so they can generate responses.
- Provide reminders, exports, imports, and server management tools.
- Detect and mitigate abuse, errors, and service stability issues.

## 3) Third-Party Disclosure
- **AI and model providers:** Content you send (including prompts, persona data, sample dialogues, relevant context, and optional media) may be transmitted to providers you configure, such as Google, OpenRouter, or NovelAI. Their terms, privacy policies, safety filters, and retention rules apply.
- **Search providers:** If enabled, search queries and relevant context may be sent to the configured provider (e.g., Brave Search). Their policies apply.
- We do not sell personal data. Sharing occurs only as necessary to operate the features you invoke or to comply with law.

## 4) Your Choices and Controls
- Use `/personal config` to stop saving personal memories about you across servers.
- Use `/data export` to retrieve personal or server data.
- Use `/data delete personal` to remove your user record (cascades related personal data) or `/data delete server` to remove a server's TomoriBot data.
- Server admins can disable features such as sample dialogue teaching, personal memories, web search, or other permissions using configuration commands.

## 5) Retention
- Stored data (memories, persona, reminders, server configuration, and encrypted keys) persists until removed through the commands above.
- When TomoriBot is removed from a server, server data may be retained to allow for re-invitation.
- User data persists across servers until explicitly deleted via `/data delete personal`.
- Error logs are kept for operational stability and diagnosing system issues.
- Transient context built from recent Discord messages is kept in memory only for the duration of request processing unless you explicitly save it.

## 6) Security
- Provider API keys are encrypted at rest.
- The database is restricted to the bot's runtime and operators with server access. No method is perfectly secure; do not submit highly sensitive or regulated data.

## 7) Children's Data
- TomoriBot is intended for users 13+ (or the local minimum age for Discord). We do not knowingly collect data from younger users.

## 8) Changes
- We may update this Privacy Policy; the "Last updated" date will change accordingly. Continued use after updates means you accept the revisions.

## 9) Contact
- For hosted-instance privacy questions or requests beyond the commands above, contact us through the email `bredrumb@gmail.com`, project GitHub issues, or the [official TomoriBot support Discord server](https://discord.gg/bjCfHm9QsB).

## 10) International Users and GDPR
- TomoriBot's hosted service operates globally with data stored according to the hosting provider's infrastructure.
- For users in the European Economic Area (EEA), UK, or Switzerland: You have additional rights under the General Data Protection Regulation (GDPR), including the right to access, rectify, erase, restrict processing, data portability, and to object to processing of your personal data.
- The data controls described in Section 4 fulfill most GDPR rights (export, deletion, opt-out). For additional requests, contact us via the methods in Section 9.
- Legal basis for processing: Legitimate interest (bot functionality), Contract (service provision), and Consent (optional features like memories and reminders).
