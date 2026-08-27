---
title: "Wiki"
sidebar:
  hidden: true
---

<!-- Hidden top-level folder (no navbar entry): sidebar.hidden hides the whole wiki
     group from main navigation. Reachable only via in-page hyperlinks. Keeps
     refactor-record.md and threat-models.md. See docs-site-restructure.md decision 7. -->

Internal reference notes, reachable only via links from other pages.

- [`refactor-record`](./refactor-record) — historical plugin-architecture-prerequisite refactor record
- [`threat-models`](./threat-models) — security threat models

Cloud deployment pages live under `cloud/<provider>/` on the `release` branch and are absent from
`main`. They name real production resources on purpose, because substituting placeholders in a
runbook makes it wrong, and `wiki/` is `noindex` so they stay out of search results.
