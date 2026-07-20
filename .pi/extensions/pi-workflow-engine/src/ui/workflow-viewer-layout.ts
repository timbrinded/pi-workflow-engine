import { truncateToWidth } from "@earendil-works/pi-tui";

const VIEWPORT_HEIGHT_RATIO = 0.8;
const VIEWPORT_MARGIN_ROWS = 2;

export const WORKFLOW_VIEWER_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "80%",
    minWidth: 40,
    maxHeight: "80%",
    margin: 1,
  },
} as const;

export function workflowViewerHeight(terminalRows: number): number {
  const rows = Math.max(1, terminalRows);
  const availableRows = Math.max(1, rows - VIEWPORT_MARGIN_ROWS);
  const proportionalRows = Math.floor(rows * VIEWPORT_HEIGHT_RATIO);
  return Math.min(availableRows, Math.max(3, proportionalRows));
}

export function fitWorkflowViewerRow(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "...", true);
}

export function fitWorkflowViewerRows(lines: readonly string[], height: number): string[] {
  const visible = lines.slice(0, Math.max(0, height));
  return [...visible, ...Array.from({ length: Math.max(0, height - visible.length) }, () => "")];
}

export interface WorkflowViewerViewport<T> {
  readonly visible: readonly T[];
  readonly percentage: number;
}

export function centerWorkflowViewerViewport<T>(
  rows: readonly T[],
  height: number,
  selectedIndex: number,
): WorkflowViewerViewport<T> {
  const visibleHeight = Math.max(0, Math.floor(height));
  const clampedSelection = Math.min(Math.max(0, rows.length - 1), Math.max(0, selectedIndex));
  const maxStart = Math.max(0, rows.length - visibleHeight);
  const start = Math.min(maxStart, Math.max(0, clampedSelection - Math.floor(visibleHeight / 2)));
  const visible = rows.slice(start, start + visibleHeight);
  const end = Math.min(rows.length, start + visible.length);
  const percentage = rows.length <= visibleHeight ? 100 : Math.round((end / rows.length) * 100);
  return { visible, percentage };
}
