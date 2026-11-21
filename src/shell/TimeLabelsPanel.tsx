/** The Timeline labels window: how a trial's time is labelled (what that gives, and which
 * labels plots use, are in the timeline pane: TimelinePane.tsx). */
import { useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  FileText,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import type { LogPreviewLine, TimeLabelsData } from "../types";
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
import { duration } from "./TimelinePane";

/** What the Timeline labels window reads and changes, assembled by App. */
export interface TimeLabelsContext {
  config: TimeLabelConfig;
  setConfig: (update: (c: TimeLabelConfig) => TimeLabelConfig) => void;
  /** The loaded trial's labels, once the worker answers. */
  data: TimeLabelsData | null;
  /** The trial's name, and the names of its files the log glob matches (the log, if exactly
   * one does). */
  trialName?: string;
  logNames: string[];
  notify: (message: string, isError?: boolean) => void;
  /** A label's row hovered in the timeline pane (null when none is), to show its times. */
  onHoverLabel: (label: number | null) => void;
}

const REGEX_REFERENCE = "https://docs.rs/regex-lite/latest/regex_lite/#syntax";
/** How many of the log's lines a rule matched. */
const matchedText = (n: number, total: number) =>
  `matched ${n.toLocaleString()}/${total.toLocaleString()} lines`;
/** Seconds as `m:ss`, to the nearest second. */
function clock(s: number) {
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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

/**
 * The log as the rules take it (see `TimeLabelsData.preview`): each label's first two and last
 * lines, in its colour with the time picked out, and "…" where lines are left out; then a
 * regular expression cheat sheet.
 */
function LogPreview({ lines }: { lines: LogPreviewLine[] }) {
  return (
    <>
      {lines.length > 0 && (
        <ol className="regex-preview" aria-label="Log preview">
          {lines.map((l, i) =>
            l.kind === "gap" ? (
              <li key={i} className="gap">
                …
              </li>
            ) : (
              <li key={i} className={l.kind}>
                <span className="regex-line">{l.line}</span>
                <span
                  className="regex-label"
                  style={l.label !== null ? { background: labelColor(l.label) } : undefined}
                />
                <code>
                  {l.kind === "match" ? (
                    <>
                      {[...l.text].slice(0, l.start).join("")}
                      <mark>{[...l.text].slice(l.start, l.end).join("")}</mark>
                      {[...l.text].slice(l.end).join("")}
                    </>
                  ) : (
                    l.text
                  )}
                </code>
              </li>
            ),
          )}
        </ol>
      )}
      <table className="regex-cheatsheet">
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
            <td>the time (captured)</td>
            <td>
              <code>(?:…)</code>
            </td>
            <td>a group, not captured</td>
          </tr>
        </tbody>
      </table>
      <a href={REGEX_REFERENCE} target="_blank" rel="noreferrer">
        Full syntax (regex-lite)
      </a>
    </>
  );
}

/**
 * How a rule did: green with a check, as the log file's, when it's valid and matches; orange
 * when it matches nothing; and its error when it can't be used (cut short, in full on hover),
 * with its matches too when it matches but has no capture group.
 */
function RuleStatus({
  matched,
  lines,
  problem,
}: {
  matched: number;
  lines: number;
  problem?: string;
}) {
  if (problem) {
    // On the rule's own row, its number needn't be said.
    const why = problem.replace(/^Rule \d+: /, "");
    // A missing group says what matched too; several groups say how to choose one.
    const text = /needs a capture group/.test(why)
      ? `${matchedText(matched, lines)}, no time group`
      : why.replace(/\.$/, "");
    return (
      <span className="time-matched bad" title={problem}>
        {text}
      </span>
    );
  }
  return (
    <span className={`time-matched ${matched ? "found" : "none"}`}>
      {matched > 0 && <Check size={12} strokeWidth={3} aria-label="Valid" />}
      {matchedText(matched, lines)}
    </span>
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
  // Matches are answered even when the rules can't label (a rule without a capture group).
  const matched = data?.matched.length ? data.matched : null;
  // Rules without a capture group: they match, but give no time.
  const untimed = (i: number) =>
    !!data?.problems.some((p) => p.rule === i && /capture group/.test(p.message));
  // A rule just added, whose pattern box takes the focus when it appears.
  const focusRule = useRef<number | null>(null);
  const names = c.logNames;
  const listed = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
  return (
    <>
      <div className="label-row file-row">
        <span className="label-row-key" title="Log file">
          <FileText size={15} aria-hidden="true" />
        </span>
        <div className="time-file">
          <input
            className="time-glob"
            value={config.glob}
            aria-label="Log file"
            placeholder="*.ttl"
            title="A glob for the log file's name, among the trial's files: * any characters, ? one, [abc] a set, {a,b} either"
            spellCheck={false}
            onChange={(e) => set("glob", e.target.value)}
          />
          {names.length === 1 ? (
            <span className="time-file-status found">
              <Check size={12} strokeWidth={3} aria-label="Matched" /> {names[0]}
            </span>
          ) : (
            c.trialName && (
              <span className="time-file-status" role="alert">
                {names.length
                  ? `${names.length} files match: ${listed}`
                  : `No file of ${c.trialName} matches`}
              </span>
            )
          )}
        </div>
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
                  aria-invalid={!!data?.problems.some((p) => p.rule === i)}
                  title={data?.problems.find((p) => p.rule === i)?.message}
                  value={r.pattern}
                  aria-label={`Rule ${i + 1} pattern`}
                  placeholder={String.raw`ttl_4 (\S+) 1`}
                  spellCheck={false}
                  onChange={(e) => setRule(i, { pattern: e.target.value })}
                  ref={(box) => {
                    if (box && focusRule.current === i) {
                      focusRule.current = null;
                      box.focus();
                    }
                  }}
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
                  // Without a capture group there's no time for a unit to apply to.
                  disabled={untimed(i)}
                  onChange={(e) => setRule(i, { unit: e.target.value as TimeRule["unit"] })}
                >
                  {TIME_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {UNIT_NAMES[u]}
                    </option>
                  ))}
                </select>
                {r.unit === "ticks" && (
                  <label className={`time-rate ${untimed(i) ? "disabled" : ""}`}>
                    at{" "}
                    <input
                      type="number"
                      min={1}
                      disabled={untimed(i)}
                      value={r.rate}
                      aria-label={`Rule ${i + 1} ticks per second`}
                      onChange={(e) => +e.target.value > 0 && setRule(i, { rate: +e.target.value })}
                    />{" "}
                    Hz
                  </label>
                )}
                {/* A rule just added has no count until the next answer. */}
                {matched?.[i] !== undefined && (
                  <RuleStatus
                    matched={matched[i]}
                    lines={data!.lines}
                    problem={data!.problems.find((p) => p.rule === i)?.message}
                  />
                )}
              </div>
            </div>
          </LabelRow>
        ))}
      </ol>
      <button
        className="secondary time-add"
        onClick={() => {
          focusRule.current = config.rules.length;
          set("rules", [
            ...config.rules,
            newRule(nextLabel([config.initial, ...config.rules.map((r) => r.label)])),
          ]);
        }}
      >
        <Plus size={12} /> Add rule
      </button>
      {data && c.logNames.length === 1 && <LogPreview lines={data.preview} />}
    </>
  );
}
