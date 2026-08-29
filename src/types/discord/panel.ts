export type PanelReadStatus = "fresh" | "stale" | "unavailable";
export type PanelReceiptTone = "success" | "warning" | "error" | "info";

export interface PanelReceipt {
  tone: PanelReceiptTone;
  heading: string;
  detail: string;
  metadata?: string;
}

export interface ResolvedRangeSelection<T> {
  rangeIndex: number;
  rangeCount: number;
  totalCount: number;
  visibleItems: T[];
}

export interface ChooserRange {
  rangeIndex: number;
  start: number;
  end: number;
}

export interface ResolvedRangeChooser {
  ranges: ChooserRange[];
  rangeCount: number;
  chooserPageCount: number;
  chooserPage: number;
}

export type PanelActionResult<T> =
  | { status: "success"; value: T; receipt: PanelReceipt }
  | { status: "unchanged"; value: T; receipt: PanelReceipt }
  | { status: "failed"; receipt: PanelReceipt };
