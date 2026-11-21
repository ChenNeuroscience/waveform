// Browser I/O and ABI bridge. Positions and analyses are computed by handlers in Rust
// (core/src/compute_handlers.rs), a compute graph (core/src/compute.rs); this writes their inputs,
// supplies files they say they need, and copies their answers out.
import { parseHeader, readCut } from "../files";
import { streamFile, copyF32, copyU8, copyU16, copyU32, withU8, type Core } from "./wasm";
import type {
  AnalysisData,
  AnalysisPart,
  Header,
  LfpDistribution,
  TimeLabelsData,
  TimeMask,
  Trajectory,
} from "../types";
import { Superseded, type LfpRequest, type PositionRequest } from "./protocol";
import { recordingSource } from "./demo";
import { readPopulation } from "./recording";
import { fitPca } from "./pca";
import { get, openStore } from "./history";

/** Reads a position file's header. */
export async function positionHeader(file: File): Promise<Header> {
  return parseHeader(new Uint8Array(await file.slice(0, 65536).arrayBuffer())).header;
}

/** Reads a position file with its calibration (an edit, the file's, or a guess), unprocessed,
 * into a new handle. */
export async function readPosition(file: File, w: Core, editedPpm?: number): Promise<number> {
  const { header: h, offset } = parseHeader(
    new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
  );
  if (h.pos_format !== "t,x1,y1,x2,y2,numpix1,numpix2") {
    throw new Error("Unsupported LTX position format.");
  }
  const n = parseInt(h.num_pos_samples);
  const stated = editedPpm ?? parseFloat(h.pixels_per_metre);
  const rate = parseFloat(h.sample_rate);
  const minX = parseFloat(h.window_min_x || "0");
  const minY = parseFloat(h.window_min_y || "0");
  const maxX = parseFloat(h.window_max_x);
  const maxY = parseFloat(h.window_max_y);
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    offset + n * 20 > file.size ||
    !(rate > 0) ||
    !(maxX > minX) ||
    !(maxY > minY)
  ) {
    throw new Error("Invalid or truncated position file.");
  }
  const estimated = !(stated > 0);
  const handle = w.position_new(n, estimated ? 1 : stated, rate, minX, minY, maxX, maxY);
  try {
    w.position_bearing(handle, parseFloat(h.bearing_colour_1 || "0"));
    await streamFile(w, file, offset, n * 20, 32768 * 20, (p, bytes) =>
      w.position_push(handle, p, bytes),
    );
    // With no calibration, the largest dimension used is taken to be a metre, just so that
    // there's something to look at. If the LEDs were never seen, the same goes for the window.
    const ppm = estimated
      ? w.position_used_extent(handle) || Math.max(maxX - minX, maxY - minY)
      : stated;
    w.position_set_ppm(handle, ppm, estimated ? 1 : 0);
    return handle;
  } catch (e) {
    w.position_free(handle);
    throw e;
  }
}
/** Reads an `.egf` file (or a synthetic stand-in) into a new handle, decimated, for the
 * compute graph to take (`compute_supply_egf`). */
