export type PanelReadStatus = "fresh" | "stale" | "unavailable";
export type PanelReceiptTone = "success" | "warning" | "error" | "info";

export interface PanelReceipt {
  tone: PanelReceiptTone;
  heading: string;
  detail: string;
  metadata?: string;
  /**
   * Stable machine key naming why this receipt happened, for operator queries.
   *
   * `heading` is localized, so grouping failures by it splits one defect across locales. Call sites
   * that know their specific cause set this; the failure metric falls back to the route namespace
   * plus tone when it is absent.
   */
  reason?: string;
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
