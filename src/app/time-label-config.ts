/** Time labels: how a trial's time is labelled (equal sections, times given one by one, or
 * rules matched against its log file) and which labels plots use. The labels themselves are computed in the worker's
 * compute graph (core/src/time_labels.rs); this holds the configuration, writes it as the
 * graph's inputs and copies it as a compact versioned code (`useTimeLabels` asks for the
 * labels). */
import { color, fileId, type Trial } from "../types";

export const TIME_UNITS = ["s", "ms", "us", "ticks"] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];
export const UNIT_NAMES: Record<TimeUnit, string> = {
  s: "seconds",
  ms: "milliseconds",
  us: "microseconds",
  ticks: "ticks",
};
/** A log rule: lines its pattern (a regular expression, matching anywhere in a line) matches
 * change the label to `label`, from the time it captures: in the group named `time`, or else
 * the first. */
export interface TimeRule {
  pattern: string;
  unit: TimeUnit;
  /** Ticks per second, for `ticks`. */
  rate: number;
  label: number;
}
/** A custom time: from `time` (s), the label is `label`. */
export interface TimeEntry {
  time: number;
  label: number;
}
export const METHODS = ["split", "times", "log"] as const;
export interface TimeLabelConfig {
  /** Which rows of the window's table plots show: the whole trial (`total`) and each
   * `selected` label alone. Total alone is no labelling at all. */
  total: boolean;
  selected: number[];
  method: (typeof METHODS)[number];
  /** Each equal section's label, for `split`: as many sections as labels. */
  sections: number[];
  /** For `times`: in order, the first at 0 s. */
  times: TimeEntry[];
  /** A glob for the log file's name, among the files named for the trial. */
  glob: string;
  /** The label before the first rule matches. */
  initial: number;
  /** Tried in order on each line; the first that matches applies. */
  rules: TimeRule[];
}
export const MAX_SECTIONS = 100;
/** Labels are small whole numbers, each with its own colour (see `labelColor`). */
export const MAX_LABEL = 99;
/** A label's colour: always the same for the same label, from the cell palette. */
export const labelColor = (label: number) => color(label + 1);
/** One more than the largest label in use (at most MAX_LABEL), for a new entry. */
export const nextLabel = (labels: number[]) => Math.min(MAX_LABEL, Math.max(-1, ...labels) + 1);
const rule = (pattern: string, label: number): TimeRule => ({
  pattern,
  unit: "s",
  rate: 96000,
  label,
});
export const defaultTimeLabels: TimeLabelConfig = {
  total: true,
  selected: [],
  method: "split",
  sections: [0, 1],
  times: [
    { time: 0, label: 0 },
    { time: 300, label: 1 },
  ],
  glob: "*.ttl",
  initial: 0,
  rules: [rule(String.raw`^ttl_4 (\S+) 1$`, 1), rule(String.raw`^ttl_4 (\S+) 0$`, 0)],
};
/** `labels` for `n` sections: those there are, then new ones numbered by position. */
export function resizeSections(labels: number[], n: number) {
  return Array.from({ length: n }, (_, i) => labels[i] ?? Math.min(i, MAX_LABEL));
}
export const newRule = (label: number) => rule("", label);

/** Seconds per unit of a rule's time (NaN for a rate that isn't positive, which the graph
 * reports). */
function secondsPerUnit(r: TimeRule) {
  return { s: 1, ms: 1e-3, us: 1e-6, ticks: r.rate > 0 ? 1 / r.rate : NaN }[r.unit];
}
/** The rules as the compute graph's text input (see `Rules::parse` in time_labels.rs). */
export function timeRulesText(c: TimeLabelConfig): string {
  if (c.method === "split") {
    return [`split\t${c.sections.length}`, ...c.sections].join("\n");
  }
  if (c.method === "times") {
    return ["times", ...c.times.map((t) => `${t.time}\t${t.label}`)].join("\n");
  }
  return [
    `log\t${c.initial}`,
    ...c.rules.map(
      (r) => `${secondsPerUnit(r)}\t${r.label}\t${r.pattern.replace(/[\r\n]+/g, " ")}`,
    ),
  ].join("\n");
}
/** A glob as a regular expression for a whole file name, ignoring case: `*` any run of
 * characters, `?` one, `[abc]` or `[!abc]` a set, `{a,b}` alternatives; the rest literal. */