export async function readEgf(
  w: Core,
  marker: File,
  options: { current?: () => boolean; progress?: (fraction: number) => void } = {},
): Promise<number> {
  const file = recordingSource(w, marker);
  const { header: h, offset } = parseHeader(
    new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
  );
  const rate = parseFloat(h.sample_rate);
  // A blank count is an interrupted recording: read what's there, without the end marker.
  const stated = parseInt(h.num_EEG_samples);
  const n = Number.isSafeInteger(stated) ? stated : Math.max(0, file.size - offset);
  if (
    parseInt(h.num_chans || "1") !== 1 ||
    (h.bytes_per_sample && parseInt(h.bytes_per_sample) !== 1) ||
    !(rate > 0) ||
    n < 0 ||
    offset + n > file.size
  ) {
    throw new Error(`${marker.name}: unsupported or truncated .egf file.`);
  }
  const handle = w.egf_new(n, rate);
  try {
    await streamFile(
      w,
      file,
      offset,
      n,
      1 << 20,
      (p, bytes) => {
        if (options.current && !options.current()) {
          throw new Superseded("Superseded .egf read.");
        }
        w.egf_push(handle, p, bytes);
      },
      options.progress,
    );
    return handle;
  } catch (e) {
    w.egf_free(handle);
    throw e;
  }
}
/** The frequency distribution of a trial's `.egf` signal, band-passed, or null without one. */
export async function lfpDistribution(
  w: Core,
  inputs: ComputeInputs,
): Promise<LfpDistribution | null> {
  if (!inputs.egf) {
    return null;
  }
  const answer = await ask(w, inputs, "lfpFrequency");
  const [low, bin, mean] = answer.buffers.shape;
  return { key: answer.key, values: answer.buffers.values as Float32Array, low, bin, mean };
}
/** The trial's time labels for `inputs`' recording. */
export async function timeLabels(w: Core, inputs: ComputeInputs): Promise<TimeLabelsData> {
  const { key, buffers: b } = await ask(w, inputs, "timeLabels");
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  const counts = b.counts as Uint32Array;
  // One name per label; a lone empty name is still a label.
  const names = counts.length ? text(b.names as Uint8Array).split("\n") : [];
  const result: TimeLabelsData = {
    key,
    duration: b.stats[0],
    lines: b.stats[1],
    segments: b.segments as Float64Array,
    labels: b.labels as Uint16Array,
    names,
    seconds: b.seconds as Float64Array,
    counts,
    matched: b.matched as Uint32Array,
    error: text(b.error as Uint8Array),
    problems: text(b.problems as Uint8Array)
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [rule, ...message] = row.split("\t");
        return { rule: +rule, message: message.join("\t") };
      }),
    preview: text(b.preview as Uint8Array)
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        // The text is last, and may hold tabs itself. 65535 is no rule or label.
        const [rule, label, line, kind, start, end, ...rest] = row.split("\t");
        const none = (v: string) => v === "65535";
        return {
          rule: none(rule) ? null : +rule,
          label: none(label) ? null : Number(names[+label]),
          line: +line,
          kind: ({ m: "match", o: "other", g: "gap" } as const)[kind as "m" | "o" | "g"],
          start: +start,
          end: +end,
          text: rest.join("\t"),
        };
      }),
  };
  return result;
}
/** The times `inputs`' label covers (see `timeMaskSource`), or the whole trial without one. */
export async function timeMask(w: Core, inputs: ComputeInputs): Promise<TimeMask> {
  const { key, buffers } = await ask(w, inputs, "timeMask");
  return { key, intervals: buffers.intervals as Float64Array, seconds: buffers.stats[0] };
}
/** The numeric inputs, in the order Rust reads them (checked by a test against
 * `compute_input_name`). */
export const COMPUTE_INPUTS = [
  "leds",
  "maxSpeed",
  "posSmooth",
  "binCm",
  "smooth",
  "maxRate",
  "rateMapSteps",
  "scMinOverlap",
  "dirBin",
  "dirSmooth",
  "speedBin",
  "speedMax",
  "acWindow",
  "acBinMs",
  "ppm",
  "sync",
  "pcaSamples",
  "lfpLow",
  "lfpHigh",
  "lfpFreqBin",
  "lfpPhaseBin",
] as const;
/** A recording as the compute graph needs it: its identity and header, and the files only
 * JavaScript can read for it. */
