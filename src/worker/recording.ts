import { parseHeader } from "../files";
import type { Header } from "../types";
import { Superseded } from "./protocol";
import { streamFile, type Core } from "./wasm";

/** A tetrode file's header, where its spikes start, and how many there are. */
export interface RecordingHeader {
  header: Header;
  offset: number;
  n: number;
}

/** Reads and checks a tetrode file's header. */
export async function readHeader(file: File): Promise<RecordingHeader> {
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
  return { header, offset, n };
}

/** Streams a recording's spikes into a new population handle, for the compute graph to take
 * (`compute_supply_population`). Raw waveforms are never kept. */
export async function readPopulation(
  wasm: Core,
  file: File,
  { offset, n }: RecordingHeader,
  options: {
    current?: () => boolean;
    progress?: (fraction: number, spikes: number) => void;
  } = {},
): Promise<number> {
  const check = () => {
    if (options.current && !options.current()) {
      throw new Superseded("Superseded recording read.");
    }
  };
  check();
  const population = wasm.population_new(n);
  try {
    await streamFile(
      wasm,
      file,
      offset,
      n * 216,
      32768 * 216,
      (p, bytes) => {
        check();
        wasm.population_push(population, p, bytes);
      },
      (fraction) => options.progress?.(fraction, n),
    );
    check();
    return population;
  } catch (error) {
    wasm.population_free(population);
    throw error;
  }
}
