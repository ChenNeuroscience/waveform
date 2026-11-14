// Browser I/O and ABI bridge. Numeric position/analysis code, and the cache of what it
// derives, are in Rust (core/src/position.rs and core/src/cache.rs).
import { parseHeader } from "../files";
import { streamFile, copyF32, type Core } from "./wasm";
import type { Header, Settings, AnalysisData, Trajectory } from "../types";
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
/** Reads and processes a position into one handle, outside the cache, for one-off use. */
export async function parsePosition(
  file: File,
  s: Settings,
  w: Core,
  editedPpm?: number,
  sync = 0,
): Promise<number> {
  const handle = await readPosition(file, w, editedPpm);
  w.position_finish(handle, s.leds, s.maxSpeed, s.posSmooth, sync);
  return handle;
}

/** The numeric cache inputs, in the order Rust reads them (checked by a test against
 * `cache_input_name`). */
export const CACHE_NUMBERS = [
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
/** What the Rust cache keys on, besides the cell (which Rust works out from the engine). */
export interface CacheInputs extends PositionRequest {
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
    w.cache_set_text(field, p, bytes.length);
  } finally {
    w.free_bytes(p, Math.max(1, bytes.length));
  }
}
function writeInputs(w: Core, i: CacheInputs) {
  const numbers = new Float64Array(w.memory.buffer, w.cache_numbers(), CACHE_NUMBERS.length);
  CACHE_NUMBERS.forEach((name, j) => {
    numbers[j] =
      name === "ppm" ? (i.ppm ?? NaN) : name === "sync" ? (i.sync ?? 0) : i.settings[name];
  });
  setText(w, 0, i.pos ? (i.posFile ?? "") : "");
  setText(w, 1, i.recording ?? "");
  setText(w, 2, i.cellPrefix ?? "");
}
/**
 * Makes `i` the cache's current inputs, first reading the position file into the cache if
 * it hasn't been. Requests are handled one at a time, so they stay current until the next
 * call.
 */
export async function setCacheInputs(w: Core, i: CacheInputs) {
  writeInputs(w, i);
  if (i.pos && !w.cache_has_raw()) {
    const handle = await readPosition(i.pos, w, i.ppm);
    writeInputs(w, i);
    w.cache_put_raw(handle);
  }
}
/** Digests of the last answer's keys, as hex ("" for none). */
function keys(w: Core) {
  const [a, b, c, d, e, f] = new Uint32Array(w.memory.buffer, w.cache_keys(), 6);
  const hex = (lo: number, hi: number) =>
    lo || hi ? hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0") : "";
  return { analysis: hex(a, b), path: hex(c, d), speedDwell: hex(e, f) };
}

/** A processed position's size and calibration, with the path last put in the output. */
function trajectoryOf(w: Core, handle: number): Trajectory {
  const size = w.alloc_bytes(8);
  try {
    w.position_size(handle, size);
    const [arenaWidth, arenaHeight] = new Float32Array(w.memory.buffer, size, 2);
    return {
      key: "",
      ppm: w.position_ppm(handle),
      ppmEstimated: !!w.position_ppm_estimated(handle),
      path: copyF32(w, w.output_path(), w.output_path_len()),
      arenaWidth,
      arenaHeight,
    };
  } finally {
    w.free_bytes(size, 8);
  }
}
/** The trajectory of a processed position handle, without the cache. */
export function trajectory(w: Core, handle: number): Trajectory {
  w.position_path(handle);
  return trajectoryOf(w, handle);
}
/** The current inputs' trajectory, or null without a position. Call `setCacheInputs` first. */
export function cachedTrajectory(w: Core): Trajectory | null {
  if (!w.cache_path()) {
    return null;
  }
  // The path is cached apart from the position, so storing it can't evict this.
  const handle = w.cache_position();
  return { ...trajectoryOf(w, handle), key: keys(w).path };
}

/** Copies the analysis Rust last computed or fetched. */
function output(w: Core): AnalysisData {
  const meta = new Float64Array(w.memory.buffer, w.analysis_meta(), 9).slice();
  const array = (name: "spatial" | "spikes" | "direction" | "speed" | "speed_dwell" | "ac") =>
    copyF32(w, w[`analysis_${name}`](), w[`analysis_${name}_len`]());
  const sc = w.analysis_sc_len();
  return {
    cell: meta[0],
    arenaWidth: meta[6],
    arenaHeight: meta[7],
    count: meta[8],
    width: meta[1],
    height: meta[2],
    peak: meta[3],
    refractory: meta[4],
    rate: meta[5],
    spatial: array("spatial"),
    spikes: array("spikes"),
    direction: array("direction"),
    speed: array("speed"),
    speedDwell: array("speed_dwell"),
    ac: array("ac"),
    spatialAc: sc ? copyF32(w, w.analysis_sc(), sc) : undefined,
  };
}
/**
 * A cell's analyses for the current inputs, with the spatial autocorrelogram if asked (see `setCacheInputs`), from the cache or computed
 * with `engine` and cached. With no engine it only looks: undefined if it isn't cached.
 */
export function cachedAnalysis(
  w: Core,
  engine: number,
  cell: number,
  tb: number,
  duration: number,
  spatialAc = false,
): AnalysisData | undefined {
  if (!w.cache_analysis(engine, cell, tb, duration, Number(spatialAc))) {
    if (engine) {
      throw new Error("The position isn't available for analysis.");
    }
    return undefined;
  }
  const { analysis, speedDwell } = keys(w);
  return { ...output(w), key: analysis, speedDwellKey: speedDwell };
}
/** A cell's analysis computed directly, outside the cache, for one-off use and tests. */
export function analyse(
  w: Core,
  engine: number,
  cell: number,
  tb: number,
  duration: number,
  position: number | undefined,
  s: Settings,
  spatialAc = false,
): AnalysisData {
  w.engine_analyse(
    engine,
    position || 0,
    cell,
    tb,
    duration,
    s.binCm,
    s.smooth,
    s.acWindow,
    s.acBinMs,
    s.dirBin,
    s.dirSmooth,
    s.speedBin,
    s.speedMax,
  );
  if (spatialAc) {
    w.analysis_add_sc(s.scMinOverlap);
  }
  return output(w);
}