export interface RecordingSource {
  /** The recording's identity (its asset key). */
  key: string;
  /** The tetrode file (or a synthetic stand-in), and its header. */
  file: File;
  header: Header;
  offset: number;
  n: number;
  /** Where its labels start: a cut file, or unsorted. */
  cut?: File;
  cutSource: string;
  /** Applied patch ids, in order. */
  history: string[];
}
/** The compute graph's inputs, besides the cell. */
export interface ComputeInputs extends PositionRequest, Omit<LfpRequest, "settings"> {
  recording?: RecordingSource;
  /** The id for a command's patch. */
  patch?: string;
  /** Time labels (see `timeLabelSource` and `timeMaskSource`): the log file and its
   * identity, the rules' text and the label a mask covers. */
  log?: File;
  logFile?: string;
  timeRules?: string;
  timeLabel?: string;
  /** For reading files the graph needs: whether the request is still wanted, and progress. */
  current?: () => boolean;
  progress?: (fraction: number, message: string) => void;
}
function setText(w: Core, field: number, text: string) {
  const bytes = new TextEncoder().encode(text);
  const p = w.alloc_bytes(Math.max(1, bytes.length));
  try {
    new Uint8Array(w.memory.buffer, p, bytes.length).set(bytes);
    w.compute_set_text(field, p, bytes.length);
  } finally {
    w.free_bytes(p, Math.max(1, bytes.length));
  }
}
function writeInputs(w: Core, i: ComputeInputs) {
  // Pointer first: the call can grow memory, detaching an earlier `memory.buffer`.
  const at = w.compute_inputs();
  const numbers = new Float64Array(w.memory.buffer, at, COMPUTE_INPUTS.length);
  COMPUTE_INPUTS.forEach((name, j) => {
    numbers[j] =
      name === "ppm" ? (i.ppm ?? NaN) : name === "sync" ? (i.sync ?? 0) : i.settings[name];
  });
  const r = i.recording;
  setText(w, 0, i.pos ? (i.posFile ?? "") : "");
  setText(w, 1, r?.key ?? "");
  setText(w, 2, r?.cutSource ?? "");
  setText(w, 3, r?.history.join(",") ?? "");
  setText(w, 4, i.patch ?? "");
  setText(w, 5, i.egf ? (i.egfFile ?? "") : "");
  setText(w, 6, i.log ? (i.logFile ?? "") : "");
  setText(w, 7, i.timeRules ?? "");
  setText(w, 8, i.timeLabel ?? "");
  const tb = parseFloat(r?.header.timebase ?? "");
  w.compute_set_recording(r?.n ?? 0, tb, r ? recordingDuration(r) : 0);
}
/** A recording's duration (s): from its header, else its last spike. */
export function recordingDuration(r: RecordingSource) {
  return parseFloat(r.header.duration) || 0;
}
/** The handlers JavaScript can ask for, in the order Rust lists them (checked by a test
 * against `compute_handler_name`). */
