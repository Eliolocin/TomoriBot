import type { ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";

/**
 * Nodes one toggle modal presents, and node ranges one selector offers. The route handler that
 * slices nodes and the panel that labels the ranges must divide by the same size, or a range option
 * names a span the modal does not open.
 */
export const MAX_NODES_PER_MODAL_PAGE = 50;
export const NODE_RANGE_OPTIONS_PER_PAGE = 25;

export type StPresetsPanelRoute =
  | { action: "select" | "retry" | "none" | "disable" | "add-open"; locale: string }
  | { action: "range"; locale: string; rangeIndex: number }
  | { action: "add-submit"; locale: string; nonce: string }
  | { action: "nodes-open" | "delete-prompt" | "delete-cancel" | "delete-confirm"; locale: string; presetId: number }
  | { action: "nodes-range"; locale: string; presetId: number; rangeIndex: number }
  | { action: "nodes-range-select"; locale: string; presetId: number }
  | { action: "nodes-page"; locale: string; presetId: number; chooserPage: number }
  | { action: "nodes-submit"; locale: string; presetId: number; nonce: string };

export type StPresetsAction = StPresetsPanelRoute["action"];

/**
 * Host-neutral route input used by the panel renderer. Hosts provide the namespace, version, and
 * codec implementation while the panel keeps one semantic action set for every surface.
 */
export type StPresetsPanelRouteInput = StPresetsPanelRoute;

export interface StPresetsPanelRouteAdapter {
  namespace: string;
  version: string;
  buildRouteId(route: StPresetsPanelRouteInput): string;
  buildRouteSegments(route: StPresetsPanelRouteInput): string[];
  parseRoute(route: ParsedInteractionRoute): StPresetsPanelRouteInput | null;
}
