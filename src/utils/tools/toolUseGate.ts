import type { TomoriState } from "@/types/db/schema";

/**
 * Whether tools may be attached to a request, given whatever the provider believes the model
 * supports.
 *
 * Two pipeline features disable tools by narrowing `llm.has_tools` in place before a provider
 * sees the state: the server-wide Tool Use master toggle (`tomoriStateCache`) and Deliberate Tool
 * Mode's kill switch (`applyDeliberateToolKillSwitch`). That narrowing is the only signal either
 * feature emits, so a provider that re-derives the flag from a live capability catalog reverses a
 * decision it cannot see it is reversing. Every gate routes through here so a capability override
 * can only withdraw tools, never restore them.
 *
 * A narrowed flag is therefore indistinguishable from a stale `has_tools=false` catalog row, and
 * this resolves that ambiguity in favor of the user's switch: a genuinely mis-seeded model stays
 * toolless until its catalog row is corrected, rather than a disabled workspace silently regaining
 * tools. `tool_use_enabled` is re-read directly because a `TomoriState` assembled outside the
 * persona cache never passes through the forging site at all.
 *
 * @param providerReportedHasTools - The provider's own capability verdict, which for a provider
 *   with no capability override is just `state.llm.has_tools`.
 */
export function resolveToolsEnabled(state: TomoriState, providerReportedHasTools: boolean): boolean {
  if (state.config.tool_use_enabled === false) return false;
  if (!state.llm.has_tools) return false;
  return providerReportedHasTools;
}
