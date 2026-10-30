// Browser I/O and ABI bridge. Numeric position/analysis code is in Rust.
import { parseHeader } from "../files";
import { streamFile, copyF32, type Core } from "./wasm";
import type { Header, Settings, AnalysisData, Trajectory } from "../types";
export interface Position {
  handle: number;
  identity: string;
  header: Header;
}
export async function parsePosition(
  file: File,
  s: Settings,
  w: Core,
  identity: string,
  base?: Position,
): Promise<Position> {
  if (base) {
    return {
      handle: w.position_variant(base.handle, s.leds, s.maxSpeed, s.posSmooth),
      identity,
      header: base.header,
    };
  }
  const { header: h, offset } = parseHeader(
    new Uint8Array(await file.slice(0, 65536).arrayBuffer()),
  );
  if (h.pos_format !== "t,x1,y1,x2,y2,numpix1,numpix2") {
    throw new Error("Unsupported LTX position format.");
  }
  const n = parseInt(h.num_pos_samples);
  const ppm = parseFloat(h.pixels_per_metre);
  const rate = parseFloat(h.sample_rate);
  const minX = parseFloat(h.window_min_x || "0");
  const minY = parseFloat(h.window_min_y || "0");
  const maxX = parseFloat(h.window_max_x);
  const maxY = parseFloat(h.window_max_y);
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    offset + n * 20 > file.size ||
    !(ppm > 0) ||
    !(rate > 0) ||
    !(maxX > minX) ||
    !(maxY > minY)
  ) {
    throw new Error("Invalid or truncated position file.");
  }
  const handle = w.position_new(n, ppm, rate, minX, minY, maxX, maxY);
  try {
    w.position_bearing(handle, parseFloat(h.bearing_colour_1 || "0"));
    await streamFile(w, file, offset, n * 20, 32768 * 20, (p, bytes) =>
      w.position_push(handle, p, bytes),
    );
    w.position_finish(handle, s.leds, s.maxSpeed, s.posSmooth);
    return { handle, identity, header: h };
  } catch (e) {
    w.position_free(handle);
    throw e;
  }
}
/** The trajectory for a processed position, computed once in Rust and cached there. */
export function trajectory(w: Core, pos: Position): Trajectory {
  const size = w.alloc_bytes(8);
  try {
    w.position_size(pos.handle, size);
    const [arenaWidth, arenaHeight] = new Float32Array(w.memory.buffer, size, 2);
    return {
      path: copyF32(w, w.position_path(pos.handle), w.position_path_len(pos.handle)),
      arenaWidth,
      arenaHeight,
    };
  } finally {
    w.free_bytes(size, 8);
  }
}
export function analyse(
  w: Core,
  engine: number,
  cell: number,
  tb: number,
  duration: number,
  pos: Position | undefined,
  s: Settings,
  spatialAc = false,
): AnalysisData {
  w.engine_analyse(
    engine,
    pos?.handle || 0,
    cell,
    tb,
    duration,
    s.binCm,
    s.smooth,
    s.acWindow,
    s.dirBin,
    s.speedBin,
    s.speedMax,
  );
  if (spatialAc) {
    w.engine_analyse_sc(engine, s.scMinOverlap);
  }
  const meta = new Float64Array(w.memory.buffer, w.engine_analysis_meta(engine), 8).slice();
  const array = (name: "spatial" | "spikes" | "direction" | "speed" | "speed_dwell" | "ac") =>
    copyF32(w, w[`engine_analysis_${name}`](engine), w[`engine_analysis_${name}_len`](engine));
  return {
    cell: meta[0],
    arenaWidth: meta[6],
    arenaHeight: meta[7],
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
    spatialAc: spatialAc
      ? copyF32(w, w.engine_analysis_sc(engine), w.engine_analysis_sc_len(engine))
      : undefined,
  };
}
