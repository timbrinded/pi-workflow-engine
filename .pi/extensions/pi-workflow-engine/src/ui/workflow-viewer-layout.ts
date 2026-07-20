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
