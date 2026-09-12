---
title: Privacy Policy
description: How the official hosted TomoriBot instance collects, stores, and deletes your data.
aiGenerated: false
---

Last updated: 2026-09-12

This Privacy Policy explains how the official hosted TomoriBot instance handles data. If you self-host TomoriBot from this repository, you control your own data; this document is a reference template and does not govern your self-hosted deployment.

Terms like "Server," "Memories," "Persona/Preset," "Provider," "Trigger," and "API Key" are defined in our [Terms of Service](/legal/terms-of-service/). Please refer to that document for definitions.

## Privacy at a Glance

- We do not keep a copy of your Discord chat history. TomoriBot reads recent messages while it is answering, then discards them.
- If short-term memory is enabled, TomoriBot does store short summaries derived from those conversations. Those expire after a period of inactivity (90 days by default).
- Everything you teach TomoriBot on purpose (memories, persona settings, uploaded documents) is stored until someone deletes it.
- When TomoriBot answers, it sends your prompt and recent context to the AI provider configured for that server. That provider has its own terms and privacy practices, which we do not control.
- `/personal nuke` erases everything we store about you, in every server.

The sections below give the detail behind each of those lines.

## 1) Who This Policy Covers

This policy applies to the official hosted TomoriBot instance. Server managers configure TomoriBot for a Server, but every member whose messages TomoriBot processes is covered by this policy, whether or not they ran a command themselves.

Server managers accept the Terms of Service during `/setup` and confirm there that they will make this information available to their members. Any member can read the current policies at any time with `/legal privacy-policy` and `/legal terms-of-service`.

## 2) What We Store

### 2.1) About You
- **Identity and preferences:** your Discord user ID, language preference, and privacy opt-out status.
- **Personalization settings:** the nickname you choose, pronouns, gender identity, forms of address, physical appearance tags, an impersonation prompt, a character reference image URL, timezone offset, and message prefix/suffix overrides.
- **Naming preferences:** what each persona should call you.
- **Personal memories:** facts you teach TomoriBot about yourself, or that it saves about you when personal memories are enabled.
- **Spotlights:** the personal spotlight configuration you set per server.
- **Conditioning records:** the text and reason you supply through `/reward` and `/punish`, which shape how a persona behaves in that Server.
- **Usage counters:** daily counts of commands, models, and tools you used, plus token totals, keyed to you, the Server, and the persona. These power `/stats`.

### 2.2) About Your Server
- **Server configuration:** persona attributes, sample dialogues, trigger words, provider and model selections, channel and role permissions, quotas, timezone, and feature toggles.
- **Server memories:** facts taught to TomoriBot for the whole Server. These may describe members, including members who did not write them.
- **Emoji and sticker metadata:** Discord IDs, names, descriptions, and format flags. Image files themselves are not stored.
- **Reminders:** the reminder text, the target user's Discord ID and nickname, the channel, the schedule, and any recurrence setting.
- **Short-term memory summaries:** when short-term memory is enabled, TomoriBot writes short summaries derived from recent conversation into the database so it can stay contextual between Triggers. These are deleted after a period of inactivity (90 days by default).
- **Integration links:** Matrix room and channel links, and the URLs, discovered tool names, and encrypted authentication tokens for any MCP servers a manager connects.

### 2.3) Credentials
- **Provider API keys** you choose to store, at Server level or personally.
- **Custom endpoint definitions,** including the endpoint URL and any bearer token.

All credentials are encrypted at rest.

### 2.4) Content You Upload
- **Documents:** the full extracted text of files uploaded to a Server's knowledge base, along with the file name, media type, size, and search embeddings generated from that text.
- **Persona images:** avatars, sprites, and character reference images, stored in object storage so personas can render consistently.
- **Voice samples:** audio samples and their reference transcripts, when voice cloning is configured.

### 2.5) Operational Records
- **Error logs:** interaction IDs, user and Server IDs, command names, error types, and stack traces. Message content and conversations are not logged. Kept for 90 days.
- **Performance metrics:** timing and resource samples used to keep the service healthy. Kept for 30 days.
- **Persona message mappings:** Discord message and channel IDs linking a sent message to the persona sprite it used, so TomoriBot can update or clean up its own messages. Kept for 30 days.

## 3) What We Do Not Store

The following is read while TomoriBot is preparing a response and is not written to our database:

