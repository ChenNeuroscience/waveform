/** The Timeline labels window: how a trial's time is labelled, what that gives for the loaded
 * trial, and which labels plots use. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ClipboardPaste, Copy, Plus, RotateCcw, X } from "lucide-react";
import type { TimeLabelsData } from "../types";
import {
  decodeTimeLabels,
  defaultTimeLabels,
  encodeTimeLabels,
  labelColor,
  MAX_LABEL,
  MAX_SECTIONS,
  newRule,
  nextLabel,
  TIME_UNITS,
  UNIT_NAMES,
  type TimeLabelConfig,
  type TimeRule,
} from "../app/time-label-config";
import { ToggleButton } from "./ToggleButton";

/** What the Timeline labels window reads and changes, assembled by App. */
export interface TimeLabelsContext {
  config: TimeLabelConfig;
  setConfig: (update: (c: TimeLabelConfig) => TimeLabelConfig) => void;
  /** The loaded trial's labels, once the worker answers. */
  data: TimeLabelsData | null;
  /** The trial's name; its log file's, if one matches; and how many match. */
  trialName?: string;
  logName?: string;
  logMatches: number;
  notify: (message: string, isError?: boolean) => void;
}

const REGEX_REFERENCE = "https://docs.rs/regex-lite/latest/regex_lite/#syntax";
const pct = (part: number, whole: number) =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "–";
/** Seconds as `m:ss`, to the nearest second. */
function clock(s: number) {
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
/** Seconds as `12.3 s`, or `m:ss` from a minute. */
function duration(s: number) {
  if (s < 60) {
    return `${s.toFixed(1)} s`;
  }
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function TimeLabelsPanel({ c }: { c: TimeLabelsContext }) {
  const { config, setConfig, data } = c;
  const set = <K extends keyof TimeLabelConfig>(k: K, v: TimeLabelConfig[K]) =>
    setConfig((x) => ({ ...x, [k]: v }));
  const setRule = (i: number, change: Partial<TimeRule>) =>
    setConfig((x) => ({
      ...x,
      rules: x.rules.map((r, j) => (j === i ? { ...r, ...change } : r)),
    }));
  const copy = async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([encodeTimeLabels(config)], { type: "text/plain" }),
        }),
      ]);
      c.notify("Timeline labels copied.");
    } catch {
      c.notify("Timeline labels could not be copied.", true);
    }
  };
  const restore = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      c.notify("Could not read the clipboard to restore timeline labels.", true);
      return;
    }
    try {
      const restored = decodeTimeLabels(text);
      setConfig(() => restored);
      c.notify("Timeline labels restored.");
    } catch (error) {
      c.notify(`Could not restore timeline labels: ${(error as Error).message}`, true);
    }
  };
  // A row of the table: a label, or null for the whole trial.
  const toggleRow = (label: number | null) =>
    setConfig((x) =>
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
    <div className="time-labels">
      <div className="time-header">
        <div className="toggle-group time-methods" role="group" aria-label="Labels from">
          {(
            [
              ["split", "Equal", "Equal sections of the trial"],
              ["times", "Custom", "Times you give"],
              ["log", "Log file", "Rules matched against the trial's log file"],
            ] as const
          ).map(([method, name, title]) => (
            <ToggleButton
              key={method}
              title={title}
              pressed={config.method === method}
              onClick={() => set("method", method)}
            >
              {name}
            </ToggleButton>
          ))}
        </div>
        <div className="settings-actions" role="group" aria-label="Timeline label actions">
          <button
            aria-label="Reset timeline labels"
            title="Restore the default timeline labels"
            onClick={() => setConfig(() => defaultTimeLabels)}
          >
            <RotateCcw size={15} />
          </button>
          <button
            aria-label="Copy timeline labels"
            title="Copy the timeline labels as a code for your notes"
            onClick={copy}
          >
            <Copy size={15} />
          </button>
          <button
            aria-label="Restore timeline labels"
            title="Restore timeline labels from a code on the clipboard"
            onClick={restore}
          >
            <ClipboardPaste size={15} />
          </button>
        </div>
      </div>

      {config.method === "split" ? (
        <SectionLabels config={config} set={set} duration={data?.duration} />
      ) : config.method === "times" ? (
        <CustomTimes config={config} set={set} duration={data?.duration} />
      ) : (
        <LogRules c={c} setRule={setRule} set={set} />
      )}

      <h3>This trial</h3>
      {!data ? (
        <p className="muted">Load a tetrode to see its trial's labels.</p>
      ) : data.error ? (
        <p className="time-error" role="alert">
          {data.error}
        </p>
      ) : (
        <LabelSummary data={data} config={config} onToggle={toggleRow} />
      )}
      <p className="muted">
        Tick the rows plots show: Total for the whole trial, a label for only its times. Total alone
        is no labelling. Plots don't use timeline labels yet.
      </p>
    </div>
  );
}

