/** Tool-window panels: settings, help/shortcuts and file headers. */
import { useState } from "react";
import { Search } from "lucide-react";
import type { Settings } from "./types";

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
      <Toggle
        label="Isolate selected cell"
        checked={isolate}
        onChange={onIsolate}
      />
      <Toggle
        label="Colour by recording time"
        checked={settings.drift}
        onChange={(v) => update("drift", v)}
      />
      <Toggle
        label="Density rendering"
        checked={settings.density}
        onChange={(v) => update("density", v)}
      />
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
        Largest cell becomes 1. Noise remains 0. This changes the cut and can be
        undone.
      </p>
    </>
  );
}
export function HelpPanel() {
  return (
    <>
      <p className="muted">
        Import a selection of LTX files or a folder to begin. Add cut files at
        any time.
      </p>
      <h3>Navigation</h3>
      <Shortcut keys="0–9" text="Jump to tetrode (ones digit)" />
      <Shortcut keys="O" text="Toggle tetrode tens digit" />
      <Shortcut keys="← / →" text="Previous / next trial" />
      <Shortcut keys="H" text="Inspect file headers" />
      <Shortcut keys="K / ?" text="Keyboard shortcuts" />
      <h3>Cut editing</h3>
      <Shortcut keys="Drag tile" text="Merge higher cell number into lower" />
      <Shortcut
        keys="Right drag"
        text="Adjust a split preview from either waveform tile"
      />
      <Shortcut keys="L" text="Lasso source spikes into destination" />
      <Shortcut
        keys="E / F"
        text="Group under pointer as destination / source"
      />
      <Shortcut
        keys="Shift F"
        text="Toggle the group under the pointer in the source set"
      />
      <Shortcut
        keys="Left / right click chip"
        text="Choose destination / source; Shift-right toggles a source"
      />
      <Shortcut keys="Enter / +" text="First unused destination group" />
      <Shortcut
        keys="Click tile"
        text="Bring the group's feature points to the front"
      />
      <Shortcut
        keys="S"
        text="Hover a tile, then click or type the group to swap with; Escape cancels"
      />
      <Shortcut keys="⌘ / Ctrl Z" text="Undo" />
      <Shortcut keys="⌘ / Ctrl ⇧ Z" text="Redo" />
      <Shortcut keys="⌘ / Ctrl S" text="Export .cut" />
      <Shortcut keys="⌘ / Ctrl C" text="Copy active cell plots" />
      <h3>Views</h3>
      <Shortcut
        keys="Hover tile"
        text="Show cell spikes on the position path"
      />
      <Shortcut
        keys="Hold Space"
        text="Click a plot to copy it; click a window to close it"
      />
      <Shortcut
        keys="W / R / C / V / T"
        text="Show only waves / spatial / direction / speed / autocorrelation; Shift adds or removes"
      />
      <Shortcut
        keys="D / P"
        text="Time colours (features and waveforms) / waveform density"
      />
      <Shortcut keys="Esc" text="Close panel, return to paint" />
      <a
        href="https://github.com/ChenNeuroscience/waveform"
        target="_blank"
        rel="noreferrer"
      >
        Original project & source ↗
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
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
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
export function HeadersPanel({
  headers,
}: {
  headers: Record<string, Record<string, string>>;
}) {
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
              .filter(([k, v]) =>
                `${k} ${v}`.toLowerCase().includes(filter.toLowerCase()),
              )
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
