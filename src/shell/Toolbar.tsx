import { useEffect, useRef, useState, type ReactNode } from "react";
import icon from "../../img/icon.svg";
import { FolderOpen, Folder, Undo2, Redo2, Keyboard, Settings2, History, List } from "lucide-react";
import type { PlotMode, ViewData } from "../types";
import type { VisiblePlots } from "../tiles/TileWall";
import type { PanelName } from "./panels";
import { experimentTiming } from "./position-info";

/** The Waveform icon, which returns to the start screen after a confirmation. */
function HomeButton({ unexported, onHome }: { unexported: boolean; onHome: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // A press anywhere else dismisses the confirmation.
  useEffect(() => {
    if (!confirming) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setConfirming(false);
      }
    };
    addEventListener("pointerdown", dismiss, true);
    return () => removeEventListener("pointerdown", dismiss, true);
  }, [confirming]);
  const cancelOnEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setConfirming(false);
    }
  };
  const confirm = () => {
    setConfirming(false);
    onHome();
  };
  return (
    <div className="toolbar-home" ref={root} onKeyDown={cancelOnEscape}>
      <button
        className="home-button"
        title="Waveform · close files and return to the start screen"
        aria-label="Return to the start screen"
        aria-expanded={confirming}
        onClick={() => setConfirming((c) => !c)}
      >
        <img src={icon} alt="" width={20} height={20} />
      </button>
      {confirming && (
        <div className="home-confirm" role="dialog" aria-label="Return to the start screen">
          <p>
            Close all files and return to the start screen?
            {unexported && " Unexported cut edits will be lost."}
          </p>
          <button autoFocus className="primary" onClick={confirm}>
            Close files
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** Home, open files, undo/redo, panels, plot toggles and the recording status line. */
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
  /** Some cut has edits not yet exported (the home confirmation warns). */
  unexported: boolean;
  onHome: () => void;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  /** Extra controls after the plot toggles. */
  children?: ReactNode;
}) {
  const timing = experimentTiming(p.data?.headers || {}, p.data?.duration || 0);
  return (
    <div className="desktop-toolbar" role="toolbar" aria-label="Waveform tools">
      <HomeButton unexported={p.unexported} onHome={p.onHome} />
      <span className="tool-separator" />
      <button
        title="Open files [Ctrl/Cmd O]"
        aria-label="Browse files"
        onClick={() => p.onOpenFiles()}
      >
        <FolderOpen size={17} />
      </button>
      <button title="Open folder" aria-label="Open a folder" onClick={() => p.onOpenFolder()}>
        <Folder size={16} />
      </button>
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
        <List size={17} />
      </button>
      <button title="Settings" aria-label="Settings" onClick={() => p.onPanel("settings")}>
        <Settings2 size={17} />
      </button>
      <span className="tool-separator" />
      {(["waveforms", "spatial", "direction", "speed", "ac"] as PlotMode[]).map((m) => (
        <button
          key={m}
          className={`plot-toggle ${p.shown[m] ? "checked" : ""}`}
          aria-label={
            {
              waveforms: "Waveforms",
              spatial: "Spatial rate",
              direction: "Head direction",
              speed: "Speed",
              ac: "Autocorrelation",
            }[m]
          }
          aria-pressed={p.shown[m]}
          title={
            {
              waveforms: "Waveforms [W]",
              spatial: "Spatial rate maps [R]",
              direction: "Head direction [C]",
              speed: "Speed tuning [V]",
              ac: "Autocorrelation [T]",
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
            }[m]
          }
        </button>
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