export function globPattern(glob: string): RegExp {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[" && glob.indexOf("]", i + 2) > 0) {
      const end = glob.indexOf("]", i + 2);
      const set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
      out += `[${set.startsWith("!") ? "^" + set.slice(1) : set}]`;
      i = end;
    } else if (ch === "{") {
      braces++;
      out += "(?:";
    } else if (ch === "}" && braces) {
      braces--;
      out += ")";
    } else if (ch === "," && braces) {
      out += "|";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}${")".repeat(braces)}$`, "i");
}
/** The trial's files whose names match the log glob, by name. */
export function logFiles(trial: Trial | undefined, c: TimeLabelConfig) {
  const glob = c.glob.trim();
  if (!glob) {
    return [];
  }
  const pattern = globPattern(glob);
  return (trial?.auxFiles ?? [])
    .filter((f) => pattern.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
/** The trial's log file: the first whose name matches the glob, if any does. */
export const logFile = (trial: Trial | undefined, c: TimeLabelConfig) =>
  logFiles(trial, c)[0] as File | undefined;
/** The compute graph's inputs for `trial`'s time labels (as the window shows them). */
export function timeLabelSource(trial: Trial | undefined, c: TimeLabelConfig) {
  const log = c.method === "log" ? logFile(trial, c) : undefined;
  return {
    log,
    logFile: log && trial ? `${trial.id}|${fileId(log)}` : undefined,
    timeRules: timeRulesText(c),
  };
}
/**
 * The compute graph's inputs for the times `label` covers in `trial`, or with null, the whole
 * trial: then there are no rules, log or label, so what is made with that mask doesn't depend
 * on the configuration.
 */
export function timeMaskSource(trial: Trial | undefined, c: TimeLabelConfig, label: number | null) {
  return label === null
    ? { log: undefined, logFile: undefined, timeRules: "", timeLabel: "" }
    : { ...timeLabelSource(trial, c), timeLabel: String(label) };
}
/** What plots show, in order: the whole trial (null) if ticked, then each ticked label. */
export function timeSelections(c: TimeLabelConfig): (number | null)[] {
  return [...(c.total ? [null] : []), ...[...new Set(c.selected)].sort((a, b) => a - b)];
}
/** Whether plots show anything but the whole trial. */
export const labelsInUse = (c: TimeLabelConfig) => !c.total || c.selected.length > 0;

/** `raw` as a configuration, or an error naming what isn't valid. Missing fields take their
 * defaults. */
export function validTimeLabels(raw: unknown): TimeLabelConfig {
  const fail = (what: string): never => {
    throw new Error(`Invalid ${what}.`);
  };
  if (!raw || typeof raw !== "object") {
    fail("time labels");
  }
  const r = raw as Partial<Record<keyof TimeLabelConfig | "extension", unknown>>;
  const text = (v: unknown, fallback: string, what: string) =>
    v === undefined ? fallback : typeof v === "string" ? v : fail(what);
  // Labels were text at first: whole numbers written as text are still labels.
  const label = (v: unknown, what: string) => {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_LABEL
      ? n
      : fail(`${what} (0–${MAX_LABEL})`);
  };
  // A count is how sections were first kept: numbered labels.
  const rawSections = r.sections ?? defaultTimeLabels.sections;
  const sections =
    typeof rawSections === "number" && Number.isInteger(rawSections)
      ? resizeSections([], rawSections)
      : rawSections;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > MAX_SECTIONS) {
    fail(`sections (1–${MAX_SECTIONS} labels)`);
  }
  const times = r.times ?? defaultTimeLabels.times;
  if (!Array.isArray(times) || !times.length) {
    fail("times");
  }
  let last = 0;
  const entries = (times as unknown[]).map((x, i) => {
    const o = (x && typeof x === "object" ? x : fail(`time ${i + 1}`)) as Partial<TimeEntry>;
    // The first holds from the start.
    const time = i === 0 ? 0 : o.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < last) {
      fail(`time ${i + 1} (each at or after the one before)`);
    }
    last = time as number;
    return { time: time as number, label: label(o.label ?? 0, `label of time ${i + 1}`) };
  });
  const rules = r.rules ?? defaultTimeLabels.rules;
  const selected = r.selected ?? [];
  if (!Array.isArray(rules) || !Array.isArray(selected)) {
    fail("rules");
  }
  const total = r.total === undefined ? true : !!r.total;
  if (!total && !(selected as unknown[]).length) {
    fail("selection (choose at least one row)");
  }
  return {
    total,
    selected: (selected as unknown[]).map((x) => label(x, "selected label")),
    method:
      r.method === undefined
        ? "split"
        : METHODS.includes(r.method as TimeLabelConfig["method"])
          ? (r.method as TimeLabelConfig["method"])
          : fail("method"),
    sections: (sections as unknown[]).map((l, i) => label(l, `label of section ${i + 1}`)),
    times: entries,
    // An extension is how the log was first chosen.
    glob: text(
      r.glob ??
        (typeof r.extension === "string" ? `*.${r.extension.replace(/^\./, "")}` : undefined),
      defaultTimeLabels.glob,
      "log file glob",
    ),
    initial: label(r.initial ?? defaultTimeLabels.initial, "initial label"),
    rules: (rules as unknown[]).map((x, i) => {
      const o = (x && typeof x === "object" ? x : fail(`rule ${i + 1}`)) as Partial<TimeRule>;
      const unit = o.unit ?? "s";
      const rate = o.rate ?? 96000;
      if (!TIME_UNITS.includes(unit) || typeof rate !== "number" || !(rate > 0)) {
        fail(`time unit in rule ${i + 1}`);
      }
      return {
        pattern: text(o.pattern, "", `pattern in rule ${i + 1}`),
        unit,
        rate,
        label: label(o.label ?? 0, `label in rule ${i + 1}`),
      };
    }),
  };
}

/** The clipboard code's prefix; its version names the layout that follows. */
const CODE = "waveform-labels";
export const TIME_LABELS_VERSION = 1;
/**
 * A one-line code for lab notes: `waveform-labels:v1:` and compact JSON. Sections are their
 * labels, times `[seconds, label]` pairs, and rules `[pattern, label]` with unit and rate
 * appended only when they aren't the defaults; the whole configuration is
 * kept, whichever method is in use.
 */
export function encodeTimeLabels(c: TimeLabelConfig): string {
  const body: Record<string, unknown> = {
    by: c.method,
    s: c.sections,
    t: c.times.map((t) => [t.time, t.label]),
    file: c.glob,
    first: c.initial,
    rules: c.rules.map((r) => {
      const a: (string | number)[] = [r.pattern, r.label];
      if (r.unit !== "s") {
        a.push(r.unit);
      }
      if (r.unit === "ticks") {
        a.push(r.rate);
      }
      return a;
    }),
  };
  // Only what isn't the default: the total ticked, no labels.
  if (!c.total) {
    body.total = 0;
  }
  if (c.selected.length) {
    body.show = c.selected;
  }
  return `${CODE}:v${TIME_LABELS_VERSION}:${JSON.stringify(body)}`;
}
/** Reads a code from `encodeTimeLabels`, wherever it is in `text` (as in pasted notes).
 * Older versions are migrated here when there are any. */
export function decodeTimeLabels(text: string): TimeLabelConfig {
  const line = text.split(/\r?\n/).find((l) => l.includes(`${CODE}:v`));
  const match = line && new RegExp(`${CODE}:v(\\d+):(.*)$`).exec(line.trim());
  if (!match) {
    throw new Error(`Paste a ${CODE}:v${TIME_LABELS_VERSION} code.`);
  }
  if (+match[1] !== 1) {
    throw new Error(`Version ${match[1]} codes are from a newer Waveform.`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(match[2]);
  } catch {
    throw new Error("The code is incomplete.");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.rules)) {
    throw new Error("The code is incomplete.");
  }
  return validTimeLabels({
    total: body.total !== 0,
    selected: body.show,
    method: body.by,
    sections: body.s,
    times: Array.isArray(body.t)
      ? body.t.map((a: unknown, i: number) => {
          if (!Array.isArray(a) || a.length < 2) {
            throw new Error(`Invalid time ${i + 1}.`);
          }
          return { time: a[0], label: a[1] };
        })
      : undefined,
    glob: body.file,
    initial: body.first,
    rules: (body.rules as unknown[]).map((a, i) => {
      if (!Array.isArray(a) || a.length < 2) {
        throw new Error(`Invalid rule ${i + 1}.`);
      }
      return { pattern: a[0], label: a[1], unit: a[2], rate: a[3] };
    }),
  });
}
