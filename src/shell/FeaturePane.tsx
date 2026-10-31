import { Lasso, Paintbrush, Palette, Rotate3D } from "lucide-react";
import { useMemo, useState, type SetStateAction } from "react";
import { DEFAULT_CLUSTER_CAMERA, type ClusterCamera } from "../plots/cluster-camera";
import { Clusters } from "../plots/FeatureView";
import { Cluster3D } from "../plots/Cluster3D";
import { GroupSelector } from "./GroupSelector";
import { ToggleButton } from "./ToggleButton";
import { usePreference } from "../preferences";
import type {
  FeatureCoordinates,
  FeatureMode,
  FeatureProjection,
  Settings,
  ViewData,
} from "../types";

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
  threeD,
  onThreeD,
  onNotice,
}: {
  data: ViewData | null;
  settings: Settings;
  cell: number;
  painting: Painting;
  /** Data is ready and no swap is pending. */
  canPaint: boolean;
  splitting: boolean;
  grabMode: boolean;
  onHover: (group: number | null) => void;
  onPolygon: (polygon: number[], ax: number, ay: number, projection?: FeatureProjection) => void;
  onPopPlot: (kind: "features", x: number, y: number) => void;
  mode: FeatureMode;
  onMode: (mode: FeatureMode) => void;
  coordinates: FeatureCoordinates | null;
  featureMessage: string;
  featureError?: string;
  threeD: boolean;
  onThreeD: (enabled: boolean) => void;
  onNotice: (message: string, isError?: boolean) => void;
}) {
  const { sources, dest, tool, onSource, onDest, onNewGroup, onTool } = painting;
  const [fixedColours, setFixedColours] = usePreference("cluster-fixed-colours", false);
  const [savedOmission, setOmitted] = usePreference("cluster-3d-omitted", 3);
  const omitted =
    Number.isInteger(savedOmission) && savedOmission >= 0 && savedOmission < 4 ? savedOmission : 3;
  const cameraKey = (space: FeatureMode, samples: number) =>
    `${data?.key}|${space}|${space === "pca" ? samples : ""}`;
  const key = cameraKey(mode, settings.pcaSamples);
  const [cameraState, setCameraState] = useState({ key: "", camera: DEFAULT_CLUSTER_CAMERA });
  const camera = cameraState.key === key ? cameraState.camera : DEFAULT_CLUSTER_CAMERA;
  const onCamera = (change: SetStateAction<ClusterCamera>) =>
    setCameraState((state) => ({
      key,
      camera:
        typeof change === "function"
          ? change(state.key === key ? state.camera : DEFAULT_CLUSTER_CAMERA)
          : change,
    }));
  const clusterSettings = useMemo(
    () => (fixedColours ? { ...settings, renderMode: "fixed" as const } : settings),
    [settings, fixedColours],
  );
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
          <ToggleButton
            pressed={fixedColours}
            aria-label="Fixed cluster colours"
            title={
              fixedColours
                ? "Fixed cell colours; turn off to follow the main colour mode"
                : "Keep fixed cell colours in cluster plots"
            }
            onClick={() => setFixedColours((fixed) => !fixed)}
          >
            <Palette size={17} />
          </ToggleButton>
          <ToggleButton
            pressed={threeD}
            aria-label="3D clusters"
            title="3D cluster view: three amplitude channels or principal components"
            disabled={!canPaint || splitting}
            onClick={() => onThreeD(!threeD)}
          >
            <span className="cluster-3d-toggle">3D</span>
          </ToggleButton>
          <span className="tool-separator" aria-hidden="true" />
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
            {threeD && (
              <ToggleButton
                pressed={tool === "orbit"}
                aria-label="Rotate 3D view"
                title="Navigate: drag to rotate, Shift-drag to pan, scroll to zoom · L cycles tools"
                onClick={() => onTool("orbit")}
              >
                <Rotate3D size={15} />
              </ToggleButton>
            )}
            <ToggleButton
              pressed={tool === "brush"}
              aria-label="Paint source spikes"
              title={
                threeD
                  ? "Paint source spikes · L cycles navigation/paint/lasso"
                  : "Paint source spikes · L toggles brush/lasso"
              }
              onClick={() => onTool("brush")}
            >
              <Paintbrush size={14} />
            </ToggleButton>
            <ToggleButton
              pressed={tool === "lasso"}
              aria-label="Lasso cut"
              title={
                threeD
                  ? "Lasso source spikes · L cycles navigation/paint/lasso"
                  : "Lasso source spikes · L toggles brush/lasso"
              }
              onClick={() => onTool("lasso")}
            >
              <Lasso size={14} />
            </ToggleButton>
          </div>
          <span className="tool-separator" aria-hidden="true" />
        </div>
      </GroupSelector>
      <div className="feature-stage" onPointerDownCapture={grabFeatures}>
        {data &&
          coordinates &&
          (threeD ? (
            <Cluster3D
              key={coordinates.key}
              data={data}
              coordinates={coordinates}
              camera={camera}
              onCamera={onCamera}
              omitted={omitted}
              onOmitted={setOmitted}
              onNotice={onNotice}
              onRestoreProjection={(saved) => {
                setCameraState({
                  key: cameraKey(saved.mode, settings.pcaSamples),
                  camera: saved.camera,
                });
                setOmitted(saved.omitted);
                onMode(saved.mode);
                onTool("orbit");
              }}
              settings={clusterSettings}
              selected={cell}
              range={FULL_RANGE}
              tool={canPaint && !splitting ? tool : "disabled"}
              onPolygon={onPolygon}
              onPick={(group, source, toggle) => (source ? onSource(group, toggle) : onDest(group))}
            />
          ) : (
            <Clusters
              data={data}
              coordinates={coordinates}
              settings={clusterSettings}
              selected={cell}
              range={FULL_RANGE}
              tool={canPaint ? tool : "disabled"}
              onPolygon={onPolygon}
              onPick={(group, source, toggle) => (source ? onSource(group, toggle) : onDest(group))}
            />
          ))}
        {data && !coordinates && (
          <div className="pane-placeholder" role="status">
            {featureError || featureMessage}
          </div>
        )}
      </div>
    </section>
  );
}
