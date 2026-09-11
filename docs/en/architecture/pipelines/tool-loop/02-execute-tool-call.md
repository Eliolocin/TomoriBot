---
title: "02: Execute Tool Call"
---

Validate, gate, dispatch, and record one tool call from the provider.

**File:** `src/utils/chat/toolLoop.ts:237-475`

## Mission

Given a `function_call` stream result, run the named tool and return a
discriminated outcome that tells the outer loop whether to restart (context was
enriched), abort (fatal condition), or append a history entry and continue.

The stage enforces the deliberate-tool-mode allowlist before reaching the
registry, retains the affordance window on success, emits a hidden trigger
notice when a deliberate-mode trigger matched, and delegates context-enrichment
restarts to
[stage 03 — `handleEnhancedContextRestart`](03-enhanced-context-restart.md).

## Input

- `params: ToolLoopParams` — full loop context.
- `streamResult: StreamResult` — the `function_call` result from stage 01;
  `streamResult.data` carries the raw function-call payload.
- `iteration: number` — current loop iteration index (used to set
  `showKillHint` in `ToolContext` once the soft-warn threshold is reached).

## Output

A discriminated union:

```ts
| { kind: "restart" }
| { kind: "abort"; status: GenerationTurnResult["status"] }
| {
    kind: "history";
    functionName: string;
    success: boolean;
    endTurn: boolean;
    stickerSelection?: Sticker | null;
    historyEntry: ToolHistoryEntry;
  }
```

- **`"restart"`** — `handleEnhancedContextRestart` consumed the result; the
  outer loop does `continue` without pushing to `functionHistory`.
- **`"abort"`** — a fatal condition was hit (malformed call, stop request,
  consecutive error cap); outer loop calls `buildResult(status)` immediately.
- **`"history"`** — normal outcome; outer loop pushes `historyEntry` to
  `functionHistory` and checks `endTurn` / `shouldEndAfterPreToolText`.

## Side effects

Steps in execution order:

1. **Validate function-call data** — if `streamResult.data` is missing or has
   no `name`, returns `{kind: "abort", status: "error"}` and logs the
   malformed result.

2. **Stop-request check** — a regular stop returns
   `{kind: "abort", status: "stopped_by_user"}` before any tool runs. A stale
   follow-up interrupt is different: the follow-up is already queued, so the
   interrupt is cleared and the active tool chain continues. The same
   distinction is checked again after tool execution.

3. **Build `ToolContext`** — assembles the context object passed to every tool.
   Key fields derived from `ChatTurnContext`:
   - `channel`, `client`, `message`, `userId`, `guildId`
   - `tomoriState`, `locale`, `provider` (provider name string)
   - `streamContext` (the live `StreamingContext`)
   - `webhook`, `personaUsername`, `personaAvatarUrl` (from `responseTarget`)
   - `activePersonaId`, `isUserImpersonation`, `impersonatedUserId`
   - `suppressProgressNotices` — set when `shouldSurfaceUserErrors` is false
   - `contextItems`, `messageIdMap` — live references (tools may read these)
   - `showKillHint` — true once `iteration >= SOFT_WARN_ITERATION_THRESHOLD`
   - `abortSignal` — the turn-level `AbortSignal` from `getChannelTurnAbortSignal`.
     Tools that forward this to their `fetch` calls get true HTTP-level
     cancellation when `/kill` fires.

4. **Deliberate-tool-mode allowlist gate** — if
   `context.deliberateToolModeActive` is true and `deliberateToolAllowedNames`
   is set and the requested tool is not in the allowed set, the tool is *not*
   dispatched. A synthetic failure response is produced instead:
   ```
   { status: "blocked_by_deliberate_tool_mode", functionName, allowedToolNames }
   ```
   This is model-visible (returned as a tool response) so the model can adapt
   its next turn without a user-facing error.

5. **Truncated-argument refusal**: when the adapter recovered `functionCall.args` from an
   incomplete provider payload it sets `FunctionCall.argumentsTruncated`. The tool is *not*
   dispatched. A recovered payload holds only the keys that arrived whole, and for a tool whose
   arguments replace stored state (the short-term memory category map, for example) writing
   that subset silently drops everything else. No tool's semantics survive a partial call, so
   the stage returns `{kind: "history"}` with a synthetic failure response:
   ```
   { status: "tool_execution_failed", tool_name, reason }
   ```
   The `reason` names the cause and the outcome, so the model retries with a complete call
   instead of assuming the update landed. The recovered subset is cleared from
   `functionCall.args` before the history entry is built, so the replayed assistant turn does
   not show the model arguments it never finished writing. The visit counts toward
   `MAX_CONSECUTIVE_TOOL_ERRORS`, which is what bounds a model that keeps reissuing a truncated
   call. See [stage 03 of the provider pipeline](../provider/03-chunk-normalization.md) for the
   repair itself.

6. **`ToolRegistry.executeTool` with timeout + kill race** — actual dispatch,
   wrapped in a `Promise.race` against two cancellation promises:

   Before dispatch, the registry runs two separate availability gates whose
   rejection text differs because `error` is fed back to the model:
   - `tool.isAvailableFor(provider)` — static provider support. Rejection is
     logged at `error` level and reported as *not available for provider X*.
   - `tool.isAvailableForContext(provider, context)` — live turn state
     (per-turn dedup flags, model capabilities, configured server slots).
     Rejection is logged at `warn` level and reported as *not available for
     the current turn*, with an instruction not to retry it this turn. It must
     never be reported as a provider capability gap.

   - **Timeout promise** — resolves after `TOOL_EXECUTION_TIMEOUT_MS` (default
     5 min) with a synthetic `{ success: false, error: "timed out" }` result.
     The timer is fresh per tool call, so a chain of fast tools is unaffected.
   - **Kill promise** — resolves immediately if the turn-level `AbortSignal`
     fires (i.e., `/kill` was used while the tool was running).

   After the race, if `StreamOrchestrator.hasStopRequest` is true (kill was
   requested), the stage returns `{kind: "abort", status: "stopped_by_user"}`
   immediately — the failed result is never fed back to the model. For a plain
   timeout (no kill), the `{ success: false }` result is returned normally so
   the model can handle it gracefully.

   Returns `ToolResult`:
   ```ts
   { success: boolean; data?: unknown; error?: string;
     message?: string; endTurn?: boolean; imageMetadata?: … }
   ```

