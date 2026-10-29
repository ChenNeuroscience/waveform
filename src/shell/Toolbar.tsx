import type { ReactNode } from "react";
import { Undo2, Redo2, Keyboard, Settings as SettingsIcon, History } from "lucide-react";
import type { PlotMode, ViewData } from "../types";
import type { VisiblePlots } from "../tiles/TileWall";
import type { PanelName } from "./panels";
import { experimentTiming } from "./position-info";
import { ToggleButton } from "./ToggleButton";
import { FileMenu } from "./FileMenu";

/** A file with paired key/value lines, for recording header metadata. */
function HeadersIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M7 11h2m3 0h5M7 15h2m3 0h5M7 19h2m3 0h5" />
    </svg>
  );
}

/** File menu, undo/redo, panels, plot toggles and the recording status line. */
export function Toolbar(p: {
  busy: boolean;
  data: ViewData | null;
  message: string;
  onOperation: (type: "undo" | "redo") => void;
  onPanel: (panel: PanelName) => void;
  onToggle: (m: PlotMode, multiple: boolean) => void;
  progress: number;
  ready: boolean;
  shown: VisiblePlots;
  onHome: () => void;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  /** Extra controls after the plot toggles. */
  children?: ReactNode;
}) {
  const timing = experimentTiming(p.data?.headers || {}, p.data?.duration || 0);
  return (
    <div className="desktop-toolbar" role="toolbar" aria-label="Waveform tools">
      <FileMenu onHome={p.onHome} onOpenFiles={p.onOpenFiles} onOpenFolder={p.onOpenFolder} />
      <span className="tool-separator" />
      <button
        title="Keyboard shortcuts [K]"
        aria-label="Keyboard shortcuts"
        onClick={() => p.onPanel("help")}
      >
        <Keyboard size={17} />
      </button>
      <span className="tool-separator" />
      <button
        title="Undo [Ctrl/Cmd Z]"
        aria-label="Undo"
        disabled={!p.ready || !p.data?.undo.length}
        onClick={() => p.onOperation("undo")}
      >
        <Undo2 size={18} />
      </button>
      <button
        title="Redo [Ctrl/Cmd Shift Z]"
        aria-label="Redo"
        disabled={!p.ready || !p.data?.redo.length}
        onClick={() => p.onOperation("redo")}
      >
        <Redo2 size={18} />
      </button>
      <button title="Edit history" aria-label="Edit history" onClick={() => p.onPanel("history")}>
        <History size={17} />
      </button>
      <span className="tool-separator" />
      <button
        title="File headers [H]"
        aria-label="File headers"
        onClick={() => p.onPanel("headers")}
      >
        <HeadersIcon />
      </button>
      <button title="Settings" aria-label="Settings" onClick={() => p.onPanel("settings")}>
        <SettingsIcon size={17} />
      </button>
      <span className="tool-separator" />
      {(["waveforms", "spatial", "sc", "direction", "speed", "ac"] as PlotMode[]).map((m) => (
        <ToggleButton
          key={m}
          className="plot-toggle"
          aria-label={
            {
              waveforms: "Waveforms",
              spatial: "Spatial rate",
              direction: "Head direction",
              speed: "Speed",
              ac: "Autocorrelation",
              sc: "Spatial autocorrelation",
            }[m]
          }
          pressed={p.shown[m]}
          title={
            {
              waveforms: "Waveforms [W]",
              spatial: "Spatial rate maps [R]",
              direction: "Head direction [C]",
              speed: "Speed tuning [V]",
              ac: "Autocorrelation [T]",
              sc: "Spatial autocorrelogram [A]",
            }[m] + " · Shift-click to show several"
          }
          onClick={(e) => p.onToggle(m, e.shiftKey)}
        >
          {
            {
              waveforms: "WAV",
              spatial: "RM",
              direction: "DIR",
              speed: "SPD",
              ac: "TC",
              sc: "SC",
            }[m]
          }
        </ToggleButton>
      ))}
      {p.children && (
        <>
          <span className="tool-separator" />
          {p.children}
        </>
      )}
      <div className="toolbar-status" role="group" aria-label="Recording details">
        {p.data && (
          <span>
            Spikes: <b>{p.data.n.toLocaleString()}</b> · {timing.durationText}
            {p.data.waveSlots < p.data.n && (
              <strong
                className="toolbar-warning"
                title={`Waveform tiles draw ${p.data.waveSlots.toLocaleString()} evenly spaced spikes of ${p.data.n.toLocaleString()}. Counts, edits and exports use every spike.`}
              >
                {" "}
                · WARNING: waveforms sampled
              </strong>
            )}
          </span>
        )}
        <span>
          {p.busy ? (
            <>
              <progress max="1" value={p.progress} /> {p.message}
            </>
          ) : p.data ? (
            `${(p.data.residentBytes / 1048576).toFixed(0)} MB cached`
          ) : (
            "Preparing…"
          )}
        </span>
      </div>
    </div>
  );
}