type SetField = <K extends keyof TimeLabelConfig>(k: K, v: TimeLabelConfig[K]) => void;

/** A label: its colour, a box for one or two digits, and steps up and down (or the arrow
 * keys). Typed digits apply at once; leaving an emptied box puts back the label. */
function LabelPicker({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const step = (by: number) => {
    setDraft(null);
    onChange(Math.min(MAX_LABEL, Math.max(0, value + by)));
  };
  return (
    <span className="label-picker" title={`Label ${value}`}>
      <span className="label-colour" style={{ background: labelColor(value) }} />
      <input
        value={draft ?? String(value)}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(-2);
          setDraft(digits);
          if (digits) {
            onChange(Number(digits));
          }
        }}
        onBlur={() => setDraft(null)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            step(e.key === "ArrowUp" ? 1 : -1);
          } else if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
      />
      <span className="label-steps">
        <button
          tabIndex={-1}
          aria-label={`${label}: next`}
          disabled={value >= MAX_LABEL}
          onClick={() => step(1)}
        >
          <ChevronUp size={9} strokeWidth={2.5} />
        </button>
        <button
          tabIndex={-1}
          aria-label={`${label}: previous`}
          disabled={value <= 0}
          onClick={() => step(-1)}
        >
          <ChevronDown size={9} strokeWidth={2.5} />
        </button>
      </span>
    </span>
  );
}

/** A row of a method's list: its label on the left, then what gives that label. */
function LabelRow({
  value,
  label,
  onChange,
  children,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
  children: ReactNode;
}) {
  return (
    <li className="label-row">
      <LabelPicker value={value} label={label} onChange={onChange} />
      <div className="label-row-body">{children}</div>
    </li>
  );
}
/** A remove button at the end of a row. */
function Remove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="label-row-remove" aria-label={label} title={label} onClick={onClick}>
      <X size={13} />
    </button>
  );
}

/** Equal sections, added and removed like the other methods' rows: each row its label, and
 * the times it spans. */
function SectionLabels({
  config,
  set,
  duration: end,
}: {
  config: TimeLabelConfig;
  set: SetField;
  duration?: number;
}) {
  const sections = config.sections;
  const n = sections.length;
  const at = (i: number) => (end === undefined ? "" : clock((end * i) / n));
  return (
    <>
      <ol className="label-rows">
        {sections.map((label, i) => (
          <LabelRow
            key={i}
            value={label}
            label={`Section ${i + 1} label`}
            onChange={(v) =>
              set(
                "sections",
                sections.map((l, j) => (j === i ? v : l)),
              )
            }
          >
            <span className="time-range">
              {end === undefined ? `section ${i + 1} of ${n}` : `${at(i)} – ${at(i + 1)}`}
            </span>
            {n > 1 && (
              <Remove
                label={`Remove section ${i + 1}`}
                onClick={() =>
                  set(
                    "sections",
                    sections.filter((_, j) => j !== i),
                  )
                }
              />
            )}
          </LabelRow>
        ))}
      </ol>
      <button
        className="secondary time-add"
        disabled={n >= MAX_SECTIONS}
        onClick={() => set("sections", [...sections, nextLabel(sections)])}
      >
        <Plus size={12} /> Add section
      </button>
    </>
  );
}

