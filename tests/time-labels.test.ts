import { describe, it, expect } from "vitest";
import { organiseFiles } from "../src/files";
import { defaultSettings } from "../src/types";
import { timeLabels, timeMask } from "../src/worker/compute";
import {
  decodeTimeLabels,
  defaultTimeLabels,
  encodeTimeLabels,
  globPattern,
  logFile,
  logFiles,
  resizeSections,
  configuredLabels,
  labelsInUse,
  timeLabelSource,
  timeMaskSource,
  timeSelections,
  timeRulesText,
  validTimeLabels,
  type TimeLabelConfig,
} from "../src/app/time-label-config";
import { corePromise, seedRecording } from "./wasm";
import { parseTime } from "../src/shell/TimeLabelsPanel";

const logRules: TimeLabelConfig = {
  ...defaultTimeLabels,
  method: "log",
  initial: 0,
  rules: [
    { pattern: String.raw`^ttl_4 ([\d.]+) 1$`, unit: "s", rate: 96000, label: 1 },
    {
      pattern: String.raw`^ttl_2 (?<time>\d+) 0$`,
      unit: "ticks",
      rate: 1000,
      label: 2,
    },
  ],
};

describe("time label configuration", () => {
  it("copies as a one-line versioned code and restores from notes around it", () => {
    const config = { ...logRules, total: false, selected: [0, 2] };
    const code = encodeTimeLabels(config);
    expect(code).toMatch(/^waveform-labels:v1:\{/);
    expect(code).not.toContain("\n");
    expect(decodeTimeLabels(code)).toEqual(config);
    expect(decodeTimeLabels(`Session 4 notes\n  labels: ${code}  \nmore`)).toEqual(config);
    // Defaults stay short: a plain rule in seconds is just its pattern and label.
    expect(code).toContain(String.raw`["^ttl_4 ([\\d.]+) 1$",1]`);
    expect(decodeTimeLabels(encodeTimeLabels(defaultTimeLabels))).toEqual(defaultTimeLabels);
  });

  it("refuses codes it can't read", () => {
    expect(() => decodeTimeLabels("hello")).toThrow("waveform-labels:v1");
    expect(() => decodeTimeLabels('waveform-labels:v2:{"rules":[]}')).toThrow("newer");
    expect(() => decodeTimeLabels("waveform-labels:v1:{")).toThrow("incomplete");
    expect(() => decodeTimeLabels('waveform-labels:v1:{"rules":[],"s":[]}')).toThrow("section");
    expect(() =>
      decodeTimeLabels('waveform-labels:v1:{"rules":[],"t":[[0,0],[9,1],[5,2]]}'),
    ).toThrow("time 3");
    expect(() => decodeTimeLabels('waveform-labels:v1:{"rules":[["a","b","","hours"]]}')).toThrow(
      "time unit",
    );
    expect(() => validTimeLabels({ method: "magic" })).toThrow("method");
  });

  it("writes the graph's inputs, with none of the configuration when off", () => {
    expect(timeRulesText({ ...defaultTimeLabels, sections: [0, 1, 0, 1] })).toBe(
      "split\t4\n0\n1\n0\n1",
    );
    expect(
      timeRulesText({
        ...defaultTimeLabels,
        method: "times",
        times: [
          { time: 0, label: 3 },
          { time: 90.5, label: 4 },
        ],
      }),
    ).toBe("times\n0\t3\n90.5\t4");
    expect(timeRulesText({ ...logRules, initial: 7 }).split("\n")).toEqual([
      "log\t7",
      ["1", "1", String.raw`^ttl_4 ([\d.]+) 1$`].join("\t"),
      ["0.001", "2", String.raw`^ttl_2 (?<time>\d+) 0$`].join("\t"),
    ]);
    const log = new File(["x"], "t.TTL");
    const trial = { id: "/t", name: "t", folder: "", tetrodes: [], auxFiles: [log] };
    expect(logFile(trial, logRules)).toBe(log);
    expect(logFile(trial, { ...logRules, glob: "*.log" })).toBeUndefined();
    expect(timeLabelSource(trial, logRules).log).toBe(log);
    // The total needs none of the configuration, so its values never depend on it.
    expect(timeMaskSource(trial, logRules, null)).toEqual({ timeRules: "", timeLabel: "" });
    const one = timeMaskSource(trial, logRules, 2);
    expect([one.log, one.timeLabel]).toEqual([log, "2"]);
    // Plots show the total first, then each label in order; total alone is no labelling.
    expect(timeSelections({ ...logRules, selected: [2, 0, 2] })).toEqual([null, 0, 2]);
    expect(timeSelections({ ...logRules, total: false, selected: [1] })).toEqual([1]);
    expect(labelsInUse(defaultTimeLabels)).toBe(false);
    // Ticks for labels the method doesn't give (left from another) are passed over, kept for
    // going back; with nothing ticked left, the whole trial stands in.
    const fromSplit = { ...defaultTimeLabels, sections: [0, 1, 2, 3], selected: [2, 3] };
    expect(timeSelections(fromSplit)).toEqual([null, 2, 3]);
    expect(timeSelections({ ...fromSplit, method: "times" })).toEqual([null]);
    expect(timeSelections({ ...fromSplit, method: "times", total: false })).toEqual([null]);
    expect(labelsInUse({ ...fromSplit, method: "times", total: false })).toBe(false);
    expect(timeSelections({ ...fromSplit, method: "log", total: false })).toEqual([null]);
    expect(timeSelections({ ...fromSplit, method: "log", selected: [1, 2] })).toEqual([null, 1]);
    expect(configuredLabels(logRules)).toEqual([0, 1, 2]);
    expect(labelsInUse({ ...defaultTimeLabels, selected: [1] })).toBe(true);
    expect(() => validTimeLabels({ total: false, selected: [] })).toThrow("at least one");
  });

  it("keeps custom times in order from 0, reads m:ss, and migrates a section count", () => {
    const c = validTimeLabels({
      times: [
        { time: 7, label: 4 },
        { time: 30, label: "5" },
      ],
      sections: 3,
    });
    expect(c.times[0].time).toBe(0);
    expect(c.sections).toEqual([0, 1, 2]);
    // Whole numbers kept as text (as labels first were) still read.
    expect(c.times[1].label).toBe(5);
    expect(() => validTimeLabels({ initial: "on" })).toThrow("0–99");
    expect(() => validTimeLabels({ sections: [100] })).toThrow("section 1");
    expect(resizeSections([5, 6, 7], 2)).toEqual([5, 6]);
    expect(resizeSections([5], 3)).toEqual([5, 1, 2]);
    expect([parseTime("90"), parseTime("1:30"), parseTime("2:05.5"), parseTime(".5")]).toEqual([
      90, 90, 125.5, 0.5,
    ]);
    expect([parseTime("1:75"), parseTime("-3"), parseTime("abc")]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("finds the log by a glob over the trial's files, the first by name if several match", () => {
    const g = (glob: string) => globPattern(glob);
    expect(g("*.ttl").test("Trial A.TTL")).toBe(true);
    expect(g("*.ttl").test("a.ttl.bak")).toBe(false);
    expect(g("t_?.{ttl,log}").test("t_2.log")).toBe(true);
    expect(g("t_[!0-1].txt").test("t_1.txt")).toBe(false);
    expect(g("t_[0-1].txt").test("t_1.txt")).toBe(true);
    expect(g("a+b (1).txt").test("a+b (1).txt")).toBe(true);
    expect(g("a+b (1).txt").test("aab (1).txt")).toBe(false);
    const f = (name: string) => new File([""], name);
    const trial = {
      id: "/t",
      name: "t",
      folder: "",
      tetrodes: [],
      auxFiles: [f("t_10.ttl"), f("t_2.ttl"), f("t.log")],
    };
    expect(logFiles(trial, { ...defaultTimeLabels, glob: "*.ttl" }).map((x) => x.name)).toEqual([
      "t_2.ttl",
      "t_10.ttl",
    ]);
    expect(logFiles(trial, { ...defaultTimeLabels, glob: " " })).toEqual([]);
    // With several, which is meant isn't known: none is used.
    expect(logFile(trial, { ...defaultTimeLabels, glob: "*.ttl" })).toBeUndefined();
    expect(logFile(trial, { ...defaultTimeLabels, glob: "t_2.*" })?.name).toBe("t_2.ttl");
    // An extension is how the log was first chosen.
    expect(validTimeLabels({ extension: ".log" }).glob).toBe("*.log");
  });

  it("keeps handles of files named for a trial, such as its log", async () => {
    const f = (name: string) => new File([""], name, { lastModified: 1 });
    const { trials } = await organiseFiles([f("t.1"), f("t.ttl"), f("u.ttl")]);
    expect(trials[0].auxFiles!.map((x) => x.name)).toEqual(["t.ttl"]);
    expect(trials[0].otherFiles).toEqual(["t.ttl"]);
  });
});

describe("time labels in the compute graph", () => {
  it("labels a trial from its log, and masks the times of one label", async () => {
    const w = await corePromise;
    const recording = await seedRecording([0, 5000], [1, 1], { duration: 10 });
    const log = new File(
      ["duration 10\ndata_startttl_4 2.5 1\nttl_2 5000 0\nttl_4 7 1\nttl_9 8 1\n\ndata_end"],
      "t.ttl",
    );
    const trial = { id: "/t", name: "t", folder: "", tetrodes: [], auxFiles: [log] };
    const ask = (config: TimeLabelConfig) =>
      timeLabels(w, { settings: defaultSettings, recording, ...timeLabelSource(trial, config) });
    const mask = (config: TimeLabelConfig, label: number | null) =>
      timeMask(w, {
        settings: defaultSettings,
        recording,
        ...timeMaskSource(trial, config, label),
      });
    const labelled = await ask(logRules);
    expect(labelled.error).toBe("");
    expect(labelled.names).toEqual(["0", "1", "2"]);
    expect([...labelled.segments]).toEqual([0, 2.5, 2.5, 5, 5, 7, 7, 10]);
    expect([...labelled.labels]).toEqual([0, 1, 2, 1]);
    expect([...labelled.seconds]).toEqual([2.5, 5.5, 2]);
    expect([...labelled.counts]).toEqual([1, 2, 1]);
    expect([...labelled.matched]).toEqual([2, 1]);
    // The log previewed: each label's first two and last lines, by file line, with its rule,
    // label and time's span; a gap for the lines left out at the end.
    expect(labelled.preview).toEqual([
      { rule: 0, label: 1, line: 2, kind: "match", start: 6, end: 9, text: "ttl_4 2.5 1" },
      { rule: 1, label: 2, line: 3, kind: "match", start: 6, end: 10, text: "ttl_2 5000 0" },
      { rule: 0, label: 1, line: 4, kind: "match", start: 6, end: 7, text: "ttl_4 7 1" },
      { rule: null, label: null, line: 0, kind: "gap", start: 0, end: 0, text: "" },
    ]);
    const on = await mask(logRules, 1);
    expect([...on.intervals]).toEqual([2.5, 5, 7, 10]);
    expect(on.seconds).toBe(5.5);
    expect([...(await mask(logRules, null)).intervals]).toEqual([0, 10]);
    // Equal sections need no log; a bad rule is reported, not thrown.
    const halves = await ask(defaultTimeLabels);
    expect([...halves.segments]).toEqual([0, 5, 5, 10]);
    // Neighbouring sections with one label join up.
    const quarters = await ask({ ...defaultTimeLabels, sections: [0, 1, 1, 1] });
    expect([...quarters.segments]).toEqual([0, 2.5, 2.5, 10]);
    expect(quarters.names).toEqual(["0", "1"]);
    expect([...quarters.counts]).toEqual([1, 1]);
    const times: TimeLabelConfig = {
      ...defaultTimeLabels,
      method: "times",
      times: [
        { time: 0, label: 0 },
        { time: 4, label: 1 },
        { time: 6, label: 0 },
      ],
    };
    expect([...(await mask(times, 0)).intervals]).toEqual([0, 4, 6, 10]);
    const bad = await ask({
      ...logRules,
      rules: [{ ...logRules.rules[0], pattern: "(" }],
    });
    // A broken rule is reported against itself; the rest still label.
    expect(bad.error).toBe("");
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toMatchObject({ rule: 0 });
    expect(bad.problems[0].message).toMatch(/^Rule 1:/);
    const missing = await ask({ ...logRules, glob: "*.log" });
    expect(missing.error).toContain("no log file");
  });
});
