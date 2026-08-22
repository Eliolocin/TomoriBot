export type PanelReadStatus = "fresh" | "stale" | "unavailable";
export type PanelReceiptTone = "success" | "warning" | "error" | "info";

export interface PanelReceipt {
  tone: PanelReceiptTone;
  heading: string;
  detail: string;
  metadata?: string;
}

export interface ResolvedCollectionSelection<T> {
  item: T | null;
  itemIndex: number;
  rangeIndex: number;
  rangeCount: number;
  visibleItems: T[];
}

export interface CollectionPanelViewState<T> {
  items: T[];
  readStatus: PanelReadStatus;
  selection: ResolvedCollectionSelection<T>;
  receipt?: PanelReceipt;
}

export interface ResolvedRangeSelection<T> {
  rangeIndex: number;
  rangeCount: number;
  totalCount: number;
  visibleItems: T[];
}

export type PanelActionResult<T> =
  | { status: "success"; value: T; receipt: PanelReceipt }
  | { status: "unchanged"; value: T; receipt: PanelReceipt }
  | { status: "failed"; receipt: PanelReceipt };
