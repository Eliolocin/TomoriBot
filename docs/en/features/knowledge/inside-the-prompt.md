---
title: "Inside The Prompt"
sidebar:
  order: 2
aiGenerated: false
---

Every time you trigger TomoriBot, the following is assembled and sent to your configured text
model as the main prompt/context, in this order:

| Block | Optional? | Commands | What it is |
|---|---|---|---|
| [**System prompt**](/features/chatting-personality/behavior-tweaking/#system-prompt) | | `/config` > Engine > General | Basic instructions at the topmost of context. |

> **Default system prompt text** (used only while no server system prompt is set):
>
> *"You are {bot}. {bot} makes sure to respond short and concisely by default. {bot} only makes lengthy responses if the situation warrants it.
>
> {{if tool:create_long_term_memory}}{bot} proactively uses the available {memory_tool} whenever someone shares a detail or {bot} notices one in the conversation that is actually worth remembering, such as a preference, an interest, or an important fact, preferring to remember things even if it is minor as long as it's not a duplicate of what {bot} already knows. {{/if}}{{if tool:update_long_term_memory}}{bot} uses {memory_update_tool} instead when new information changes or adds onto something {bot} already remembers, rather than saving a duplicate.{{/if}}
>
> {{if tool:review_capabilities}}When someone asks what {bot} can do or why something is unavailable, {bot} checks {capabilities_tool} before answering. {{/if}}{{if tool_family:url_fetch}}When more detail is needed, {bot} uses {url_fetch_tool} on `https://docs.tomoribot.app/llms.txt` for information.{{/if}}"*

| Block | Optional? | Command | What it is |
|---|---|---|---|
| **Channel prompt (append)** | *(Optional)* | `/config` > Channels > Channel Overrides | Varies per-channel, layered in right after the system prompt. The same page's *replace* mode takes over the system prompt slot above instead of adding a new one. |
| **Persona prompt** | *(Optional)* | `/config` > Persona > Advanced | A prompt written specifically for the active persona, separate from the system prompt.|
| [**Persona attributes**](/features/chatting-personality/multiple-personas/#attributes) | | `/config` > Persona > Identity & Personality | The active persona's personality traits and speech patterns. |
| **Server info** | | *(none, from Discord)* | The server name, description, and the channel she's in, pulled from Discord itself. |
| [**Persona-user blocks**](/features/capabilities/tools-and-extensions/#built-in-tools) | *(Optional)* | `/moderation` to review/clear; gated by `/config` > Permissions (User Blocking) | Active mute/block restrictions this persona holds against specific users. |
| [**Server memories**](/features/knowledge/memory/#personal-vs-server-memories) | | `/memories` | The long-term facts saved for this server. |
| [**Server emojis**](/features/chatting-personality/behavior-tweaking/#capabilities-what-shes-allowed-to-do) | *(Optional)* | `/config` > Permissions (Emoji Usage) (toggle only), initialize with `/expressions initialize` | The custom emojis present in the server.|
| [**Server stickers**](/features/chatting-personality/behavior-tweaking/#capabilities-what-shes-allowed-to-do) | *(Optional)* | `/config` > Permissions (Sticker Usage) (toggle only), initialize with `/expressions initialize` | The custom stickers present in the server. |
| [**Persona sprites**](/features/chatting-personality/multiple-personas/#sprites-emotion-avatars) | *(Optional)* | `/config` > Persona > Sprites | Named expression sprites configured for the persona, if it has any. |
| [**Conversation Participants**](/features/knowledge/memory/#personal-vs-server-memories) | *(Optional)* | `/personal memories` (gated by `/config` > Permissions (Personalization)) | The people in the conversation, their nicknames and mention handles, and the personal memories saved about each of them. Loaded when the person owns a message in context, or if their name/alias get mentioned. Also carries the current channel and local time as a footer, using `/config` > Engine > General. |
| [**Short-term memory**](/features/knowledge/memory/#short-term-memory-stm) | | `/config` > Persona > Memories; `/memories` to clear entries; gated by `/config` > Permissions (Short-Term Memory) | Contains summaries and recent messages of different channels |
| [**Documents**](/features/knowledge/memory/#document-knowledge-base-rag) | *(Optional)* | `/memories` | Relevant chunks pulled from the knowledge base using RAG. |
| [**Conditioning**](/features/knowledge/memory/#conditioning) | *(Optional)* | `/reward <feed\|headpat\|hug\|kiss\|tickle>`, `/punish <bite\|bonk\|pinch\|spank\|squeeze>`, managed via `/conditioning manage` | Accumulated behavioral nudges for this persona in this server. |
| [**Sample dialogues**](/features/chatting-personality/multiple-personas/#sample-dialogues) | *(Optional)* | `/config` > Persona > Identity & Personality | Examples of how this persona talks, if any are configured. |
| [**Recent messages**](/features/chatting-personality/behavior-tweaking/#generation-tuning) | | `/config` > Engine > General | The actual conversation, up to this many messages (default 80). Your context note and any reunion note are injected inline inside this block, at a configurable depth, rather than as a separate block of their own. |

Rows marked *(Optional)* contribute nothing (and cost no tokens) when there's nothing to say, e.g. no documents matched, or the server has no custom emojis.

Recent messages are the largest and most fragile part, it is a window that slides forward as people talk. Everything above them is rebuilt from saved settings and is stable.

`/tool prompt snapshot` dumps the exact bundle for a persona to a file. It is the ground
truth for which memories are currently active, whether a document matched, and how much of
the conversation actually fit.

`/tool estimate cost` breaks the same bundle down by size, which is useful for working out
what is eating your context before you raise any limits.

### Where are Tools defined?

For every
provider TomoriBot supports natively, tool schemas are sent through the provider's own `tools`
field, so it depends upon the provider/configured inference engine.

### Why does TomoriBot forget?

This ordering explains almost every "why doesn't she remember?" question:

| What happened | Why |
|---|---|
| She forgot something from earlier today | It scrolled past the message limit. It was only ever in **Recent messages**, if Tomori does not save it as a long-term memory, then it will be forgotten once it reaches outside the message window. |
| She forgot something in another channel | **Recent messages** is per-channel. Only **Server memories**, **Conversation Participants**, and **Short-term memory** cross channels. Short-term memory remedies this by loading in recent messages from different channels, but it does not dump everything. |
| `/refresh` made her forget | Refresh cuts off **Recent messages** and clears this channel's **Short-term memory**, but shouldn't remove long-term memory. Delete the refresh embed to remove the cut-off. |
| She forgot something after a restart | **Recent messages** never survives restarts |

If you want something to survive all of the above, it has to become a **long-term memory**. See [Memory](/features/knowledge/memory/#long-term-memory).

## Tips and Tricks

- `/config` > Engine > General widens the conversation window (20-100 messages). More
  context, more tokens per reply.
- `/config` > Engine > General injects a short reminder at a chosen depth. Because it sits low
  in the bundle, close to the recent messages, she is more likely to act on it than on
  something in the system prompt. This is the best place to nudge her into saving memories
  more often.
- `/personal memories` and `/memories` write directly into **Server memories** and
  **Conversation Participants**, which is one of the guaranteed ways to make knowledge permanent in TomoriBot's context.
