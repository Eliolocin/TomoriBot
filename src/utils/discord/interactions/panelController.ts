import type { ResolvedRangeSelection } from "@/types/discord/panel";

export const MODERATION_PANEL_RANGE_SIZE = 10;

export interface PanelInteractionStart<T> {
  acknowledge(): Promise<unknown>;
  authorize(): boolean | Promise<boolean>;
  onDenied(): Promise<unknown>;
  load(): Promise<T | null>;
  onMissing(): Promise<unknown>;
}

export async function beginPanelInteraction<T>(steps: PanelInteractionStart<T>): Promise<T | null> {
  await steps.acknowledge();
  if (!(await steps.authorize())) {
    await steps.onDenied();
    return null;
  }
  const state = await steps.load();
  if (!state) {
    await steps.onMissing();
    return null;
  }
  return state;
}

export async function performPanelAction<TResult, TState>(
  action: () => Promise<TResult>,
  reload: () => Promise<TState | null>,
): Promise<{ result: TResult; state: TState | null }> {
  const result = await action();
  return { result, state: await reload() };
}

export function resolveRangeSelection<T>(
  items: readonly T[],
  requestedRange = 0,
  rangeSize = MODERATION_PANEL_RANGE_SIZE,
): ResolvedRangeSelection<T> {
  const rangeCount = Math.max(1, Math.ceil(items.length / rangeSize));
  const rangeIndex = Math.min(Math.max(requestedRange, 0), rangeCount - 1);
  const start = rangeIndex * rangeSize;

  return {
    rangeIndex,
    rangeCount,
    totalCount: items.length,
    visibleItems: items.slice(start, start + rangeSize),
  };
}
