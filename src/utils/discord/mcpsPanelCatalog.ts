/**
 * Host-neutral route input used by the MCP panel renderer. Hosts provide the namespace,
 * version, and codec implementation while the panel keeps one bounded action set for every surface.
 */
export type McpsPanelRouteInput =
  | { action: "range"; locale: string; rangeIndex: number }
  | { action: "retry" | "refresh"; locale: string; selectedId: number | "none" }
  | { action: "add-open" | "add-type"; locale: string }
  | { action: "add-submit"; locale: string; nonce: string }
  | { action: "set-enabled"; locale: string; entityId: number; enabled: boolean }
  | { action: "remove-prompt" | "remove-cancel" | "remove-confirm"; locale: string; entityId: number };

export interface McpsPanelRouteAdapter {
  namespace: string;
  version: string;
  buildRouteId(route: McpsPanelRouteInput): string;
  buildRangeSegments(locale: string, rangeIndex: number): string[];
}
