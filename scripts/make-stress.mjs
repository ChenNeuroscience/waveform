import { mkdir, open } from "node:fs/promises";
const dir = process.argv[2];
if (!dir)
  throw new Error(
    "Usage: node scripts/make-stress.mjs /absolute/temporary/directory",
  );
await mkdir(dir, { recursive: true });
const n = 9_000_000,
  chunk = 32768,
  b = Buffer.alloc(chunk * 216),
  f = await open(`${dir}/stress.1`, "w"),
  cut = await open(`${dir}/stress_1.cut`, "w");
await f.write(
  `num_spikes ${n}\nnum_chans 4\nsamples_per_spike 50\nbytes_per_sample 1\nbytes_per_timestamp 4\ntimebase 96000 hz\nduration 1500\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
);
await cut.write(
  `n_clusters: 101\nn_channels: 4\nn_params: 2\ntimes_used_in_Vt: 0 0 0 0\nExact_cut_for: stress spikes: ${n}\n`,
);
for (let first = 0; first < n; first += chunk) {
  const count = Math.min(chunk, n - first);
  let labels = "";
  for (let j = 0; j < count; j++) {
    const cell = (first + j) % 101;
    labels += `${cell} `;
    for (let c = 0; c < 4; c++) {
      const p = j * 216 + c * 54;
      b.writeUInt32BE((first + j) * 16, p);
      for (let t = 0; t < 50; t++)
        b[p + 4 + t] = Math.round((10 + cell * 0.7) * Math.sin(t * 0.13 + c));
    }
  }
  await f.write(b.subarray(0, count * 216));
  await cut.write(labels + "\n");
}
await f.write("\r\ndata_end");
await f.close();
await cut.close();
console.log(`Generated 9,000,000 spikes / 100 cells + noise in ${dir}`);
