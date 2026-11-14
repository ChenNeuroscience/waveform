/** Bounded file I/O for PCA; the sampling plan and all numeric work live in Rust. */
import { streamFile, copyU32, type Core } from "./wasm";

/** Fits PCA for a recording into a new builder handle, for the compute graph to take
 * (`compute_supply_pca`). */
export async function fitPca(
  w: Core,
  recording: { n: number; file: File; offset: number },
  samples: number,
  check: () => void,
  progress: (fraction: number, message: string) => void,
): Promise<number> {
  const { n, file, offset } = recording;
  const pca = w.pca_new(n, samples);
  try {
    const ranges = copyU32(w, w.pca_ranges(pca), w.pca_ranges_len(pca));
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
          w.pca_sample(pca, p, bytes);
        },
      );
      progress((0.15 * (i + 2)) / ranges.length, "Sampling waveforms…");
    }
    check();
    progress(0.15, "Fitting four principal components…");
    if (!w.pca_fit(pca)) {
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
        w.pca_project(pca, p, bytes);
      },
      (fraction) => progress(0.2 + fraction * 0.8, "Projecting all spikes…"),
    );
    check();
    if (!w.pca_finish(pca)) {
      throw new Error("Incomplete PCA projection.");
    }
    return pca;
  } catch (error) {
    w.pca_free(pca);
    throw error;
  }
}
