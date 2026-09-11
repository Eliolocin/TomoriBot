---
title: "LTM Sub-Pipeline"
sidebar:
  label: "Overview"
  groupLabel: "LTM"
  order: 520
---

Handles persistent, database-backed memory writes initiated by the LLM via
tool calls during the tool-loop. Two tools cover the full CRUD surface:

| Stage | File | Tool name | What it does |
|---|---|---|---|
| `01-ltm-create.md` | `MemoryTool` | `create_long_term_memory` | Inserts a new server or personal memory record |
| `02-ltm-update-delete.md` | `UpdateLongTermMemoryTool` | `update_long_term_memory` | Replaces or deletes an existing memory by its `ID:N` |

## Key design facts

- **Feature-flagged** — both tools require `self_teaching_enabled = true` in
  `TomoriState.config`. When disabled, the tool returns a user-reportable
  error without writing to the DB.
- **Persona-lineage scoping** — all DB writes use `persona_lineage_id`, not
  `persona_id`, so memories are shared across all personas of the same
  character lineage (different server instances of the same persona still
  see each other's memories).
- **Cache invalidation on success** — every successful write immediately
  invalidates the relevant TomoriState or user cache so the next
  context-build reads fresh DB state.
- **Dual scope** — memories are either `server_wide` (stored in
  `server_memories`, keyed by `server_id + persona_lineage_id`) or
  `target_user` (stored in `personal_memories`, keyed by
  `user_id + persona_lineage_id`).
- **Template placeholders** — content must use `{user}` and `{bot}` tokens
  instead of hardcoded names. Both tools strip unknown brace-wrapped tokens
  (e.g. `{Obonya}`) via `sanitizeUnknownTemplatePlaceholders()` before the
  DB write.

## Cross-references

- Intent gate that routes toward LTM tools: → [memory pipeline README](../README)
- Tool-loop that executes these tools: → [tool-loop Stage 02 `executeToolCall`](../../tool-loop/02-execute-tool-call)
- Read side (server memories): → [context-build server-memory stage](../../context-build/02-native-assembly/03-server-memories)
- Read side (personal memories): → [context-build personal-memory stage](../../context-build/02-native-assembly/07-personal-memories)
- Memory ID formatting used in context: → `src/utils/memory/memoryId.ts` (`formatMemoryWithId`)