/** A time typed as seconds or m:ss, if it is one. */
export function parseTime(text: string): number | undefined {
  const t = text.trim();
  if (/^(?:\d+\.?\d*|\.\d+)$/.test(t)) {
    return Number(t);
  }
  const m = /^(\d+):([0-5]?\d(?:\.\d*)?)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
/** A time from `min` to `max` (s). Typed values apply when they're in range; leaving the
 * box puts back the last that did. */
function TimeInput({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (t: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inRange = (t: number | undefined) => t !== undefined && t >= min && t <= max;
  return (
    <input
      className="time-at"
      inputMode="decimal"
      value={draft ?? String(value)}
      aria-label={label}
      aria-invalid={draft !== null && !inRange(parseTime(draft))}
      title={`${duration(min)} to ${max < Infinity ? duration(max) : "any later time"}: seconds, or m:ss`}
      onChange={(e) => {
        setDraft(e.target.value);
        const t = parseTime(e.target.value);
        if (inRange(t)) {
          onCommit(t!);
        }
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Labels from times given one by one, each between the times before and after it. */
function CustomTimes({
  config,
  set,
  duration: end,
}: {
  config: TimeLabelConfig;
  set: SetField;
  duration?: number;
}) {
  const times = config.times;
  const change = (i: number, entry: Partial<TimeLabelConfig["times"][number]>) =>
    set(
      "times",
      times.map((t, j) => (j === i ? { ...t, ...entry } : t)),
    );
  const add = () => {
    const last = times[times.length - 1].time;
    // Halfway to the end when there's room, else a minute on.
    const time =
      end !== undefined && end > last + 1 ? Math.round((last + end) / 2) : Math.round(last + 60);
    set("times", [...times, { time, label: nextLabel(times.map((t) => t.label)) }]);
  };
  return (
    <>
      <ol className="label-rows">
        {times.map((t, i) => (
          <LabelRow
            key={i}
            value={t.label}
            label={`Time ${i + 1} label`}
            onChange={(label) => change(i, { label })}
          >
            <span>from</span>
            {i === 0 ? (
              <span className="time-at fixed">0</span>
            ) : (
              <TimeInput
                value={t.time}
                min={times[i - 1].time}
                max={times[i + 1]?.time ?? Infinity}
                label={`Time ${i + 1}`}
                onCommit={(time) => change(i, { time })}
              />
            )}
            <span>s</span>
            {end !== undefined && i > 0 && t.time >= end && (
              <span className="time-matched none">after the end</span>
            )}
            {i > 0 && (
              <Remove
                label={`Remove time ${i + 1}`}
                onClick={() =>
                  set(
                    "times",
                    times.filter((_, j) => j !== i),
                  )
                }
              />
            )}
          </LabelRow>
        ))}
      </ol>
      <button className="secondary time-add" onClick={add}>
        <Plus size={12} /> Add time
      </button>
    </>
  );
}

/** The log file and its rules, tried in order on each line. */
function LogRules({
  c,
  setRule,
  set,
}: {
  c: TimeLabelsContext;
  setRule: (i: number, change: Partial<TimeRule>) => void;
  set: SetField;
}) {
  const { config, data } = c;
  const matched = data && !data.error ? data.matched : null;
  return (
    <>
      <div className="time-log-file">
        <input
          className="time-glob"
          value={config.glob}
          aria-label="Log file"
          placeholder="*.ttl"
          title="A glob for the log file's name, among the trial's files: * any characters, ? one, [abc] a set, {a,b} either"
          spellCheck={false}
          onChange={(e) => set("glob", e.target.value)}
        />
        <span
          className={`muted time-log-name ${c.logName ? "" : "none"}`}
          title={c.logMatches > 1 ? `${c.logMatches} files match; the first is used` : undefined}
        >
          {c.logName
            ? `${c.logName}${c.logMatches > 1 ? ` (1 of ${c.logMatches})` : ""}`
            : c.trialName
              ? `No match in ${c.trialName}`
              : ""}
        </span>
      </div>
      <ol className="label-rows">
        <LabelRow
          value={config.initial}
          label="Label before the first match"
          onChange={(v) => set("initial", v)}
        >
          <span className="time-range">before the first match</span>
        </LabelRow>
        {config.rules.map((r, i) => (
          <LabelRow
            key={i}
            value={r.label}
            label={`Rule ${i + 1} label`}
            onChange={(label) => setRule(i, { label })}
          >
            <div className="time-rule">
              <div className="time-rule-row">
                <input
                  className="time-pattern"
                  value={r.pattern}
                  aria-label={`Rule ${i + 1} pattern`}
                  placeholder={String.raw`^ttl_4 (\S+) 1$`}
                  spellCheck={false}
                  onChange={(e) => setRule(i, { pattern: e.target.value })}
                />
                <Remove
                  label={`Remove rule ${i + 1}`}
                  onClick={() =>
                    set(
                      "rules",
                      config.rules.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
              <div className="time-rule-row">
                <select
                  value={r.unit}
                  aria-label={`Rule ${i + 1} time unit`}
                  onChange={(e) => setRule(i, { unit: e.target.value as TimeRule["unit"] })}
                >
                  {TIME_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {UNIT_NAMES[u]}
                    </option>
                  ))}
                </select>
                {r.unit === "ticks" && (
                  <label className="time-rate">
                    at{" "}
                    <input
                      type="number"
                      min={1}
                      value={r.rate}
                      aria-label={`Rule ${i + 1} ticks per second`}
                      onChange={(e) => +e.target.value > 0 && setRule(i, { rate: +e.target.value })}
                    />{" "}
                    Hz
                  </label>
                )}
                {matched && (
                  <span className={`time-matched ${matched[i] ? "" : "none"}`}>
                    {matched[i] ? `${matched[i].toLocaleString()} lines` : "no lines"}
                  </span>
                )}
              </div>
            </div>
          </LabelRow>
        ))}
      </ol>
      <button
        className="secondary time-add"
        onClick={() =>
          set("rules", [
            ...config.rules,
            newRule(nextLabel([config.initial, ...config.rules.map((r) => r.label)])),
          ])
        }
      >
        <Plus size={12} /> Add rule
      </button>
      <details className="time-cheatsheet">
        <summary>Regular expression help</summary>
        <p>
          A rule matches anywhere in a line. Its time is the group named <code>time</code>, or else
          the first group: <code>{String.raw`^ttl_4 (\S+) 1$`}</code> takes 12.5 from{" "}
          <code>ttl_4 12.5 1</code>.
        </p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>.</code>
              </td>
              <td>any character</td>
              <td>
                <code>\d</code>
              </td>
              <td>a digit</td>
            </tr>
            <tr>
              <td>
                <code>* + ?</code>
              </td>
              <td>0+, 1+, optional</td>
              <td>
                <code>\s \S</code>
              </td>
              <td>space, not space</td>
            </tr>
            <tr>
              <td>
                <code>^ $</code>
              </td>
              <td>line start, end</td>
              <td>
                <code>\.</code>
              </td>
              <td>a literal .</td>
            </tr>
            <tr>
              <td>
                <code>[abc]</code>
              </td>
              <td>any of a, b, c</td>
              <td>
                <code>a|b</code>
              </td>
              <td>a or b</td>
            </tr>
            <tr>
              <td>
                <code>(…)</code>
              </td>
              <td>a group</td>
              <td>
                <code>(?:…)</code>
              </td>
              <td>not captured</td>
            </tr>
          </tbody>
        </table>
        <p>
          A time: <code>{String.raw`([\d.]+)`}</code>. Named:{" "}
          <code>{String.raw`(?<time>[\d.]+)`}</code>. Catch-all:{" "}
          <code>{String.raw`^\S+ (\S+)`}</code>.
        </p>
        <a href={REGEX_REFERENCE} target="_blank" rel="noreferrer">
          Full syntax (regex-lite)
        </a>
      </details>
    </>
  );
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
  }, [data, config.selected]);
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
