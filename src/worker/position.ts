// Browser I/O and ABI bridge. Positions and analyses are computed by handlers in Rust
// (core/src/analysis.rs), a compute graph (core/src/compute.rs); this writes their inputs,
// supplies files they say they need, and copies their answers out.
import { parseHeader } from "../files";
import { streamFile, copyF32, type Core } from "./wasm";
import type { AnalysisData, AnalysisPart, Header, Trajectory } from "../types";
import type { PositionRequest } from "./protocol";

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
] as const;
/** The compute graph's inputs, besides the cell (which Rust works out from the engine). */
export interface ComputeInputs extends PositionRequest {
  /** The recording asset. */
  recording?: string;
  /** Names cells by cut and revision rather than membership hash, for recordings whose
   * spikes aren't loaded. */
  cellPrefix?: string;
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
  setText(w, 0, i.pos ? (i.posFile ?? "") : "");
  setText(w, 1, i.recording ?? "");
  setText(w, 2, i.cellPrefix ?? "");
}
/** The handlers JavaScript can ask for, in the order Rust lists them (checked by a test
 * against `compute_handler_name`). */
export const HANDLERS = [
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
] as const;
export type HandlerName = (typeof HANDLERS)[number];
/** A cell asked about: its number, its recording's clock, and its engine, or 0 to only look
 * among values already computed. */
export interface CellRequest {
  engine: number;
  cell: number;
  tb: number;
  duration: number;
}
/** A handler's answer: its key's digest and its named buffers. */
export interface Answer {
  key: string;
  buffers: Record<string, Float32Array | Float64Array>;
}
function readAnswer(w: Core): Answer {
  // Pointers before views: a call can grow memory, detaching an earlier `memory.buffer`.
  const digest = w.answer_digest();
  const [lo, hi] = new Uint32Array(w.memory.buffer, digest, 2);
  const buffers: Answer["buffers"] = {};
  for (let i = 0; i < w.answer_count(); i++) {
    const [at, length] = [w.answer_name(i), w.answer_name_len(i)];
    const name = new TextDecoder().decode(new Uint8Array(w.memory.buffer, at, length));
    const [data, n] = [w.answer_data(i), w.answer_len(i)];
    buffers[name] = w.answer_kind(i)
      ? new Float64Array(w.memory.buffer, data, n).slice()
      : copyF32(w, data, n);
  }
  return { key: hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0"), buffers };
}
/**
 * Asks the compute graph's `handler` for `inputs` (and `cell`, for a cell's analyses).
 * Reads the position file and hands it over if the graph says it needs it. Undefined if it needs the
 * recording's spikes and `cell` has no engine.
 */
export async function ask(
  w: Core,
  inputs: ComputeInputs,
  handler: HandlerName,
  cell: CellRequest = { engine: 0, cell: 0, tb: 0, duration: 0 },
): Promise<Answer | undefined> {
  const id = HANDLERS.indexOf(handler);
  for (let read = false; ; read = true) {
    writeInputs(w, inputs);
    const status = w.compute_request(id, cell.engine, cell.cell, cell.tb, cell.duration);
    if (status === 0) {
      return readAnswer(w);
    }
    if (status === 1) {
      return undefined;
    }
    if (read || !inputs.pos) {
      throw new Error("The position isn't available.");
    }
    // Requests are handled one at a time, so the inputs are still these when it's stored.
    const handle = await readPosition(inputs.pos, w, inputs.ppm);
    writeInputs(w, inputs);
    w.compute_supply_position(handle);
  }
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
};
/** Parts that need a position; without one they're left empty. */
const POSITIONAL = new Set<AnalysisPart>([
  "spatial",
  "sc",
  "direction",
  "speed",
  "speedDwell",
  "spikes",
]);
/**
 * The `parts` of a cell's analysis, from the compute graph. Undefined if a
 * part needs the recording's spikes and `cell` has no engine.
 */
export async function analysis(
  w: Core,
  inputs: ComputeInputs,
  cell: CellRequest,
  parts: readonly AnalysisPart[],
): Promise<AnalysisData | undefined> {
  const empty = new Float32Array();
  const result: AnalysisData = {
    keys: {},
    cell: cell.cell,
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
    [result.arenaWidth, result.arenaHeight] = (await ask(w, inputs, "positionInfo"))!.buffers.info;
  }
  for (const part of new Set(parts)) {
    if (POSITIONAL.has(part) && !hasPos) {
      continue;
    }
    const answer = await ask(w, inputs, PART_HANDLERS[part], cell);
    if (!answer) {
      return undefined;
    }
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
      default:
        result[part] = values as Float32Array;
    }
  }
  return result;
}
