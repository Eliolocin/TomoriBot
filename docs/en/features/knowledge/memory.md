---
title: "Memory"
sidebar:
  order: 1
aiGenerated: false
---

TomoriBot has a persistent memory system so she remembers facts across conversations. This
page is about *what she knows* (facts, context, documents). For *how she behaves*
(personality, tone), see [Multiple Personas](/features/chatting-personality/multiple-personas/).

## Memory Hierarchy

From most permanent to most fleeting

| Tier | What it is | How long it lasts |
|---|---|---|
| **Long-term memory (LTM)** | Saved facts about a user or a server, uploaded documents, and conditioning | Forever, until someone removes it. Survives `/tool refresh`, restarts, everything |
| **Short-term memory (STM)** | A summary she writes for a channel, plus a few recent messages | 24 hours. Can reach across channels |
| **Chat history** | The recent messages in the channel she's replying in | Only this channel, only until they scroll out of `/config message-fetch-limit` range (defaults to latest 80 messages). `/tool refresh` cuts it off immediately |

Almost everything she appears to "know" in a conversation is just recent chat history, which is why
she seems to forget a message once the conversation becomes too long. **Only long-term memory is
permanent.** STM sits in between: useful for carrying a scene across channels without
committing anything, but it still expires.

To see exactly what she is handed on any given turn, see
[Inside The Prompt](/features/knowledge/inside-the-prompt/).

## Long-Term Memory

Long-term memories are the only thing she keeps permanently. They are not affected by
`/tool refresh`, by restarts, or by moving to another channel.

### Personal vs. Server Memories

There are two kinds of long-term memory:

- **Personal memories** (`/memory personal add`): facts about an individual user, e.g.
  "Amaori loves cats", "prefers dark mode", "allergic to peanuts". These are tied to *you*
  and follow you **across every server**, but she only draws on them in conversations you're actively part of.
- **Server memories** (`/memory server add`): information relevant to the whole server,
  e.g. "Game night is every Friday at 8 PM", "no NSFW posting", "#general is for
  announcements". These stay within the server and are always in mind there.

**Memories are isolated per persona by default.** Each persona (including alters) keeps its
own separate set of personal and server memories, so different personas means she can't recall
what another persona learned. The one exception is a personal memory added with `scope: global`
on `/memory personal add`, which then applies to every persona for you specifically. Server
memories have no such option, each persona's server-memory set always stays separate, even
within the same server.

Remove them with `/memory personal remove` and `/memory server remove`. Memories persist
until you remove them.


### How Memories Get Saved

There are exactly two ways a long-term memory is created:

1. **You save it** with `/memory personal add` or `/memory server add`.
2. **She saves it herself** when she decides something is worth keeping.

When she saves one herself, she posts an embed saying she learned something. **That embed is
the confirmation.** If you tell her something and no embed appears, nothing was saved: it is
still only chat history, so she will lose it once the conversation moves on, and she will not
have it in a different channel.

If she is not saving things you want kept, you have three options, in increasing order of
force:

