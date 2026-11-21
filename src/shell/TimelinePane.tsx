/** The timeline pane, between the position and feature panes while the toolbar's timeline
 * button is on: a line saying what's configured, with a cog toggling the Timeline labels window
 * where it's set (TimeLabelsPanel.tsx), then the trial's labels across it, each one's time
 * and segments and the total's, and which of them plots show. */
import { useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import type { TimeLabelsData } from "../types";
import { labelColor, type TimeLabelConfig } from "../app/time-label-config";
import type { TimeLabelsContext } from "./TimeLabelsPanel";
import { ToggleButton } from "./ToggleButton";

const pct = (part: number, whole: number) =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "–";
/** Seconds as `12.3 s`, or `m:ss` from a minute. */
export function duration(s: number) {
  if (s < 60) {
    return `${s.toFixed(1)} s`;
  }
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function TimelinePane({
  c,
  settingsOpen,
  onSettings,
}: {
  c: TimeLabelsContext;
  /** Whether the Timeline labels window is open, and opening or closing it. */
  settingsOpen: boolean;
  onSettings: () => void;
}) {
  const { config, data } = c;
  // A row of the table: a label, or null for the whole trial.
  const toggleRow = (label: number | null) =>
    c.setConfig((x) =>
      label === null
        ? { ...x, total: !x.total }
        : {
            ...x,
            selected: x.selected.includes(label)
              ? x.selected.filter((n) => n !== label)
              : [...x.selected, label],
          },
    );
  return (
    <section className="timeline-pane" aria-label="Timeline labels">
      <div className="timeline-summary">
        <span>{summary(config, c.logNames)}</span>
        {/* The cog the 3D cluster view uses for its settings, pressed while they're open. */}
        <ToggleButton
          className="timeline-settings"
          aria-label="Timeline label settings"
          title="Timeline label settings"
          pressed={settingsOpen}
          onClick={onSettings}
        >
          <SettingsIcon size={17} />
        </ToggleButton>
      </div>
      {!data ? (
        <p className="muted">Load a tetrode to see its trial's labels.</p>
      ) : config.method === "log" && c.logNames.length !== 1 ? null : data.error ? (
        <p className="time-error" role="alert">
          {data.error}
        </p>
      ) : (
        <>
          {/* Rules that can't be used; the others still label. */}
          {data.problems.map((p) => (
            <p key={p.rule} className="time-error" role="alert">
              {p.message}
            </p>
          ))}
          <LabelSummary data={data} config={config} onToggle={toggleRow} />
        </>
      )}
    </section>
  );
}

/** What's configured, in a line: the method and how much of it. */
function summary(c: TimeLabelConfig, logNames: string[]) {
  const n = (count: number, one: string, many = `${one}s`) =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;
  switch (c.method) {
    case "split":
      return `${n(c.sections.length, "equal section")}`;
    case "times":
      return `${n(c.times.length, "custom time")}`;
    case "log":
      return `${n(c.rules.length, "rule")} on ${
        logNames.length === 1
          ? logNames[0]
          : logNames.length
            ? `${logNames.length} files (choose one)`
            : "no log file"
      }`;
  }
}

/** The graph names labels as text; here they are the numbers they were given as. */
const labelValues = (data: TimeLabelsData) => data.names.map(Number);

/** The labels across the trial, each one's time and segments and the total's, and which
 * of them plots show. */
function LabelSummary({
  data,
  config,
  onToggle,
}: {
  data: TimeLabelsData;
  config: TimeLabelConfig;
  /** Ticks or unticks a row: a label, or null for the total. */
  onToggle: (label: number | null) => void;
}) {
  const selected = new Set(config.selected);
  // The last ticked row stays ticked: plots always show something.
  const ticked = (config.total ? 1 : 0) + labelValues(data).filter((v) => selected.has(v)).length;
  const values = labelValues(data);
  const canvas = useRef<HTMLCanvasElement>(null);
  // The pane is resizable: the strip is drawn again at each width.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = canvas.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    el.width = Math.round(el.clientWidth * ratio);
    el.height = Math.round(el.clientHeight * ratio);
    g.clearRect(0, 0, el.width, el.height);
    const scale = el.width / Math.max(data.duration, 1e-9);
    // With labels ticked, the rest fade.
    const chosen = new Set(config.selected);
    for (let i = 0; i < data.labels.length; i++) {
      const label = data.labels[i];
      const [a, b] = [data.segments[i * 2], data.segments[i * 2 + 1]];
      const value = Number(data.names[label]);
      g.globalAlpha = chosen.size && !chosen.has(value) ? 0.18 : 1;
      g.fillStyle = labelColor(value);
      // At least a pixel, so brief segments still show.
      g.fillRect(a * scale, 0, Math.max(1, (b - a) * scale), el.height);
    }
  }, [data, config.selected, width]);
  const total = data.labels.length;
  const row = (
    key: string,
    label: number | null,
    seconds: number,
    segments: number,
    name: string,
  ) => {
    const on = label === null ? config.total : selected.has(label);
    return (
      <tr key={key} className={`${on ? "chosen" : ""} ${label === null ? "total" : ""}`}>
        <td>
          <label>
            <input
              type="checkbox"
              checked={on}
              aria-label={`Show ${name} in plots`}
              title={on && ticked === 1 ? "Plots always show at least one row" : undefined}
              // The last ticked row stays ticked, looking like the rest (not disabled).
              onChange={() => !(on && ticked === 1) && onToggle(label)}
            />
            {label !== null && (
              <span className="time-swatch" style={{ background: labelColor(label) }} />
            )}
            {name}
          </label>
        </td>
        <td>{duration(seconds)}</td>
        <td>{pct(seconds, data.duration)}</td>
        <td>{segments.toLocaleString()}</td>
      </tr>
    );
  };
  return (
    <>
      <canvas
        ref={canvas}
        className="time-strip"
        role="img"
        aria-label={`${total.toLocaleString()} segments over ${duration(data.duration)}`}
      />
      <div className="time-strip-limits">
        <span>0</span>
        <span>{duration(data.duration)}</span>
      </div>
      <table className="time-stats">
        <thead>
          <tr>
            <th>Label</th>
            <th>Time</th>
            <th>Trial</th>
            <th>Segments</th>
          </tr>
        </thead>
        <tbody>
          {values
            .map((value, i) => [value, i])
            .sort((a, b) => a[0] - b[0])
            .map(([value, i]) =>
              row(String(i), value, data.seconds[i], data.counts[i], String(value)),
            )}
          {row("total", null, data.duration, total, "Total")}
        </tbody>
      </table>
    </>
  );
}
