import type { ResolvedCollectionSelection, ResolvedRangeSelection } from "@/types/discord/panel";

export const COLLECTION_PANEL_RANGE_SIZE = 25;
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

export function resolveCollectionSelection<T>(
  items: readonly T[],
  getId: (item: T) => number,
  requestedId?: number | null,
  requestedRange = 0,
  removedIndex?: number,
): ResolvedCollectionSelection<T> {
  const rangeCount = Math.max(1, Math.ceil(items.length / COLLECTION_PANEL_RANGE_SIZE));
  let itemIndex = requestedId ? items.findIndex((item) => getId(item) === requestedId) : -1;

  if (itemIndex < 0 && items.length > 0) {
    if (removedIndex !== undefined) {
      itemIndex = Math.min(Math.max(removedIndex, 0), items.length - 1);
    } else {
      const clampedRange = Math.min(Math.max(requestedRange, 0), rangeCount - 1);
      itemIndex = clampedRange * COLLECTION_PANEL_RANGE_SIZE;
    }
  }

  const rangeIndex =
    itemIndex >= 0
      ? Math.floor(itemIndex / COLLECTION_PANEL_RANGE_SIZE)
      : Math.min(Math.max(requestedRange, 0), rangeCount - 1);
  const start = rangeIndex * COLLECTION_PANEL_RANGE_SIZE;

  return {
    item: itemIndex >= 0 ? (items[itemIndex] ?? null) : null,
    itemIndex,
    rangeIndex,
    rangeCount,
    visibleItems: items.slice(start, start + COLLECTION_PANEL_RANGE_SIZE),
  };
}

export function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1");
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