7. **`retainSuccessfulToolAffordance`** — on success, extends the deliberate-
   tool-mode affordance window for this channel so short follow-up turns
   ("do it again") keep the tool exposed for `deliberateToolContextTurns`
   additional turns. No-op when deliberate-tool-mode is inactive.

8. **Deliberate-trigger hidden notice** — if `deliberateToolTriggerMatchByToolName`
   has an entry for this tool and mode is active, sends a hidden embed via
   `routeHiddenToolNotice` (thought-log only; not shown to users) describing
   which trigger phrase caused deliberate mode to expose the tool.

9. **Enhanced-context restart check** — calls
   [`handleEnhancedContextRestart`](03-enhanced-context-restart.md)
   (`toolLoop.ts:537-568`) with `toolResult.data`. If it returns `true`,
   returns `{kind: "restart"}`.

10. **Reactivate one-shot STM guard** — a successful
   `update_short_term_memory` sets
   `streamingContext.disableShortTermMemoryUpdate = true`, so the tool's own
   availability and execution guards reject a second update in this turn.

11. **Capture sticker selection** — `select_sticker_for_response` maps a
    successful `sticker_id` through the guild sticker cache and returns it as
    `stickerSelection`. Any other result from that tool returns `null`, so the
    latest sticker call wins and a miss clears an earlier selection.

12. **Build function response** — wraps `toolResult.data` (success) or a
   standardized error object (failure) into the `functionResponse` shape:
   ```ts
   { functionResponse: { name, response: { result: … } } }
   ```

13. **Preserve pre-tool text** — `buildPreToolCallTextParts` converts
    `streamResult.accumulatedText` (the visible text this stream iteration
    already delivered to Discord before the function call) into
    `preToolCallTextParts` on the history entry. Whitespace-only text yields
    `undefined`. Provider adapters merge these parts into the synthetic
    assistant tool-call turn on the follow-up call, so the model knows it
    already said that text and does not repeat it. Each iteration's entry
    carries only that iteration's text (stream state is fresh per
    `streamOnce` call). After the history entry is accepted, the outer loop
    clears the same text from `accumulatedModelParts`; otherwise OpenAI-style
    providers would also append it as a trailing assistant prefill.

14. **Return `{kind: "history"}`** with `historyEntry` (the paired
    `functionCall` + `functionResponse` + optional `imageMetadata` +
    optional `preToolCallTextParts`).

## Invariants

After this stage runs:

- A tool was dispatched at most once per call (the deliberate-mode synthetic
  failure and the truncated-argument refusal both short-circuit before
  `executeTool`).
- A call whose provider payload was truncated is never dispatched, and its
  recovered argument subset is never replayed to the model as the call it made.
- If `kind === "restart"` is returned, `functionHistory` will **not** receive
  an entry for this tool call — the restart mechanism replaces the tool
  response with enriched context.
- `consecutiveToolErrors` in the outer loop is reset to `0` on `success ===
  true` or `kind === "restart"`.
- If `/kill` fired during tool execution, `kind === "abort"` is returned
  immediately — no history entry is added and the model never sees the failed
  tool result.
- A tool timeout (no `/kill`) returns `kind === "history"` with
  `success: false` — the model is informed and can decide how to proceed.
- A queued follow-up never converts an in-progress tool chain into
  `stopped_by_user`; only a genuine stop does.
- After a successful STM update, the live streaming context prevents another
  STM update in the same turn.
- Tool execution duration is logged at `INFO` level
  (`"Function call completed: ${name} (${ms}ms)"`).

## Extension points

| Surface | Plugin-relevance |
|---|---|
| `ToolRegistry.executeTool` | The tool registration contract is the seam — A plugin adding a new tool registers it with the `ToolRegistry`. → plugin plan candidate |
| Deliberate-tool-mode allowlist (`deliberateToolAllowedNames`) | Internal — controlled by `turnPlanner`; tool plugins declare their trigger patterns, not the gating logic |
| `ToolContext.abortSignal` | Tools that forward this to their `fetch` calls gain free cancellation on `/kill`. New tools should always thread it through. |
| `ToolContext` shape | The context contract — tools depend on its fields; adding a field here widens the contract for all tools |
| `retainSuccessfulToolAffordance` | Internal — deliberate-tool-mode retention window; operational parameter, not plugin-relevant |
| `handleEnhancedContextRestart` | See [stage 03](03-enhanced-context-restart.md) — the `context_restart_*` namespace is the seam |

## Configuration

| Env var | Default | Minimum | Purpose |
|---|---|---|---|
| `TOOL_EXECUTION_TIMEOUT_MS` | `300000` (5 min) | `10000` (10 s) | Per-tool execution timeout; resets fresh for every tool call in a chain |

## Related docs

- Tool registry: → [`README.md`](README.md)
- Enhanced-context restart: → [stage 03 — `handleEnhancedContextRestart`](03-enhanced-context-restart.md)
- Deliberate tool mode: → `src/utils/tools/deliberateToolMode.ts`
- Tool-loop coordinator: → [`README.md`](README.md)
