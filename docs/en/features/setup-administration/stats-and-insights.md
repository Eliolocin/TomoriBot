---
title: "Stats & Insights"
sidebar:
  order: 4
---

TomoriBot tracks usage so you can see who talks to whom, which personas and models get used,
and what tools fire — then turn it into a shareable infographic.

## Text Dashboards

Three commands open an interactive, tabbed dashboard (Overview, Personas, Models & Cost,
Tools & Commands, Expression, Favorite People, Leaderboard):

- `/stats personal` — your own usage.
- `/stats persona` — a persona's usage on this server.
- `/stats server` — server-wide usage.

Most support a **timeframe** window, and personal stats can be scoped to this server or
across all servers.

:::note
**Token counts** are the provider's own reported usage when available (a character-based
estimate is used only for providers that report none). **Cost** prices those tokens at the
model catalog's list rates, so it may differ from your actual bill (prompt caching, discounts,
free-tier quotas, etc.).
:::

## Shareable Infographic Cards

`/stats generate` renders a polished image card you can drop into chat:

- **Personal Wrapped** — your personal activity, Spotify-Wrapped style.
- **Persona Affinity** — a persona's stats on this server.
- **Server Leaderboard** — server-wide standings.

Fully-private users (`/personal config`) can't generate personal cards.

For how the cards are composed and rendered, see the architecture reference on the
[stats infographic subsystem](/architecture/subsystems/stats-infographic/).