- **Discord messages:** recent channel messages (typically the last 80) are read in memory to build context and sent to the configured Provider. They are discarded once the response is generated. Summaries may be retained separately if short-term memory is enabled, as described in Section 2.2.
- **Attachments and media:** images, video, and profile pictures analyzed during a Trigger are processed in memory and discarded.
- **Server and channel metadata:** Server names, descriptions, channel names, and topics are read fresh each time.
- **Presence information:** your current activity or status, when available.
- **Emoji and sticker images:** fetched from Discord each time they are used.

## 4) What We Send to Third Parties

- **AI providers:** your prompt, the recent context described above, persona data, and any attachments are sent to the Provider configured for that Server or for you, such as Google, OpenRouter, NovelAI, or a custom endpoint. This covers text, vision, embedding, image, video, speech, and transcription requests. Their terms, privacy policies, safety filters, and retention rules apply to that content, and we do not control them.
- **Search providers:** if web search is enabled, search queries and relevant context go to the configured search provider.
- **Matrix:** if a Matrix bridge is configured for a channel, messages cross between Discord and the linked Matrix room.

We do not sell personal data. We share it only as needed to operate the features you invoke, or where the law requires it.

## 5) How Long We Keep It

| Data | Retention |
|---|---|
| Short-term memory summaries | 90 days after last activity (default) |
| Error logs | 90 days |
| Performance metrics | 30 days |
| Persona message mappings | 30 days |
| Everything else in Section 2 | Until deleted through the commands in Section 6 |

When TomoriBot is removed from a Server, that Server's data is kept so the configuration survives a re-invitation. A manager who wants it gone should run `/nuke` before removing the bot.

## 6) Your Controls

| What you want | Command |
|---|---|
| Stop TomoriBot saving personal memories about you | `/personal config` |
| Review or remove individual personal memories | `/personal memories` |
| Review or remove Server memories and documents | `/memories` |
| Take a copy of your personal data | `/export personal config`, `/export personal memories` |
| Take a copy of a Server's data | `/export config`, `/export memories` |
| Reset your personal settings to defaults | `/reset personal config` |
| Erase everything we store about you, in every Server | `/personal nuke` |
| Erase a Server's data (managers only) | `/nuke` |

`/personal nuke` deletes your personal memories, personalization and naming settings, spotlights, your saved provider keys and personal endpoints, your registered models, your usage counters, the persona conditioning you contributed, and any reminder you created or that was set for you. Two consequences are worth knowing before you run it:

- Persona conditioning you contributed through `/reward` and `/punish` shapes how a persona behaves for everyone in that Server, so removing it changes shared behavior.
- Server memories you taught and documents you uploaded belong to the Server and are kept, with your authorship removed. If one of them describes you, ask a manager to remove it with `/memories`.

Your opt-out settings deliberately survive erasure, so erasing your data does not quietly re-enable collection about you.

For anything these commands cannot reach, contact us using Section 9 and we will handle it manually.

## 7) Security

- Provider API keys, bearer tokens, and MCP credentials are encrypted at rest.
- Database connections use TLS with certificate verification.
- Database access is limited to the bot's runtime and to operators with infrastructure access.

No system is completely secure. Please do not give TomoriBot highly sensitive or regulated information.

## 8) Children's Data

TomoriBot is not directed to anyone below the minimum age Discord requires in their country, which is at least 13. We do not knowingly collect data from users below that age. If you believe we hold data about someone under the applicable minimum age, contact us using Section 9 and we will delete it.

## 9) Contact

For privacy questions or requests beyond the commands above, email `bredrumb@gmail.com` or reach us in the [official TomoriBot support Discord server](https://discord.gg/bjCfHm9QsB). Please use email or a direct message rather than a public GitHub issue for anything involving your personal data.

## 10) Changes

We may update this Privacy Policy, and the "Last updated" date above will change when we do. Material changes are announced through the support Discord or the project repository.

## 11) International Users and GDPR

- TomoriBot's hosted service is available globally, and data is stored on infrastructure operated by our hosting provider.
- If you are in the European Economic Area, the UK, or Switzerland, you have rights under the GDPR to access, rectify, erase, restrict, and port your personal data, and to object to processing.
- The controls in Section 6 cover access, portability, and erasure directly. For anything else, contact us using Section 9.
- We rely on the following legal bases: performance of a contract for operating the features you invoke; legitimate interest for security, abuse prevention, and service stability; and consent for optional features you switch on, such as personal memories, short-term memory, and web search. You can withdraw that consent by turning the feature off.
