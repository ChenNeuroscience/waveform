/** Bounded file I/O for PCA; the sampling plan and all numeric work live in Rust. */
import { streamFile, copyU32, type Core } from "./wasm";

export async function fitPca(
  w: Core,
  recording: { e: number; n: number; file: File; offset: number },
  samples: number,
  check: () => void,
  progress: (fraction: number, message: string) => void,
) {
  const { e, n, file, offset } = recording;
  w.engine_pca_begin(e, samples);
  try {
    const ranges = copyU32(w, w.engine_pca_ranges(e), w.engine_pca_ranges_len(e));
    for (let i = 0; i < ranges.length; i += 2) {
      check();
      const [first, count] = ranges.subarray(i, i + 2);
      await streamFile(
        w,
        file,
        offset + first * 216,
        count * 216,
        Math.min(count, 32768) * 216,
        (p, bytes) => {
          check();
          w.engine_pca_sample(e, p, bytes);
        },
      );
      progress((0.15 * (i + 2)) / ranges.length, "Sampling waveforms…");
    }
    check();
    progress(0.15, "Fitting four principal components…");
    if (!w.engine_pca_fit(e)) {
      throw new Error("PCA eigensolver did not converge.");
    }
    await streamFile(
      w,
      file,
      offset,
      n * 216,
      32768 * 216,
      (p, bytes) => {
        check();
        w.engine_pca_project(e, p, bytes);
      },
      (fraction) => progress(0.2 + fraction * 0.8, "Projecting all spikes…"),
    );
    check();
    if (!w.engine_pca_finish(e)) {
      throw new Error("Incomplete PCA projection.");
    }
  } catch (error) {
    w.engine_pca_clear(e);
    throw error;
  }
}
