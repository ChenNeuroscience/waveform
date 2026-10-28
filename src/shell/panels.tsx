/** Tool-window panels: settings, help/shortcuts and file headers. */
import { useState, type ReactNode } from "react";
import { History, Redo2, Search, Undo2 } from "lucide-react";
import type { HistoryEntry, Settings } from "../types";

export type PanelName = "settings" | "history" | "headers" | "help";
/** Everything the tool panels read or act on, assembled once by App. */
export interface PanelContext {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  resetSettings: () => void;
  isolate: boolean;
  setIsolate: (v: boolean) => void;
  ready: boolean;
  operation: (type: "undo" | "redo") => void;
  renumber: () => void;
  history: { undo: HistoryEntry[]; redo: HistoryEntry[] } | null;
  headers: Record<string, Record<string, string>>;
}
/** Each tool panel's window title, default placement and content. */
export const TOOL_PANELS: Record<
  PanelName,
  {
    title: string;
    x: number;
    y: number;
    height: number;
    render: (c: PanelContext) => ReactNode;
  }
> = {
  settings: {
    title: "Settings",
    x: 35,
    y: 65,
    height: 560,
    render: (c) => (
      <SettingsPanel
        settings={c.settings}
        update={c.update}
        onReset={c.resetSettings}
        isolate={c.isolate}
        onIsolate={c.setIsolate}
        ready={c.ready}
        onRenumber={c.renumber}
      />
    ),
  },
  history: {
    title: "Edit history",
    x: 35,
    y: 105,
    height: 460,
    render: (c) => <HistoryPanel c={c} />,
  },
  headers: {
    title: "File headers",
    x: 410,
    y: 65,
    height: 460,
    render: (c) => <HeadersPanel headers={c.headers} />,
  },
  help: {
    title: "Keyboard shortcuts",
    x: 35,
    y: 65,
    height: 460,
    render: () => <HelpPanel />,
  },
};
const fmt = (n: number) => n.toLocaleString("en-GB");
function HistoryPanel({ c }: { c: PanelContext }) {
  return (
    <>
      <p className="muted">
        Each cut keeps its own undo and redo history when you switch trials or tetrodes.
      </p>
      <div className="history-actions">
        <button
          disabled={!c.ready || !c.history?.undo.length}
          className="secondary"
          onClick={() => c.operation("undo")}
        >
          <Undo2 size={14} /> Undo
        </button>
        <button
          disabled={!c.ready || !c.history?.redo.length}
          className="secondary"
          onClick={() => c.operation("redo")}
        >
          <Redo2 size={14} /> Redo
        </button>
      </div>
      <div className="history-list">
        {c.history?.undo.length ? (
          c.history.undo.map((h, i) => (
            <div key={h.id}>
              <span className="history-index">{i + 1}</span>
              <div>
                <b>{h.description}</b>
                <small>{fmt(h.changed)} spikes changed</small>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-history">
            <History size={27} />
            <p>No edits yet.</p>
            <small>Merge, swap, or lasso spikes to start a cut.</small>
          </div>
        )}
        {c.history?.redo
          .slice()
          .reverse()
          .map((h) => (
            <div className="undone" key={h.id}>
              <Redo2 size={13} />
              <div>
                <b>{h.description}</b>
                <small>Undone · available to redo</small>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

export function SettingsPanel({
  settings,
  update,
  onReset,
  isolate,
  onIsolate,
  ready,
  onRenumber,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onReset: () => void;
  isolate: boolean;
  onIsolate: (v: boolean) => void;
  ready: boolean;
  onRenumber: () => void;
}) {
  return (
    <>
      <h3>Rendering</h3>
      <Slider
        label="Point size"
        value={settings.pointSize}
        min={0.5}
        max={4}
        step={0.1}
        unit="px"
        onChange={(v) => update("pointSize", v)}
      />
      <Toggle label="Isolate selected cell" checked={isolate} onChange={onIsolate} />
      <h3>Spatial & temporal analysis</h3>
      <Slider
        label="Spatial bin width"
        value={settings.binCm}
        min={0.5}
        max={10}
        step={0.5}
        unit="cm"
        onChange={(v) => update("binCm", v)}
      />
      <Slider
        label="Boxcar radius"
        value={settings.smooth}
        min={0}
        max={5}
        step={1}
        unit="bins"
        onChange={(v) => update("smooth", v)}
      />
      <Slider
        label="Rate-map colour maximum (0 = auto)"
        value={settings.maxRate}
        min={0}
        max={50}
        step={1}
        unit="Hz"
        onChange={(v) => update("maxRate", v)}
      />
      <Slider
        label="Rate-map colour steps"
        value={settings.rateMapSteps}
        min={2}
        max={32}
        step={1}
        onChange={(v) => update("rateMapSteps", v)}
      />
      <Slider
        label="Autocorrelation window"
        value={settings.acWindow}
        min={20}
        max={1000}
        step={20}
        unit="ms"
        onChange={(v) => update("acWindow", v)}
      />
      <Slider
        label="Direction bin width"
        value={settings.dirBin}
        min={2}
        max={30}
        step={2}
        unit="°"
        onChange={(v) => update("dirBin", v)}
      />
      <Slider
        label="Speed bin width"
        value={settings.speedBin}
        min={1}
        max={10}
        step={1}
        unit="cm/s"
        onChange={(v) => update("speedBin", v)}
      />
      <Slider
        label="Maximum speed shown"
        value={settings.speedMax}
        min={10}
        max={200}
        step={5}
        unit="cm/s"
        onChange={(v) => update("speedMax", v)}
      />
      <h3>Position processing</h3>
      <label className="field">
        Tracked LEDs
        <select
          aria-label="Tracked LEDs"
          value={settings.leds}
          onChange={(e) => update("leds", +e.target.value)}
        >
          <option value="1">One · movement direction</option>
          <option value="2">Two · LED direction</option>
        </select>
      </label>
      <Slider
        label="Jump filter (0 = off)"
        value={settings.maxSpeed}
        min={0}
        max={10}
        step={0.25}
        unit="m/s"
        onChange={(v) => update("maxSpeed", v)}
      />
      <Slider
        label="Position smoothing"
        value={settings.posSmooth}
        min={0}
        max={2}
        step={0.1}
        unit="s"
        onChange={(v) => update("posSmooth", v)}
      />
      <button className="secondary" onClick={onReset}>
        Reset settings
      </button>
      <h3>Cut labels</h3>
      <button className="secondary" disabled={!ready} onClick={onRenumber}>
        Renumber cells by spike count
      </button>
      <p className="muted">
        Largest cell becomes 1. Noise remains 0. This changes the cut and can be undone.
      </p>
    </>
  );
}
export function HelpPanel() {
  return (
    <>
      <p className="muted">
        Import a selection of LTX files or a folder to begin. Add cut files at any time.
      </p>
      <h3>Navigation</h3>
      <Shortcut keys="0–9" text="Jump to tetrode (ones digit)" />
      <Shortcut keys="O" text="Toggle tetrode tens digit" />
      <Shortcut keys="↑ / ↓" text="Previous / next trial" />
      <Shortcut keys="← / →" text="Previous / next tetrode (restores its last cut)" />
      <Shortcut keys="⇧ ← / →" text="Previous / next cut of the tetrode (first: no cut)" />
      <Shortcut keys="H" text="Inspect file headers" />
      <Shortcut keys="K / ?" text="Keyboard shortcuts" />
      <h3>Cut editing</h3>
      <Shortcut keys="Drag tile" text="Merge higher cell number into lower" />
      <Shortcut keys="Right drag" text="Adjust a split preview from either waveform tile" />
      <Shortcut keys="L" text="Lasso source spikes into destination" />
      <Shortcut keys="E / F" text="Group under pointer as destination / source" />
      <Shortcut keys="Shift F" text="Toggle the group under the pointer in the source set" />
      <Shortcut
        keys="Left / right click chip"
        text="Choose destination / source; Shift-right toggles a source"
      />
      <Shortcut keys="Enter / +" text="First unused destination group" />
      <Shortcut keys="Click tile" text="Bring the group's feature points to the front" />
      <Shortcut
        keys="S"
        text="Hover a tile, then click or type the group to swap with; Escape cancels"
      />
      <Shortcut keys="⌘ / Ctrl Z" text="Undo" />
      <Shortcut keys="⌘ / Ctrl ⇧ Z" text="Redo" />
      <Shortcut keys="⌘ / Ctrl S" text="Export .cut" />
      <Shortcut keys="⌘ / Ctrl C" text="Copy the selected cell's stats and plots" />
      <Shortcut
        keys="Hold ⌘ / Ctrl C"
        text="Copy mode: click tiles to pick several, or select all; Esc finishes"
      />
      <h3>Views</h3>
      <Shortcut keys="Hover tile" text="Show cell spikes on the position path" />
      <Shortcut keys="Hold Space" text="Click a plot to copy it; click a window to close it" />
      <Shortcut
        keys="W / R / C / V / T"
        text="Show only waves / spatial / direction / speed / autocorrelation; Shift adds or removes"
      />
      <Shortcut keys="D / P" text="Time colours (features and waveforms) / waveform density" />
      <Shortcut
        keys="Esc"
        text="Close panel or leave the lasso; otherwise hide / show the toolbar"
      />
      <a href="https://github.com/ChenNeuroscience/waveform" target="_blank" rel="noreferrer">
        Project and source on GitHub ↗
      </a>
    </>
  );
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="slider-field">
      <span>
        {label}
        <b>
          {Number(value.toFixed(2))} {unit}
        </b>
      </span>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
function Shortcut({ keys, text }: { keys: string; text: string }) {
  return (
    <div className="shortcut">
      <span>{text}</span>
      <kbd>{keys}</kbd>
    </div>
  );
}
export function HeadersPanel({ headers }: { headers: Record<string, Record<string, string>> }) {
  const [filter, setFilter] = useState("");
  return (
    <>
      <div className="cell-search">
        <Search size={14} />
        <input
          aria-label="Filter headers"
          placeholder="Filter headers…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {Object.entries(headers).map(([file, h]) => (
        <div key={file}>
          <h3>{file}</h3>
          <dl className="headers-list">
            {Object.entries(h)
              .filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(filter.toLowerCase()))
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </>
  );
}
