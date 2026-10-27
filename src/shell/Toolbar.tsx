import {
  FolderOpen,
  Folder,
  Undo2,
  Redo2,
  Keyboard,
  Settings2,
  History,
  List,
  HelpCircle,
} from "lucide-react";
import type { PlotMode } from "../types";
import type { ShellProps } from "./props";
import type { Timing } from "./position-info";

/** Open files, undo/redo, panels, plot toggles and the recording status line. */
export function Toolbar({
  timing,
  ...p
}: Pick<
  ShellProps,
  | "busy"
  | "data"
  | "fileInput"
  | "folderInput"
  | "message"
  | "onOperation"
  | "onPanel"
  | "onToggle"
  | "progress"
  | "ready"
  | "shown"
> & { timing: Timing }) {
  return (
    <div className="desktop-toolbar" role="toolbar" aria-label="Waveform tools">
      <button
        title="Open files [Ctrl/Cmd O]"
        aria-label="Browse files"
        onClick={() => p.fileInput.current?.click()}
      >
        <FolderOpen size={17} />
      </button>
      <button
        title="Open folder"
        aria-label="Open a folder"
        onClick={() => p.folderInput.current?.click()}
      >
        <Folder size={16} />
      </button>
      <span className="tool-separator" />
      <button title="Help / original video" aria-label="Help" onClick={() => p.onPanel("help")}>
        <HelpCircle size={17} />
      </button>
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
