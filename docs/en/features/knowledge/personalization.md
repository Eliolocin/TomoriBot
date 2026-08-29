---
title: "Personalization"
sidebar:
  order: 3
---

TomoriBot can be configured for **you specifically** with the `/personal` commands — settings
that follow you across every server you share with her, independent of any server's
configuration.

## Personal Memories

Facts she remembers about you follow you between servers. Managing them (add, remove, export)
is covered on the [Memory](/features/knowledge/memory/#personal-vs-server-memories) page.

## Profile and Persona-Aware Names

`/personal config` stores three independent, optional preferences: gender identity,
pronouns, and addressing style. TomoriBot never infers one from another. The addressing style
selects a persona's masculine, feminine, or neutral naming variant, and Neutral is the
preselected default. Blank fields are cleared and omitted from prompt context. Raw profile
fields are exposed only at Minimal privacy.

`/personal config` opens a naming modal for either global or persona scope. A persona-scoped
preference follows that persona's stable lineage across servers. Nicknames inherit from the
persona preference to the global preference and then the live Discord display name. A blank
global nickname keeps following Discord, including later display-name changes. Saving a global
nickname freezes that custom value until it is cleared. A blank prefix or suffix inherits the
same way, and typed text overrides it, so `Master Sparrow-san`
can combine values from different levels without changing the underlying Discord mention
target. To drop a title a persona supplies on its own, ask the persona directly ("stop calling
me Master"); that suppresses it for that persona while leaving your other personas alone.

Server managers can configure persona defaults with `/persona naming-habits`. A standalone
address term such as `fam` is separate from the formatted name and is available only to
persona-authored prompt text. The default-on User Info Updates capability allows a persona to
apply explicit structured changes requested in conversation. Disabling it stops automatic
tool updates but does not disable `/personal config`.

`/personal config` stores only a numeric UTC offset from -12 through +14. It does not store
or infer a geographic location or IANA timezone.

## Your Own Providers

Personal providers let *your own requests* use *your own* API keys and models instead of the
server's defaults. This is bring-your-own-key (BYOK) at the individual level.

Two scopes are in play, and it's worth keeping them straight:

- **Server default**: shared credentials and catalogs in `/providers`, with routing selected through
  `/model` by members with the required server permission. It applies to everyone there.
- **Personal override**: configuration used only for your own requests. When enabled it
  overrides the server default for that capability **across every server** where you use
  TomoriBot, not just the one you set it up in.

**Setup:**

1. `/personal providers` saves a provider (your key is encrypted). This also enables your
   personal **Text** override immediately, using that provider's default text model.
2. `/personal config` allows selecting a different model for your personal text override.
   Picking a model here keeps Text enabled.
3. Return to `/personal providers` whenever you need to update credentials, manage custom
   endpoints, or add and edit personal model registrations.

Selecting a model with `/personal config` activates that capability for your requests.

Because steps 1 and 2 switch you onto a cross-server override, TomoriBot asks you to confirm
before saving whenever a capability moves from the server default to a personal one. Rotating
the key on a provider that already answers your requests skips that confirmation, since the
routing isn't changing.

Thought logs attribute those turns to you, and you can tune them with `/personal config`.
This affects your requests everywhere and never touches this server's settings. You can
also register personal custom endpoints with `/personal providers`; see
[Custom Endpoints](/features/setup-administration/providers-and-models/#custom-endpoints).

If a request fails while using your personal provider, the error's "What you can do" tips name
the personal commands that can actually fix it (`/personal providers`, `/personal config`)
rather than the server-manager ones.

:::note[BYOK-required servers]
A server can require member-provided providers with User BYOK mode
([Server Moderation](/features/setup-administration/server-moderation/#user-byok-bring-your-own-key)). When that's
on, your user-triggered messages need a personal provider before she can answer. Personal
providers apply across every server you use her in.
:::

## Other Personal Settings

- `/personal config` — change what she calls you.
- `/personal config` — your own appearance tags (booru-style), used when an
  [image generation](/features/capabilities/media-generation/image-generation/#tag-customization)
  references you. Submit an empty box to clear them.
- `/personal config` — control your visibility to her, up to **full invisibility** (opt out
  of memory features entirely).
- `/personal config` — your personal override for
  [Deliberate Trigger Mode](/features/chatting-personality/chatting-and-triggers/#deliberate-trigger-mode).
- `/personal config` — opt into cross-server short-term memory sharing;
  `/personal memories` wipes your STM.
- `/personal config` — set a reusable prompt for when she impersonates you via
  `/impersonate user`.
  
## Personal Spotlight

**Personal Spotlight: per-channel persona picks.** Spotlight lets *you* narrow which personas
you can trigger in one channel — and optionally assign one to auto-trigger for your own
messages there. It's scoped to **you + one channel** and doesn't affect anyone else.

**Set one up** with `/personal config`, choosing:

- a duration in hours (use **0** to keep it until you remove it manually),
- the target channel,
- the personas you want in your spotlight.

After choosing personas, you can optionally pick one as your **personal auto-trigger
persona** — the fallback responder for your messages in that channel. Direct triggers still
target whichever persona you explicitly call. Press Finish to skip.

**Important rules:**

- Spotlight only **narrows** access; it never expands it. The selected personas are the
  *only* ones you can trigger there.
- It still respects server-level persona limits configured through `/moderation`.
- Proxy chains are blocked: if your spotlight only includes Alice, an Alice reply can't hand
  off to Bob for your message chain.

Review or remove entries with `/personal config` (uncheck to remove; timed
spotlights expire on their own). In `/help`, choose **Behavior**, then **Personal Spotlight**, for the Discord summary.
