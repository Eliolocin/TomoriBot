---
title: "Adding a Built-In Tool"
---

This guide walks through adding a new built-in tool that the LLM can call during tool-loop execution.

## Steps

1. Create a file in `src/tools/functionCalls/`.

2. Export a class that extends `BaseTool`.

3. Define the required members:
   - `name` — tool identifier (must be unique across all registered tools)
   - `description` — what the tool does (shown to the LLM in the context)
   - `category` — grouping label for logging and UI
   - `parameters` — JSON Schema describing tool arguments
   - `execute()` — async method that runs the tool and returns a result string

4. Define optional members when needed:
   - `requiresFeatureFlag` — gate the tool behind a server config toggle
   - `requiresPermissions` — restrict to certain Discord permission levels
   - `requiresFollowUp` — signal that the tool result needs a follow-up generation turn

5. Forward `context.abortSignal` to every HTTP call the tool makes:
   - Pass `signal: context.abortSignal` to raw `fetch` calls.
   - Pass `externalSignal: context.abortSignal` to `safeDownload` calls.
   - Pass it through any helper option that accepts an `AbortSignal`.

   This gives `/kill` true HTTP-level cancellation. Without it, the underlying request keeps running even after the turn is stopped.

6. The tool is auto-discovered by `toolInitializer.ts` at startup — no manual registration is needed.

## Notes on Feature-Gated Tools

If the tool should be toggled by a server config field, see
[`docs/guides/adding-feature-flag-tool.md`](/contributing/adding-feature-flag-tool/) for the full flag-mapping steps.

## Quality Gate

```bash
bun run check    # TypeScript strict mode
bun run lint     # Biome formatting
```

Then test the tool by prompting the bot in a way that triggers it and checking the tool-loop logs.

## Related Docs

- [`docs/en/architecture/pipelines/tool-loop/`](../pipelines/tool-loop/) — how tools are dispatched and results assembled
- [`docs/guides/adding-feature-flag-tool.md`](/contributing/adding-feature-flag-tool/) — gating a tool behind a feature flag