- Ask her directly to remember it.
- Add a nudge with `/config context-note set`, or with any of the other prompt-carrying
  commands from [Inside The Prompt](/features/knowledge/inside-the-prompt/) (`/persona prompt set`,
  `/config system-prompt set`, `/server channel-prompt`). A context note in particular sits low
  in her prompt, which makes it more likely to be acted on. Something as simple as *"It is
  encouraged to create long-term memories for information that is worth remembering"* is usually
  enough. To reference the actual save-memory tool by name without hardcoding something that can
  vary by provider, use the `{memory_tool}`
  [prompt macro](/features/capabilities/tools-and-extensions/#built-in-tools) instead, e.g.
  *"Use {memory_tool} whenever..."*.
- Save it yourself with `/memory personal add`, which is a guaranteed method.

Server admins can turn her self-saving off entirely with `/capabilities manage`.

### How Many Memories 

By default she holds up to **100 personal memories** and **100 server memories**. Self-hosters can change these with .env variables `MAX_PERSONAL_MEMORIES`, `MAX_SERVER_MEMORIES`, and
`MAX_MEMORY_LENGTH`. Raising the *length* costs far more context than raising the *count*, so
prefer more short memories over fewer long ones.

These counts are **per persona**, not per user or per server. Each persona keeps her own set,
so a server running four personas has four separate allowances. Your own global personal
memories count against every persona's personal allowance.


### Document Knowledge Base (RAG)

Server admins can give her documents to reference using RAG. Documents are chunked and stored as searchable embeddings; she automatically retrieves
  relevant content when answering.

**Requires an embedding model**, configured with `/model embedding`. See
[Providers & Models](/features/setup-administration/providers-and-models/).:

- `/memory document add`: upload a text, PDF, or Markdown file as server knowledge. The
  `scope` option picks whether it's tied to just this persona (the default) or `serverwide`
  for every persona to reference, the same persona-isolation split as personal/server memories
  above.
- `/memory history import`: extract channel history into searchable knowledge.
- `/memory document view`: browse stored documents chunk by chunk. Server admins can
  edit individual chunks, update document channel tags, or delete a single chunk without
  removing the whole document.
- Remove any stored document with `/memory document remove`. `/memory history remove` is
  a filtered shortcut that only lists documents created by `/memory history import`.

#### History Import Prompts

When importing channel history with `/memory history import`, the `prompt` option changes how TomoriBot extracts
memories:

- **Conversation** extracts standalone facts from normal chat. It resolves pronouns and uses absolute timestamps when dates or times are mentioned or can be inferred.
- **Roleplay** looks for scenes, lore, relationships, and memorable events without trying to preserve every small beat.
- **In-Character** extracts memories from the selected persona's point of view, using that persona's prompt, attributes, existing memories, and relevant documents as context.

The prompt is shown before import so you can adjust it for the channel or scene.

History imports are stored as documents, so `/memory document view` and
`/memory document remove` work on them too.

### Conditioning

`/conditioning` is a per-persona, per-server memory that steers a persona's behavior over
time. A lighter-weight nudge than a full attribute or system prompt. Use it to reinforce
how a specific character should act in a specific server.

Every `/conditioning reward` or `/conditioning punish` is tallied regardless, but it only
becomes a memory she actually acts on when you give it a `reason`, which appears like this in her prompt:

```text
## Rewarded Behaviors
Here are past things Tomori did that got rewarded for. Strive to do them again:
- [Tomori was fed by Amaori. Reason: `being extra helpful today` with `cookies`] (2 times)

## Punished Behaviors
Here are past things Tomori did that got punished for. Avoid doing them again:
- [Tomori was bonked by Amaori. Reason: `spamming pings after being told to stop`]
```

Without a `reason`, the tally is
recorded but never surfaces in her prompt. Review or clear entries with `/conditioning manage`.

## Controlling When Memories Activate

Scope narrows things before anything else does: a server memory only ever reaches prompts
in its own server, a personal memory only when that user is visible in the conversation,
and both only for the persona that owns them. Within that scope, **every memory is sent
with every prompt** by default. Tagging narrows it further, so a memory activates only on
a keyword or only in one channel. Turn it on with `/memory tagging set`.

### Keyword Tags

- Memories **without** keyword tags are always active (the default).
- Memories **with** keyword tags only activate when the keyword appears in the visible
  context.
- Use `/tool prompt snapshot` to see which memories are currently activating.

### Channel Tags

- Memories with a `#channel` tag activate only in that channel.
- Channel tags combine with keyword tags.
- If you use the document knowledge base (RAG), channel tags also apply to documents and
  extracted histories.

Run `/help memory-tagging` for the same summary in Discord.

## Short-Term Memory (STM)

TomoriBot can easily read messages from the current channel she's talking in, but STM allows her to do the following without saving an actual long-term memory:
1. Temporarily reinforce the current scenario/situation of the channel in context
2. Temporarily remember conversations from other channels/servers

**She only remembers conversations she took part in.** She updates a channel's memory when
she replies, and at no other time, so a busy channel where nobody talks to her leaves no
trace. 

STM of each channel expires after 24 hours by default and if you've opted out with `/personal privacy`, your messages never go into it at all as well.

### What she can and can't see

| Where | What that means |
|---|---|
| **In a server** | One shared memory per channel, not one per person. She isn't keeping notes on you individually. |
| **In DMs** | Yours alone. |
| **Other channels** | She can recall her recent conversations from a few other channels in the same server. |
| **Private channels** | Anything set with `/server private-channels` stays there and won't surface elsewhere. |
| **Other servers** | Never, unless you turn on `/personal stm` → `crossserver`. Even then only *your own* conversations follow you. |
| **Each persona** | Keeps her own separate memory, so switching persona switches memory. |

Each channel's memory holds the last few messages plus a short summary she writes herself
and refreshes as the conversation moves along. It fades on its own after a few quiet hours.

### Commands

| Command | What it does |
|---|---|
| `/persona stm view` | See the summary she's keeping for this channel |
| `/persona stm edit` | Correct it or write it yourself |
| `/personal stm` | Opt into cross-server recall, or wipe your own |
| `/tool refresh` | Make her forget this channel right now |
| `/server stm parameters` | How often she updates it, and how much detail she keeps |
| `/server stm categories-edit` | Swap the summary for up to 5 labeled fields (*Current scene*, *Mood*, …) |
| `/server stm prompt-edit` | Reword how she's asked to keep it |
| `/server stm manage` | Review or clear stored memories |
| `/server stm privacy-bypass` | Let private-channel memories surface elsewhere |
| `/capabilities manage` | Turn the feature on or off (stored memories are kept either way) |

Anyone can run `/persona stm view` and `/personal stm`. The rest need Manage Server.

:::tip
These STM commands are for advanced users only, it is recommended to keep the default settings, unless you want to allow her to remember you across servers with `/personal stm`
:::

---

## Privacy 
For exactly what she stores and how to export or delete it, see
[Data Handling](/features/knowledge/data-handling/) and `/legal privacy`. You can opt out of memory
entirely with `/personal privacy`.
