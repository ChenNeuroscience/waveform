import { AnalysisPlot } from "../plots/AnalysisPlot";
import { PathPlot, type SpikeLayer } from "../plots/PathPlot";
import { type AnalysisData } from "../types";
import type { ShellProps } from "./props";
import type { Timing } from "./position-info";

/** Recording times, speed dwell and the path with hovered/compared spikes. */
export function PositionPane({
  timing,
  pathLayers,
  primary,
  secondary,
  ...p
}: Pick<ShellProps, "analysis" | "grabMode" | "onPopPlot" | "settings" | "trajectory" | "trial"> & {
  timing: Timing;
  pathLayers: SpikeLayer[];
  primary: AnalysisData | null;
  secondary: AnalysisData | null;
}) {
  return (
    <section className="position-pane">
      <div className="position-content">
        {p.analysis && p.trajectory && p.trial?.pos ? (
          <>
            <div className="position-info">
              <div className="position-time" title={timing.date}>
                {timing.text}
                <br />
                {timing.durationText}
              </div>
              <div className="position-speed">
                <AnalysisPlot
                  data={p.analysis}
                  mode="speed"
                  maxRate={0}
                  positionSpeed
                  speedAlignment="left"
                  compact
                />
                <small className="speed-axis-limit">{p.settings.speedMax} cm/s max</small>
              </div>
            </div>
            <div
              className="position-path"
              data-cell={primary?.cell}
              data-cells={pathLayers.map((a) => a.cell).join(",")}
              data-spikes={pathLayers.reduce((n, a) => n + a.spikes.length / 2, 0)}
              data-source-spikes={primary?.spikes.length ? primary.spikes.length / 2 : 0}
              data-target-spikes={secondary?.spikes.length ? secondary.spikes.length / 2 : 0}
              onPointerDownCapture={(e) => {
                if (p.grabMode && e.button === 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onPopPlot("path", e.clientX, e.clientY);
                }
              }}
            >
              <PathPlot trajectory={p.trajectory} layers={pathLayers} />
            </div>
          </>
        ) : (
          <span className="pane-placeholder">
            {p.trial?.pos
              ? "Processing position…"
              : "Drop a matching .pos file for position plots."}
          </span>
        )}
      </div>
    </section>
  );
}