export const HANDLERS = [
  "population",
  "view",
  "membership",
  "pca",
  "path",
  "positionInfo",
  "cellStats",
  "spikePositions",
  "ratemap",
  "spatialAc",
  "direction",
  "speed",
  "speedDwell",
  "temporalAc",
  "spatialDrift",
  "spikeDrift",
  "lfpFrequency",
  "spikePhase",
  "timeLabels",
  "timeMask",
] as const;
export type HandlerName = (typeof HANDLERS)[number];
type Buffer = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array;
/** A handler's answer: its key's digest and its named buffers. */
export interface Answer {
  key: string;
  buffers: Record<string, Buffer>;
}
function readAnswer(w: Core): Answer {
  // Pointers before views: a call can grow memory, detaching an earlier `memory.buffer`.
  const digest = w.answer_digest();
  const [lo, hi] = new Uint32Array(w.memory.buffer, digest, 2);
  const buffers: Answer["buffers"] = {};
  for (let i = 0; i < w.answer_count(); i++) {
    const [at, length] = [w.answer_name(i), w.answer_name_len(i)];
    const name = new TextDecoder().decode(new Uint8Array(w.memory.buffer, at, length));
    const [data, n, kind] = [w.answer_data(i), w.answer_len(i), w.answer_kind(i)];
    buffers[name] = [
      () => copyF32(w, data, n),
      () => new Float64Array(w.memory.buffer, data, n).slice(),
      () => copyU8(w, data, n),
      () => copyU16(w, data, n),
      () => copyU32(w, data, n),
    ][kind]();
  }
  return { key: hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0"), buffers };
}

/** What the graph reports missing (see `Missing` in core/src/compute.rs). */
const MISSING = [
  "",
  "population",
  "position",
  "cut",
  "patch",
  "pca",
  "scan",
  "invalid",
  "egf",
  "log",
] as const;
/** Supplies what the graph reported missing for `i` (status `status`), reading the files
 * only JavaScript can. Requests are handled one at a time, so the inputs are still these
 * when it is handed over. */
async function supply(w: Core, i: ComputeInputs, status: number) {
  const r = i.recording;
  const check = () => {
    if (i.current && !i.current()) {
      throw new Superseded("Superseded request.");
    }
  };
  const missing = MISSING[status];
  if (missing === "position" && i.pos) {
    const handle = await readPosition(i.pos, w, i.ppm);
    writeInputs(w, i);
    w.compute_supply_position(handle);
  } else if (missing === "egf" && i.egf) {
    const handle = await readEgf(w, i.egf, {
      current: i.current,
      progress: (fraction) =>
        i.progress?.(fraction, `Reading ${i.egf!.name} ${Math.round(fraction * 100)}%`),
    });
    writeInputs(w, i);
    w.compute_supply_egf(handle);
  } else if (missing === "log" && i.log) {
    const bytes = new Uint8Array(await i.log.arrayBuffer());
    writeInputs(w, i);
    withU8(w, bytes, (p, n) => w.compute_supply_log(p, n));
  } else if (missing === "population" && r) {
    const handle = await readPopulation(w, r.file, r, {
      current: i.current,
      progress: (fraction, n) =>
        i.progress?.(
          fraction,
          `Preparing ${Math.round(fraction * n).toLocaleString()} / ${n.toLocaleString()} spikes`,
        ),
    });
    writeInputs(w, i);
    w.compute_supply_population(handle);
  } else if (missing === "cut" && r?.cut) {
    const handle = await readCut(r.cut, r.n, w);
    writeInputs(w, i);
    w.compute_supply_cut(handle);
  } else if (missing === "patch") {
    const [at, n] = [w.missing_patch(), w.missing_patch_len()];
    const id = new TextDecoder().decode(new Uint8Array(w.memory.buffer, at, n));
    const patch = await get<Uint8Array>(await openStore(), `patch:${id}`);
    if (!patch) {
      throw new Error("Undo data is unavailable.");
    }
    writeInputs(w, i);
    withU8(w, patch, (p, length) => w.compute_supply_patch(p, length));
  } else if (missing === "pca" && r) {
    const handle = await fitPca(w, r, i.settings.pcaSamples, check, (fraction, message) =>
      i.progress?.(fraction, message),
    );
    writeInputs(w, i);
    w.compute_supply_pca(handle);
  } else if (missing === "scan" && r) {
    const scan = w.scan_take();
    try {
      await streamFile(
        w,
        r.file,
        r.offset,
        r.n * 216,
        32768 * 216,
        (p, bytes, first) => {
          check();
          w.scan_feed(scan, first / 216, p, bytes);
        },
        (fraction) =>
          i.progress?.(
            fraction,
            `Preparing waveform gate ${Math.round(fraction * r.n).toLocaleString()} / ${r.n.toLocaleString()}`,
          ),
      );
    } catch (error) {
      w.scan_free(scan);
      throw error;
    }
    writeInputs(w, i);
    w.compute_supply_scan(scan);
  } else if (missing === "invalid") {
    throw new Error("Saved cut data doesn't match its recording.");
  } else {
    throw new Error(`The ${missing} isn't available.`);
  }
}
/** Runs `call` against the graph for `i`, supplying whatever it reports missing until it
 * answers; at most once per kind, so a resource that doesn't satisfy it can't loop. */
async function resolve(w: Core, i: ComputeInputs, call: () => number): Promise<number> {
  const supplied = new Set<number>();
  for (;;) {
    writeInputs(w, i);
    const status = call();
    if (status <= 0) {
      return status;
    }
    if (supplied.has(status) && MISSING[status] !== "patch") {
      throw new Error(`The ${MISSING[status]} isn't available.`);
    }
    supplied.add(status);
    await supply(w, i, status);
  }
}
/** Asks the compute graph's `handler` for `inputs` (and `cell`, for a cell's analyses). */
export async function ask(
  w: Core,
  inputs: ComputeInputs,
  handler: HandlerName,
  cell = 0,
): Promise<Answer> {
  const id = HANDLERS.indexOf(handler);
  await resolve(w, inputs, () => w.compute_request(id, cell));
  return readAnswer(w);
}
/** Runs an edit command for `inputs`, whose patch gets id `inputs.patch`: how many spikes
 * changed and the patch. Throws for invalid input or no room for another cell. */
export async function command(
  w: Core,
  inputs: ComputeInputs,
  run: () => number,
): Promise<{ changed: number; patch: Uint8Array }> {
  const status = await resolve(w, inputs, run);
  if (status === -2) {
    throw new Error("No room to insert another cell.");
  }
  if (status < 0) {
    throw new Error("Invalid edit.");
  }
  return {
    changed: w.command_changed(),
    patch: copyU8(w, w.command_output(), w.command_output_len()),
  };
}
/** The labels at `inputs`' history as cut-file (or .clu) text, in chunks. */
export async function exportLabels(w: Core, inputs: ComputeInputs, format: "cut" | "clu") {
  const n = inputs.recording!.n;
  const parts: BlobPart[] = [];
  for (let first = 0; first < n; first += 65536) {
    if (
      (await resolve(w, inputs, () => w.command_export(first, 65536, format === "clu" ? 1 : 0))) < 0
    ) {
      throw new Error("Cut labels are unavailable.");
    }
    parts.push(copyU8(w, w.command_output(), w.command_output_len()));
  }
  return parts;
}

/** The trajectory for `inputs`, or null without a position. */
export async function trajectory(w: Core, inputs: ComputeInputs): Promise<Trajectory | null> {
  if (!inputs.pos) {
    return null;
  }
  const path = (await ask(w, inputs, "path"))!;
  const [arenaWidth, arenaHeight, ppm, estimated] = (await ask(w, inputs, "positionInfo"))!.buffers
    .info;
  return {
    key: path.key,
    path: path.buffers.values as Float32Array,
    arenaWidth,
    arenaHeight,
    ppm,
    ppmEstimated: !!estimated,
  };
}

/** Which handler gives each part of a cell's analysis. */
const PART_HANDLERS: Record<AnalysisPart, HandlerName> = {
  stats: "cellStats",
  spatial: "ratemap",
  sc: "spatialAc",
  direction: "direction",
  speed: "speed",
  speedDwell: "speedDwell",
  ac: "temporalAc",
  spikes: "spikePositions",
  spatialDrift: "spatialDrift",
  spikeDrift: "spikeDrift",
  phase: "spikePhase",
};
/** Parts that need a position; without one they're left empty. */
const POSITIONAL = new Set<AnalysisPart>([
  "spatial",
  "sc",
  "direction",
  "speed",
  "speedDwell",
  "spikes",
  "spatialDrift",
  "spikeDrift",
]);
/**
 * The `parts` of a cell's analysis, from the compute graph.
 */
export async function analysis(
  w: Core,
  inputs: ComputeInputs,
  cell: number,
  parts: readonly AnalysisPart[],
): Promise<AnalysisData> {
  const empty = new Float32Array();
  const result: AnalysisData = {
    keys: {},
    cell,
    arenaWidth: 0,
    arenaHeight: 0,
    count: 0,
    refractory: 0,
    rate: 0,
    spatial: empty,
    width: 0,
    height: 0,
    peak: 0,
    direction: empty,
    speed: empty,
    speedDwell: empty,
    ac: empty,
    spikes: empty,
  };
  const hasPos = !!inputs.pos;
  if (hasPos) {
    [result.arenaWidth, result.arenaHeight] = (await ask(w, inputs, "positionInfo")).buffers.info;
  }
  for (const part of new Set(parts)) {
    if ((POSITIONAL.has(part) && !hasPos) || (part === "phase" && !inputs.egf)) {
      continue;
    }
    const answer = await ask(w, inputs, PART_HANDLERS[part], cell);
    result.keys[part] = answer.key;
    const { values, stats, shape } = answer.buffers;
    switch (part) {
      case "stats":
        [result.count, result.refractory, result.rate] = stats;
        break;
      case "spatial":
        result.spatial = values as Float32Array;
        [result.width, result.height, result.peak] = shape;
        break;
      case "sc":
        result.spatialAc = values as Float32Array;
        [result.width, result.height] = shape;
        break;
      case "phase":
        result.phase = values as Float32Array;
        result.phaseMean = stats[0];
        break;
      default:
        result[part] = values as Float32Array;
    }
  }
  return result;
}
