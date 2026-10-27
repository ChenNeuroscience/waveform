import { Lasso, Paintbrush } from "lucide-react";
import { Clusters } from "../plots/FeatureView";
import { GroupSelector } from "./GroupSelector";
import type { Settings, ViewData } from "../types";

const FULL_RANGE = [0, 1];

/** The feature-space painting tool: move spikes from source groups to a
 * destination group with the brush or lasso. */
export interface Painting {
  sources: number[];
  dest: number;
  tool: string;
  onSource: (group: number, toggle?: boolean) => void;
  onDest: (group: number) => void;
  onNewGroup: () => void;
  onTool: (tool: string) => void;
}

/** Group selector, paint/lasso tools and the feature-space projections. */
export function FeaturePane({
  data,
  settings,
  cell,
  isolate,
  painting,
  canPaint,
  splitting,
  grabMode,
  onHover,
  onPolygon,
  onPopPlot,
}: {
  data: ViewData | null;
  settings: Settings;
  cell: number;
  isolate: boolean;
  painting: Painting;
  /** Data is ready and no swap is pending. */
  canPaint: boolean;
  splitting: boolean;
  grabMode: boolean;
  onHover: (group: number | null) => void;
  onPolygon: (polygon: number[], ax: number, ay: number) => void;
  onPopPlot: (kind: "features", x: number, y: number) => void;
}) {
  const { sources, dest, tool, onSource, onDest, onNewGroup, onTool } = painting;
  // Space-click copies the feature grid into a floating window.
  const grabFeatures = (e: React.PointerEvent) => {
    if (grabMode && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      onPopPlot("features", e.clientX, e.clientY);
    }
  };
  return (
    <section className="feature-pane">
      <GroupSelector
        counts={data?.counts}
        sources={sources}
        dest={dest}
        selected={cell}
        disabled={!canPaint || splitting}
        onSource={onSource}
        onDest={onDest}
        onNew={onNewGroup}
        onHover={onHover}
      >
        <div className="feature-tools">
          <button
            className={tool === "brush" ? "active" : ""}
            aria-label="Paint source spikes"
            title="Paint source spikes"
            onClick={() => onTool("brush")}
          >
            <Paintbrush size={14} />
          </button>
          <button
            className={tool === "lasso" ? "active" : ""}
            aria-label="Lasso cut"
            title="Lasso source spikes [L]"
            onClick={() => onTool("lasso")}
          >
            <Lasso size={14} />
          </button>
        </div>
      </GroupSelector>
      <div className="feature-stage" onPointerDownCapture={grabFeatures}>
        {data && (
          <Clusters
            data={data}
            settings={settings}
            selected={cell}
            isolate={isolate}
            range={FULL_RANGE}
            tool={canPaint ? tool : "disabled"}
            onPolygon={onPolygon}
            onPick={(group, source, toggle) => (source ? onSource(group, toggle) : onDest(group))}
          />
        )}
      </div>
    </section>
  );
}
