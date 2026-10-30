import { useMemo } from "react";
import { SpeedDwellPlot } from "../plots/SpeedPlot";
import { PathPlot, type SpikeLayer } from "../plots/PathPlot";
import {
  color,
  type AnalysisData,
  type Settings,
  type Trajectory,
  type Trial,
  type ViewData,
} from "../types";
import type { DragComparison } from "../tiles/tile-gestures";
import { experimentTiming } from "./position-info";

/** Recording times, speed dwell and the path, with the hovered cell's spikes (or,
 * while dragging one tile onto another, both cells' spikes). */
export function PositionPane({
  data,
  trial,
  settings,
  trajectory,
  speedDwell,
  analysis,
  comparisonAnalysis,
  hoverCell,
  dragComparison,
  grabMode,
  onPopPlot,
  onHover,
  copyLayers,
}: {
  data: ViewData | null;
  trial: Trial | undefined;
  settings: Settings;
  trajectory: Trajectory | null;
  speedDwell: Float32Array | null;
  /** The displayed (hovered or selected) cell's analysis. */
  analysis: AnalysisData | null;
  comparisonAnalysis: AnalysisData | null;
  hoverCell: number | null;
  dragComparison: DragComparison | null;
  grabMode: boolean;
  onPopPlot: (kind: "path", x: number, y: number) => void;
  onHover: (hovered: boolean) => void;
  copyLayers: SpikeLayer[] | null;
}) {
  const timing = experimentTiming(data?.headers || {}, data?.duration || 0);
  const pathCell = dragComparison?.source ?? hoverCell;
  const primary = analysis?.cell === pathCell ? analysis : null;
  const secondary =
    dragComparison?.target != null && comparisonAnalysis?.cell === dragComparison.target
      ? comparisonAnalysis
      : null;
  // Stable unless the overlaid analyses change, so unrelated renders (hover,
  // progress, selection) do not repaint the full-resolution trajectory.
  const hoverLayers = useMemo(
    () =>
      [primary, secondary]
        .filter((a): a is AnalysisData => !!a)
        .map((a) => ({ cell: a.cell, spikes: a.spikes, color: color(a.cell) })),
    [primary, secondary],
  );
  const pathLayers = copyLayers ?? hoverLayers;
  const hover = { onPointerEnter: () => onHover(true), onPointerLeave: () => onHover(false) };
  // Space-click copies the path into a floating window.
  const grabPath = (e: React.PointerEvent) => {
    if (grabMode && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      onPopPlot("path", e.clientX, e.clientY);
    }
  };
  // The path is independent of cell analysis. Keep its canvas mounted while a
  // different tetrode or cut loads, preserving PathPlot's cached base image.
  if (!trajectory || !trial?.pos) {
    return (
      <section className="position-pane" {...hover}>
        <div className="position-content">
          <span className="pane-placeholder">
            {trial?.pos ? "Processing position…" : "Drop a matching .pos file for position plots."}
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className="position-pane" {...hover}>
      <div className="position-content">
        <div className="position-info">
          <div className="position-time" title={timing.date}>
            {timing.text}
            <br />
            {timing.durationText}
          </div>
          <div className="position-speed">
            {speedDwell && <SpeedDwellPlot values={speedDwell} />}
            <small className="speed-axis-limit">{settings.speedMax} cm/s max</small>
          </div>
        </div>
        <div
          className="position-path"
          data-cell={primary?.cell}
          data-cells={pathLayers.map((a) => a.cell).join(",")}
          data-spikes={pathLayers.reduce((n, a) => n + a.spikes.length / 2, 0)}
          data-source-spikes={primary ? primary.spikes.length / 2 : 0}
          data-target-spikes={secondary ? secondary.spikes.length / 2 : 0}
          onPointerDownCapture={grabPath}
        >
          <PathPlot trajectory={trajectory} layers={pathLayers} />
        </div>
      </div>
    </section>
  );
}
