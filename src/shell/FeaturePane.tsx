import { Lasso, Paintbrush } from "lucide-react";
import { Clusters } from "../plots/FeatureView";
import { GroupSelector } from "./GroupSelector";
import { ToggleButton } from "./ToggleButton";
import type { FeatureCoordinates, FeatureMode, Settings, ViewData } from "../types";

const FULL_RANGE = [0, 1];

function AmplitudeIcon() {
  return (
    <svg width="18" height="16" viewBox="0 0 20 16" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 8H4L6 2L9 14L12 5L14 8H15" />
        <path d="M18 2V14M16.5 2H19.5M16.5 14H19.5" />
      </g>
    </svg>
  );
}

function PrincipalComponentsIcon() {
  return (
    <svg width="18" height="16" viewBox="0 0 20 16" aria-hidden="true">
      <g fill="currentColor" opacity="0.45">
        {[
          [4, 10],
          [6, 12],
          [7, 7],
          [8, 10],
          [10, 5],
          [11, 8],
          [13, 3],
          [14, 6],
          [16, 4],
        ].map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r="0.85" />
        ))}
      </g>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 14L16 1M13 1H16V4" />
        <path d="M7 5L14 12M14 9V12H11" />
      </g>
    </svg>
  );
}

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
  mode,
  onMode,
  coordinates,
  featureMessage,
  featureError,
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
  mode: FeatureMode;
  onMode: (mode: FeatureMode) => void;
  coordinates: FeatureCoordinates | null;
  featureMessage: string;
  featureError?: string;
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
          <div className="toggle-group" role="group" aria-label="Feature space">
            <ToggleButton
              pressed={mode === "amplitudes"}
              aria-label="Amplitudes"
              title="Amplitudes: peak-to-trough height on each channel [Q]"
              disabled={!canPaint || splitting}
              onClick={() => onMode("amplitudes")}
            >
              <AmplitudeIcon />
            </ToggleButton>
            <ToggleButton
              pressed={mode === "pca"}
              aria-label="Principal components"
              title="Principal components: four axes across all waveform channels [Q]"
              disabled={!canPaint || splitting}
              onClick={() => onMode("pca")}
            >
              <PrincipalComponentsIcon />
            </ToggleButton>
          </div>
          <span className="tool-separator" aria-hidden="true" />
          <div className="toggle-group" role="group" aria-label="Cutting tool">
            <ToggleButton
              pressed={tool === "brush"}
              aria-label="Paint source spikes"
              title="Paint source spikes · L toggles brush/lasso"
              onClick={() => onTool("brush")}
            >
              <Paintbrush size={14} />
            </ToggleButton>
            <ToggleButton
              pressed={tool === "lasso"}
              aria-label="Lasso cut"
              title="Lasso source spikes · L toggles brush/lasso"
              onClick={() => onTool("lasso")}
            >
              <Lasso size={14} />
            </ToggleButton>
          </div>
          <span className="tool-separator" aria-hidden="true" />
        </div>
      </GroupSelector>
      <div className="feature-stage" onPointerDownCapture={grabFeatures}>
        {data && coordinates && (
          <Clusters
            data={data}
            coordinates={coordinates}
            settings={settings}
            selected={cell}
            isolate={isolate}
            range={FULL_RANGE}
            tool={canPaint ? tool : "disabled"}
            onPolygon={onPolygon}
            onPick={(group, source, toggle) => (source ? onSource(group, toggle) : onDest(group))}
          />
        )}
        {data && !coordinates && (
          <div className="pane-placeholder" role="status">
            {featureError || featureMessage}
          </div>
        )}
      </div>
    </section>
  );
}
