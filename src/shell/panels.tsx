/** Tool-window panels: settings, help/shortcuts and file headers. */
import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ClipboardPaste,
  Copy,
  History,
  Redo2,
  RotateCcw,
  Search,
  Undo2,
} from "lucide-react";
import { usePreference } from "../preferences";
import { decodeSettings, encodeSettings } from "../app/settings-clipboard";
import type { HistoryEntry, Settings } from "../types";

export type PanelName = "settings" | "history" | "headers" | "help";
/** Everything the tool panels read or act on, assembled once by App. */
export interface PanelContext {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  resetSettings: () => void;
  restoreSettings: (settings: Settings) => void;
  notify: (message: string, isError?: boolean) => void;
  ready: boolean;
  operation: (type: "undo" | "redo") => void;
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
        onRestore={c.restoreSettings}
        onNotice={c.notify}
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
      <div className="settings-actions history-actions" role="group" aria-label="History actions">
        <button
          disabled={!c.ready || !c.history?.undo.length}
          aria-label="Undo"
          title="Undo"
          onClick={() => c.operation("undo")}
        >
          <Undo2 size={15} />
        </button>
        <button
          disabled={!c.ready || !c.history?.redo.length}
          aria-label="Redo"
          title="Redo"
          onClick={() => c.operation("redo")}
        >
          <Redo2 size={15} />
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
  onRestore,
  onNotice,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onReset: () => void;
  onRestore: (settings: Settings) => void;
  onNotice: (message: string, isError?: boolean) => void;
}) {
  const [section, setSection] = usePreference<string | null>(
    "settings-section",
    "Position processing",
  );
  const copy = async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([encodeSettings(settings)], { type: "text/plain" }),
        }),
      ]);
      onNotice("Settings copied.");
    } catch {
      onNotice("Settings could not be copied.", true);
    }
  };
  const read = async () => {
    let value: string;
    try {
      value = await navigator.clipboard.readText();
    } catch {
      onNotice("Could not read the clipboard to restore settings.", true);
      return;
    }
    try {
      onRestore(decodeSettings(value));
      onNotice("Settings restored.");
    } catch (error) {
      onNotice(`Could not restore settings: ${(error as Error).message}`, true);
    }
  };
  const sections = [
    {
      title: "Position processing",
      content: (
        <>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.leds === 2}
              onChange={(e) => update("leds", e.target.checked ? 2 : 1)}
            />
            <span>Use both LEDs when available</span>
          </label>
          <Slider
            label="Jump filter"
            value={settings.maxSpeed}
            min={0}
            max={10}
            step={0.25}
            unit="m/s"
            zeroLabel="Off"
            zeroHint="Position jumps are not filtered."
            onChange={(v) => update("maxSpeed", v)}
          />
          <Slider
            label="Position smoothing"
            value={settings.posSmooth}
            min={0}
            max={2}
            step={0.1}
            unit="s"
            zeroLabel="Off"
            zeroHint="Position coordinates are not smoothed."
            onChange={(v) => update("posSmooth", v)}
          />
        </>
      ),
    },
    {
      title: "Cluster plots",
      content: (
        <>
          <Slider
            label="PCA fit sample size"
            value={settings.pcaSamples}
            min={500}
            max={20000}
            step={500}
            unit="spikes"
            onChange={(v) => update("pcaSamples", v)}
          />
        </>
      ),
    },
    {
      title: "Spatial rate map",
      content: (
        <>
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
            zeroLabel="Off"
            zeroHint="Spatial smoothing is off."
            onChange={(v) => update("smooth", v)}
          />
          <Slider
            label="Rate-map colour maximum"
            value={settings.maxRate}
            min={0}
            max={50}
            step={1}
            unit="Hz"
            zeroLabel="Auto"
            zeroHint="Uses each cell's peak rate."
            onChange={(v) => update("maxRate", v)}
          />
          <Slider
            label="Rate-map colour steps"
            value={settings.rateMapSteps}
            min={2}
            max={32}
            step={1}
            unit="steps"
            onChange={(v) => update("rateMapSteps", v)}
          />
        </>
      ),
    },
    {
      title: "Spatial autocorrelogram",
      content: (
        <>
          <p className="muted">Uses the spatial rate map's binning and smoothing.</p>
          <Slider
            label="Spatial AC minimum overlap"
            value={settings.scMinOverlap}
            min={2}
            max={200}
            step={1}
            unit="bins"
            onChange={(v) => update("scMinOverlap", v)}
          />
        </>
      ),
    },
    {
      title: "Directional rate map",
      content: (
        <>
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
            label="Directional boxcar radius"
            value={settings.dirSmooth}
            min={0}
            max={10}
            step={1}
            unit="bins"
            zeroLabel="Off"
            zeroHint="Directional smoothing is off."
            onChange={(v) => update("dirSmooth", v)}
          />
        </>
      ),
    },
    {
      title: "Speed tuning",
      content: (
        <>
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
        </>
      ),
    },
    {
      title: "Temporal autocorrelogram",
      content: (
        <>
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
            label="Temporal bin width"
            value={settings.acBinMs}
            min={0.5}
            max={50}
            step={0.5}
            unit="ms"
            onChange={(v) => update("acBinMs", v)}
          />
        </>
      ),
    },
  ];
  return (
    <div className="settings-panel">
      <div className="settings-actions" role="group" aria-label="Settings actions">
        <button aria-label="Reset settings" title="Restore default settings" onClick={onReset}>
          <RotateCcw size={15} />
        </button>
        <button aria-label="Copy settings" title="Copy settings to the clipboard" onClick={copy}>
          <Copy size={15} />
        </button>
        <button
          aria-label="Restore settings"
          title="Restore settings from the clipboard"
          onClick={read}
        >
          <ClipboardPaste size={15} />
        </button>
      </div>
      {sections.map(({ title, content }) => (
        <SettingsSection
          key={title}
          title={title}
          open={section === title}
          onToggle={() => setSection(section === title ? null : title)}
        >
          {content}
        </SettingsSection>
      ))}
    </div>
  );
}

function SettingsSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section">
      <h3>
        <button aria-expanded={open} aria-controls={id} onClick={onToggle}>
          {title}
          <ChevronDown size={14} />
        </button>
      </h3>
      <div id={id} hidden={!open} className="settings-section-content">
        {children}
      </div>
    </section>
  );
}

export function HelpPanel() {
  return (
    <>
      <h3>Navigation</h3>
      <Shortcut keys="⌘ / Ctrl O" text="Add files…" />
      <Shortcut keys="0–9" text="Jump to tetrode (ones digit)" />
      <Shortcut keys="O" text="Toggle tetrode tens digit" />
      <Shortcut keys="↑ / ↓" text="Previous / next trial" />
      <Shortcut keys="← / →" text="Previous / next tetrode (restores its last cut)" />
      <Shortcut keys="⇧ ← / →" text="Previous / next cut of the tetrode (first: no cut)" />
      <Shortcut keys="H" text="Inspect file headers" />
      <Shortcut keys="Z" text="Edit history" />
      <Shortcut keys="K / ?" text="Keyboard shortcuts" />
      <h3>Cut editing</h3>
      <Shortcut keys="L" text="Cycle navigate / paint / lasso in 3D; switch paint / lasso in 2D" />
      <Shortcut keys="E / F" text="Group under pointer as destination / source" />
      <Shortcut keys="Shift F" text="Toggle the group under the pointer in the source set" />
      <Shortcut keys="Enter / +" text="First unused destination group" />
      <Shortcut keys="S" text="Swap cell under pointer (Esc cancels)" />
      <Shortcut keys="⌘ / Ctrl Z" text="Undo" />
      <Shortcut keys="⌘ / Ctrl ⇧ Z / Ctrl Y" text="Redo" />
      <Shortcut keys="⌘ / Ctrl S" text="Export .cut" />
      <Shortcut keys="⌘ / Ctrl C" text="Copy plots and statistics (position pane when hovered)" />
      <Shortcut keys="Hold ⌘ / Ctrl C" text="Enter extended copy mode (500 ms)" />
      <Shortcut keys="⌘ / Ctrl A" text="Select all cells in copy mode" />
      <h3>Views</h3>
      <Shortcut keys="Q" text="Switch amplitudes / principal components" />
      <Shortcut keys="G" text="Cycle the three displayed features in 3D" />
      <p className="muted">
        In 3D, drag to rotate, Shift-drag to pan and scroll to zoom. Choose brush or lasso to cut
        through all depths. L cycles tools; Esc cancels a stroke.
      </p>
      <Shortcut keys="Space + click" text="Copy a plot / close a floating window" />
      <Shortcut
        keys="W / R / A / C / V / T"
        text="Show only waves / spatial / spatial autocorrelation / direction / speed / temporal autocorrelation; Shift adds or removes"
      />
      <Shortcut keys="P / ⇧ P" text="Cycle fixed colours / density / drift (forward / back)" />
      <Shortcut
        keys="Esc"
        text="Close panel or cancel stroke; leave lasso in 2D; otherwise hide / show the toolbar"
      />
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
  zeroLabel,
  zeroHint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  zeroLabel?: "Off" | "Auto";
  zeroHint?: string;
  onChange: (n: number) => void;
}) {
  const id = useId();
  const format = (n: number) => {
    const suffix = n === 1 && ["bins", "spikes", "steps"].includes(unit) ? unit.slice(0, -1) : unit;
    return `${fmt(Number(n.toFixed(2)))}${suffix ? `${suffix === "°" ? "" : " "}${suffix}` : ""}`;
  };
  const state = value === 0 ? zeroLabel : undefined;
  const current = state || format(value);
  return (
    <label className="slider-field" htmlFor={id} data-state={state?.toLowerCase()}>
      <span className="slider-heading">
        <span>{label}</span>
        <output className="slider-value" htmlFor={id} title={format(value)} aria-hidden="true">
          {current}
        </output>
      </span>
      <input
        id={id}
        aria-label={label}
        aria-valuetext={current}
        aria-describedby={state && zeroHint ? `${id}-hint` : undefined}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(+e.target.value)}
      />
      <span className="slider-limits" aria-hidden="true">
        <span>{min === 0 && zeroLabel ? zeroLabel : format(min)}</span>
        <span>{format(max)}</span>
      </span>
      {state && zeroHint && (
        <small className="slider-hint" id={`${id}-hint`}>
          {zeroHint}
        </small>
      )}
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
        <div key={file} data-text-selectable>
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
