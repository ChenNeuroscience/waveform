import { parseHeader, readCut } from "../files";
import type { Header } from "../types";
import { Superseded } from "./protocol";
import { streamFile, type Core } from "./wasm";

/** Stream a recording's population into an engine; raw waveforms are never retained. */
export async function readRecording(
  wasm: Core,
  file: File,
  cut?: File,
  options: {
    current?: () => boolean;
    progress?: (fraction: number, spikes: number) => void;
  } = {},
): Promise<{ e: number; n: number; header: Header; offset: number; file: File; ms: number }> {
  const start = performance.now();
  const check = () => {
    if (options.current && !options.current()) {
      throw new Superseded("Superseded recording read.");
    }
  };
  check();
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const { header, offset } = parseHeader(head);
  let n = parseInt(header.num_spikes);
  if (
    header.spike_format !== "t,ch1,t,ch2,t,ch3,t,ch4" ||
    parseInt(header.samples_per_spike || "50") !== 50 ||
    parseInt(header.num_chans || "4") !== 4 ||
    parseInt(header.bytes_per_sample || "1") !== 1 ||
    parseInt(header.bytes_per_timestamp || "4") !== 4
  ) {
    throw new Error(
      "Supported tetrodes have 4 channels, 50 signed 8-bit samples, and 32-bit timestamps.",
    );
  }
  if (new TextDecoder().decode(head.subarray(offset, offset + 10)).startsWith("\r\ndata_end")) {
    n = 0;
  }
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > 20_000_000 ||
    file.size < offset + n * 216 ||
    !(parseFloat(header.timebase) > 0)
  ) {
    throw new Error("Invalid/truncated tetrode or unsupported spike count.");
  }
  check();
  const e = wasm.engine_new(n);
  try {
    if (cut) {
      await readCut(cut, n, wasm, e);
    }
    await streamFile(
      wasm,
      file,
      offset,
      n * 216,
      32768 * 216,
      (p, bytes) => {
        check();
        wasm.engine_push(e, p, bytes);
      },
      (fraction) => options.progress?.(fraction, n),
    );
    check();
    wasm.engine_recount(e);
    return { e, n, header, offset, file, ms: performance.now() - start };
  } catch (error) {
    wasm.engine_free(e);
    throw error;
  }
}
